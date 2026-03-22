import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename } from 'node:path';
import { getChangedFiles } from './git.js';
import { resolveAutoKnowledgeType } from './import-classifier.js';
import { getServiceOpenApiDocument, getSpecInfo, IVN_KNOWLEDGE_SPEC_VERSION } from './spec.js';
import { IvnStore } from './store.js';
import {
  generateAccessToken,
  isLoopbackOrigin,
  normalizeAccessToken,
  readJsonBody as readRawJsonBody,
  requestHasValidToken,
} from './server-security.js';
import type {
  EdgeType,
  KnowledgeType,
  ReviewStatus,
  ReviewStatusFilter,
  SourceKind,
  Visibility,
  VisibilityFilter,
} from './types.js';
import { EDGE_TYPES, KNOWLEDGE_TYPES } from './types.js';
import { APP_VERSION } from './version.js';

const SOURCE_KINDS: SourceKind[] = ['manual', 'git', 'mcp', 'import', 'external', 'conversation'];
const VISIBILITY_VALUES: Visibility[] = ['shared', 'private'];
const VISIBILITY_FILTERS: VisibilityFilter[] = ['shared', 'private', 'all'];
const REVIEW_STATUS_VALUES: ReviewStatus[] = ['active', 'pending', 'rejected'];
const REVIEW_STATUS_FILTERS: ReviewStatusFilter[] = ['active', 'pending', 'rejected', 'all'];

export interface HttpServerHandle {
  host: string;
  port: number;
  url: string;
  authToken: string;
  close: () => Promise<void>;
}

export async function startHttpServer(
  options: { port?: number; host?: string; root?: string; authToken?: string } = {},
): Promise<HttpServerHandle> {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? 3103;
  const root = options.root;
  const authToken = options.authToken
    ? normalizeAccessToken(options.authToken, 'HTTP auth token')
    : generateAccessToken();

  const openApi = getServiceOpenApiDocument();
  const specInfo = getSpecInfo();

  const server = createServer((req, res) => {
    void handleRequest(req, res, openApi, specInfo, authToken, () => IvnStore.open(root));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on('error', reject);
  });

  const address = server.address() as AddressInfo | null;
  const actualPort = address?.port || port;
  const url = `http://${host}:${actualPort}`;

  return {
    host,
    port: actualPort,
    url,
    authToken,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  openApi: unknown;
  specInfo: ReturnType<typeof getSpecInfo>;
  authToken: string;
  openStore: () => IvnStore;
}

type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

function parseVisibilityAndStatus(url: URL) {
  return {
    visibility: parseOptionalEnum(url.searchParams.get('visibility'), VISIBILITY_FILTERS, 'visibility') || 'shared',
    reviewStatus: parseOptionalEnum(url.searchParams.get('review_status'), REVIEW_STATUS_FILTERS, 'review_status') || 'active',
  };
}

const routes: Array<{ method: string; path: string | string[]; handler: RouteHandler }> = [
  {
    method: 'GET', path: '/health',
    handler({ res, openStore }) {
      withStore(openStore, (store) => {
        const stats = store.stats();
        writeJson(res, 200, {
          ok: true, service: 'ivn-http', version: APP_VERSION,
          spec_version: IVN_KNOWLEDGE_SPEC_VERSION,
          project: basename(store.getRoot()), total_entries: stats.total,
        });
      });
    },
  },
  {
    method: 'GET', path: '/openapi.json',
    handler({ res, openApi }) { writeJson(res, 200, openApi); },
  },
  {
    method: 'GET', path: '/v1/spec',
    handler({ res }) {
      writeJson(res, 200, {
        version: IVN_KNOWLEDGE_SPEC_VERSION, openapi_url: '/openapi.json',
        knowledge_export_schema_url: '/spec/ivn-export.schema.json',
        pack_manifest_schema_url: '/spec/ivn-pack-manifest.schema.json',
      });
    },
  },
  {
    method: 'GET', path: '/spec/ivn-export.schema.json',
    handler({ res, specInfo }) { writeJson(res, 200, readSpecJson(specInfo.export_schema_path)); },
  },
  {
    method: 'GET', path: '/spec/ivn-pack-manifest.schema.json',
    handler({ res, specInfo }) { writeJson(res, 200, readSpecJson(specInfo.pack_manifest_schema_path)); },
  },
  {
    method: 'GET', path: '/v1/status',
    handler({ res, openStore }) {
      withStore(openStore, (store) => writeJson(res, 200, store.stats()));
    },
  },
  {
    method: 'GET', path: '/v1/knowledge',
    handler({ req, res, url, authToken, openStore }) {
      withStore(openStore, (store) => {
        const { visibility, reviewStatus } = parseVisibilityAndStatus(url);
        assertAuthorizedVisibility(req, authToken, visibility);
        const entries = store.list({
          type: parseOptionalEnum(url.searchParams.get('type'), KNOWLEDGE_TYPES, 'type'),
          limit: parseLimit(url.searchParams.get('limit'), 20),
          visibility, reviewStatus,
          includeArchived: parseBoolean(url.searchParams.get('include_archived')) || false,
        });
        writeJson(res, 200, { entries, count: entries.length });
      });
    },
  },
  {
    method: 'POST', path: ['/v1/knowledge', '/v1/webhooks/knowledge'],
    async handler({ req, res, authToken, openStore }) {
      assertAuthorizedWrite(req, authToken);
      const body = await readJsonBody(req);
      const payload = asRecord(body, '$');
      const content = requireString(payload.content, 'content');
      const type = await resolveAutoKnowledgeType(content, {
        type: parseOptionalEnum(payload.type, KNOWLEDGE_TYPES, 'type'),
      });
      withStore(openStore, (store) => {
        const { entry, isNew } = store.rememberIfNew(content, {
          type,
          tags: parseOptionalStringArray(payload.tags, 'tags'),
          fileRefs: parseOptionalStringArray(payload.file_refs, 'file_refs'),
          source: optionalString(payload.source, 'source') || 'http',
          sourceKind: parseOptionalEnum(payload.source_kind, SOURCE_KINDS, 'source_kind') || 'external',
          sourceRef: optionalNullableString(payload.source_ref, 'source_ref'),
          confidence: optionalNumber(payload.confidence, 'confidence'),
          visibility: parseOptionalEnum(payload.visibility, VISIBILITY_VALUES, 'visibility'),
          reviewStatus: parseOptionalEnum(payload.review_status, REVIEW_STATUS_VALUES, 'review_status'),
          reviewNote: optionalNullableString(payload.review_note, 'review_note'),
          summary: optionalString(payload.summary, 'summary'),
        });
        writeJson(res, isNew ? 201 : 200, { created: isNew, entry });
      });
    },
  },
  {
    method: 'POST', path: '/v1/links',
    async handler({ req, res, authToken, openStore }) {
      assertAuthorizedWrite(req, authToken);
      const body = await readJsonBody(req);
      const payload = asRecord(body, '$');
      const sourceId = requireString(payload.source_id, 'source_id');
      const targetId = requireString(payload.target_id, 'target_id');
      const type = parseOptionalEnum(payload.type, EDGE_TYPES, 'type') || 'relates_to';
      withStore(openStore, (store) => writeJson(res, 201, { edge: store.link(sourceId, targetId, type as EdgeType) }));
    },
  },
  {
    method: 'GET', path: '/v1/recall',
    handler({ req, res, url, authToken, openStore }) {
      const query = requireString(url.searchParams.get('query'), 'query');
      withStore(openStore, (store) => {
        const { visibility, reviewStatus } = parseVisibilityAndStatus(url);
        assertAuthorizedVisibility(req, authToken, visibility);
        const results = store.recall(
          query, parseLimit(url.searchParams.get('limit'), 10),
          visibility, reviewStatus, url.searchParams.get('file_path') || undefined,
        );
        writeJson(res, 200, { results, count: results.length });
      });
    },
  },
  {
    method: 'GET', path: '/v1/context',
    handler({ req, res, url, authToken, openStore }) {
      withStore(openStore, (store) => {
        const { visibility, reviewStatus } = parseVisibilityAndStatus(url);
        assertAuthorizedVisibility(req, authToken, visibility);
        writeJson(res, 200, {
          context: store.context(
            url.searchParams.get('query') || undefined,
            url.searchParams.get('file_path') || undefined,
            visibility, reviewStatus,
          ),
        });
      });
    },
  },
  {
    method: 'GET', path: '/v1/focus',
    handler({ req, res, url, authToken, openStore }) {
      const filePath = requireString(url.searchParams.get('file_path'), 'file_path');
      withStore(openStore, (store) => {
        const { visibility, reviewStatus } = parseVisibilityAndStatus(url);
        assertAuthorizedVisibility(req, authToken, visibility);
        const results = store.focus(
          filePath, parseLimit(url.searchParams.get('limit'), 10), visibility, reviewStatus,
        );
        writeJson(res, 200, { results, count: results.length });
      });
    },
  },
  {
    method: 'GET', path: '/v1/changed',
    handler({ req, res, url, authToken, openStore }) {
      withStore(openStore, (store) => {
        const { visibility, reviewStatus } = parseVisibilityAndStatus(url);
        assertAuthorizedVisibility(req, authToken, visibility);
        const changedFiles = getChangedFiles(store.getRoot(), url.searchParams.get('ref') || 'HEAD');
        const results = store.focusFiles(
          changedFiles, parseLimit(url.searchParams.get('limit'), 12), visibility, reviewStatus,
        );
        writeJson(res, 200, { changed_files: changedFiles, results, count: results.length });
      });
    },
  },
  {
    method: 'GET', path: '/v1/warn',
    handler({ req, res, url, authToken, openStore }) {
      withStore(openStore, (store) => {
        const limit = parseLimit(url.searchParams.get('limit'), 6);
        const { visibility, reviewStatus } = parseVisibilityAndStatus(url);
        const filePath = url.searchParams.get('file_path') || undefined;
        const changed = parseBoolean(url.searchParams.get('changed')) || false;
        assertAuthorizedVisibility(req, authToken, visibility);

        if (filePath) {
          const warnings = store.warn(filePath, limit, visibility, reviewStatus);
          writeJson(res, 200, { changed_files: [], warnings, count: warnings.length });
          return;
        }
        if (!changed) {
          throw new HttpError(422, 'VALIDATION_ERROR', 'Provide `file_path` or `changed=true`.');
        }
        const changedFiles = getChangedFiles(store.getRoot(), url.searchParams.get('ref') || 'HEAD');
        const warnings = store.warnFiles(changedFiles, limit, visibility, reviewStatus);
        writeJson(res, 200, { changed_files: changedFiles, warnings, count: warnings.length });
      });
    },
  },
  {
    method: 'GET', path: '/v1/contradictions',
    handler({ req, res, url, authToken, openStore }) {
      withStore(openStore, (store) => {
        const { visibility, reviewStatus } = parseVisibilityAndStatus(url);
        const filePath = url.searchParams.get('file_path') || undefined;
        const changed = parseBoolean(url.searchParams.get('changed')) || false;
        assertAuthorizedVisibility(req, authToken, visibility);
        const filePaths = filePath
          ? [filePath]
          : changed ? getChangedFiles(store.getRoot(), url.searchParams.get('ref') || 'HEAD') : undefined;
        const findings = store.contradictions({
          filePaths, limit: parseLimit(url.searchParams.get('limit'), 20), visibility, reviewStatus,
        });
        writeJson(res, 200, { findings, count: findings.length, file_paths: filePaths || [] });
      });
    },
  },
];

function matchRoute(method: string, path: string): RouteHandler | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    if (paths.includes(path)) return route.handler;
  }
  return null;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  openApi: unknown,
  specInfo: ReturnType<typeof getSpecInfo>,
  authToken: string,
  openStore: () => IvnStore,
): Promise<void> {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const method = req.method || 'GET';
  const url = new URL(req.url || '/', 'http://localhost');
  const ctx: RouteContext = { req, res, url, openApi, specInfo, authToken, openStore };

  try {
    const handler = matchRoute(method, url.pathname);
    if (!handler) throw new HttpError(404, 'NOT_FOUND', `No route for ${method} ${url.pathname}`);
    await handler(ctx);
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      writeError(res, err.status, err.code, err.message, err.details);
      return;
    }
    writeError(res, 500, 'INTERNAL_ERROR', 'Internal server error.');
  }
}

function withStore<T>(openStore: () => IvnStore, run: (store: IvnStore) => T): T {
  const store = openStore();
  try {
    return run(store);
  } finally {
    store.close();
  }
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && isLoopbackOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Ivn-Token');
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function writeError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Array<{ field: string; message: string }>,
): void {
  writeJson(res, status, {
    error: {
      code,
      message,
      ...(details && details.length > 0 ? { details } : {}),
    },
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  try {
    return await readRawJsonBody(req);
  } catch (err: unknown) {
    const message = (err as Error).message;
    if (message.includes('exceeds')) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', message);
    }
    if (message.startsWith('Invalid JSON body:')) {
      throw new HttpError(400, 'IVNALID_JSON', message);
    }
    throw new HttpError(422, 'VALIDATION_ERROR', message);
  }
}

function assertAuthorizedWrite(req: IncomingMessage, authToken: string): void {
  if (requestHasValidToken(req, authToken)) return;
  throw new HttpError(401, 'AUTH_REQUIRED', 'Write access requires a valid IVN auth token.');
}

function assertAuthorizedVisibility(
  req: IncomingMessage,
  authToken: string,
  visibility: VisibilityFilter,
): void {
  if (visibility === 'shared') return;
  if (requestHasValidToken(req, authToken)) return;
  throw new HttpError(401, 'AUTH_REQUIRED', 'Private visibility requires a valid IVN auth token.');
}

function readSpecJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseLimit(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new HttpError(422, 'VALIDATION_ERROR', 'Limit must be a positive integer.', [
      { field: 'limit', message: 'Expected a positive integer.' },
    ]);
  }
  return Math.min(parsed, 500);
}

function parseBoolean(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new HttpError(422, 'VALIDATION_ERROR', 'Boolean query parameters must be `true` or `false`.');
}

function parseOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && allowed.includes(value as T)) {
    return value as T;
  }
  throw new HttpError(422, 'VALIDATION_ERROR', `Invalid value for ${field}.`, [
    { field, message: `Expected one of: ${allowed.join(', ')}.` },
  ]);
}

function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HttpError(422, 'VALIDATION_ERROR', `Invalid value for ${field}.`, [
      { field, message: 'Expected an array of strings.' },
    ]);
  }
  return value as string[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(422, 'VALIDATION_ERROR', `Missing or invalid ${field}.`, [
      { field, message: 'Expected a non-empty string.' },
    ]);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new HttpError(422, 'VALIDATION_ERROR', `Invalid value for ${field}.`, [
      { field, message: 'Expected a string.' },
    ]);
  }
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(422, 'VALIDATION_ERROR', `Invalid value for ${field}.`, [
      { field, message: 'Expected a string or null.' },
    ]);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new HttpError(422, 'VALIDATION_ERROR', `Invalid value for ${field}.`, [
      { field, message: 'Expected a number.' },
    ]);
  }
  return value;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(422, 'VALIDATION_ERROR', 'Expected a JSON object request body.', [
      { field, message: 'Expected an object.' },
    ]);
  }
  return value as Record<string, unknown>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
  }
}
