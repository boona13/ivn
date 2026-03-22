import { extractWords } from './knowledge-heuristics.js';
import type { Knowledge, VisibilityFilter } from './types.js';

export function buildDuplicateSearchQuery(content: string): string | null {
  const words = extractWords(content);
  if (words.length === 0) return null;
  return words
    .slice(0, 12)
    .map((word) => `"${word}"`)
    .join(' OR ');
}

function extractBigrams(words: string[]): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function setIntersectionCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) {
    if (b.has(item)) count++;
  }
  return count;
}

/**
 * What fraction of the smaller set's terms appear in the larger?
 * Catches rephrasings where one version uses different filler words
 * but the core technical terms overlap heavily.
 */
function containment(a: Set<string>, b: Set<string>): number {
  const minSize = Math.min(a.size, b.size);
  if (minSize === 0) return 0;
  return setIntersectionCount(a, b) / minSize;
}

/**
 * Combines word-level Jaccard, bigram Jaccard, and containment
 * for robust duplicate detection. Jaccard catches exact overlap,
 * bigrams catch phrase-level similarity, and containment catches
 * rephrasings where the core terms match but filler words differ.
 */
export function combinedSimilarity(contentA: string, contentB: string): number {
  const wordsA = extractWords(contentA);
  const wordsB = extractWords(contentB);
  if (wordsA.length === 0 && wordsB.length === 0) return 0;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  const wordJaccard = jaccardSimilarity(setA, setB);
  const bigramJaccard = jaccardSimilarity(extractBigrams(wordsA), extractBigrams(wordsB));
  const wordContainment = containment(setA, setB);

  const jaccardScore = wordJaccard * 0.6 + bigramJaccard * 0.4;
  const containmentScore = wordContainment * 0.9;

  return Math.max(jaccardScore, containmentScore);
}

export function findSimilarKnowledge(options: {
  content: string;
  candidateRows: Array<Record<string, unknown>>;
  threshold: number;
  visibility: VisibilityFilter;
  toKnowledge: (row: Record<string, unknown>) => Knowledge;
  matchesVisibility: (entry: Knowledge | null, visibility: VisibilityFilter) => boolean;
  matchesReviewStatus: (entry: Knowledge | null, reviewStatus: 'all_active_or_pending') => boolean;
}): Knowledge[] {
  const { content, candidateRows, threshold, visibility, toKnowledge, matchesVisibility, matchesReviewStatus } =
    options;
  const words = extractWords(content);
  if (words.length === 0) return [];

  return candidateRows
    .map((row) => {
      const knowledge = toKnowledge(row);
      const similarity = combinedSimilarity(content, knowledge.content);
      return { knowledge, similarity };
    })
    .filter((result) => matchesVisibility(result.knowledge, visibility))
    .filter((result) => matchesReviewStatus(result.knowledge, 'all_active_or_pending'))
    .filter((result) => result.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .map((result) => result.knowledge);
}

export function detectDuplicateKnowledge(options: {
  content: string;
  candidateRows: Array<Record<string, unknown>>;
  visibility: VisibilityFilter;
  toKnowledge: (row: Record<string, unknown>) => Knowledge;
  matchesVisibility: (entry: Knowledge | null, visibility: VisibilityFilter) => boolean;
  matchesReviewStatus: (entry: Knowledge | null, reviewStatus: 'all_active_or_pending') => boolean;
}): { duplicate: boolean; existing?: Knowledge } {
  const similar = findSimilarKnowledge({
    ...options,
    threshold: 0.55,
  });
  if (similar.length > 0) return { duplicate: true, existing: similar[0] };
  return { duplicate: false };
}
