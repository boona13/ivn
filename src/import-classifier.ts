import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  classifyKnowledge,
  type KnowledgeClassification,
} from './knowledge-classifier.js';
import type { KnowledgeType } from './types.js';

interface ZeroShotOutput {
  labels: string[];
  scores: number[];
}

type ZeroShotClassifier = (
  text: string,
  labels: string[],
  options?: Record<string, unknown>,
) => Promise<ZeroShotOutput>;

const IMPORT_MODEL = process.env.IVN_IMPORT_CLASSIFIER_MODEL?.trim()
  || process.env.IVN_IMPORT_CLASSIFIER_MODEL?.trim()
  || 'typeform/distilbert-base-uncased-mnli';

const MODEL_CACHE_DIR = process.env.IVN_MODEL_CACHE_DIR?.trim()
  || process.env.IVN_MODEL_CACHE_DIR?.trim()
  || join(homedir(), '.cache', 'ivn', 'models');

const LABEL_DEFS: Array<{ label: string; type: KnowledgeType }> = [
  { label: 'architectural decision or technology choice', type: 'decision' },
  { label: 'repeatable implementation pattern or coding rule', type: 'pattern' },
  { label: 'gotcha, warning, pitfall, or failure mode', type: 'gotcha' },
  { label: 'debugging note, root cause, or fixed bug', type: 'debug' },
  { label: 'background context or project overview', type: 'context' },
  { label: 'dependency requirement, version constraint, or environment constraint', type: 'dependency' },
  { label: 'future task, follow-up, or todo item', type: 'todo' },
];

const LABELS = LABEL_DEFS.map((item) => item.label);
const LABEL_TYPE_MAP = new Map<string, KnowledgeType>(
  LABEL_DEFS.map((item) => [item.label, item.type]),
);

let zeroShotPromise: Promise<ZeroShotClassifier | null> | null = null;

export async function classifyImportedKnowledge(
  content: string,
  options: {
    heuristic?: KnowledgeClassification;
    preferHeuristic?: boolean;
  } = {},
): Promise<KnowledgeClassification> {
  const heuristic = options.heuristic || classifyKnowledge(content);
  if (shouldBypassModelForImport(heuristic, options.preferHeuristic || false)) {
    return heuristic;
  }
  const classifier = await getZeroShotClassifier();
  if (!classifier) return heuristic;

  try {
    const ml = await classifyWithModel(classifier, content);
    return chooseImportedClassification(heuristic, ml, options.preferHeuristic || false);
  } catch {
    return heuristic;
  }
}

export function shouldBypassModelForImport(
  heuristic: KnowledgeClassification,
  preferHeuristic: boolean,
): boolean {
  return (
    preferHeuristic
    && heuristic.confidence >= 0.72
  );
}

export async function resolveAutoKnowledgeType(
  content: string,
  options: {
    type?: KnowledgeType;
    heuristic?: KnowledgeClassification;
    preferHeuristic?: boolean;
    classify?: (
      text: string,
      classifyOptions?: {
        heuristic?: KnowledgeClassification;
        preferHeuristic?: boolean;
      },
    ) => Promise<KnowledgeClassification>;
  } = {},
): Promise<KnowledgeType> {
  if (options.type) return options.type;

  const classify = options.classify || classifyImportedKnowledge;
  const classification = await classify(content, {
    heuristic: options.heuristic,
    preferHeuristic: options.preferHeuristic,
  });
  return classification.type;
}

export function chooseImportedClassification(
  heuristic: KnowledgeClassification,
  ml: KnowledgeClassification,
  preferHeuristic: boolean,
): KnowledgeClassification {
  if (heuristic.type === ml.type) {
    return {
      ...ml,
      confidence: Math.max(heuristic.confidence, ml.confidence),
      evidence: mergeEvidence(heuristic, ml),
    };
  }

  if (preferHeuristic && heuristic.type !== 'context' && heuristic.confidence >= 0.72) {
    return heuristic;
  }

  if (heuristic.type === 'context' && ml.type !== 'context' && ml.confidence >= 0.42) {
    return ml;
  }

  if (ml.type === 'context' && heuristic.type !== 'context' && heuristic.confidence >= 0.68) {
    return heuristic;
  }

  if (ml.confidence >= 0.62) {
    return ml;
  }

  if (heuristic.confidence >= ml.confidence + 0.12) {
    return heuristic;
  }

  return ml.confidence >= heuristic.confidence ? ml : heuristic;
}

async function getZeroShotClassifier(): Promise<ZeroShotClassifier | null> {
  if (process.env.IVN_DISABLE_ML_IMPORTS === '1' || process.env.IVN_DISABLE_ML_IMPORTS === '1') {
    return null;
  }

  if (!zeroShotPromise) {
    zeroShotPromise = (async () => {
      const transformers = await import('@huggingface/transformers');
      const env = transformers.env as {
        cacheDir: string;
        allowRemoteModels: boolean;
      };
      const pipeline = transformers.pipeline as unknown as (
        task: string,
        model: string,
        options?: Record<string, unknown>,
      ) => Promise<unknown>;
      env.cacheDir = MODEL_CACHE_DIR;
      env.allowRemoteModels = (process.env.IVN_ALLOW_REMOTE_MODELS || process.env.IVN_ALLOW_REMOTE_MODELS) !== '0';
      return await pipeline('zero-shot-classification', IMPORT_MODEL, {
        quantized: true,
      }) as ZeroShotClassifier;
    })().catch(() => null);
  }

  return zeroShotPromise;
}

async function classifyWithModel(
  classifier: ZeroShotClassifier,
  content: string,
): Promise<KnowledgeClassification> {
  const normalized = content.replace(/\s+/g, ' ').trim().slice(0, 600);
  const result = await classifier(normalized, LABELS, {
    hypothesis_template: 'This text is primarily about {}.',
    multi_label: false,
  });

  const scores = emptyScores();
  const evidence = emptyEvidence();
  for (let i = 0; i < result.labels.length; i++) {
    const label = result.labels[i];
    const type = LABEL_TYPE_MAP.get(label);
    const score = result.scores[i] || 0;
    if (!type) continue;
    scores[type] = Math.max(scores[type], Math.round(score * 100));
  }

  const topLabel = result.labels[0];
  const topScore = result.scores[0] || 0;
  const topType = LABEL_TYPE_MAP.get(topLabel) || 'context';
  evidence[topType].push(`ml zero-shot: ${topLabel}`);

  return {
    type: topType,
    confidence: topScore,
    scores,
    evidence,
  };
}

function mergeEvidence(
  heuristic: KnowledgeClassification,
  ml: KnowledgeClassification,
): KnowledgeClassification['evidence'] {
  const merged = emptyEvidence();
  for (const type of Object.keys(merged) as KnowledgeType[]) {
    merged[type] = [...heuristic.evidence[type], ...ml.evidence[type]];
  }
  return merged;
}

function emptyScores(): Record<KnowledgeType, number> {
  return {
    decision: 0,
    pattern: 0,
    gotcha: 0,
    debug: 0,
    context: 0,
    dependency: 0,
    todo: 0,
  };
}

function emptyEvidence(): Record<KnowledgeType, string[]> {
  return {
    decision: [],
    pattern: [],
    gotcha: [],
    debug: [],
    context: [],
    dependency: [],
    todo: [],
  };
}
