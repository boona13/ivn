import type Database from 'better-sqlite3';
import type {
  Edge,
  Knowledge,
  KnowledgeDiffItem,
  KnowledgeEvent,
  KnowledgeEventType,
  ReviewStatus,
  ReviewStatusFilter,
  SnapshotEntry,
  SnapshotResult,
  SourceKind,
  VisibilityFilter,
} from './types.js';

export function toKnowledgeEvent(row: Record<string, unknown>): KnowledgeEvent {
  return {
    id: row.id as string,
    type: row.type as KnowledgeEventType,
    knowledge_id: (row.knowledge_id as string | null | undefined) ?? null,
    edge_id: (row.edge_id as string | null | undefined) ?? null,
    created_at: row.created_at as string,
  };
}

export function buildKnowledgeEventInsertParams(options: {
  id: string;
  type: KnowledgeEventType;
  knowledgeId?: string | null;
  edgeId?: string | null;
  createdAt: string;
}): unknown[] {
  const { id, type, knowledgeId, edgeId, createdAt } = options;
  return [
    id,
    type,
    knowledgeId ?? null,
    edgeId ?? null,
    createdAt,
  ];
}

export function buildKnowledgeEventRowsQuery(since?: string): { sql: string; params: unknown[] } {
  let sql = 'SELECT * FROM knowledge_events';
  const params: unknown[] = [];

  if (since) {
    sql += ' WHERE datetime(created_at) >= datetime(?)';
    params.push(since);
  }

  sql += ' ORDER BY created_at DESC';
  return { sql, params };
}

export function listKnowledgeDiffItems(options: {
  rows: Array<Record<string, unknown>>;
  visibility?: VisibilityFilter;
  knowledgeId?: string;
  getEdge: (id: string) => Edge | null;
  getKnowledge: (id: string, includeArchived?: boolean) => Knowledge | null;
}): KnowledgeDiffItem[] {
  const { rows, visibility = 'all', knowledgeId, getEdge, getKnowledge } = options;
  return rows
    .map((row) => toKnowledgeDiffItem(row, getEdge, getKnowledge))
    .filter((item) => matchesDiffVisibility(item, visibility))
    .filter((item) => matchesHistoryScope(item, knowledgeId));
}

export function listKnowledgeTimelineItems(options: {
  since?: string;
  limit?: number;
  visibility?: VisibilityFilter;
  knowledgeId?: string;
  queryRows: (sql: string, params: unknown[]) => Array<Record<string, unknown>>;
  getEdge: (id: string) => Edge | null;
  getKnowledge: (id: string, includeArchived?: boolean) => Knowledge | null;
}): KnowledgeDiffItem[] {
  const {
    since,
    limit = 20,
    visibility = 'all',
    knowledgeId,
    queryRows,
    getEdge,
    getKnowledge,
  } = options;
  const { sql, params } = buildKnowledgeEventRowsQuery(since);
  const rows = queryRows(sql, params);
  return listKnowledgeDiffItems({
    rows,
    visibility,
    knowledgeId,
    getEdge,
    getKnowledge,
  }).slice(0, limit);
}

export function listKnowledgeTimelineItemsForDb(options: {
  db: Database.Database;
  since?: string;
  limit?: number;
  visibility?: VisibilityFilter;
  knowledgeId?: string;
  getEdge: (id: string) => Edge | null;
  getKnowledge: (id: string, includeArchived?: boolean) => Knowledge | null;
}): KnowledgeDiffItem[] {
  const { db, ...rest } = options;
  return listKnowledgeTimelineItems({
    ...rest,
    queryRows: (sql, params) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
  });
}

export function buildSnapshotResult(options: {
  at: string;
  limit?: number;
  visibility?: VisibilityFilter;
  reviewStatus?: ReviewStatusFilter;
  entries: Knowledge[];
  events: KnowledgeEvent[];
  edges: Edge[];
  matchesVisibility: (entry: Knowledge | null, visibility: VisibilityFilter) => boolean;
  defaultReviewStatus: (sourceKind: SourceKind) => ReviewStatus;
}): SnapshotResult {
  const {
    at,
    limit = 50,
    visibility = 'all',
    reviewStatus = 'all',
    entries,
    events,
    edges,
    matchesVisibility,
    defaultReviewStatus,
  } = options;

  const eventsByKnowledge = new Map<string, KnowledgeEvent[]>();
  for (const event of events) {
    if (!event.knowledge_id) continue;
    const group = eventsByKnowledge.get(event.knowledge_id) || [];
    group.push(event);
    eventsByKnowledge.set(event.knowledge_id, group);
  }

  const snapshotEntries = entries
    .filter((entry) => entry.created_at <= at)
    .filter((entry) => matchesVisibility(entry, visibility))
    .map((entry) =>
      toSnapshotEntry({
        entry,
        at,
        events: eventsByKnowledge.get(entry.id) || [],
        defaultReviewStatus,
      }),
    )
    .filter((entry) => entry !== null)
    .filter((entry) => reviewStatus === 'all' || entry.knowledge.review_status === reviewStatus)
    .slice(0, limit);

  const includedIds = new Set(snapshotEntries.map((entry) => entry.knowledge.id));
  const includedEdges = edges.filter(
    (edge) => edge.created_at <= at && includedIds.has(edge.source_id) && includedIds.has(edge.target_id),
  );

  return {
    at,
    exact: snapshotEntries.every((entry) => !entry.content_may_have_changed),
    entries: snapshotEntries,
    edges: includedEdges,
  };
}

export function buildKnowledgeSnapshot(options: {
  at: string;
  limit?: number;
  visibility?: VisibilityFilter;
  reviewStatus?: ReviewStatusFilter;
  loadData: () => { entries: Knowledge[]; events: KnowledgeEvent[]; edges: Edge[] };
  matchesVisibility: (entry: Knowledge | null, visibility: VisibilityFilter) => boolean;
  defaultReviewStatus: (sourceKind: SourceKind) => ReviewStatus;
}): SnapshotResult {
  const {
    at,
    limit = 50,
    visibility = 'all',
    reviewStatus = 'all',
    loadData,
    matchesVisibility,
    defaultReviewStatus,
  } = options;
  const { entries, events, edges } = loadData();
  return buildSnapshotResult({
    at,
    limit,
    visibility,
    reviewStatus,
    entries,
    events,
    edges,
    matchesVisibility,
    defaultReviewStatus,
  });
}

function toKnowledgeDiffItem(
  row: Record<string, unknown>,
  getEdge: (id: string) => Edge | null,
  getKnowledge: (id: string, includeArchived?: boolean) => Knowledge | null,
): KnowledgeDiffItem {
  const event = toKnowledgeEvent(row);
  const edge = event.edge_id ? getEdge(event.edge_id) : null;
  const knowledge = event.knowledge_id ? getKnowledge(event.knowledge_id, true) : null;

  return {
    event,
    knowledge,
    edge,
    source: edge ? getKnowledge(edge.source_id, true) : null,
    target: edge ? getKnowledge(edge.target_id, true) : null,
  };
}

function matchesDiffVisibility(item: KnowledgeDiffItem, visibility: VisibilityFilter): boolean {
  if (visibility === 'all') return true;
  if (item.knowledge) return item.knowledge.visibility === visibility;
  if (item.edge) {
    const sourceVisibility = item.source?.visibility;
    const targetVisibility = item.target?.visibility;
    if (visibility === 'shared') {
      return sourceVisibility === 'shared' && targetVisibility === 'shared';
    }
    return sourceVisibility === 'private' || targetVisibility === 'private';
  }
  return false;
}

function matchesHistoryScope(item: KnowledgeDiffItem, knowledgeId?: string): boolean {
  if (!knowledgeId) return true;
  if (item.event.knowledge_id === knowledgeId) return true;
  if (!item.edge) return false;
  return item.edge.source_id === knowledgeId || item.edge.target_id === knowledgeId;
}

function toSnapshotEntry(options: {
  entry: Knowledge;
  at: string;
  events: KnowledgeEvent[];
  defaultReviewStatus: (sourceKind: SourceKind) => ReviewStatus;
}): SnapshotEntry | null {
  const { entry, at, events, defaultReviewStatus } = options;
  if (events.some((event) => event.type === 'knowledge_archived' && event.created_at <= at)) {
    return null;
  }

  let reviewStatus = defaultReviewStatus(entry.source_kind);
  let contentMayHaveChanged = false;

  for (const event of events) {
    if (event.created_at <= at) {
      if (event.type === 'knowledge_accepted' || event.type === 'knowledge_refreshed') {
        reviewStatus = 'active';
      } else if (event.type === 'knowledge_rejected') {
        reviewStatus = 'rejected';
      }
    } else if (event.type === 'knowledge_updated') {
      contentMayHaveChanged = true;
    }
  }

  return {
    knowledge: {
      ...entry,
      review_status: reviewStatus,
      reviewed_at: reviewStatus === entry.review_status ? entry.reviewed_at : null,
      valid_to: reviewStatus === 'rejected' && entry.review_status === 'rejected' ? entry.valid_to : null,
      archived: false,
    },
    content_may_have_changed: contentMayHaveChanged,
  };
}
