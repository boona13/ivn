import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkFiles } from '../src/check.js';
import { syncRules } from '../src/share.js';
import { IvnStore } from '../src/store.js';

async function withTempProject(run: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ivn-scale-test-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('checkFiles evaluates rules beyond the first 200 knowledge entries', async () => {
  await withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('Never use blocked target marker in production code.', { type: 'gotcha' });

    for (let i = 0; i < 210; i++) {
      store.remember(`Never use filler marker ${i} in production code.`, { type: 'gotcha' });
    }

    const filePath = 'src/handler.ts';
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, filePath), 'const marker = "blocked target marker";\n');

    const result = checkFiles(store, [filePath]);
    store.close();

    assert.equal(result.violations.length >= 1, true);
    assert.match(result.violations[0]?.knowledge.content || '', /blocked target marker/);
  });
});

test('stale analysis still sees entries older than the newest 10000 rows', async () => {
  await withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    const staleEntry = store.remember('Old deployment rollback note that must be revalidated.', {
      type: 'context',
    });

    for (let i = 0; i < 10020; i++) {
      store.remember(`Recent filler entry ${i} for corpus scaling coverage.`, { type: 'context' });
    }
    store.close();

    const db = new Database(join(root, '.ivn', 'knowledge.db'));
    const oldIso = new Date(Date.now() - 240 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE knowledge
       SET created_at = ?, updated_at = ?, reviewed_at = ?, valid_from = ?
       WHERE id = ?`,
    ).run(oldIso, oldIso, oldIso, oldIso, staleEntry.id);
    db.close();

    const reopened = IvnStore.open(root);
    const stale = reopened.stale({ limit: 5 });
    reopened.close();

    assert.equal(stale.some((entry) => entry.id === staleEntry.id), true);
  });
});

test('contradiction analysis still sees older conflicts beyond the newest 10000 rows', async () => {
  await withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('We decided src/auth/session.ts should bypass the repository layer for auth writes.');
    store.remember('All auth writes in src/auth/session.ts must go through the repository layer.');

    for (let i = 0; i < 10020; i++) {
      store.remember(`Recent contradiction filler ${i} for scaling coverage.`, { type: 'context' });
    }

    const findings = store.contradictions({ limit: 10 });
    store.close();

    assert.equal(findings.some((finding) => finding.kind === 'decision_pattern_conflict'), true);
  });
});

test('link reuses an existing edge signature instead of creating duplicates', async () => {
  await withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    const source = store.remember('We decided auth writes go through the repository layer.');
    const target = store.remember('All auth writes must use the repository layer.');

    const first = store.link(source.id, target.id, 'implements');
    const second = store.link(source.id, target.id, 'implements');
    const related = store.getRelated(source.id).filter((item) => item.edge.type === 'implements');

    store.close();

    assert.equal(second.id, first.id);
    assert.equal(related.length, 1);
  });
});

test('syncRules still projects durable knowledge across thousands of entries', async () => {
  await withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('Old durable decision: auth writes must use the repository layer.', {
      type: 'decision',
    });

    for (let i = 0; i < 2500; i++) {
      store.remember(`Scale filler entry ${i} to simulate a long-lived repository corpus.`, {
        type: 'context',
      });
    }

    store.remember('Newest gotcha: webhook retries must stay idempotent under duplicate delivery.', {
      type: 'gotcha',
    });
    syncRules(store, { targets: ['generic'] });
    store.close();

    const knowledgeFile = readFileSync(join(root, 'KNOWLEDGE.md'), 'utf8');
    assert.match(knowledgeFile, /Old durable decision: auth writes must use the repository layer\./);
    assert.match(knowledgeFile, /Newest gotcha: webhook retries must stay idempotent/);
  });
});
