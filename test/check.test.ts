import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IvnStore } from '../src/store.js';
import { checkFiles } from '../src/check.js';

function withTempProject(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'ivn-check-test-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function setupStore(root: string, entries: Array<{ content: string; type?: string; tags?: string[]; fileRefs?: string[] }>): IvnStore {
  IvnStore.init(root);
  const store = IvnStore.open(root);
  for (const entry of entries) {
    store.remember(entry.content, {
      type: entry.type as 'gotcha' | 'pattern' | 'debug' | 'dependency' | undefined,
      tags: entry.tags,
      fileRefs: entry.fileRefs,
    });
  }
  return store;
}

// ── Edge runtime detection ─────────────────────────

test('check detects Edge runtime violation from "never use Edge" gotcha', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Stripe webhooks MUST use Node.js runtime, not Edge — crypto.timingSafeEqual unavailable in Edge Runtime.', type: 'gotcha', tags: ['stripe', 'webhook'] },
    ]);

    const filePath = 'src/app/api/webhooks/stripe/route.ts';
    const absPath = join(root, filePath);
    mkdirSync(join(root, 'src', 'app', 'api', 'webhooks', 'stripe'), { recursive: true });
    writeFileSync(absPath, `export const runtime = 'edge';\nexport async function POST(req: Request) { return new Response('ok'); }\n`);

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.violations.length >= 1, true, 'Should detect edge runtime violation');
    assert.equal(result.violations[0]!.line, 1);
    assert.match(result.violations[0]!.matchedText, /runtime.*edge/i);
  });
});

test('check allows Node.js runtime without violation', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Never use Edge runtime for webhook routes.', type: 'gotcha' },
    ]);

    const filePath = 'src/api/webhook.ts';
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, filePath), `export const runtime = 'nodejs';\n`);

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.violations.length, 0, 'Node.js runtime should not trigger violation');
  });
});

// ── Prisma singleton detection ─────────────────────

test('check detects new PrismaClient() when singleton gotcha is active', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Always use the PrismaClient singleton from src/lib/db.ts. Creating new instances exhausts the connection pool.', type: 'gotcha', tags: ['prisma', 'database'] },
    ]);

    const filePath = 'src/services/user.ts';
    mkdirSync(join(root, 'src', 'services'), { recursive: true });
    writeFileSync(join(root, filePath), `import { PrismaClient } from '@prisma/client';\nconst prisma = new PrismaClient();\n`);

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.violations.length >= 1, true, 'Should detect new PrismaClient()');
    assert.match(result.violations[0]!.matchedText, /new\s+PrismaClient/);
  });
});

// ── Hardcoded secrets detection ────────────────────

test('check detects hardcoded Stripe secret keys', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: "Don't hardcode API keys or secrets. Use environment variables.", type: 'gotcha' },
    ]);

    const filePath = 'src/config.ts';
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, filePath), `const key = 'sk_live_placeholder_key_for_tests_only';\n`);

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.violations.length >= 1, true, 'Should detect hardcoded Stripe key');
  });
});

// ── "never use X" extraction ───────────────────────

test('check extracts forbidden terms from "never use X" gotchas', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Never use console.log in production code.', type: 'gotcha' },
    ]);

    const filePath = 'src/handler.ts';
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, filePath), `function handle() {\n  console.log("debug");\n}\n`);

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.violations.length >= 1, true, 'Should detect forbidden console.log');
  });
});

test('check extracts core forbidden term from "do not use X in Y" gotchas', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Do not use synchronous file reads in the request path.', type: 'gotcha' },
    ]);

    const filePath = 'src/api.ts';
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, filePath), `import fs from 'fs';\nconst data = synchronous file reads;\n`);

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.violations.length >= 1, true, 'Should detect forbidden core term after qualifier stripping');
  });
});

// ── "must use X instead of Y" detection ────────────

test('check detects banned library when "must use X instead of Y" is active', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Always use dayjs instead of moment for date operations.', type: 'pattern' },
    ]);

    const filePath = 'src/utils/dates.ts';
    mkdirSync(join(root, 'src', 'utils'), { recursive: true });
    writeFileSync(join(root, filePath), `import moment from 'moment';\n`);

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.violations.length >= 1, true, 'Should detect banned moment import');
    assert.match(result.violations[0]!.matchedText, /moment/);
  });
});

// ── "prefer X over Y" detection ────────────────────

test('check detects banned alternative when "prefer X over Y" pattern is active', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Prefer fetch over axios for HTTP requests.', type: 'pattern' },
    ]);

    const filePath = 'src/api-client.ts';
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, filePath), `import axios from 'axios';\n`);

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.violations.length >= 1, true, 'Should detect banned axios import');
  });
});

// ── Rule scoping by file_refs ──────────────────────

test('check scopes rules to matching files via file_refs', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Never call raw SQL directly.', type: 'gotcha', fileRefs: ['src/api'] },
    ]);

    const apiFile = 'src/api/users.ts';
    const libFile = 'src/lib/db.ts';
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    mkdirSync(join(root, 'src', 'lib'), { recursive: true });
    writeFileSync(join(root, apiFile), `const result = raw SQL directly;\n`);
    writeFileSync(join(root, libFile), `const result = raw SQL directly;\n`);

    const result = checkFiles(store, [apiFile, libFile]);
    store.close();

    const apiViolations = result.violations.filter(v => v.file === apiFile);
    const libViolations = result.violations.filter(v => v.file === libFile);
    assert.equal(apiViolations.length >= 1, true, 'Should find violation in API file');
    assert.equal(libViolations.length, 0, 'Should not flag lib file');
  });
});

// ── Global rules (no file_refs) ────────────────────

test('check applies global rules when knowledge has no file_refs', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Never hardcode database connection strings.', type: 'gotcha' },
    ]);

    const filePath = 'src/any-file.ts';
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, filePath), `const db = "postgres://user:pass@localhost:5432/mydb";\nconst other = database connection strings;\n`);

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.violations.length >= 1, true, 'Global rule should apply to any file');
  });
});

// ── Deduplication ──────────────────────────────────

test('check deduplicates violations on the same line from the same knowledge entry', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Never use Edge runtime for webhook routes. Edge runtime is unavailable for crypto operations.', type: 'gotcha' },
    ]);

    const filePath = 'src/webhook.ts';
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, filePath), `export const runtime = 'edge';\n`);

    const result = checkFiles(store, [filePath]);
    store.close();

    const lineOneViolations = result.violations.filter(v => v.line === 1);
    const knowledgeIds = lineOneViolations.map(v => v.knowledge.id);
    const uniqueIds = new Set(knowledgeIds);
    assert.equal(knowledgeIds.length, uniqueIds.size, 'Same knowledge should not produce duplicate violations on same line');
  });
});

// ── No false positives on clean files ──────────────

test('check reports zero violations on clean files', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Never use Edge runtime for webhook routes.', type: 'gotcha' },
      { content: 'Always use the PrismaClient singleton.', type: 'gotcha', tags: ['prisma'] },
      { content: "Don't hardcode secrets.", type: 'gotcha' },
    ]);

    const filePath = 'src/clean.ts';
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, filePath), `import { prisma } from './lib/db';\nexport const runtime = 'nodejs';\nconst key = process.env.API_KEY;\n`);

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.violations.length, 0, 'Clean file should have zero violations');
  });
});

// ── Missing files are silently skipped ─────────────

test('check gracefully handles non-existent files', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Never use Edge runtime.', type: 'gotcha' },
    ]);

    const result = checkFiles(store, ['does/not/exist.ts']);
    store.close();

    assert.equal(result.violations.length, 0);
    assert.deepEqual(result.files, ['does/not/exist.ts']);
  });
});

// ── Stats are reported correctly ───────────────────

test('check reports correct gotcha and pattern counts', () => {
  withTempProject((root) => {
    const store = setupStore(root, [
      { content: 'Watch out: edge runtime breaks crypto.', type: 'gotcha' },
      { content: 'Watch out: singleton pattern required for DB.', type: 'gotcha' },
      { content: 'All routes must use Zod validation.', type: 'pattern' },
    ]);

    const filePath = 'src/test.ts';
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, filePath), 'const x = 1;\n');

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.gotchasChecked, 2);
    assert.equal(result.patternsChecked, 1);
  });
});
