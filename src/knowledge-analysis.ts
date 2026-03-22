import { normalizeFileRef } from './knowledge-heuristics.js';
import {
  normalizeScopedFilePaths,
  renderChangedKnowledgeContext,
  renderProjectContext,
} from './knowledge-context.js';
import { detectContradictions, inferLinkSuggestions } from './knowledge-insights.js';
import { getFreshnessTimestamp, isStale } from './knowledge-ranking.js';
import type {
  ContradictionFinding,
  Edge,
  InferenceSuggestion,
  Knowledge,
  ReviewStatusFilter,
  SearchResult,
  VisibilityFilter,
} from './types.js';

export function buildStaleKnowledge(options: {
  entries: Knowledge[];
  days: number;
  limit: number;
}): Knowledge[] {
  const { entries, days, limit } = options;
  return entries
    .filter((entry) => isStale(entry, days))
    .sort((a, b) => getFreshnessTimestamp(a).localeCompare(getFreshnessTimestamp(b)))
    .slice(0, limit);
}

export function buildContradictionFindings(options: {
  entries: Knowledge[];
  filePaths: string[];
  root: string;
  limit: number;
  supersedesEdges: Edge[];
}): ContradictionFinding[] {
  const { entries, filePaths, root, limit, supersedesEdges } = options;
  const normalizedFilePaths = [...new Set(
    filePaths.map((filePath) => normalizeFileRef(filePath, root)).filter(Boolean),
  )];

  return detectContradictions({
    entries: entries.filter((entry) => entry.review_status === 'active' && !entry.archived),
    supersedesEdges,
    normalizedFilePaths,
    root,
    limit,
  });
}

export function buildLinkInferenceSuggestions(options: {
  entries: Knowledge[];
  filePaths: string[];
  root: string;
  limit: number;
  linkedPairs: Set<string>;
}): InferenceSuggestion[] {
  const { entries, filePaths, root, limit, linkedPairs } = options;
  const normalizedFilePaths = [...new Set(
    filePaths.map((filePath) => normalizeFileRef(filePath, root)).filter(Boolean),
  )];

  return inferLinkSuggestions({
    entries: entries.filter((entry) => !entry.archived),
    linkedPairs,
    normalizedFilePaths,
    root,
    limit,
  });
}

export function renderStoreContext(options: {
  query?: string;
  filePath?: string;
  root: string;
  projectName: string;
  recall: (query: string, limit: number, visibility: VisibilityFilter, reviewStatus: ReviewStatusFilter, filePath?: string) => SearchResult[];
  focus: (filePath: string, limit: number, visibility: VisibilityFilter, reviewStatus: ReviewStatusFilter) => SearchResult[];
  warn: (filePath: string, limit: number, visibility: VisibilityFilter, reviewStatus: ReviewStatusFilter) => SearchResult[];
  list: (options: { limit?: number }) => Knowledge[];
}): string {
  const { query, filePath, root, projectName, recall, focus, warn, list } = options;
  let entries: Knowledge[];
  let warnings: SearchResult[] = [];

  if (query && filePath) {
    entries = recall(query, 100, 'all', 'active', filePath);
    warnings = warn(filePath, 6, 'all', 'active');
  } else if (filePath) {
    entries = focus(filePath, 100, 'all', 'active');
    warnings = warn(filePath, 6, 'all', 'active');
  } else if (query) {
    entries = recall(query, 100, 'all', 'active');
  } else {
    entries = list({ limit: 50 });
  }

  return renderProjectContext({
    projectName,
    entries,
    warnings,
    focusedFilePath: filePath ? normalizeFileRef(filePath, root) : undefined,
  });
}

export function renderChangedFileKnowledgeContext(options: {
  filePaths: string[];
  limit: number;
  visibility: VisibilityFilter;
  reviewStatus: ReviewStatusFilter;
  root: string;
  projectName: string;
  focusFiles: (filePaths: string[], limit: number, visibility: VisibilityFilter, reviewStatus: ReviewStatusFilter) => SearchResult[];
  warnFiles: (filePaths: string[], limit: number, visibility: VisibilityFilter, reviewStatus: ReviewStatusFilter) => SearchResult[];
}): string {
  const {
    filePaths,
    limit,
    visibility,
    reviewStatus,
    root,
    projectName,
    focusFiles,
    warnFiles,
  } = options;

  const normalizedFilePaths = normalizeScopedFilePaths(filePaths, root);
  if (normalizedFilePaths.length === 0) {
    return 'No changed files detected.';
  }

  const warnings = warnFiles(
    normalizedFilePaths,
    Math.max(3, Math.min(6, limit)),
    visibility,
    reviewStatus,
  );
  const warningIds = new Set(warnings.map((entry) => entry.id));
  const entries = focusFiles(normalizedFilePaths, limit, visibility, reviewStatus)
    .filter((entry) => !warningIds.has(entry.id));

  return renderChangedKnowledgeContext({
    projectName,
    filePaths: normalizedFilePaths,
    entries,
    warnings,
  });
}
