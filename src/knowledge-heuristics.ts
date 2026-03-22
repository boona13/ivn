import { classifyKnowledge, detectTechnicalTags, tokenizeWords } from './knowledge-classifier.js';
import type { KnowledgeType } from './types.js';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'some', 'them',
  'than', 'its', 'over', 'such', 'that', 'this', 'with', 'will', 'each',
  'from', 'they', 'were', 'which', 'their', 'said', 'what', 'when', 'who',
  'how', 'use', 'using', 'used', 'also', 'into', 'just', 'about', 'would',
  'make', 'like', 'does', 'could', 'should', 'where', 'after', 'back',
  'then', 'because', 'being', 'other', 'very', 'here', 'more', 'there',
]);

const TAG_BLACKLIST = new Set([
  ...STOP_WORDS,
  // IVN domain terms
  'project', 'knowledge', 'memory', 'layer', 'entry', 'entries', 'manual',
  'decision', 'pattern', 'gotcha', 'debug', 'context', 'dependency', 'todo',
  // Classifier cue words — useful for classification but not as tags
  'decided', 'chose', 'picked', 'fixed', 'fixing', 'watch', 'warning',
  'careful', 'avoid', 'before', 'after', 'should', 'need', 'needs', 'load',
  'loading', 'write', 'writing', 'read', 'reads', 'using', 'matters',
  // Common verbs/adjectives that leak through as noise tags
  'added', 'adding', 'allows', 'already', 'always', 'applied', 'apply',
  'access', 'admin', 'algorithm', 'attachment', 'attachments',
  'authenticated', 'available',
  'based', 'becomes', 'block', 'breaking', 'brown',
  'called', 'calling', 'caused', 'change', 'changed', 'changes',
  'check', 'choose', 'chosen', 'compatible', 'compatibility',
  'comparison', 'confirm', 'configure', 'configurable', 'connection',
  'constant', 'created', 'currency', 'current',
  'dedicated', 'default', 'delivery', 'depends', 'different',
  'directly', 'during',
  'enable', 'enabled', 'endpoints', 'ensure', 'every', 'existing',
  'expected', 'explicit', 'explicitly',
  'familiar', 'first', 'found', 'function',
  'going', 'handle', 'handler', 'handlers', 'handles', 'happens',
  'having', 'hierarchical', 'however',
  'including', 'initial', 'instead', 'integration', 'internally',
  'known', 'launch', 'limiting', 'looking',
  'making', 'management', 'manual', 'means', 'member', 'might',
  'migrate', 'missing', 'model', 'moved',
  'native', 'never', 'notice',
  'otherwise', 'owner', 'pasting', 'pooling', 'possible', 'prevent',
  'processing', 'provide', 'public',
  'reach', 'reaching', 'reason', 'related', 'remove', 'removed',
  'require', 'required', 'requirement', 'requires', 'resolve',
  'responses', 'return', 'returns', 'running',
  'scaffolding', 'seems', 'signature', 'signatures', 'simpler',
  'simulates', 'since', 'someone', 'specific', 'started', 'still',
  'streaming', 'subtl', 'support', 'supports', 'sufficient',
  'switch', 'switched',
  'taking', 'through', 'timeout', 'tried', 'trying', 'turned',
  'under', 'undefined', 'unless', 'update', 'updated',
  'verified', 'verification',
  'wanted', 'without', 'working', 'works',
  // JavaScript object prototype keys are noisy tags and unsafe map keys.
  'constructor', 'prototype', '__proto__', 'hasownproperty', 'tostring', 'valueof',
]);

const PATH_REF_PATTERN =
  /(?:^|[\s(])((?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]{1,10})(?=$|[\s),.;:])/g;

export function extractWords(text: string): string[] {
  return tokenizeWords(text)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

export function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9./:+-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeFileRef(filePath: string, root: string): string {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/g, '');
  let normalized = filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replace(/\/+$/g, '');

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  if (normalized.startsWith(`${normalizedRoot}/`)) {
    normalized = normalized.slice(normalizedRoot.length + 1);
  }

  return normalized;
}

export function extractFileRefs(content: string, root: string): string[] {
  const normalized = content.replace(/\s+/g, ' ').trim();
  const refs = new Set<string>();
  const matches = normalized.matchAll(PATH_REF_PATTERN);
  for (const match of matches) {
    const rawPath = match[1];
    if (!rawPath) continue;
    const fileRef = normalizeFileRef(rawPath, root);
    if (fileRef) refs.add(fileRef);
    if (refs.size >= 8) break;
  }
  return [...refs];
}

export function extractTags(content: string, root: string): string[] {
  const normalized = content.replace(/\s+/g, ' ').trim();
  const tags = new Set<string>();

  for (const tag of detectTechnicalTags(normalized)) {
    tags.add(tag);
  }

  for (const rawPath of extractFileRefs(normalized, root)) {
    const fileName = rawPath.split('/').pop() || rawPath;
    const baseName = fileName.replace(/\.[a-z0-9]+$/i, '');
    const normalizedTag = normalizeTag(baseName);
    if (
      normalizedTag &&
      normalizedTag.length > 2 &&
      !/^(src|app|lib|dist|build|test|tests|spec|index)$/i.test(normalizedTag)
    ) {
      tags.add(normalizedTag);
    }
  }

  const fallbackMinLength = tags.size > 0 ? 7 : 5;
  const fallbackLimit = tags.size > 0 ? 4 : 6;
  const fallbackWords = extractWords(normalized)
    .filter((word) => word.length >= fallbackMinLength)
    .filter((word) => !TAG_BLACKLIST.has(word) && !/^\d+$/.test(word))
    .filter((word) => !/^(src|lib|app|dist|build|test|tests)[a-z0-9]+(?:ts|tsx|js|jsx)$/.test(word))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));

  for (const word of fallbackWords) {
    if (tags.size >= fallbackLimit) break;
    tags.add(normalizeTag(word));
  }

  return [...tags].slice(0, 6);
}

export function inferKnowledgeType(content: string): KnowledgeType {
  return classifyKnowledge(content).type;
}

function scoreSummaryCandidate(text: string): number {
  const candidate = text.trim();
  if (!candidate) return -Infinity;

  let score = Math.max(0, 40 - Math.abs(candidate.length - 72) / 2);
  if (/(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+/.test(candidate)) score += 10;
  if (/\b(decided|chose|fixed|avoid|warning|requires|pattern|migrate|sync|store|capture)\b/i.test(candidate)) score += 10;
  if (/\b(because|since|so that|to avoid|to fix|to support|to prevent)\b/i.test(candidate)) score += 6;
  if (/[A-Z][a-z]+[A-Z][A-Za-z0-9]+/.test(candidate)) score += 6;
  return score;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength - 3);
  const breakPoint = slice.lastIndexOf(' ');
  const trimmed = breakPoint > maxLength / 2 ? slice.slice(0, breakPoint) : slice;
  return `${trimmed.trim()}...`;
}

export function makeSummary(content: string): string {
  const normalized = content
    .replace(/\s+/g, ' ')
    .replace(/^[a-z]+(?:\(.+?\))?!?:\s*/i, '')
    .trim();

  if (normalized.length <= 120) return normalized;

  const candidates = normalized
    .split(/(?<=[.!?])\s+|\s+[—-]\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  let best = candidates[0] || normalized;
  let bestScore = scoreSummaryCandidate(best);

  for (const candidate of candidates.slice(1, 8)) {
    const score = scoreSummaryCandidate(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  const pivot = best.search(/\b(because|since|so that|to avoid|to fix|to support|to prevent)\b/i);
  if (pivot > 24) {
    best = best.slice(0, pivot).trim();
  }

  return truncate(best || normalized, 120);
}

export function mergeTags(manualTags: string[], autoTags: string[]): string[] {
  const merged = new Set<string>();
  for (const tag of [...manualTags, ...autoTags]) {
    const normalized = normalizeTag(tag);
    if (normalized) merged.add(normalized);
    if (merged.size >= 8) break;
  }
  return [...merged];
}

export function mergeFileRefs(manualRefs: string[], autoRefs: string[], root: string): string[] {
  const merged = new Set<string>();
  for (const ref of [...manualRefs, ...autoRefs]) {
    const normalized = normalizeFileRef(ref, root);
    if (!normalized) continue;
    merged.add(normalized);
    if (merged.size >= 8) break;
  }
  return [...merged];
}
