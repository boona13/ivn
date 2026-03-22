import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { classifyImportedKnowledge } from './import-classifier.js';
import type { Knowledge, KnowledgeType } from './types.js';
import { IvnStore } from './store.js';

interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  files: string[];
}

const NOISE_PATTERNS = [
  /^wip/i,
  /^fixup/i,
  /^squash/i,
  /^merge (branch|pull request|remote)/i,
  /^bump version/i,
  /^update changelog/i,
  /^(initial|first) commit$/i,
  /^typo/i,
  /^lint/i,
  /^format/i,
  /^prettier/i,
  /^eslint/i,
  /^chore\(?deps\)?:/i,
  /^auto-?commit/i,
];

const CONVENTIONAL_TYPE_MAP: Record<string, KnowledgeType> = {
  'feat':     'decision',
  'feature':  'decision',
  'fix':      'debug',
  'bugfix':   'debug',
  'hotfix':   'debug',
  'docs':     'context',
  'refactor': 'pattern',
  'perf':     'pattern',
  'test':     'context',
  'chore':    'context',
  'build':    'dependency',
  'ci':       'context',
  'revert':   'gotcha',
  'breaking': 'gotcha',
  'security': 'gotcha',
  'deps':     'dependency',
};

const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const SAFE_GIT_REF = /^(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD|[A-Za-z0-9][A-Za-z0-9._/@:+-]*(?:[~^][0-9]*)*)$/;
const GIT_LOG_DELIMITER = '---IVN_DELIM---';
const GIT_FILES_DELIMITER = '---IVN_FILES---';
const WEAK_SUBJECT_PATTERNS = [
  /^(?:update|updates|change|changes)\b/i,
  /^(?:misc|miscellaneous)\b/i,
  /^(?:cleanup|clean up)\b/i,
  /^(?:small|minor|quick)\s+(?:fix|fixes|change|changes|update|updates)\b/i,
  /^(?:tmp|temporary|work)\b/i,
];

function isGitRepo(dir: string): boolean {
  try {
    runGit(dir, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

function getGitRoot(dir: string): string {
  return runGit(dir, ['rev-parse', '--show-toplevel']);
}

export function getCommitTimestamp(projectRoot: string, ref: string = 'HEAD'): string {
  if (!isGitRepo(projectRoot)) {
    throw new Error('Not a git repository. Run from inside a git project.');
  }

  try {
    return runGit(projectRoot, ['show', '-s', '--format=%cI', validateGitRef(ref)]);
  } catch {
    throw new Error(`Git ref not found: ${ref}`);
  }
}

export function getChangedFiles(projectRoot: string, ref: string = 'HEAD'): string[] {
  if (!isGitRepo(projectRoot)) {
    throw new Error('Not a git repository. Run from inside a git project.');
  }

  const files = new Set<string>();
  const safeRef = validateGitRef(ref);

  try {
    const diffOutput = runGit(projectRoot, ['diff', '--name-only', '--relative', safeRef, '--']);
    for (const line of diffOutput.split('\n')) {
      const file = line.trim();
      if (file) files.add(file);
    }
  } catch {
    if (ref !== 'HEAD') {
      throw new Error(`Git ref not found: ${ref}`);
    }

    const statusOutput = runGit(projectRoot, ['status', '--porcelain']);

    for (const line of statusOutput.split('\n')) {
      const candidate = line.trim();
      if (!candidate) continue;
      const filePart = candidate.slice(3).trim();
      const file = filePart.includes(' -> ') ? filePart.split(' -> ').pop() : filePart;
      if (file && !file.endsWith('/')) files.add(file);
    }
  }

  const untrackedOutput = runGit(projectRoot, ['ls-files', '--others', '--exclude-standard']);
  for (const line of untrackedOutput.split('\n')) {
    const file = line.trim();
    if (file) files.add(file);
  }

  return [...files];
}

function parseGitLog(dir: string, options: { since?: string; last?: number; paths?: string[] } = {}): GitCommit[] {
  const args = [
    'log',
    `--format=${GIT_LOG_DELIMITER}%n%H%n%h%n%an%n%cI%n%s%n%b%n${GIT_FILES_DELIMITER}`,
    '--name-only',
    '--no-merges',
  ];

  if (options.last) {
    args.push('-n', String(normalizeGitHistoryCount(options.last)));
  } else if (options.since) {
    args.push(`--since=${normalizeGitSince(options.since)}`);
  } else {
    args.push('--since=90 days ago');
  }
  const normalizedPaths = normalizeGitPathspecs(options.paths);
  if (normalizedPaths.length > 0) {
    args.push('--', ...normalizedPaths);
  }

  let output: string;
  try {
    output = runGit(dir, args);
  } catch (err: unknown) {
    throw new Error(normalizeGitCommandError(err, 'Failed to read git history.'));
  }

  const entries = output.split(GIT_LOG_DELIMITER).filter((e) => e.trim());

  return entries.map((entry) => {
    const lines = entry.trim().split('\n');
    const filesDelimiterIndex = lines.indexOf(GIT_FILES_DELIMITER);
    const bodyLines = filesDelimiterIndex === -1 ? lines.slice(5) : lines.slice(5, filesDelimiterIndex);
    const fileLines = filesDelimiterIndex === -1 ? [] : lines.slice(filesDelimiterIndex + 1);
    const hash = lines[0] || '';
    const shortHash = lines[1] || '';
    const author = lines[2] || '';
    const date = lines[3] || '';
    const subject = lines[4] || '';
    const body = bodyLines.join('\n').trim();
    return {
      hash,
      shortHash,
      subject,
      body,
      author,
      date,
      files: fileLines.map((line) => line.trim()).filter(Boolean),
    };
  });
}

function isSignificant(commit: GitCommit): boolean {
  const text = commit.subject.trim();
  if (text.length < 8) return false;
  if (NOISE_PATTERNS.some((p) => p.test(text))) return false;
  if (commit.files.length === 0 && !hasMeaningfulCommitBody(commit.body)) return false;
  if (WEAK_SUBJECT_PATTERNS.some((pattern) => pattern.test(text)) && !hasMeaningfulCommitBody(commit.body)) {
    return false;
  }
  return true;
}

function inferTypeFromCommit(subject: string): KnowledgeType {
  const conventionalMatch = subject.match(/^(\w+)(?:\(.+?\))?[!]?:\s*/);
  if (conventionalMatch) {
    const prefix = conventionalMatch[1].toLowerCase();
    if (CONVENTIONAL_TYPE_MAP[prefix]) return CONVENTIONAL_TYPE_MAP[prefix];
  }

  if (/\bBREAKING\b/.test(subject)) return 'gotcha';

  const lower = subject.toLowerCase();
  if (/\b(fix|bug|crash|error|patch)\b/.test(lower)) return 'debug';
  if (/\b(add|feat|implement|introduce|create)\b/.test(lower)) return 'decision';
  if (/\b(refactor|restructure|reorganize|clean|improve)\b/.test(lower)) return 'pattern';
  if (/\b(upgrade|bump|dep|migrate|update .+ to)\b/.test(lower)) return 'dependency';
  if (/\b(remove|deprecate|disable|revert)\b/.test(lower)) return 'gotcha';

  return 'context';
}

const TRAILER_PATTERN = /^[A-Z][\w-]*:\s/;

function extractMeaningfulCommitBody(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !TRAILER_PATTERN.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMeaningfulCommitBody(body: string): boolean {
  const meaningful = extractMeaningfulCommitBody(body);
  return meaningful.length >= 24 && meaningful.split(/\s+/).length >= 4;
}

function commitToContent(commit: GitCommit): string {
  let content = commit.subject;
  const meaningful = extractMeaningfulCommitBody(commit.body);
  if (meaningful) {
    const snippet = meaningful.length > 320 ? `${meaningful.slice(0, 317).trimEnd()}...` : meaningful;
    content += ' — ' + snippet;
  }
  return content;
}

function runGit(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  }).trim();
}

function normalizeGitCommandError(err: unknown, fallback: string): string {
  if (err instanceof Error && typeof (err as Error & { stderr?: unknown }).stderr === 'string') {
    const stderr = ((err as Error & { stderr?: string }).stderr || '').trim();
    if (stderr) {
      return `${fallback} ${stderr}`;
    }
  }
  if (err instanceof Error && err.message.trim()) {
    return `${fallback} ${err.message.trim()}`;
  }
  return fallback;
}

function gitSourceForCommit(commit: GitCommit): { source: string; sourceRef: string } {
  return {
    source: `git:${commit.shortHash}`,
    sourceRef: commit.hash,
  };
}

function validateGitRef(ref: string): string {
  const normalized = ref.trim();
  if (!normalized) {
    throw new Error('Git ref must be a non-empty string.');
  }
  if (!SAFE_GIT_REF.test(normalized)) {
    throw new Error(`Unsafe git ref: ${ref}`);
  }
  return normalized;
}

function normalizeGitSince(since: string): string {
  const normalized = since.trim();
  if (!normalized) {
    throw new Error('Git `since` value must be a non-empty string.');
  }
  if (normalized.length > 120 || /[\0\r\n]/.test(normalized)) {
    throw new Error('Git `since` value is invalid.');
  }
  return normalized;
}

function normalizeGitHistoryCount(last: number): number {
  if (!Number.isInteger(last) || last < 1 || last > 5000) {
    throw new Error('Git history count must be an integer between 1 and 5000.');
  }
  return last;
}

function normalizeGitPathspecs(paths?: string[]): string[] {
  if (!paths) return [];
  return paths
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => {
      if (path.length > 512 || /[\0\r\n]/.test(path)) {
        throw new Error(`Git path is invalid: ${path}`);
      }
      return path;
    });
}

export interface GitImportResult {
  total: number;
  imported: number;
  skipped: number;
  duplicates: number;
  entries: Array<{ entry: Knowledge; isNew: boolean; commit: GitCommit }>;
}

export async function importFromGit(
  store: IvnStore,
  options: { since?: string; last?: number; dryRun?: boolean; paths?: string[] } = {},
): Promise<GitImportResult> {
  const root = store.getRoot();
  if (!isGitRepo(root)) {
    throw new Error('Not a git repository. Run from inside a git project.');
  }

  const commits = parseGitLog(root, {
    since: options.since,
    last: options.last,
    paths: options.paths,
  });
  const significant = commits.filter(isSignificant);

  const result: GitImportResult = {
    total: commits.length,
    imported: 0,
    skipped: commits.length - significant.length,
    duplicates: 0,
    entries: [],
  };

  // Disable auto-sync during batch import — fire once at the end
  store.setAutoSync(false);

  for (const commit of significant) {
    const content = commitToContent(commit);
    const heuristicType = inferTypeFromCommit(commit.subject);
    const provenance = gitSourceForCommit(commit);
    const classification = await classifyImportedKnowledge(content, {
      heuristic: {
        type: heuristicType,
        confidence: commitHasStrongTypeSignal(commit.subject) ? 0.86 : 0.62,
        scores: {
          decision: heuristicType === 'decision' ? 100 : 0,
          pattern: heuristicType === 'pattern' ? 100 : 0,
          gotcha: heuristicType === 'gotcha' ? 100 : 0,
          debug: heuristicType === 'debug' ? 100 : 0,
          context: heuristicType === 'context' ? 100 : 0,
          dependency: heuristicType === 'dependency' ? 100 : 0,
          todo: heuristicType === 'todo' ? 100 : 0,
        },
        evidence: {
          decision: heuristicType === 'decision' ? ['git subject heuristic'] : [],
          pattern: heuristicType === 'pattern' ? ['git subject heuristic'] : [],
          gotcha: heuristicType === 'gotcha' ? ['git subject heuristic'] : [],
          debug: heuristicType === 'debug' ? ['git subject heuristic'] : [],
          context: heuristicType === 'context' ? ['git subject heuristic'] : [],
          dependency: heuristicType === 'dependency' ? ['git subject heuristic'] : [],
          todo: heuristicType === 'todo' ? ['git subject heuristic'] : [],
        },
      },
      preferHeuristic: commitHasStrongTypeSignal(commit.subject),
    });
    const type = classification.type;

    if (options.dryRun) {
      const now = new Date().toISOString();
      result.entries.push({
        entry: {
          id: commit.shortHash,
          type,
          content,
          summary: content.slice(0, 120),
          tags: ['git'],
          file_refs: commit.files,
          source: provenance.source,
          source_kind: 'git',
          source_ref: provenance.sourceRef,
          confidence: 1,
          valid_from: now,
          valid_to: null,
          visibility: 'shared',
          review_status: 'pending',
          reviewed_at: null,
          review_note: null,
          created_at: now,
          updated_at: now,
          archived: false,
        },
        isNew: true,
        commit,
      });
      result.imported++;
      continue;
    }

    const { entry, isNew } = store.rememberIfNew(content, {
      type,
      tags: ['git'],
      fileRefs: commit.files,
      source: provenance.source,
      sourceKind: 'git',
      sourceRef: provenance.sourceRef,
    });

    result.entries.push({ entry, isNew, commit });
    if (isNew) {
      result.imported++;
    } else {
      result.duplicates++;
    }
  }

  // Re-enable and fire a single sync after all imports
  store.setAutoSync(true);
  if (!options.dryRun && result.imported > 0) {
    store.autoSync();
  }

  return result;
}

function commitHasStrongTypeSignal(subject: string): boolean {
  if (/^(\w+)(?:\(.+?\))?[!]?:\s*/.test(subject)) return true;
  return /\b(BREAKING|fix|bug|crash|error|patch|refactor|restructure|upgrade|bump|dep|migrate)\b/i.test(subject);
}

const IVN_HOOK_MARKER = '# IVN post-commit hook';

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function buildHookScript(options: { syncPack?: boolean; packDir?: string } = {}): string {
  const lines = [
    '#!/bin/sh',
    '# IVN post-commit hook — auto-capture knowledge and sync AI rules',
    '# Installed by: ivn hook install',
    '# Safe: fails silently if ivn is not available or .ivn doesn\'t exist',
    '# IVN:START',
    'command -v ivn >/dev/null 2>&1 || exit 0',
    'ivn git-import --last 1 2>/dev/null || true',
    'ivn sync-rules 2>/dev/null || true',
  ];

  if (options.syncPack) {
    const dirFlag = options.packDir ? ` --dir ${shellQuote(options.packDir)}` : '';
    lines.push(`ivn pack sync${dirFlag} 2>/dev/null || true`);
  }

  lines.push('# IVN:END', '');
  return lines.join('\n');
}

function stripIvnHookBlock(content: string): string {
  if (content.includes('# IVN:START') && content.includes('# IVN:END')) {
    const start = content.indexOf('# IVN:START');
    const end = content.indexOf('# IVN:END');
    return (content.slice(0, start) + content.slice(end + '# IVN:END'.length)).trim();
  }

  if (!content.includes(IVN_HOOK_MARKER)) return content.trim();

  const lines = content.split('\n');
  const ivnStart = lines.findIndex((l) => l.includes(IVN_HOOK_MARKER));
  if (ivnStart === -1) return content.trim();

  let ivnEnd = ivnStart;
  for (let i = ivnStart + 1; i < lines.length; i++) {
    if (
      lines[i].trim() === '' ||
      lines[i].startsWith('#') ||
      lines[i].startsWith('command -v ivn') ||
      lines[i].startsWith('ivn ')
    ) {
      ivnEnd = i;
    } else {
      break;
    }
  }

  return [...lines.slice(0, Math.max(0, ivnStart - 1)), ...lines.slice(ivnEnd + 1)]
    .join('\n')
    .trim();
}

export function installHook(
  projectRoot: string,
  options: { syncPack?: boolean; packDir?: string } = {},
): { hookPath: string; alreadyExists: boolean; updated: boolean } {
  if (!isGitRepo(projectRoot)) {
    throw new Error('Not a git repository. Cannot install hook.');
  }

  const gitRoot = getGitRoot(projectRoot);
  const hooksDir = join(gitRoot, '.git', 'hooks');
  const hookPath = join(hooksDir, 'post-commit');
  const hookScript = buildHookScript(options);

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf-8');
    if (existing.includes(IVN_HOOK_MARKER)) {
      const stripped = stripIvnHookBlock(existing);
      const nextContent = stripped
        ? `${stripped}\n\n${hookScript.trimEnd()}\n`
        : hookScript;

      if (existing === nextContent) {
        return { hookPath, alreadyExists: true, updated: false };
      }

      writeFileSync(hookPath, nextContent);
      chmodSync(hookPath, '755');
      return { hookPath, alreadyExists: false, updated: true };
    }
    const merged = existing.trimEnd() + '\n\n' + hookScript.split('\n').slice(1).join('\n');
    writeFileSync(hookPath, merged);
    chmodSync(hookPath, '755');
    return { hookPath, alreadyExists: false, updated: false };
  }

  writeFileSync(hookPath, hookScript);
  chmodSync(hookPath, '755');
  return { hookPath, alreadyExists: false, updated: false };
}

const PRE_COMMIT_MARKER = '# IVN pre-commit check';

function buildPreCommitScript(): string {
  return [
    '#!/bin/sh',
    '# IVN pre-commit check — validate staged files against known gotchas',
    '# Installed by: ivn hook install --pre-commit',
    '# IVN:PRE-COMMIT:START',
    'command -v ivn >/dev/null 2>&1 || exit 0',
    'ivn check --changed 2>/dev/null',
    'if [ $? -ne 0 ]; then',
    '  echo ""',
    '  echo "  ivn check found violations. Commit blocked."',
    '  echo "  Run \\`ivn check --changed\\` to see details."',
    '  echo "  Use \\`git commit --no-verify\\` to skip."',
    '  echo ""',
    '  exit 1',
    'fi',
    '# IVN:PRE-COMMIT:END',
    '',
  ].join('\n');
}

export function installPreCommitHook(
  projectRoot: string,
): { hookPath: string; installed: boolean } {
  if (!isGitRepo(projectRoot)) {
    throw new Error('Not a git repository. Cannot install hook.');
  }

  const gitRoot = getGitRoot(projectRoot);
  const hooksDir = join(gitRoot, '.git', 'hooks');
  const hookPath = join(hooksDir, 'pre-commit');
  const hookScript = buildPreCommitScript();

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf-8');
    if (existing.includes(PRE_COMMIT_MARKER)) {
      return { hookPath, installed: false };
    }
    const merged = existing.trimEnd() + '\n\n' + hookScript.split('\n').slice(1).join('\n');
    writeFileSync(hookPath, merged);
    chmodSync(hookPath, '755');
    return { hookPath, installed: true };
  }

  writeFileSync(hookPath, hookScript);
  chmodSync(hookPath, '755');
  return { hookPath, installed: true };
}

export function uninstallHook(projectRoot: string): boolean {
  if (!isGitRepo(projectRoot)) {
    throw new Error('Not a git repository.');
  }

  const gitRoot = getGitRoot(projectRoot);
  const hookPath = join(gitRoot, '.git', 'hooks', 'post-commit');

  if (!existsSync(hookPath)) return false;

  const content = readFileSync(hookPath, 'utf-8');
  if (!content.includes(IVN_HOOK_MARKER)) return false;

  const remaining = stripIvnHookBlock(content);

  if (!remaining || remaining === '#!/bin/sh') {
    unlinkSync(hookPath);
  } else {
    writeFileSync(hookPath, remaining + '\n');
    chmodSync(hookPath, '755');
  }

  return true;
}
