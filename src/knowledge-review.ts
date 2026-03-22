import type { Knowledge, ReviewStatus, SourceKind } from './types.js';

export function defaultReviewStatusForSource(sourceKind: SourceKind): ReviewStatus {
  return sourceKind === 'manual' ? 'active' : 'pending';
}

export function buildReviewUpdate(
  existing: Knowledge,
  reviewStatus: ReviewStatus,
  now: string,
  options: { note?: string; refreshValidity?: boolean } = {},
): {
  reviewStatus: ReviewStatus;
  reviewedAt: string;
  reviewNote: string | null;
  validFrom: string;
  validTo: string | null;
  updatedAt: string;
} {
  const validFrom = options.refreshValidity ? now : existing.valid_from;
  const validTo =
    reviewStatus === 'rejected'
      ? now
      : reviewStatus === 'active'
        ? null
        : options.refreshValidity
          ? null
          : existing.valid_to;

  return {
    reviewStatus,
    reviewedAt: now,
    reviewNote: options.note ?? null,
    validFrom,
    validTo,
    updatedAt: now,
  };
}
