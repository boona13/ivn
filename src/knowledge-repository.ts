import Database from 'better-sqlite3';
import { toKnowledgeEvent } from './knowledge-ledger.js';
import { toEdgeRecord, toKnowledgeRecord } from './knowledge-records.js';
import type {
  Edge,
  Knowledge,
  KnowledgeEvent,
  KnowledgeType,
  ReviewStatusFilter,
  VisibilityFilter,
} from './types.js';

export interface ListKnowledgeOptions {
  type?: KnowledgeType;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
  visibility?: VisibilityFilter;
  reviewStatus?: ReviewStatusFilter;
}

export interface SnapshotData {
  entries: Knowledge[];
  events: KnowledgeEvent[];
  edges: Edge[];
}

export function listKnowledge(options: {
  db: Database.Database;
  root: string;
  defaultConfidence: number;
  filters?: ListKnowledgeOptions;
}): Knowledge[] {
  const {
    db,
    root,
    defaultConfidence,
    filters = {},
  } = options;
  const {
    type,
    limit = 50,
    offset = 0,
    includeArchived = false,
    visibility = 'all',
    reviewStatus = 'active',
  } = filters;

  const { sql, params } = buildKnowledgeSelectSql({
    type,
    includeArchived,
    visibility,
    reviewStatus,
  });
  let pagedSql = sql;
  pagedSql += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(pagedSql).all(...params) as Record<string, unknown>[];
  return rows.map((row) =>
    toKnowledgeRecord({ row, root, defaultConfidence }),
  );
}

export function listAllKnowledge(options: {
  db: Database.Database;
  root: string;
  defaultConfidence: number;
  filters?: Omit<ListKnowledgeOptions, 'limit' | 'offset'>;
}): Knowledge[] {
  const {
    db,
    root,
    defaultConfidence,
    filters = {},
  } = options;
  const { sql, params } = buildKnowledgeSelectSql(filters);
  const rows = db
    .prepare(`${sql} ORDER BY created_at DESC, id DESC`)
    .all(...params) as Record<string, unknown>[];
  return rows.map((row) => toKnowledgeRecord({ row, root, defaultConfidence }));
}

export function getKnowledgeById(options: {
  db: Database.Database;
  root: string;
  defaultConfidence: number;
  id: string;
  includeArchived?: boolean;
}): Knowledge | null {
  const { db, root, defaultConfidence, id, includeArchived = false } = options;
  const row = db
    .prepare(
      `SELECT * FROM knowledge WHERE id = ? ${includeArchived ? '' : 'AND archived = 0'}`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? toKnowledgeRecord({ row, root, defaultConfidence }) : null;
}

export function getEdgeById(db: Database.Database, id: string): Edge | null {
  const row = db
    .prepare('SELECT * FROM edges WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? toEdgeRecord(row) : null;
}

export function getEdgesForKnowledge(
  db: Database.Database,
  id: string,
  direction: 'incoming' | 'outgoing' | 'both' = 'both',
): Edge[] {
  let rows: Array<Record<string, unknown>>;

  if (direction === 'incoming') {
    rows = db
      .prepare('SELECT * FROM edges WHERE target_id = ? ORDER BY created_at ASC')
      .all(id) as Array<Record<string, unknown>>;
  } else if (direction === 'outgoing') {
    rows = db
      .prepare('SELECT * FROM edges WHERE source_id = ? ORDER BY created_at ASC')
      .all(id) as Array<Record<string, unknown>>;
  } else {
    rows = db
      .prepare('SELECT * FROM edges WHERE source_id = ? OR target_id = ? ORDER BY created_at ASC')
      .all(id, id) as Array<Record<string, unknown>>;
  }

  return rows.map((row) => toEdgeRecord(row));
}

export function queryRecallRows(options: {
  db: Database.Database;
  ftsQuery: string;
  limit: number;
  visibility: VisibilityFilter;
  reviewStatus: ReviewStatusFilter;
}): Array<Record<string, unknown>> {
  const { db, ftsQuery, limit, visibility, reviewStatus } = options;
  const visibilityClause = visibility === 'all' ? '' : ' AND k.visibility = ?';
  const reviewClause = reviewStatus === 'all' ? '' : ' AND k.review_status = ?';
  const queryParams: unknown[] = [ftsQuery];
  if (visibility !== 'all') queryParams.push(visibility);
  if (reviewStatus !== 'all') queryParams.push(reviewStatus);
  queryParams.push(limit);

  return db
    .prepare(
      `SELECT k.*, fts.rank
       FROM knowledge_fts fts
       JOIN knowledge k ON k.rowid = fts.rowid
       WHERE knowledge_fts MATCH ? AND k.archived = 0${visibilityClause}${reviewClause}
       ORDER BY fts.rank
       LIMIT ?`,
    )
    .all(...queryParams) as Array<Record<string, unknown>>;
}

export function queryDuplicateCandidateRows(
  db: Database.Database,
  ftsQuery: string,
): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT k.*
       FROM knowledge_fts fts
       JOIN knowledge k ON k.rowid = fts.rowid
       WHERE knowledge_fts MATCH ? AND k.archived = 0
       ORDER BY fts.rank
       LIMIT 10`,
    )
    .all(ftsQuery) as Array<Record<string, unknown>>;
}

export function getEdgeBySignature(
  db: Database.Database,
  sourceId: string,
  targetId: string,
  type: string,
): Edge | null {
  const row = db
    .prepare(
      'SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ? ORDER BY created_at ASC LIMIT 1',
    )
    .get(sourceId, targetId, type) as Record<string, unknown> | undefined;
  return row ? toEdgeRecord(row) : null;
}

export function listSupersedesEdges(db: Database.Database): Edge[] {
  return db
    .prepare("SELECT * FROM edges WHERE type = 'supersedes' ORDER BY created_at DESC")
    .all()
    .map((row) => toEdgeRecord(row as Record<string, unknown>));
}

export function countActiveKnowledge(db: Database.Database): number {
  return (
    db
      .prepare('SELECT COUNT(*) as c FROM knowledge WHERE archived = 0')
      .get() as { c: number }
  ).c;
}

export function countPendingKnowledge(db: Database.Database): number {
  return (
    db
      .prepare("SELECT COUNT(*) as c FROM knowledge WHERE archived = 0 AND review_status = 'pending'")
      .get() as { c: number }
  ).c;
}

export function listKnowledgeTypeCounts(
  db: Database.Database,
): Array<{ type: string; count: number }> {
  return (db
    .prepare('SELECT type, COUNT(*) as c FROM knowledge WHERE archived = 0 GROUP BY type')
    .all() as Array<{ type: string; c: number }>)
    .map((row) => ({ type: row.type, count: row.c }));
}

export function countKnowledge(db: Database.Database): number {
  return (
    db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as { c: number }
  ).c;
}

function buildKnowledgeSelectSql(filters: Omit<ListKnowledgeOptions, 'limit' | 'offset'>): {
  sql: string;
  params: unknown[];
} {
  const {
    type,
    includeArchived = false,
    visibility = 'all',
    reviewStatus = 'active',
  } = filters;

  let sql = 'SELECT * FROM knowledge';
  const params: unknown[] = [];
  const where: string[] = [];

  if (!includeArchived) where.push('archived = 0');
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (visibility !== 'all') {
    where.push('visibility = ?');
    params.push(visibility);
  }
  if (reviewStatus !== 'all') {
    where.push('review_status = ?');
    params.push(reviewStatus);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');

  return { sql, params };
}

export function countEdges(db: Database.Database): number {
  return (
    db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }
  ).c;
}

export function loadSnapshotData(options: {
  db: Database.Database;
  root: string;
  defaultConfidence: number;
}): SnapshotData {
  const { db, root, defaultConfidence } = options;
  const rows = db
    .prepare('SELECT * FROM knowledge ORDER BY created_at DESC')
    .all() as Array<Record<string, unknown>>;
  const entries = rows.map((row) =>
    toKnowledgeRecord({ row, root, defaultConfidence }),
  );
  const events = db
    .prepare('SELECT * FROM knowledge_events ORDER BY created_at ASC')
    .all()
    .map((row) => toKnowledgeEvent(row as Record<string, unknown>));
  const edges = (db
    .prepare('SELECT * FROM edges ORDER BY created_at DESC')
    .all() as Array<Record<string, unknown>>)
    .map((row) => toEdgeRecord(row));

  return { entries, events, edges };
}

export function listLinkedPairKeys(db: Database.Database): Set<string> {
  const rows = db
    .prepare('SELECT source_id, target_id FROM edges')
    .all() as Array<{ source_id: string; target_id: string }>;
  return new Set(rows.map((row) => [row.source_id, row.target_id].sort().join(':')));
}
