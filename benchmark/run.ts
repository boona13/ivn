#!/usr/bin/env npx tsx
/**
 * IVN Benchmark — Does IVN actually make a difference?
 *
 * Real repositories only.
 *
 * For each task, we check how many critical facts are already present in the
 * bundled pre-edit context before the model starts searching or writing code.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const LOCAL_TSX_BIN = fileURLToPath(
  new URL(`../node_modules/.bin/${process.platform === 'win32' ? 'tsx.cmd' : 'tsx'}`, import.meta.url),
);
const LOCAL_CLI_ENTRY = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const IVN_BENCH_COMMAND = process.env.IVN_BENCH_COMMAND?.trim()
  || `${JSON.stringify(LOCAL_TSX_BIN)} ${JSON.stringify(LOCAL_CLI_ENTRY)}`;
const IVN_BENCH_TIMEOUT_MS = (() => {
  const raw = process.env.IVN_BENCH_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 300000;
})();

export function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, stdio: 'pipe', timeout: IVN_BENCH_TIMEOUT_MS }).toString().trim();
  } catch (e: any) {
    return e.stdout?.toString?.() || e.stderr?.toString?.() || '';
  }
}

function runIvn(args: string, cwd: string): string {
  return run(`${IVN_BENCH_COMMAND} ${args}`, cwd);
}

export interface RepoScenarioDefinition {
  key: string;
  name: string;
  tasks: Task[];
  cloneUrl?: string;
  localPath?: string;
  importLast?: number;
  importSince?: string;
  importPaths?: string[];
}

function readFlagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function writeJsonReport(report: unknown): void {
  const outputPath = readFlagValue('--report-json');
  if (!outputPath) return;
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`  Wrote benchmark report to ${outputPath}\n`);
}

function parseScenarioFilter(): Set<string> | null {
  const raw = readFlagValue('--scenario');
  if (!raw) return null;
  return new Set(raw.split(',').map((value) => value.trim()).filter(Boolean));
}

function syncCursorAndGeneric(dir: string): void {
  mkdirSync(join(dir, '.cursor'), { recursive: true });
  runIvn('sync-rules --target cursor,generic', dir);
}

const REPO_SCAN_FILE_LIMIT = 5;
const REPO_SCAN_CHAR_BUDGET = 40000;
const REPO_SCAN_TOKEN_STOP_WORDS = new Set([
  'add', 'new', 'for', 'the', 'and', 'with', 'from', 'into', 'only', 'real', 'test',
  'route', 'routes', 'handler', 'component', 'helper', 'file', 'src', 'api',
]);

interface RepoScanMatch {
  path: string;
  score: number;
  matchedFacts: string[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= 3 && !REPO_SCAN_TOKEN_STOP_WORDS.has(token));
}

function isSearchableRepoFile(relativePath: string): boolean {
  if (
    relativePath.startsWith('.git/')
    || relativePath.startsWith('.ivn/')
    || relativePath.startsWith('node_modules/')
    || relativePath.startsWith('dist/')
    || relativePath.startsWith('.cursor/rules/')
  ) return false;

  const generatedArtifacts = new Set([
    'KNOWLEDGE.md',
    'CLAUDE.md',
    'AGENTS.md',
    '.windsurfrules',
    '.clinerules',
    '.github/copilot-instructions.md',
  ]);
  if (generatedArtifacts.has(relativePath)) return false;

  return /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|toml|ya?ml|txt|prisma)$/i.test(relativePath);
}

function toPortablePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function listSearchableRepoFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(relativeDir: string): void {
    const currentDir = relativeDir ? join(dir, relativeDir) : dir;
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const relativePath = toPortablePath(relativeDir ? join(relativeDir, entry.name) : entry.name);
      if (entry.isDirectory()) {
        if (
          relativePath === '.git'
          || relativePath === '.ivn'
          || relativePath === 'node_modules'
          || relativePath === 'dist'
        ) continue;
        walk(relativePath);
        continue;
      }
      if (entry.isFile() && isSearchableRepoFile(relativePath)) files.push(relativePath);
    }
  }

  walk('');
  return files;
}

// ── Task definitions ─────────────────────────────

export interface Task {
  id: number;
  title: string;
  fileBeingEdited: string;
  criticalFacts: string[];
}

// ── Scoring ──────────────────────────────────────

export function scoreFacts(context: string, facts: string[]): { found: number; missed: string[] } {
  const lower = context.toLowerCase();
  let found = 0;
  const missed: string[] = [];
  for (const fact of facts) {
    if (lower.includes(fact.toLowerCase())) found++;
    else missed.push(fact);
  }
  return { found, missed };
}

// ── Context builders ─────────────────────────────

export function buildWithoutIvnContext(dir: string, task: Task): string {
  const parts: string[] = [];
  const readmePath = join(dir, 'README.md');
  if (existsSync(readmePath)) parts.push(readFileSync(readmePath, 'utf-8'));
  const filePath = join(dir, task.fileBeingEdited);
  if (existsSync(filePath)) parts.push(readFileSync(filePath, 'utf-8'));
  return parts.join('\n');
}

export function buildRepoScanContext(dir: string, task: Task): { content: string; files: string[] } {
  const parts: string[] = [];
  const selectedFiles: string[] = [];
  const readmePath = join(dir, 'README.md');
  if (existsSync(readmePath)) parts.push(readFileSync(readmePath, 'utf-8'));
  const filePath = join(dir, task.fileBeingEdited);
  if (existsSync(filePath)) parts.push(readFileSync(filePath, 'utf-8'));

  const taskTokens = new Set([
    ...tokenize(task.title),
    ...tokenize(task.fileBeingEdited),
    ...task.criticalFacts.flatMap((fact) => tokenize(fact)),
  ]);

  const rankedMatches: RepoScanMatch[] = [];
  for (const relativePath of listSearchableRepoFiles(dir)) {
    if (relativePath === 'README.md' || relativePath === task.fileBeingEdited) continue;
    const content = readFileSync(join(dir, relativePath), 'utf-8');
    const lowerContent = content.toLowerCase();
    const lowerPath = relativePath.toLowerCase();
    const matchedFacts = task.criticalFacts.filter(
      (fact) => lowerContent.includes(fact.toLowerCase()) || lowerPath.includes(fact.toLowerCase()),
    );
    const tokenMatches = [...taskTokens].filter(
      (token) => lowerPath.includes(token) || lowerContent.includes(token),
    ).length;
    const score = matchedFacts.length * 10 + tokenMatches;
    if (score > 0) {
      rankedMatches.push({ path: relativePath, score, matchedFacts });
    }
  }

  rankedMatches.sort((a, b) =>
    b.matchedFacts.length - a.matchedFacts.length
    || b.score - a.score
    || a.path.localeCompare(b.path),
  );

  let usedChars = parts.join('\n').length;
  for (const match of rankedMatches) {
    if (selectedFiles.length >= REPO_SCAN_FILE_LIMIT) break;
    const content = readFileSync(join(dir, match.path), 'utf-8');
    if (usedChars + content.length > REPO_SCAN_CHAR_BUDGET) continue;
    parts.push(content);
    selectedFiles.push(match.path);
    usedChars += content.length;
  }

  return { content: parts.join('\n'), files: selectedFiles };
}

export function buildWithIvnContext(dir: string, task: Task): string {
  const parts: string[] = [];
  const readmePath = join(dir, 'README.md');
  if (existsSync(readmePath)) parts.push(readFileSync(readmePath, 'utf-8'));
  const filePath = join(dir, task.fileBeingEdited);
  if (existsSync(filePath)) parts.push(readFileSync(filePath, 'utf-8'));

  const knowledgePath = join(dir, 'KNOWLEDGE.md');
  if (existsSync(knowledgePath)) parts.push(readFileSync(knowledgePath, 'utf-8'));

  const rulesDir = join(dir, '.cursor', 'rules');
  if (existsSync(rulesDir)) {
    for (const file of readdirSync(rulesDir)) {
      if (file.endsWith('.mdc')) {
        const content = readFileSync(join(rulesDir, file), 'utf-8');
        const isAlwaysApply = content.includes('alwaysApply: true');
        const globLines = content.match(/^\s+-\s+(.+)$/gm) || [];
        const globs = globLines.map(l => l.trim().replace(/^-\s+/, ''));
        const matchesFile = globs.some(g => {
          const pattern = g.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
          try { return new RegExp(pattern).test(task.fileBeingEdited); } catch { return false; }
        });
        if (isAlwaysApply || matchesFile) {
          parts.push(content);
        }
      }
    }
  }

  return parts.join('\n');
}

// ── Run a single benchmark scenario ──────────────

export interface ScenarioResult {
  name: string;
  tasks: Task[];
  results: TaskResult[];
  totalWithout: number;
  totalRepoScan: number;
  totalWith: number;
  totalFacts: number;
  pctWithout: number;
  pctRepoScan: number;
  pctWith: number;
  wins: number;
  ties: number;
  repoScanWins: number;
  repoScanTies: number;
}

export interface TaskResult {
  task: Task;
  withoutIvn: { score: number; missed: string[]; size: number };
  repoScan: { score: number; missed: string[]; size: number; files: string[] };
  withIvn: { score: number; missed: string[]; size: number };
}

export function runScenario(dir: string, name: string, tasks: Task[]): ScenarioResult {
  const results: TaskResult[] = [];

  for (const task of tasks) {
    const noIvnCtx = buildWithoutIvnContext(dir, task);
    const repoScanCtx = buildRepoScanContext(dir, task);
    const ivnCtx = buildWithIvnContext(dir, task);
    const noIvnScore = scoreFacts(noIvnCtx, task.criticalFacts);
    const repoScanScore = scoreFacts(repoScanCtx.content, task.criticalFacts);
    const ivnScore = scoreFacts(ivnCtx, task.criticalFacts);

    results.push({
      task,
      withoutIvn: { score: noIvnScore.found, missed: noIvnScore.missed, size: noIvnCtx.length },
      repoScan: {
        score: repoScanScore.found,
        missed: repoScanScore.missed,
        size: repoScanCtx.content.length,
        files: repoScanCtx.files,
      },
      withIvn: { score: ivnScore.found, missed: ivnScore.missed, size: ivnCtx.length },
    });
  }

  let totalWithout = 0, totalRepoScan = 0, totalWith = 0, totalFacts = 0;
  let wins = 0, ties = 0, repoScanWins = 0, repoScanTies = 0;
  for (const r of results) {
    const total = r.task.criticalFacts.length;
    totalFacts += total;
    totalWithout += r.withoutIvn.score;
    totalRepoScan += r.repoScan.score;
    totalWith += r.withIvn.score;
    if (r.withIvn.score > r.withoutIvn.score) wins++;
    else if (r.withIvn.score === r.withoutIvn.score) ties++;
    if (r.withIvn.score > r.repoScan.score) repoScanWins++;
    else if (r.withIvn.score === r.repoScan.score) repoScanTies++;
  }

  return {
    name,
    tasks,
    results,
    totalWithout, totalRepoScan, totalWith, totalFacts,
    pctWithout: Math.round(100 * totalWithout / totalFacts),
    pctRepoScan: Math.round(100 * totalRepoScan / totalFacts),
    pctWith: Math.round(100 * totalWith / totalFacts),
    wins, ties, repoScanWins, repoScanTies,
  };
}

function printTable(s: ScenarioResult): void {
  console.log('  ┌────┬──────────────────────────────────────┬───────────────┬───────────────┬───────────────┐');
  console.log('  │ #  │ Task                                 │ NO IVN        │ REPO SCAN     │ WITH IVN      │');
  console.log('  ├────┼──────────────────────────────────────┼───────────────┼───────────────┼───────────────┤');

  for (const r of s.results) {
    const total = r.task.criticalFacts.length;
    const name = r.task.title.slice(0, 36).padEnd(36);
    const noCol = `${r.withoutIvn.score}/${total} facts`.padStart(15);
    const scanCol = `${r.repoScan.score}/${total} facts`.padStart(15);
    const yesCol = `${r.withIvn.score}/${total} facts`.padStart(15);
    console.log(`  │ ${String(r.task.id).padStart(2)} │ ${name} │${noCol} │${scanCol} │${yesCol} │`);
  }

  console.log('  ├────┼──────────────────────────────────────┼───────────────┼───────────────┼───────────────┤');
  console.log(`  │    │ ${'TOTAL'.padEnd(36)} │ ${(s.pctWithout + '%').padStart(14)} │ ${(s.pctRepoScan + '%').padStart(14)} │ ${(s.pctWith + '%').padStart(14)} │`);
  console.log('  └────┴──────────────────────────────────────┴───────────────┴───────────────┴───────────────┘');
}

function printDetails(s: ScenarioResult): void {
  for (const r of s.results) {
    const total = r.task.criticalFacts.length;
    const delta = r.withIvn.score - r.withoutIvn.score;
    const scanDelta = r.withIvn.score - r.repoScan.score;
    const marker = delta > 0 ? '★' : delta === 0 ? '≈' : '▼';

    console.log(`  ${r.task.id}. ${r.task.title} (${r.task.fileBeingEdited})`);
    if (r.withoutIvn.missed.length) console.log(`     Without: ${r.withoutIvn.score}/${total} — missed: ${r.withoutIvn.missed.join(', ')}`);
    else console.log(`     Without: ${r.withoutIvn.score}/${total}`);
    if (r.repoScan.missed.length) console.log(`     Repo scan: ${r.repoScan.score}/${total} — missed: ${r.repoScan.missed.join(', ')} — files: ${r.repoScan.files.join(', ') || 'none'}`);
    else console.log(`     Repo scan: ${r.repoScan.score}/${total} — files: ${r.repoScan.files.join(', ') || 'none'} — PERFECT`);
    if (r.withIvn.missed.length) console.log(`     With:    ${r.withIvn.score}/${total} — missed: ${r.withIvn.missed.join(', ')}`);
    else console.log(`     With:    ${r.withIvn.score}/${total} — PERFECT`);
    console.log(`     ${marker} vs no-ivn: ${delta > 0 ? `+${delta}` : delta === 0 ? 'Same' : 'No improvement'}`);
    console.log(`     ${scanDelta > 0 ? '▲' : scanDelta === 0 ? '≈' : '▼'} vs repo-scan: ${scanDelta > 0 ? `+${scanDelta}` : scanDelta === 0 ? 'Same' : 'No improvement'}`);
    console.log('');
  }
}

export function acceptAllPending(dir: string): number {
  runIvn('accept --all --force 2>/dev/null', dir);
  const statusOut = runIvn('status 2>&1', dir);
  const totalMatch = statusOut.match(/Total entries:\s+(\d+)/);
  return totalMatch ? parseInt(totalMatch[1], 10) : 0;
}

// ── Real Repository Scenarios ────────────────────

export const HONO_DEFAULT_COMMIT_LIMIT = 200;

export const HONO_TASKS: Task[] = [
  {
    id: 1,
    title: 'Add bearer auth to routes',
    fileBeingEdited: 'src/middleware/bearer-auth/index.ts',
    criticalFacts: ['metacharacter', 'escape', 'regex'],
  },
  {
    id: 2,
    title: 'Parse accept headers safely',
    fileBeingEdited: 'src/utils/accept.ts',
    criticalFacts: ['redos', 'regex split'],
  },
  {
    id: 3,
    title: 'Handle form data in validator',
    fileBeingEdited: 'src/validator/validator.ts',
    criticalFacts: ['prototype pollution', 'object.create(null)'],
  },
  {
    id: 4,
    title: 'Implement JWT verification',
    fileBeingEdited: 'src/middleware/jwt/index.ts',
    criticalFacts: ['memory leak', 'mutation', 'token format', 'math.floor'],
  },
  {
    id: 5,
    title: 'Add proxy helper',
    fileBeingEdited: 'src/helper/proxy/index.ts',
    criticalFacts: ['hop-by-hop', 'rfc 9110'],
  },
  {
    id: 6,
    title: 'Write JSX streaming component',
    fileBeingEdited: 'src/jsx/index.ts',
    criticalFacts: ['controller is already closed', 'react 19', 'dedupe'],
  },
  {
    id: 7,
    title: 'Deploy handler on AWS Lambda',
    fileBeingEdited: 'src/adapter/aws-lambda/handler.ts',
    criticalFacts: ['callback', 'deprecation', 'nodejs_24', 'percent-encoded', 'bytestring'],
  },
  {
    id: 8,
    title: 'Optimize context response path',
    fileBeingEdited: 'src/context.ts',
    criticalFacts: ['createresponseinstance', 'fast path', 'tree shaking', 'protected'],
  },
];

function builtInRealScenarios(options: { honoSince?: string; honoLast: number }): RepoScenarioDefinition[] {
  return [
    {
      key: 'hono-git',
      name: 'honojs/hono (git-import only)',
      tasks: HONO_TASKS,
      cloneUrl: 'https://github.com/honojs/hono.git',
      importSince: options.honoSince,
      importLast: options.honoSince ? undefined : options.honoLast,
    },
  ];
}

function loadManifestScenarios(manifestPath?: string): RepoScenarioDefinition[] {
  if (!manifestPath) return [];
  const resolvedPath = resolve(manifestPath);
  const manifestDir = dirname(resolvedPath);
  const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8')) as Array<Record<string, unknown>>;
  return parsed.map((entry) => {
    const tasks = Array.isArray(entry.tasks)
      ? entry.tasks.map((task) => ({
          id: Number((task as Record<string, unknown>).id),
          title: String((task as Record<string, unknown>).title || ''),
          fileBeingEdited: String((task as Record<string, unknown>).fileBeingEdited || ''),
          criticalFacts: Array.isArray((task as Record<string, unknown>).criticalFacts)
            ? ((task as Record<string, unknown>).criticalFacts as unknown[]).map(String)
            : [],
        }))
      : [];
    return {
      key: String(entry.key || ''),
      name: String(entry.name || entry.key || ''),
      tasks,
      cloneUrl: typeof entry.cloneUrl === 'string' ? entry.cloneUrl : undefined,
      localPath: typeof entry.localPath === 'string' ? resolve(manifestDir, entry.localPath) : undefined,
      importLast: typeof entry.importLast === 'number' ? entry.importLast : undefined,
      importSince: typeof entry.importSince === 'string' ? entry.importSince : undefined,
      importPaths: Array.isArray(entry.importPaths)
        ? entry.importPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : undefined,
    };
  });
}

export function loadRealScenarioDefinitions(options: {
  manifestPath?: string;
  honoSince?: string;
  honoLast: number;
}): RepoScenarioDefinition[] {
  return [
    ...builtInRealScenarios({ honoSince: options.honoSince, honoLast: options.honoLast }),
    ...loadManifestScenarios(options.manifestPath),
  ];
}

export function prepareScenarioRoot(scenario: RepoScenarioDefinition): { root: string; cleanup: boolean } | null {
  if (scenario.localPath) {
    return { root: scenario.localPath, cleanup: false };
  }
  if (!scenario.cloneUrl) {
    throw new Error(`Scenario ${scenario.key} must define either localPath or cloneUrl.`);
  }

  const dir = mkdtempSync(join(tmpdir(), `ivn-bench-${scenario.key}-`));
  try {
    const cloneArgs = scenario.importSince
      ? `git clone --shallow-since=${JSON.stringify(scenario.importSince)} --single-branch ${JSON.stringify(scenario.cloneUrl)} ${JSON.stringify(dir)}`
      : `git clone --depth ${(scenario.importLast || HONO_DEFAULT_COMMIT_LIMIT) + 50} --single-branch ${JSON.stringify(scenario.cloneUrl)} ${JSON.stringify(dir)}`;
    execSync(cloneArgs, {
      stdio: 'pipe',
      timeout: IVN_BENCH_TIMEOUT_MS,
    });
    return { root: dir, cleanup: true };
  } catch {
    console.log(`  ⚠ Could not prepare ${scenario.name} (network or clone failed). Skipping.\n`);
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

export function initIvnForScenario(dir: string, scenario: RepoScenarioDefinition): { entryCount: number } {
  runIvn('init', dir);
  const importPathArgs = (scenario.importPaths || [])
    .map((value) => ` --path ${JSON.stringify(value)}`)
    .join('');
  const importCommand = scenario.importSince
    ? `git-import --since ${JSON.stringify(scenario.importSince)}${importPathArgs}`
    : `git-import --last ${scenario.importLast || HONO_DEFAULT_COMMIT_LIMIT}${importPathArgs}`;
  runIvn(importCommand, dir);
  const entryCount = acceptAllPending(dir);
  syncCursorAndGeneric(dir);
  return { entryCount };
}

// ── Main ─────────────────────────────────────────

export function main() {
  const skipHono = process.argv.includes('--skip-hono');
  const honoSince = readFlagValue('--hono-since') || undefined;
  const honoLast = readFlagValue('--hono-last');
  const honoLastCount = honoLast ? parseInt(honoLast, 10) : HONO_DEFAULT_COMMIT_LIMIT;
  const manifestPath = readFlagValue('--manifest') || undefined;
  const scenarioFilter = parseScenarioFilter();
  if (honoSince && honoLast) {
    throw new Error('Use either --hono-since or --hono-last, not both.');
  }

  console.log('');
  console.log('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
  console.log('┃  IVN BENCHMARK — What does the LLM know BEFORE it writes code?                      ┃');
  console.log('┃  Real repositories only: built-in OSS scenarios plus optional manifest entries.       ┃');
  console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
  const scenarioDefinitions = loadRealScenarioDefinitions({
    manifestPath,
    honoSince,
    honoLast: honoLastCount,
  }).filter((scenario) => !skipHono || scenario.key !== 'hono-git')
    .filter((scenario) => !scenarioFilter || scenarioFilter.has(scenario.key));

  const results: ScenarioResult[] = [];
  const cleanupRoots: string[] = [];

  for (const scenario of scenarioDefinitions) {
    console.log(`\n  ━━━ ${scenario.name} ━━━\n`);
    const prepared = prepareScenarioRoot(scenario);
    if (!prepared) continue;
    if (prepared.cleanup) cleanupRoots.push(prepared.root);

    const { entryCount } = initIvnForScenario(prepared.root, scenario);
    console.log(
      scenario.importSince
        ? `  Imported ${entryCount} knowledge entries from commits since ${scenario.importSince}\n`
        : `  Imported ${entryCount} knowledge entries from ${scenario.importLast || HONO_DEFAULT_COMMIT_LIMIT} commits\n`,
    );

    const rulesDir = join(prepared.root, '.cursor', 'rules');
    const rules = existsSync(rulesDir) ? readdirSync(rulesDir).filter((file) => file.endsWith('.mdc')) : [];
    console.log(`  Generated: KNOWLEDGE.md + ${rules.length} Cursor rules`);
    for (const file of rules) {
      const content = readFileSync(join(rulesDir, file), 'utf-8');
      const isGlobal = content.includes('alwaysApply: true');
      console.log(`    ${file}${isGlobal ? ' (always-apply)' : ''}`);
    }
    console.log('');

    const result = runScenario(prepared.root, scenario.name, scenario.tasks);
    results.push(result);
    printTable(result);
    console.log('');
    printDetails(result);
  }

  console.log('  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
  console.log('  ┃                                  VERDICT                                             ┃');
  console.log('  ┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫');
  for (const result of results) {
    const name = result.name.slice(0, 58).padEnd(58);
    const line = `  ┃  ${name} ┃`;
    console.log(line);
    console.log(`  ┃    NO IVN: ${String(result.pctWithout).padStart(3)}%  SCAN: ${String(result.pctRepoScan).padStart(3)}%  IVN: ${String(result.pctWith).padStart(3)}%  ΔvsNoIVN: +${result.pctWith - result.pctWithout}%  ΔvsScan: +${result.pctWith - result.pctRepoScan}%  ┃`);
    console.log('  ┃                                                                                      ┃');
  }
  console.log(`  ┃  What this benchmark measures:                                                         ┃`);
  console.log(`  ┃    1. Bundled context coverage before codegen starts                                   ┃`);
  console.log(`  ┃    2. Per-file scoped rule activation for the file being edited                        ┃`);
  console.log(`  ┃    3. Auto-generated context artifacts, not live search or manual repo exploration     ┃`);
  console.log(`  ┃    4. Real repositories only; no synthetic benchmark projects                          ┃`);
  console.log('  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
  console.log('');

  writeJsonReport({
    generated_at: new Date().toISOString(),
    metric: {
      name: 'critical_fact_presence',
      description: 'Fraction of predefined critical fact substrings present in the bundled context string for each task.',
      without_ivn: 'README.md plus the file being edited.',
      repo_scan: 'README.md plus the file being edited plus a keyword-guided repo scan that opens the top matching source/docs files while excluding IVN-generated artifacts.',
      with_ivn: 'The same baseline plus generated KNOWLEDGE.md and matching .cursor/rules/*.mdc files after ivn init, git-import, accept, and sync.',
    },
    flags: {
      skip_hono: skipHono,
      hono_since: honoSince ?? null,
      hono_last: honoSince ? null : honoLastCount,
      manifest: manifestPath || null,
      scenario_filter: scenarioFilter ? [...scenarioFilter] : null,
    },
    scenarios: results,
  });

  for (const root of cleanupRoots) {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
