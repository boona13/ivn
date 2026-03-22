import { tokenizeWords } from './knowledge-classifier.js';
import { normalizeFileRef } from './knowledge-heuristics.js';
import { scoreFileMatch, scoreFreshness } from './knowledge-ranking.js';
import type { Knowledge, SearchResult } from './types.js';

export function buildRecallFtsQuery(query: string): string | null {
  const words = [...new Set(
    tokenizeWords(query)
      .filter((word) => word.length > 1),
  )];
  if (words.length === 0) return null;
  return words.map((word) => `"${word}"`).join(' OR ');
}

export function rerankRecallResults(options: {
  rows: Array<Record<string, unknown>>;
  root: string;
  filePath?: string;
  limit: number;
  toKnowledge: (row: Record<string, unknown>) => Knowledge;
}): SearchResult[] {
  const { rows, root, filePath, limit, toKnowledge } = options;
  const results = rows.map((row) => ({
    ...toKnowledge(row),
    rank: row.rank as number,
  }));
  const normalizedFilePath = filePath ? normalizeFileRef(filePath, root) : '';

  return results
    .map((result, index) => ({
      result,
      score:
        Math.max(1, 200 - index * 5) +
        scoreFreshness(result) +
        (normalizedFilePath ? scoreFileMatch(result, normalizedFilePath, root) * 5 : 0),
    }))
    .sort((a, b) => b.score - a.score || b.result.created_at.localeCompare(a.result.created_at))
    .map(({ result }) => result)
    .slice(0, limit);
}
