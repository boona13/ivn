import { buildDuplicateSearchQuery, detectDuplicateKnowledge, findSimilarKnowledge } from './knowledge-duplicates.js';
import { toKnowledgeRecord } from './knowledge-records.js';
import { buildReviewUpdate } from './knowledge-review.js';
import type {
  Edge,
  EdgeType,
  Knowledge,
  KnowledgeEventType,
  ReviewStatus,
  ReviewStatusFilter,
  VisibilityFilter,
} from './types.js';

export function applyKnowledgeReviewDecision(options: {
  id: string;
  reviewStatus: ReviewStatus;
  eventType: KnowledgeEventType;
  note?: string;
  refreshValidity?: boolean;
  getKnowledge: (id: string, includeArchived?: boolean) => Knowledge | null;
  persistReviewState: (update: {
    id: string;
    reviewStatus: string;
    reviewedAt: string;
    reviewNote: string | null;
    validFrom: string;
    validTo: string | null;
    updatedAt: string;
  }) => void;
  logEvent: (type: KnowledgeEventType, options: { knowledgeId?: string | null; edgeId?: string | null }) => void;
}): Knowledge | null {
  const {
    id,
    reviewStatus,
    eventType,
    note,
    refreshValidity = false,
    getKnowledge,
    persistReviewState,
    logEvent,
  } = options;
  const existing = getKnowledge(id, true);
  if (!existing || existing.archived) return null;

  const now = new Date().toISOString();
  const update = buildReviewUpdate(existing, reviewStatus, now, {
    note,
    refreshValidity,
  });

  persistReviewState({
    id,
    reviewStatus: update.reviewStatus,
    reviewedAt: update.reviewedAt,
    reviewNote: update.reviewNote,
    validFrom: update.validFrom,
    validTo: update.validTo,
    updatedAt: update.updatedAt,
  });

  logEvent(eventType, { knowledgeId: id });
  return getKnowledge(id, true);
}

export function createKnowledgeLink(options: {
  sourceId: string;
  targetId: string;
  type: EdgeType;
  getKnowledge: (id: string) => Knowledge | null;
  persistEdge: (edge: Edge) => void;
  logEvent: (type: KnowledgeEventType, options: { knowledgeId?: string | null; edgeId?: string | null }) => void;
  generateId: () => string;
}): Edge {
  const { sourceId, targetId, type, getKnowledge, persistEdge, logEvent, generateId } = options;
  const source = getKnowledge(sourceId);
  const target = getKnowledge(targetId);
  if (!source) throw new Error(`Knowledge #${sourceId} not found`);
  if (!target) throw new Error(`Knowledge #${targetId} not found`);

  const edge: Edge = {
    id: generateId(),
    source_id: sourceId,
    target_id: targetId,
    type,
    created_at: new Date().toISOString(),
  };

  persistEdge(edge);
  logEvent('edge_added', { edgeId: edge.id });
  return edge;
}

export function findSimilarKnowledgeEntries(options: {
  content: string;
  threshold: number;
  visibility: VisibilityFilter;
  candidateRows: Array<Record<string, unknown>> | null;
  root: string;
  defaultConfidence: number;
  matchesVisibility: (entry: Knowledge | null, visibility: VisibilityFilter) => boolean;
  matchesReviewStatus: (entry: Knowledge | null, reviewStatus: ReviewStatusFilter | 'all_active_or_pending') => boolean;
}): Knowledge[] {
  const {
    content,
    threshold,
    visibility,
    candidateRows,
    root,
    defaultConfidence,
    matchesVisibility,
    matchesReviewStatus,
  } = options;
  if (!candidateRows) return [];

  return findSimilarKnowledge({
    content,
    candidateRows,
    threshold,
    visibility,
    toKnowledge: (row) => toKnowledgeRecord({ row, root, defaultConfidence }),
    matchesVisibility,
    matchesReviewStatus,
  });
}

export function detectDuplicateKnowledgeEntry(options: {
  content: string;
  visibility: VisibilityFilter;
  candidateRows: Array<Record<string, unknown>> | null;
  root: string;
  defaultConfidence: number;
  matchesVisibility: (entry: Knowledge | null, visibility: VisibilityFilter) => boolean;
  matchesReviewStatus: (entry: Knowledge | null, reviewStatus: ReviewStatusFilter | 'all_active_or_pending') => boolean;
}): { duplicate: boolean; existing?: Knowledge } {
  const {
    content,
    visibility,
    candidateRows,
    root,
    defaultConfidence,
    matchesVisibility,
    matchesReviewStatus,
  } = options;
  if (!candidateRows) return { duplicate: false };

  return detectDuplicateKnowledge({
    content,
    candidateRows,
    visibility,
    toKnowledge: (row) => toKnowledgeRecord({ row, root, defaultConfidence }),
    matchesVisibility,
    matchesReviewStatus,
  });
}

export function findDuplicateCandidateRows(options: {
  content: string;
  queryCandidates: (ftsQuery: string) => Array<Record<string, unknown>> | null;
}): Array<Record<string, unknown>> | null {
  const { content, queryCandidates } = options;
  const ftsQuery = buildDuplicateSearchQuery(content);
  if (!ftsQuery) return null;
  return queryCandidates(ftsQuery);
}

export function rememberIfNewKnowledge(options: {
  content: string;
  visibility: VisibilityFilter;
  detectDuplicate: (content: string, visibility: VisibilityFilter) => { duplicate: boolean; existing?: Knowledge };
  remember: () => Knowledge;
}): { entry: Knowledge; isNew: boolean } {
  const { content, visibility, detectDuplicate, remember } = options;
  const { duplicate, existing } = detectDuplicate(content, visibility);
  if (duplicate && existing) return { entry: existing, isNew: false };
  return { entry: remember(), isNew: true };
}
