import type { IncomingMessage, ServerResponse } from 'node:http';
import { IvnStore } from './store.js';
import { readJsonBody as readRawJsonBody, requestHasValidToken } from './server-security.js';
import type { KnowledgeType } from './types.js';

function json(data: unknown): string {
  return JSON.stringify(data);
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json(data));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parsed = await readRawJsonBody(req);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object body.');
  }
  return parsed as Record<string, unknown>;
}

function listDashboardEdges(store: IvnStore): Array<{ source: string; target: string; type: string }> {
  const entries = store.list({ limit: 500, reviewStatus: 'all' });
  const edges: Array<{ source: string; target: string; type: string }> = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const related = store.getRelated(entry.id);
    for (const { edge } of related) {
      const key = edge.source_id + ':' + edge.target_id;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: edge.source_id, target: edge.target_id, type: edge.type });
    }
  }

  return edges;
}

async function handleReviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: IvnStore,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Use POST /api/review for dashboard review actions.' });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err: unknown) {
    const message = (err as Error).message;
    sendJson(
      res,
      message.includes('exceeds') ? 413 : 400,
      { error: message },
    );
    return;
  }
  const id = typeof body.id === 'string' ? body.id : '';
  const action = typeof body.action === 'string' ? body.action : '';
  const note = typeof body.note === 'string' ? body.note : undefined;

  if (!id) {
    sendJson(res, 400, { error: 'Missing review target id.' });
    return;
  }

  let entry = null;
  if (action === 'accept') {
    entry = store.accept(id, note);
  } else if (action === 'reject') {
    entry = store.reject(id, note);
  } else if (action === 'refresh') {
    entry = store.refresh(id, note);
  } else {
    sendJson(res, 400, { error: 'Unsupported review action.' });
    return;
  }

  if (!entry) {
    sendJson(res, 404, { error: `Knowledge #${id} was not found.` });
    return;
  }

  sendJson(res, 200, { ok: true, entry });
}

export async function handleDashboardApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: IvnStore,
  authToken: string,
): Promise<boolean> {
  const path = url.pathname;

  if (path.startsWith('/api/') && !requestHasValidToken(req, authToken)) {
    sendJson(res, 401, { error: 'Dashboard API access requires a valid IVN session token.' });
    return true;
  }

  if (path === '/api/knowledge') {
    const type = url.searchParams.get('type') as KnowledgeType | null;
    const entries = store.list({ type: type || undefined, limit: 500, reviewStatus: 'all' });
    sendJson(res, 200, entries);
    return true;
  }

  if (path === '/api/search') {
    const q = url.searchParams.get('q') || '';
    sendJson(res, 200, store.recall(q, 50));
    return true;
  }

  if (path === '/api/stats') {
    sendJson(res, 200, store.stats());
    return true;
  }

  if (path === '/api/edges') {
    sendJson(res, 200, listDashboardEdges(store));
    return true;
  }

  if (path === '/api/review') {
    await handleReviewRequest(req, res, store);
    return true;
  }

  return false;
}
