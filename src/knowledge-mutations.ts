import {
  extractFileRefs,
  extractTags,
  inferKnowledgeType,
  makeSummary,
  mergeFileRefs,
  mergeTags,
} from './knowledge-heuristics.js';
import { inferSourceMetadata } from './knowledge-records.js';
import { defaultReviewStatusForSource } from './knowledge-review.js';
import type { Knowledge, KnowledgeType, ReviewStatus, SourceKind, Visibility } from './types.js';

export interface RememberOptions {
  type?: KnowledgeType;
  tags?: string[];
  fileRefs?: string[];
  source?: string;
  sourceKind?: SourceKind;
  sourceRef?: string | null;
  confidence?: number;
  visibility?: Visibility;
  reviewStatus?: ReviewStatus;
  reviewNote?: string | null;
  summary?: string;
}

export interface RememberMutation {
  entry: Knowledge;
  insertParams: unknown[];
}

export type KnowledgeUpdateInput = Partial<Pick<Knowledge, 'content' | 'type' | 'tags' | 'summary'>>;

export function buildRememberMutation(options: {
  id: string;
  content: string;
  input?: RememberOptions;
  root: string;
  now: string;
  defaultConfidence: number;
}): RememberMutation {
  const { id, content, input = {}, root, now, defaultConfidence } = options;
  const type = input.type || inferKnowledgeType(content);
  const summary = input.summary || makeSummary(content);
  const tags = mergeTags(input.tags || [], extractTags(content, root));
  const fileRefs = mergeFileRefs(input.fileRefs || [], extractFileRefs(content, root), root);
  const provenance = resolveKnowledgeSource(input.source, input.sourceKind, input.sourceRef);
  const confidence = normalizeKnowledgeConfidence(input.confidence, defaultConfidence);
  const visibility = input.visibility || 'shared';
  const reviewStatus = input.reviewStatus || defaultReviewStatusForSource(provenance.sourceKind);
  const reviewedAt = reviewStatus === 'active' ? now : null;
  const reviewNote = input.reviewNote ?? null;

  return {
    entry: {
      id,
      type,
      content,
      summary,
      tags,
      file_refs: fileRefs,
      source: provenance.source,
      source_kind: provenance.sourceKind,
      source_ref: provenance.sourceRef,
      confidence,
      valid_from: now,
      valid_to: null,
      visibility,
      review_status: reviewStatus,
      reviewed_at: reviewedAt,
      review_note: reviewNote,
      created_at: now,
      updated_at: now,
      archived: false,
    },
    insertParams: [
      id,
      type,
      content,
      summary,
      JSON.stringify(tags),
      JSON.stringify(fileRefs),
      provenance.source,
      provenance.sourceKind,
      provenance.sourceRef,
      confidence,
      now,
      null,
      visibility,
      reviewStatus,
      reviewedAt,
      reviewNote,
      now,
      now,
    ],
  };
}

export function buildKnowledgeUpdateMutation(options: {
  updates: KnowledgeUpdateInput;
  existing: Knowledge;
  root: string;
  now: string;
}): { sets: string[]; params: unknown[] } {
  const { updates, existing, root, now } = options;
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];

  if (updates.content !== undefined) {
    const extractedTags = extractTags(updates.content, root);
    const mergedTags = updates.tags !== undefined
      ? updates.tags
      : mergeTags(existing.tags, extractedTags);
    const mergedFileRefs = mergeFileRefs(existing.file_refs, extractFileRefs(updates.content, root), root);

    sets.push('content = ?');
    params.push(updates.content);
    sets.push('file_refs = ?');
    params.push(JSON.stringify(mergedFileRefs));
    sets.push('tags = ?');
    params.push(JSON.stringify(mergedTags));
    if (updates.summary === undefined) {
      sets.push('summary = ?');
      params.push(makeSummary(updates.content));
    }
  }
  if (updates.type !== undefined) {
    sets.push('type = ?');
    params.push(updates.type);
  }
  if (updates.summary !== undefined) {
    sets.push('summary = ?');
    params.push(updates.summary);
  }
  if (updates.tags !== undefined) {
    sets.push('tags = ?');
    params.push(JSON.stringify(mergeTags(existing.tags, updates.tags)));
  }

  return { sets, params };
}

export function resolveKnowledgeSource(
  source?: string,
  sourceKind?: SourceKind,
  sourceRef?: string | null,
): { source: string; sourceKind: SourceKind; sourceRef: string | null } {
  if (source && source.trim()) {
    const inferred = inferSourceMetadata(source);
    return {
      source,
      sourceKind: sourceKind || inferred.sourceKind,
      sourceRef: sourceRef ?? inferred.sourceRef,
    };
  }

  if (sourceKind === 'git' && sourceRef) {
    return { source: `git:${sourceRef}`, sourceKind, sourceRef };
  }

  if (sourceKind) {
    return { source: sourceKind, sourceKind, sourceRef: sourceRef ?? null };
  }

  return { source: 'manual', sourceKind: 'manual', sourceRef: null };
}

export function normalizeKnowledgeConfidence(confidence: number | undefined, fallback: number): number {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, confidence));
}
