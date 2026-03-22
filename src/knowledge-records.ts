import { extractFileRefs, normalizeFileRef } from './knowledge-heuristics.js';
import type {
  Edge,
  EdgeType,
  Knowledge,
  KnowledgeType,
  ReviewStatus,
  ReviewStatusFilter,
  SourceKind,
  Visibility,
  VisibilityFilter,
} from './types.js';

export function inferSourceMetadata(source: string): {
  sourceKind: SourceKind;
  sourceRef: string | null;
} {
  if (source.startsWith('git:')) {
    return { sourceKind: 'git', sourceRef: source.slice(4) || null };
  }
  if (source.startsWith('conversation:')) {
    return { sourceKind: 'conversation', sourceRef: source.slice(13) || null };
  }
  if (source === 'mcp') return { sourceKind: 'mcp', sourceRef: null };
  if (source === 'import') return { sourceKind: 'import', sourceRef: null };
  if (source === 'manual') return { sourceKind: 'manual', sourceRef: null };
  return { sourceKind: 'external', sourceRef: null };
}

export function toKnowledgeRecord(options: {
  row: Record<string, unknown>;
  root: string;
  defaultConfidence: number;
}): Knowledge {
  const { row, root, defaultConfidence } = options;
  const source = (row.source as string | undefined) || 'manual';
  const inferredSource = inferSourceMetadata(source);
  const rawConfidence = row.confidence;

  return {
    id: row.id as string,
    type: row.type as KnowledgeType,
    content: row.content as string,
    summary: row.summary as string,
    tags: JSON.parse((row.tags as string) || '[]'),
    file_refs: parseFileRefs(row, root),
    source,
    source_kind: (row.source_kind as SourceKind | undefined) || inferredSource.sourceKind,
    source_ref: (row.source_ref as string | null | undefined) ?? inferredSource.sourceRef,
    confidence:
      typeof rawConfidence === 'number'
        ? rawConfidence
        : Number(rawConfidence ?? defaultConfidence) || defaultConfidence,
    valid_from: (row.valid_from as string | undefined) || (row.created_at as string),
    valid_to: (row.valid_to as string | null | undefined) ?? null,
    visibility: (row.visibility as Visibility | undefined) || 'shared',
    review_status: (row.review_status as ReviewStatus | undefined) || 'active',
    reviewed_at: (row.reviewed_at as string | null | undefined) ?? null,
    review_note: (row.review_note as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    archived: Boolean(row.archived),
  };
}

export function toEdgeRecord(row: Record<string, unknown>): Edge {
  return {
    id: row.id as string,
    source_id: row.source_id as string,
    target_id: row.target_id as string,
    type: row.type as EdgeType,
    created_at: row.created_at as string,
  };
}

export function matchesVisibilityFilter(
  entry: Knowledge | null,
  visibility: VisibilityFilter,
): boolean {
  if (!entry) return false;
  if (visibility === 'all') return true;
  return entry.visibility === visibility;
}

export function matchesReviewStatusFilter(
  entry: Knowledge | null,
  reviewStatus: ReviewStatusFilter | 'all_active_or_pending',
): boolean {
  if (!entry) return false;
  if (reviewStatus === 'all') return true;
  if (reviewStatus === 'all_active_or_pending') {
    return entry.review_status === 'active' || entry.review_status === 'pending';
  }
  return entry.review_status === reviewStatus;
}

function parseFileRefs(row: Record<string, unknown>, root: string): string[] {
  const stored = (row.file_refs as string | undefined) || '[]';
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((ref) => normalizeFileRef(String(ref), root)).filter(Boolean);
    }
  } catch {
    // Fall back to extraction from content for older rows or malformed data.
  }
  return extractFileRefs(row.content as string, root);
}
