import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';
import { importFromGit } from '../src/git.js';
import { IvnStore } from '../src/store.js';
import { runGit, withTempProject } from './test-helpers.js';

function commitAll(root: string, subject: string, body?: string): void {
  runGit(root, ['add', '.']);
  const args = [
    '-c', 'user.name=IVN Test',
    '-c', 'user.email=ivn@example.com',
    'commit',
    '-m',
    subject,
  ];
  if (body) {
    args.push('-m', body);
  }
  runGit(root, args);
}

test('git-import skips vague cleanup commits without explanatory body', async () => {
  await withTempProject(async (root) => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const version = 1;\n');

    runGit(root, ['init']);
    commitAll(root, 'cleanup auth flow');

    IvnStore.init(root);
    const store = IvnStore.open(root);
    const result = await importFromGit(store, { last: 1 });
    store.close();

    assert.equal(result.total, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.imported, 0);
    assert.equal(result.entries.length, 0);
  });
});

test('git-import keeps weak-subject commits when the body carries durable detail', async () => {
  await withTempProject(async (root) => {
    mkdirSync(join(root, 'src', 'auth'), { recursive: true });
    writeFileSync(join(root, 'src', 'auth', 'session.ts'), 'export const SESSION_TTL = 86400;\n');

    runGit(root, ['init']);
    commitAll(
      root,
      'update auth flow',
      'Route session refresh writes through the repository layer so the API and dashboard stay consistent.',
    );

    const fullHash = runGit(root, ['rev-parse', 'HEAD']).trim();
    const shortHash = runGit(root, ['rev-parse', '--short', 'HEAD']).trim();

    IvnStore.init(root);
    const store = IvnStore.open(root);
    const result = await importFromGit(store, { last: 1 });
    store.close();

    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.entries[0]?.entry.source, `git:${shortHash}`);
    assert.equal(result.entries[0]?.entry.source_ref, fullHash);
    assert.match(result.entries[0]?.entry.content || '', /repository layer/i);
    assert.equal(result.entries[0]?.commit.author, 'IVN Test');
    assert.match(result.entries[0]?.commit.date || '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('git-import rejects malformed since values with an actionable error', async () => {
  await withTempProject(async (root) => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const ok = true;\n');

    runGit(root, ['init']);
    commitAll(root, 'feat: seed project');

    IvnStore.init(root);
    const store = IvnStore.open(root);
    await assert.rejects(
      () => importFromGit(store, { since: '2026-03-21\nHEAD' }),
      /Git `since` value is invalid/i,
    );
    store.close();
  });
});

test('git-import can scope history to selected paths', async () => {
  await withTempProject(async (root) => {
    mkdirSync(join(root, 'src', 'memory'), { recursive: true });
    mkdirSync(join(root, 'src', 'browser'), { recursive: true });
    writeFileSync(join(root, 'src', 'memory', 'prompt-section.ts'), 'export const memory = true;\n');
    writeFileSync(join(root, 'src', 'browser', 'server-context.ts'), 'export const browser = true;\n');

    runGit(root, ['init']);
    commitAll(
      root,
      'feat(memory): add pluggable prompt section',
      'Memory plugins can extend a dedicated system prompt section.',
    );

    writeFileSync(join(root, 'src', 'browser', 'server-context.ts'), 'export const browser = false;\n');
    commitAll(
      root,
      'fix(browser): harden existing-session support',
      'Browser existing-session validation now recognizes chrome mcp auto-connect.',
    );

    IvnStore.init(root);
    const store = IvnStore.open(root);
    const result = await importFromGit(store, {
      last: 10,
      paths: ['src/memory'],
    });
    store.close();

    assert.equal(result.total, 1);
    assert.equal(result.imported, 1);
    assert.equal(result.entries.length, 1);
    assert.match(result.entries[0]?.entry.content || '', /memory plugins/i);
    assert.deepEqual(result.entries[0]?.entry.file_refs, ['src/memory/prompt-section.ts']);
  });
});
