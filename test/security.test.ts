import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getChangedFiles } from '../src/git.js';
import { startHttpServer } from '../src/http.js';
import { mergeKnowledgePack } from '../src/share.js';
import { IvnStore } from '../src/store.js';
import { startDashboard } from '../src/web.js';

async function withTempProject(run: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ivn-security-test-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runGit(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
  });
}

test('getChangedFiles rejects unsafe git refs before running git', async () => {
  await withTempProject((root) => {
    runGit(root, ['init']);
    assert.throws(
      () => getChangedFiles(root, 'HEAD"; touch /tmp/pwned'),
      /Unsafe git ref/i,
    );
  });
});

test('mergeKnowledgePack rejects manifest file paths that escape the pack directory', async () => {
  await withTempProject((root) => {
    IvnStore.init(root);
    const packDir = join(root, '.ivn', 'pack');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'manifest.json'),
      JSON.stringify(
        {
          spec: 'ivn-knowledge-pack-manifest',
          spec_version: '1.0.0',
          version: '0.1.0',
          exported_at: '2026-03-21T00:00:00.000Z',
          project: 'security-fixture',
          visibility: 'shared',
          count: 1,
          merge_strategy: 'dedupe-by-content-and-link-replay',
          files: {
            json: '../outside.json',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(root, 'outside.json'), JSON.stringify({}));

    const store = IvnStore.open(root);
    assert.throws(
      () => mergeKnowledgePack(store, '.ivn/pack'),
      /must stay within the pack directory/i,
    );
    store.close();
  });
});

test('http service defaults to shared visibility and requires auth for writes and private reads', async () => {
  await withTempProject(async (root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('Shared decision about deployment.', { visibility: 'shared' });
    store.remember('Private operator note about rollback steps.', { visibility: 'private' });
    store.close();

    const server = await startHttpServer({ root, port: 0 });
    try {
      const sharedResponse = await fetch(`${server.url}/v1/knowledge?review_status=all`);
      assert.equal(sharedResponse.status, 200);
      const sharedPayload = await sharedResponse.json() as { count: number; entries: Array<{ visibility: string }> };
      assert.equal(sharedPayload.count, 1);
      assert.equal(sharedPayload.entries[0]?.visibility, 'shared');

      const privateResponse = await fetch(`${server.url}/v1/knowledge?visibility=all&review_status=all`);
      assert.equal(privateResponse.status, 401);

      const privateAuthedResponse = await fetch(`${server.url}/v1/knowledge?visibility=all&review_status=all`, {
        headers: { 'X-Ivn-Token': server.authToken },
      });
      assert.equal(privateAuthedResponse.status, 200);
      const privatePayload = await privateAuthedResponse.json() as { count: number };
      assert.equal(privatePayload.count, 2);

      const writeResponse = await fetch(`${server.url}/v1/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Should be rejected without auth.' }),
      });
      assert.equal(writeResponse.status, 401);
    } finally {
      await server.close();
    }
  });
});

test('dashboard API requires the issued session token', async () => {
  await withTempProject(async (root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('Shared dashboard entry.');
    store.close();

    const dashboard = await startDashboard({ root, port: 0 });
    try {
      const deniedResponse = await fetch(`${dashboard.url}/api/knowledge`);
      assert.equal(deniedResponse.status, 401);

      const allowedResponse = await fetch(`${dashboard.url}/api/knowledge`, {
        headers: { 'X-Ivn-Token': dashboard.authToken },
      });
      assert.equal(allowedResponse.status, 200);
      const entries = await allowedResponse.json() as Array<{ content: string }>;
      assert.equal(entries.length, 1);
      assert.match(entries[0]?.content || '', /dashboard entry/i);
    } finally {
      await dashboard.close();
    }
  });
});
