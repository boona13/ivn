import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.IVN_DISABLE_ML_IMPORTS = '1';

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const FIXTURES_ROOT = join(REPO_ROOT, 'test', 'fixtures', 'compatibility');
export const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
export const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');

export function withTempProject(run: (root: string) => void | Promise<void>): void | Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ivn-test-'));
  let result: void | Promise<void>;
  try {
    result = run(root);
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }

  if (result && typeof (result as Promise<void>).then === 'function') {
    return Promise.resolve(result).finally(() => {
      rmSync(root, { recursive: true, force: true });
    });
  }

  try {
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function runGit(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
  });
}

export function runCli(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): string {
  return execFileSync(TSX_BIN, [CLI_ENTRY, ...args], {
    cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
  });
}

export function runCliExpectFailure(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): string {
  try {
    runCli(cwd, args, options);
  } catch (err: unknown) {
    const stdout = typeof (err as { stdout?: unknown }).stdout === 'string'
      ? (err as { stdout: string }).stdout
      : '';
    const stderr = typeof (err as { stderr?: unknown }).stderr === 'string'
      ? (err as { stderr: string }).stderr
      : '';
    return `${stdout}${stderr}`;
  }

  throw new Error(`Expected CLI to fail: ivn ${args.join(' ')}`);
}

export function createLegacyProject(root: string): void {
  const ivnDir = join(root, '.ivn');
  mkdirSync(ivnDir, { recursive: true });
  writeFileSync(
    join(ivnDir, 'config.json'),
    JSON.stringify(
      {
        name: 'legacy-project',
        created_at: '2026-03-20T00:00:00.000Z',
        version: '0.1.0',
      },
      null,
      2,
    ),
  );

  const db = new Database(join(ivnDir, 'knowledge.db'));
  db.exec(`
    CREATE TABLE knowledge (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.prepare(
    `INSERT INTO knowledge (id, type, content, summary, tags, source, created_at, updated_at, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    'deadbeef',
    'decision',
    'We chose SQLite for local-first memory.',
    'We chose SQLite for local-first memory.',
    '["database"]',
    'git:abc12345',
    '2026-03-20T00:00:00.000Z',
    '2026-03-20T00:00:00.000Z',
  );

  db.pragma('user_version = 0');
  db.close();
}
