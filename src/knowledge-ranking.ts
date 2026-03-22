import type { ContradictionFinding, Knowledge, KnowledgeType } from './types.js';
import { extractWords, normalizeFileRef } from './knowledge-heuristics.js';
import { DEFAULT_STALE_DAYS, MS_PER_DAY } from './version.js';

export function getFreshnessTimestamp(entry: Knowledge): string {
  return entry.reviewed_at || entry.updated_at || entry.valid_from || entry.created_at;
}

export function isStale(entry: Knowledge, staleDays: number = DEFAULT_STALE_DAYS): boolean {
  if (entry.archived || entry.review_status !== 'active' || entry.valid_to !== null) return false;
  return getAgeDays(getFreshnessTimestamp(entry)) >= staleDays;
}

export function scoreFreshness(entry: Knowledge): number {
  const ageDays = getAgeDays(getFreshnessTimestamp(entry));
  let score = 0;

  if (entry.valid_to !== null || entry.review_status === 'rejected') score -= 140;
  if (entry.review_status === 'pending') score -= 30;

  if (ageDays <= 7) score += 45;
  else if (ageDays <= 30) score += 28;
  else if (ageDays <= DEFAULT_STALE_DAYS) score += 12;
  else if (ageDays <= 180) score -= 12;
  else if (ageDays <= 365) score -= 28;
  else score -= 44;

  return score;
}

export function isWarningType(type: KnowledgeType): boolean {
  return type === 'gotcha' || type === 'dependency' || type === 'debug';
}

export function warningPriority(type: KnowledgeType): number {
  if (type === 'gotcha') return 3;
  if (type === 'dependency') return 2;
  if (type === 'debug') return 1;
  return 0;
}

export function scoreFileMatch(entry: Knowledge, normalizedFilePath: string, root: string): number {
  let best = 0;
  const targetName = normalizedFilePath.split('/').pop() || normalizedFilePath;

  for (const ref of entry.file_refs) {
    const normalizedRef = normalizeFileRef(ref, root);
    const refName = normalizedRef.split('/').pop() || normalizedRef;
    if (!normalizedRef) continue;

    if (normalizedRef === normalizedFilePath) {
      best = Math.max(best, 100);
    } else if (
      normalizedFilePath.endsWith(`/${normalizedRef}`) ||
      normalizedRef.endsWith(`/${normalizedFilePath}`)
    ) {
      best = Math.max(best, 92);
    } else if (
      normalizedFilePath.startsWith(`${normalizedRef}/`) ||
      normalizedRef.startsWith(`${normalizedFilePath}/`)
    ) {
      best = Math.max(best, 84);
    } else if (refName === targetName) {
      best = Math.max(best, 68);
    }
  }

  return best;
}

export function scoreFileMatches(entry: Knowledge, normalizedFilePaths: string[], root: string): number {
  let total = 0;
  let best = 0;
  for (const filePath of normalizedFilePaths) {
    const score = scoreFileMatch(entry, filePath, root);
    best = Math.max(best, score);
    total += score;
  }
  return best + Math.floor(total * 0.15);
}

export function scoreCandidate(
  scored: Map<string, { entry: Knowledge; score: number }>,
  entry: Knowledge,
  score: number,
): void {
  const existing = scored.get(entry.id);
  if (!existing || score > existing.score) {
    scored.set(entry.id, { entry, score });
  }
}

export function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((item) => rightSet.has(item)))];
}

export function sharedTerms(primary: Knowledge, secondary: Knowledge): string[] {
  const left = new Set(extractWords(primary.content));
  const right = new Set(extractWords(secondary.content));
  return [...left]
    .filter((term) => right.has(term))
    .filter((term) => term.length >= 4)
    .slice(0, 8);
}

export function typeLabel(type: KnowledgeType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

const TYPE_PLURAL_LABELS: Record<KnowledgeType, string> = {
  decision: 'Decisions',
  pattern: 'Patterns',
  gotcha: 'Gotchas',
  debug: 'Debug History',
  context: 'Context',
  dependency: 'Dependencies',
  todo: 'Todos',
};

export function pluralTypeLabel(type: KnowledgeType): string {
  return TYPE_PLURAL_LABELS[type] || typeLabel(type) + 's';
}

export function rankContradiction(finding: ContradictionFinding): number {
  const severity = finding.severity === 'high' ? 1000 : 500;
  const freshness =
    scoreFreshness(finding.primary) +
    scoreFreshness(finding.secondary);
  return severity + freshness;
}

function getAgeDays(timestamp: string): number {
  const ageMs = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 0;
  return ageMs / MS_PER_DAY;
}
