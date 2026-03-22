import test from 'node:test';
import assert from 'node:assert/strict';
import { IvnStore } from '../src/store.js';
import { startHttpServer } from '../src/http.js';
import { IVN_KNOWLEDGE_SPEC_VERSION } from '../src/spec.js';
import { startDashboard } from '../src/web.js';
import { withTempProject } from './test-helpers.js';

test('http service exposes openapi and supports recall plus webhook ingestion', async () => {
  await withTempProject(async (root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('We decided the HTTP service should mirror the stable spec.', { type: 'decision' });
    store.close();

    const server = await startHttpServer({ root, port: 0 });
    try {
      const healthResponse = await fetch(`${server.url}/health`);
      assert.equal(healthResponse.status, 200);
      const health = await healthResponse.json() as {
        ok: boolean;
        service: string;
        spec_version: string;
      };
      assert.equal(health.ok, true);
      assert.equal(health.service, 'ivn-http');
      assert.equal(health.spec_version, IVN_KNOWLEDGE_SPEC_VERSION);

      const openApiResponse = await fetch(`${server.url}/openapi.json`);
      assert.equal(openApiResponse.status, 200);
      const openApi = await openApiResponse.json() as { openapi: string; paths: Record<string, unknown> };
      assert.equal(openApi.openapi, '3.1.0');
      assert.equal(typeof openApi.paths['/v1/knowledge'], 'object');

      const recallResponse = await fetch(`${server.url}/v1/recall?query=HTTP%20service`);
      assert.equal(recallResponse.status, 200);
      const recall = await recallResponse.json() as { count: number; results: Array<{ content: string }> };
      assert.equal(recall.count, 1);
      assert.match(recall.results[0]?.content || '', /HTTP service should mirror/);

      const ingestResponse = await fetch(`${server.url}/v1/webhooks/knowledge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ivn-Token': server.authToken,
        },
        body: JSON.stringify({
          content: 'Watch out: webhook ingestion should keep request formats stable.',
          type: 'gotcha',
        }),
      });
      assert.equal(ingestResponse.status, 201);
      const ingested = await ingestResponse.json() as {
        created: boolean;
        entry: { type: string; review_status: string };
      };
      assert.equal(ingested.created, true);
      assert.equal(ingested.entry.type, 'gotcha');
      assert.equal(ingested.entry.review_status, 'pending');

      const listResponse = await fetch(`${server.url}/v1/knowledge?type=gotcha&review_status=all`);
      assert.equal(listResponse.status, 200);
      const listed = await listResponse.json() as { count: number; entries: Array<{ content: string }> };
      assert.equal(listed.count, 1);
      assert.match(listed.entries[0]?.content || '', /webhook ingestion should keep request formats stable/);
    } finally {
      await server.close();
    }
  });
});

test('web dashboard serves local html and JSON endpoints', async () => {
  await withTempProject(async (root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('The local dashboard should stay rooted in project knowledge.', { type: 'context' });
    store.remember('Review the imported payment retry notes before trusting them.', {
      type: 'todo',
      reviewStatus: 'pending',
    });
    store.close();

    const dashboard = await startDashboard({ root, port: 0 });
    try {
      const htmlResponse = await fetch(dashboard.url);
      assert.equal(htmlResponse.status, 200);
      const html = await htmlResponse.text();
      assert.match(html, /<title>ivn — Project Knowledge<\/title>/);
      assert.match(html, /Local-first project memory/);
      assert.match(html, /what needs attention/i);
      assert.match(html, /role="status" aria-live="polite"/);
      assert.match(html, /\/assets\/web-dashboard\.css/);
      assert.match(html, /\/assets\/web-dashboard\.js/);
      assert.doesNotMatch(html, /cdn\.jsdelivr\.net|https?:\/\/cdn/i);

      const cssResponse = await fetch(`${dashboard.url}/assets/web-dashboard.css`);
      assert.equal(cssResponse.status, 200);
      const css = await cssResponse.text();
      assert.match(css, /:root/);
      assert.match(css, /\.focus-btn/);

      const jsResponse = await fetch(`${dashboard.url}/assets/web-dashboard.js`);
      assert.equal(jsResponse.status, 200);
      const js = await jsResponse.text();
      assert.match(js, /fetchDashboard\("\/api\/knowledge"\)/);
      assert.match(js, /function renderGraph/);

      const authHeaders = { 'X-Ivn-Token': dashboard.authToken };

      const knowledgeResponse = await fetch(`${dashboard.url}/api/knowledge`, {
        headers: authHeaders,
      });
      assert.equal(knowledgeResponse.status, 200);
      const knowledge = await knowledgeResponse.json() as Array<{ id: string; review_status: string; content: string }>;
      assert.equal(knowledge.length, 2);
      assert.equal(knowledge.some((entry) => entry.review_status === 'pending'), true);
      const pendingEntry = knowledge.find((entry) => entry.review_status === 'pending');
      assert.equal(Boolean(pendingEntry), true);

      const reviewResponse = await fetch(`${dashboard.url}/api/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ id: pendingEntry?.id, action: 'accept' }),
      });
      assert.equal(reviewResponse.status, 200);
      const reviewResult = await reviewResponse.json() as { ok: boolean; entry: { review_status: string } };
      assert.equal(reviewResult.ok, true);
      assert.equal(reviewResult.entry.review_status, 'active');

      const refreshedKnowledgeResponse = await fetch(`${dashboard.url}/api/knowledge`, {
        headers: authHeaders,
      });
      assert.equal(refreshedKnowledgeResponse.status, 200);
      const refreshedKnowledge = await refreshedKnowledgeResponse.json() as Array<{ review_status: string }>;
      assert.equal(refreshedKnowledge.some((entry) => entry.review_status === 'pending'), false);

      const statsResponse = await fetch(`${dashboard.url}/api/stats`, {
        headers: authHeaders,
      });
      assert.equal(statsResponse.status, 200);
      const stats = await statsResponse.json() as { total: number };
      assert.equal(stats.total, 2);

      const searchResponse = await fetch(`${dashboard.url}/api/search?q=dashboard`, {
        headers: authHeaders,
      });
      assert.equal(searchResponse.status, 200);
      const search = await searchResponse.json() as Array<{ content: string }>;
      assert.equal(search.length, 1);
      assert.match(search[0]?.content || '', /local dashboard should stay rooted/i);
    } finally {
      await dashboard.close();
    }
  });
});
