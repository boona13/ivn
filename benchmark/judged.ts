#!/usr/bin/env npx tsx

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { judgeAnswer, defaultMinimumRequired, type AnswerRubric, type JudgedAnswerResult } from '../src/benchmark-judge.js';
import {
  buildRepoScanContext,
  buildWithIvnContext,
  buildWithoutIvnContext,
  HONO_DEFAULT_COMMIT_LIMIT,
  initIvnForScenario,
  loadRealScenarioDefinitions,
  prepareScenarioRoot,
  type RepoScenarioDefinition,
  type Task,
} from './run.js';

type ContextMode = 'without_ivn' | 'repo_scan' | 'with_ivn';

interface ScenarioSpec {
  key: string;
  name: string;
  tasks: Task[];
  root: string;
  cleanup: boolean;
}

interface JudgedCase {
  id: string;
  scenarioKey: string;
  scenarioName: string;
  contextMode: ContextMode;
  task: Task;
  rubric: AnswerRubric;
  prompt: string;
  context: string;
}

interface CaseResult {
  benchCase: JudgedCase;
  answer: string;
  judged: JudgedAnswerResult;
}

const ALL_CONTEXT_MODES: ContextMode[] = ['without_ivn', 'repo_scan', 'with_ivn'];
const RUBRIC_OVERRIDES: Record<string, Partial<AnswerRubric>> = {
  'Create /api/invoices endpoint': {
    anyOf: [['rfc 7807', 'problem+json']],
  },
  'Debug Stripe webhook 500': {
    anyOf: [['nodejs', 'node.js']],
    forbidden: ['use edge runtime', "runtime = 'edge'", 'runtime="edge"'],
  },
  'Choose database for new service': {
    forbidden: ['use mysql', 'choose mysql', 'use sqlite', 'choose sqlite'],
  },
  'Add billing admin role': {
    forbidden: ['hierarchical rbac', 'role inheritance'],
  },
  'Add new API endpoint': {
    anyOf: [['pydantic', 'response model']],
    forbidden: ['return raw dicts', 'raw dict'],
  },
  'Handle errors in pipeline': {
    forbidden: ['raise raw exception', 'raise raw exceptions', 'raise exception directly'],
  },
};

function readFlagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function normalizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildRubric(task: Task): AnswerRubric {
  const override = RUBRIC_OVERRIDES[task.title] || {};
  return {
    required: task.criticalFacts,
    minRequired: override.minRequired ?? defaultMinimumRequired(task.criticalFacts.length),
    anyOf: override.anyOf || [],
    forbidden: override.forbidden || [],
  };
}

function buildPrompt(task: Task, contextMode: ContextMode, rubric: AnswerRubric, context: string): string {
  return [
    'You are reviewing a coding task for a real repository.',
    `Task: ${task.title}`,
    `File in play: ${task.fileBeingEdited}`,
    `Context mode: ${contextMode}`,
    'Write a concise engineer-facing answer that explains the repo-specific constraints, decisions, gotchas, or dependencies that should shape the implementation.',
    `Mention at least ${rubric.minRequired ?? rubric.required.length} of the repo-specific checklist items when they are present in the context.`,
    'Do not invent project facts that are not present in the provided context.',
    '',
    'Context:',
    context,
  ].join('\n');
}

function materializeScenarioSpecs(definitions: RepoScenarioDefinition[]): ScenarioSpec[] {
  const specs: ScenarioSpec[] = [];
  for (const definition of definitions) {
    const prepared = prepareScenarioRoot(definition);
    if (!prepared) continue;
    initIvnForScenario(prepared.root, definition);
    specs.push({
      key: definition.key,
      name: definition.name,
      tasks: definition.tasks,
      root: prepared.root,
      cleanup: prepared.cleanup,
    });
  }
  return specs;
}

function buildCasesForScenario(
  root: string,
  spec: ScenarioSpec,
  contextModes: ContextMode[],
): JudgedCase[] {
  const cases: JudgedCase[] = [];

  for (const task of spec.tasks) {
    const rubric = buildRubric(task);
    const contexts: Record<ContextMode, string> = {
      without_ivn: buildWithoutIvnContext(root, task),
      repo_scan: buildRepoScanContext(root, task).content,
      with_ivn: buildWithIvnContext(root, task),
    };

    for (const contextMode of contextModes) {
      const context = contexts[contextMode];
      const id = `${spec.key}--${contextMode}--task-${task.id}-${normalizeSlug(task.title)}`;
      cases.push({
        id,
        scenarioKey: spec.key,
        scenarioName: spec.name,
        contextMode,
        task,
        rubric,
        prompt: buildPrompt(task, contextMode, rubric, context),
        context,
      });
    }
  }

  return cases;
}

function emitCases(cases: JudgedCase[], outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  for (const benchCase of cases) {
    const base = join(outputDir, benchCase.id);
    writeFileSync(`${base}.json`, JSON.stringify(benchCase, null, 2) + '\n');
    writeFileSync(`${base}.prompt.txt`, `${benchCase.prompt}\n`);
    writeFileSync(`${base}.context.txt`, `${benchCase.context}\n`);
  }
}

function runAnswerCommand(answerCommand: string, benchCase: JudgedCase, runtimeDir: string): string {
  mkdirSync(runtimeDir, { recursive: true });
  const caseFile = join(runtimeDir, `${benchCase.id}.json`);
  const promptFile = join(runtimeDir, `${benchCase.id}.prompt.txt`);
  const contextFile = join(runtimeDir, `${benchCase.id}.context.txt`);
  const outputFile = join(runtimeDir, `${benchCase.id}.answer.txt`);

  writeFileSync(caseFile, JSON.stringify(benchCase, null, 2) + '\n');
  writeFileSync(promptFile, `${benchCase.prompt}\n`);
  writeFileSync(contextFile, `${benchCase.context}\n`);

  const stdout = execSync(answerCommand, {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: {
      ...process.env,
      IVN_BENCH_CASE_FILE: caseFile,
      IVN_BENCH_PROMPT_FILE: promptFile,
      IVN_BENCH_CONTEXT_FILE: contextFile,
      IVN_BENCH_OUTPUT_FILE: outputFile,
      IVN_BENCH_CONTEXT_MODE: benchCase.contextMode,
      IVN_BENCH_TASK_TITLE: benchCase.task.title,
      IVN_BENCH_EDITED_FILE: benchCase.task.fileBeingEdited,
    },
  }).toString().trim();

  if (existsSync(outputFile)) {
    const fileOutput = readFileSync(outputFile, 'utf8').trim();
    if (fileOutput) return fileOutput;
  }
  if (stdout) return stdout;
  throw new Error(`Answer command produced no output for ${benchCase.id}`);
}

function summarizeResults(results: CaseResult[]): Array<{
  scenarioKey: string;
  scenarioName: string;
  contextMode: ContextMode;
  passed: number;
  total: number;
  passRate: number;
  scorePct: number;
}> {
  const summaries = new Map<string, {
    scenarioKey: string;
    scenarioName: string;
    contextMode: ContextMode;
    passed: number;
    total: number;
    score: number;
    maxScore: number;
  }>();

  for (const result of results) {
    const key = `${result.benchCase.scenarioKey}::${result.benchCase.contextMode}`;
    const existing = summaries.get(key) || {
      scenarioKey: result.benchCase.scenarioKey,
      scenarioName: result.benchCase.scenarioName,
      contextMode: result.benchCase.contextMode,
      passed: 0,
      total: 0,
      score: 0,
      maxScore: 0,
    };
    existing.total += 1;
    existing.score += result.judged.score;
    existing.maxScore += result.judged.maxScore;
    if (result.judged.passed) existing.passed += 1;
    summaries.set(key, existing);
  }

  return [...summaries.values()]
    .sort((a, b) => a.scenarioName.localeCompare(b.scenarioName) || a.contextMode.localeCompare(b.contextMode))
    .map((summary) => ({
      scenarioKey: summary.scenarioKey,
      scenarioName: summary.scenarioName,
      contextMode: summary.contextMode,
      passed: summary.passed,
      total: summary.total,
      passRate: Math.round((summary.passed / Math.max(summary.total, 1)) * 100),
      scorePct: Math.round((summary.score / Math.max(summary.maxScore, 1)) * 100),
    }));
}

function printSummary(results: CaseResult[]): void {
  const summaries = summarizeResults(results);
  console.log('');
  console.log('  ┌──────────────────────────────┬───────────────┬──────────┬────────────┐');
  console.log('  │ Scenario                     │ Context Mode  │ Pass     │ Score      │');
  console.log('  ├──────────────────────────────┼───────────────┼──────────┼────────────┤');
  for (const summary of summaries) {
    const scenario = summary.scenarioName.slice(0, 28).padEnd(28);
    const mode = summary.contextMode.padEnd(13);
    const pass = `${summary.passed}/${summary.total} (${summary.passRate}%)`.padStart(8);
    const score = `${summary.scorePct}%`.padStart(10);
    console.log(`  │ ${scenario} │ ${mode} │ ${pass} │ ${score} │`);
  }
  console.log('  └──────────────────────────────┴───────────────┴──────────┴────────────┘');
  console.log('');
}

function writeJsonReport(outputPath: string | null, payload: unknown): void {
  if (!outputPath) return;
  const resolved = resolve(outputPath);
  writeFileSync(resolved, JSON.stringify(payload, null, 2) + '\n');
  console.log(`  Wrote judged benchmark report to ${resolved}\n`);
}

function parseContextModes(): ContextMode[] {
  const raw = readFlagValue('--context-mode');
  if (!raw) return ALL_CONTEXT_MODES;
  const parsed = raw.split(',').map((value) => value.trim()).filter(Boolean) as ContextMode[];
  if (parsed.some((mode) => !ALL_CONTEXT_MODES.includes(mode))) {
    throw new Error(`Unknown context mode: ${raw}`);
  }
  return parsed;
}

function parseScenarioFilter(): Set<string> | null {
  const raw = readFlagValue('--scenario');
  if (!raw) return null;
  const selected = new Set(raw.split(',').map((value) => value.trim()).filter(Boolean));
  return selected;
}

function main(): void {
  const skipHono = process.argv.includes('--skip-hono');
  const answerCommand = readFlagValue('--answer-command');
  const emitDir = readFlagValue('--emit-dir');
  const reportJson = readFlagValue('--report-json');
  const manifestPath = readFlagValue('--manifest') || undefined;
  const honoSince = readFlagValue('--hono-since') || undefined;
  const honoLastRaw = readFlagValue('--hono-last');
  const honoLast = honoLastRaw ? parseInt(honoLastRaw, 10) : HONO_DEFAULT_COMMIT_LIMIT;
  const contextModes = parseContextModes();
  const scenarioFilter = parseScenarioFilter();

  if (!answerCommand && !emitDir) {
    throw new Error('Provide --emit-dir to export judged cases, --answer-command to evaluate them, or both.');
  }

  if (honoSince && honoLastRaw) {
    throw new Error('Use either --hono-since or --hono-last, not both.');
  }

  const definitions = loadRealScenarioDefinitions({
    manifestPath,
    honoSince,
    honoLast,
  }).filter((scenario) => !skipHono || scenario.key !== 'hono-git')
    .filter((scenario) => !scenarioFilter || scenarioFilter.has(scenario.key));
  const specs = materializeScenarioSpecs(definitions);
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ivn-judged-bench-'));
  const cases: JudgedCase[] = [];

  try {
    console.log('');
    console.log('  IVN judged benchmark');
    console.log(`  Context modes: ${contextModes.join(', ')}`);
    if (answerCommand) {
      console.log(`  Answer command: ${answerCommand}`);
    }
    console.log('');

    for (const spec of specs) {
      console.log(`  Building ${spec.name}...`);
      cases.push(...buildCasesForScenario(spec.root, spec, contextModes));
    }

    if (emitDir) {
      emitCases(cases, resolve(emitDir));
      console.log(`  Exported ${cases.length} judged cases to ${resolve(emitDir)}\n`);
    }

    if (!answerCommand) {
      console.log('  No answer command provided, so only the portable case pack was emitted.\n');
      return;
    }

    const results: CaseResult[] = [];
    for (const benchCase of cases) {
      const answer = runAnswerCommand(answerCommand, benchCase, runtimeDir);
      results.push({
        benchCase,
        answer,
        judged: judgeAnswer(answer, benchCase.rubric),
      });
    }

    printSummary(results);
    writeJsonReport(reportJson, {
      generated_at: new Date().toISOString(),
      metric: {
        name: 'judged_answer_grounding',
        description: 'Pass/fail and score for model answers judged against repo-specific required facts, optional any-of groups, and forbidden contradictions.',
      },
      flags: {
        skip_hono: skipHono,
        hono_since: honoSince ?? null,
        hono_last: honoSince ? null : honoLast,
        manifest: manifestPath || null,
        scenario_filter: scenarioFilter ? [...scenarioFilter] : null,
      },
      cases,
      results,
      summary: summarizeResults(results),
    });
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    for (const spec of specs) {
      if (spec.cleanup) {
        rmSync(spec.root, { recursive: true, force: true });
      }
    }
  }
}

main();
