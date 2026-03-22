import type {
  ContradictionFinding,
  ContradictionSeverity,
  Edge,
  EdgeType,
  InferenceSuggestion,
  Knowledge,
} from './types.js';
import { normalizeClassifierText, tokenizeWords } from './knowledge-classifier.js';
import { extractWords } from './knowledge-heuristics.js';
import {
  intersect,
  rankContradiction,
  scoreFileMatches,
  scoreFreshness,
  sharedTerms,
  typeLabel,
} from './knowledge-ranking.js';

const GENERIC_POLICY_TERMS = new Set([
  'allow',
  'always',
  'avoid',
  'bypass',
  'decision',
  'decided',
  'disable',
  'enable',
  'forbid',
  'keep',
  'must',
  'never',
  'pattern',
  'prefer',
  'remove',
  'require',
  'requires',
  'rule',
  'skip',
  'standard',
  'through',
  'via',
  'without',
]);

export function detectContradictions(options: {
  entries: Knowledge[];
  supersedesEdges: Edge[];
  normalizedFilePaths: string[];
  root: string;
  limit: number;
}): ContradictionFinding[] {
  const { entries, supersedesEdges, normalizedFilePaths, root, limit } = options;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const findings: ContradictionFinding[] = [];
  const seen = new Set<string>();

  for (const edge of supersedesEdges) {
    const source = byId.get(edge.source_id);
    const target = byId.get(edge.target_id);
    if (!source || !target) continue;
    if (!matchesContradictionScope(source, target, normalizedFilePaths, root)) continue;

    const key = `superseded_active:${source.id}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    findings.push({
      kind: 'superseded_active',
      severity: contradictionSeverity(source, target, edge.type),
      reason:
        `${typeLabel(source.type)} #${source.id} supersedes ` +
        `${typeLabel(target.type)} #${target.id}, but both are still active.`,
      primary: source,
      secondary: target,
      edge,
      shared_tags: intersect(source.tags, target.tags),
      shared_file_refs: intersect(source.file_refs, target.file_refs),
      shared_terms: sharedTerms(source, target),
    });
  }

  const decisions = entries.filter((entry) => entry.type === 'decision');
  const patterns = entries.filter((entry) => entry.type === 'pattern');

  for (const decision of decisions) {
    for (const pattern of patterns) {
      if (decision.id === pattern.id) continue;
      if (!matchesContradictionScope(decision, pattern, normalizedFilePaths, root)) continue;

      const decisionPolarity = polarity(decision.content);
      const patternPolarity = polarity(pattern.content);
      if (decisionPolarity === 'neutral' || patternPolarity === 'neutral') continue;
      if (decisionPolarity === patternPolarity) continue;

      const sharedFileRefs = intersect(decision.file_refs, pattern.file_refs);
      const sharedTags = intersect(decision.tags, pattern.tags);
      const sharedTermList = meaningfulSharedTerms(sharedTerms(decision, pattern));
      const strongOverlap = sharedTermList.length >= 2;
      if (!strongOverlap) continue;

      const key = ['decision_pattern_conflict', decision.id, pattern.id].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push({
        kind: 'decision_pattern_conflict',
        severity: 'medium',
        reason: describeDecisionPatternConflict(
          decision,
          pattern,
          sharedFileRefs,
          sharedTags,
          sharedTermList,
        ),
        primary: decision,
        secondary: pattern,
        edge: null,
        shared_tags: sharedTags,
        shared_file_refs: sharedFileRefs,
        shared_terms: sharedTermList,
      });
    }
  }

  return findings
    .sort((left, right) => rankContradiction(right) - rankContradiction(left))
    .slice(0, limit);
}

export function inferLinkSuggestions(options: {
  entries: Knowledge[];
  linkedPairs: Set<string>;
  normalizedFilePaths: string[];
  root: string;
  limit: number;
}): InferenceSuggestion[] {
  const { entries, linkedPairs, normalizedFilePaths, root, limit } = options;
  const suggestions = new Map<string, InferenceSuggestion>();

  inferFromBuckets(entries, linkedPairs, suggestions, 'file', 140, (entry) => entry.file_refs);
  inferFromBuckets(entries, linkedPairs, suggestions, 'tag', 45, (entry) => entry.tags);
  inferFromBuckets(
    entries,
    linkedPairs,
    suggestions,
    'term',
    18,
    (entry) => extractWords(entry.content).filter((term) => term.length >= 4).slice(0, 10),
  );

  return [...suggestions.values()]
    .filter((suggestion) => matchesInferenceScope(suggestion, normalizedFilePaths, root))
    .sort((left, right) => right.score - left.score || right.source.created_at.localeCompare(left.source.created_at))
    .slice(0, limit);
}

function matchesContradictionScope(
  primary: Knowledge,
  secondary: Knowledge,
  normalizedFilePaths: string[],
  root: string,
): boolean {
  if (normalizedFilePaths.length === 0) return true;
  return (
    scoreFileMatches(primary, normalizedFilePaths, root) > 0 ||
    scoreFileMatches(secondary, normalizedFilePaths, root) > 0
  );
}

function polarity(content: string): 'positive' | 'negative' | 'neutral' {
  const normalized = normalizeClassifierText(content);
  const tokenSet = new Set(tokenizeWords(normalized));
  const positive =
    (tokenSet.has('must') && !normalized.includes('must not')) ||
    tokenSet.has('prefer') ||
    tokenSet.has('require') ||
    tokenSet.has('requires') ||
    tokenSet.has('via') ||
    tokenSet.has('enable') ||
    tokenSet.has('allow') ||
    includesAnyPhrase(normalized, ['go through', 'route through', 'flow through', 'pass through']);
  const negative =
    includesAnyPhrase(normalized, ['must not', 'should not', 'do not', "don't", 'dont', 'instead of']) ||
    tokenSet.has('never') ||
    tokenSet.has('avoid') ||
    tokenSet.has('disable') ||
    tokenSet.has('remove') ||
    tokenSet.has('forbid') ||
    tokenSet.has('skip') ||
    tokenSet.has('bypass') ||
    tokenSet.has('without');
  if (positive === negative) return 'neutral';
  return positive ? 'positive' : 'negative';
}

function contradictionSeverity(
  primary: Knowledge,
  secondary: Knowledge,
  edgeType: EdgeType | null,
): ContradictionSeverity {
  if (edgeType === 'supersedes') return 'high';
  if (primary.type === 'dependency' || secondary.type === 'dependency') return 'high';
  return 'medium';
}

function meaningfulSharedTerms(terms: string[]): string[] {
  return terms.filter((term) => {
    if (term.length < 4) return false;
    if (GENERIC_POLICY_TERMS.has(term)) return false;
    if (/(?:ts|tsx|js|jsx|md|json|yml|yaml|sql|css|html)$/.test(term)) return false;
    if (/^(?:src|app|lib|dist|build|test|tests|readme|index)/.test(term)) return false;
    return true;
  });
}

function describeDecisionPatternConflict(
  decision: Knowledge,
  pattern: Knowledge,
  sharedFileRefs: string[],
  sharedTags: string[],
  sharedTermList: string[],
): string {
  if (sharedFileRefs.length > 0) {
    return `Decision #${decision.id} conflicts with pattern #${pattern.id} around ${sharedFileRefs[0]}.`;
  }
  if (sharedTags.length > 0) {
    return `Decision #${decision.id} conflicts with pattern #${pattern.id} on #${sharedTags[0]}.`;
  }
  if (sharedTermList.length > 0) {
    return `Decision #${decision.id} conflicts with pattern #${pattern.id} around ${sharedTermList.slice(0, 2).join(', ')}.`;
  }
  return `Decision #${decision.id} conflicts with pattern #${pattern.id}.`;
}

function matchesInferenceScope(
  suggestion: InferenceSuggestion,
  normalizedFilePaths: string[],
  root: string,
): boolean {
  if (normalizedFilePaths.length === 0) return true;
  return (
    scoreFileMatches(suggestion.source, normalizedFilePaths, root) > 0 ||
    scoreFileMatches(suggestion.target, normalizedFilePaths, root) > 0
  );
}

function inferFromBuckets(
  entries: Knowledge[],
  linkedPairs: Set<string>,
  suggestions: Map<string, InferenceSuggestion>,
  kind: 'file' | 'tag' | 'term',
  weight: number,
  valuesForEntry: (entry: Knowledge) => string[],
): void {
  const buckets = new Map<string, Knowledge[]>();
  for (const entry of entries) {
    for (const value of [...new Set(valuesForEntry(entry))]) {
      if (!value) continue;
      const group = buckets.get(value) || [];
      group.push(entry);
      buckets.set(value, group);
    }
  }

  for (const [value, bucket] of buckets) {
    if (bucket.length < 2 || bucket.length > 24) continue;
    for (let index = 0; index < bucket.length; index++) {
      for (let offset = index + 1; offset < bucket.length; offset++) {
        const primary = bucket[index]!;
        const secondary = bucket[offset]!;
        const key = pairKey(primary.id, secondary.id);
        if (linkedPairs.has(key)) continue;

        const suggestion = buildInferenceSuggestion(primary, secondary);
        if (!suggestion) continue;

        const overlapCount =
          kind === 'file'
            ? suggestion.shared_file_refs.length
            : kind === 'tag'
              ? suggestion.shared_tags.length
              : suggestion.shared_terms.length;
        if (overlapCount === 0) continue;

        const existing = suggestions.get(key);
        const scoreBoost = weight * overlapCount;
        if (!existing) {
          suggestions.set(key, {
            ...suggestion,
            score: suggestion.score + scoreBoost,
            reason: describeInferenceReason(suggestion, value, kind),
          });
          continue;
        }

        existing.score += scoreBoost;
        existing.shared_file_refs = mergeUnique(existing.shared_file_refs, suggestion.shared_file_refs);
        existing.shared_tags = mergeUnique(existing.shared_tags, suggestion.shared_tags);
        existing.shared_terms = mergeUnique(existing.shared_terms, suggestion.shared_terms);
        existing.reason = describeInferenceReason(existing, value, kind);
      }
    }
  }
}

function buildInferenceSuggestion(primary: Knowledge, secondary: Knowledge): InferenceSuggestion | null {
  if (primary.id === secondary.id) return null;

  const sharedFileRefs = intersect(primary.file_refs, secondary.file_refs);
  const sharedTags = intersect(primary.tags, secondary.tags);
  const sharedTermList = sharedTerms(primary, secondary);
  const overlapScore =
    sharedFileRefs.length * 140 +
    sharedTags.length * 45 +
    sharedTermList.length * 18;
  if (overlapScore < 60) return null;

  const oriented = inferDirectionAndType(primary, secondary, sharedFileRefs, sharedTags, sharedTermList);
  return {
    source: oriented.source,
    target: oriented.target,
    suggested_type: oriented.type,
    score: overlapScore + scoreFreshness(oriented.source) + scoreFreshness(oriented.target),
    reason: '',
    shared_tags: sharedTags,
    shared_file_refs: sharedFileRefs,
    shared_terms: sharedTermList,
  };
}

function inferDirectionAndType(
  primary: Knowledge,
  secondary: Knowledge,
  sharedFileRefs: string[],
  sharedTags: string[],
  sharedTermList: string[],
): { source: Knowledge; target: Knowledge; type: EdgeType } {
  const pair = [primary, secondary].sort((left, right) => left.created_at.localeCompare(right.created_at));
  let [source, target] = pair;
  let type: EdgeType = 'relates_to';

  if (primary.type === 'dependency' && secondary.type !== 'dependency') {
    source = secondary;
    target = primary;
    type = 'depends_on';
  } else if (secondary.type === 'dependency' && primary.type !== 'dependency') {
    source = primary;
    target = secondary;
    type = 'depends_on';
  } else if (primary.type === 'pattern' && secondary.type === 'decision') {
    source = primary;
    target = secondary;
    type = 'implements';
  } else if (secondary.type === 'pattern' && primary.type === 'decision') {
    source = secondary;
    target = primary;
    type = 'implements';
  } else if (
    mentionsSupersession(primary.content) ||
    mentionsSupersession(secondary.content)
  ) {
    source = primary.updated_at >= secondary.updated_at ? primary : secondary;
    target = source.id === primary.id ? secondary : primary;
    type = 'supersedes';
  } else if (sharedFileRefs.length > 0 || sharedTags.length > 0 || sharedTermList.length > 0) {
    type = 'relates_to';
  }

  return { source, target, type };
}

function describeInferenceReason(
  suggestion: InferenceSuggestion,
  latestValue: string,
  kind: 'file' | 'tag' | 'term',
): string {
  if (suggestion.shared_file_refs.length > 0) {
    return `Shared file context around ${suggestion.shared_file_refs[0]}.`;
  }
  if (suggestion.shared_tags.length > 0) {
    return `Shared tag context around #${suggestion.shared_tags[0]}.`;
  }
  if (suggestion.shared_terms.length > 0) {
    return `Shared terminology around ${suggestion.shared_terms.slice(0, 2).join(', ')}.`;
  }
  if (kind === 'file') return `Related around ${latestValue}.`;
  if (kind === 'tag') return `Related around #${latestValue}.`;
  return `Related around ${latestValue}.`;
}

function mergeUnique(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function pairKey(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join(':');
}

function includesAnyPhrase(normalized: string, phrases: string[]): boolean {
  return phrases.some((phrase) => normalized.includes(phrase));
}

function mentionsSupersession(content: string): boolean {
  const normalized = normalizeClassifierText(content);
  return includesAnyPhrase(normalized, [
    'replace',
    'replaces',
    'replaced',
    'supersede',
    'supersedes',
    'superseded',
    'deprecated',
    'migrated away from',
  ]);
}
