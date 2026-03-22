import Database from 'better-sqlite3';
import type {
  Knowledge, KnowledgeType, Edge, EdgeType,
  SearchResult, StoreStats, ProjectConfig, TraversalStep, DoctorReport, SourceKind,
  KnowledgeEventType, KnowledgeDiffItem, Visibility, VisibilityFilter,
  ReviewStatus, ReviewStatusFilter, ContradictionFinding, SnapshotResult,
  InferenceSuggestion,
} from './types.js';
import {
  buildFocusedKnowledge,
  buildWarningKnowledge,
} from './knowledge-context.js';
import {
  buildContradictionFindings,
  buildLinkInferenceSuggestions,
  buildStaleKnowledge,
  renderChangedFileKnowledgeContext,
  renderStoreContext,
} from './knowledge-analysis.js';
import { buildDoctorReport, buildDoctorWarnings, buildStoreStats } from './knowledge-health.js';
import {
  matchesReviewStatusFilter,
  matchesVisibilityFilter,
  toKnowledgeRecord,
} from './knowledge-records.js';
import {
  buildKnowledgeUpdateMutation,
  buildRememberMutation,
  type RememberOptions,
} from './knowledge-mutations.js';
import {
  countActiveKnowledge,
  countPendingKnowledge,
  countEdges,
  countKnowledge,
  getEdgeById,
  getEdgeBySignature,
  getEdgesForKnowledge,
  getKnowledgeById,
  listAllKnowledge,
  listKnowledge as listKnowledgeRecords,
  listKnowledgeTypeCounts,
  listLinkedPairKeys,
  listSupersedesEdges,
  loadSnapshotData,
  queryDuplicateCandidateRows,
  queryRecallRows,
} from './knowledge-repository.js';
import {
  archiveKnowledgeEntry,
  insertEdge,
  insertKnowledgeEntry,
  insertKnowledgeEvent,
  rebuildKnowledgeSearchIndex,
  updateKnowledgeFields,
  updateKnowledgeReviewState,
} from './knowledge-persistence.js';
import {
  applyKnowledgeReviewDecision,
  createKnowledgeLink,
  detectDuplicateKnowledgeEntry,
  findDuplicateCandidateRows,
  findSimilarKnowledgeEntries,
  rememberIfNewKnowledge,
} from './knowledge-operations.js';
import { getRelatedKnowledge, traverseKnowledge } from './knowledge-graph.js';
import {
  findIvnRoot,
  getConfigPath as getIvnConfigPath,
  getDbPath as getIvnDbPath,
  initializeProjectConfig,
  readProjectConfig,
  syncProjectConfig,
} from './project-config.js';
import { syncRules, detectSyncTargets } from './adapters/index.js';
import { buildRecallFtsQuery, rerankRecallResults } from './knowledge-search.js';
import { defaultReviewStatusForSource } from './knowledge-review.js';
import {
  buildKnowledgeEventInsertParams,
  buildKnowledgeSnapshot,
  listKnowledgeTimelineItemsForDb,
} from './knowledge-ledger.js';
import { runMigrations } from './migrations.js';
import { allocatePersistedUniqueId, generateId } from './store-ids.js';
import { DEFAULT_STALE_DAYS } from './version.js';

const DEFAULT_CONFIDENCE = 1;

interface RepoCtx {
  db: Database.Database;
  root: string;
  defaultConfidence: number;
}

export class IvnStore {
  private db: Database.Database;
  private root: string;
  private lastAutoSyncError: string | null = null;

  private get repo(): RepoCtx {
    return { db: this.db, root: this.root, defaultConfidence: DEFAULT_CONFIDENCE };
  }

  constructor(root: string) {
    this.root = root;
    const dbPath = getIvnDbPath(root);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    runMigrations(this.db);
    this.syncConfig();
  }

  static init(dir?: string): { root: string; config: ProjectConfig } {
    const { root, config } = initializeProjectConfig(dir);
    const store = new IvnStore(root);
    store.close();

    return { root, config };
  }

  static open(from?: string): IvnStore {
    const root = findIvnRoot(from);
    if (!root) {
      throw new Error(
        'Not an ivn project (or any parent). Run `ivn init` first.',
      );
    }
    return new IvnStore(root);
  }

  // ── CRUD ──────────────────────────────────────────────

  remember(
    content: string,
    options: RememberOptions = {},
  ): Knowledge {
    const now = new Date().toISOString();
    const mutation = this.allocateUniqueId(
      (id) => buildRememberMutation({
        id,
        content,
        input: options,
        root: this.root,
        now,
        defaultConfidence: this.repo.defaultConfidence,
      }),
      (nextMutation) => insertKnowledgeEntry(this.db, nextMutation.insertParams),
      'knowledge entry',
    );

    this.logEvent('knowledge_added', { knowledgeId: mutation.entry.id });
    this.autoSync();
    return mutation.entry;
  }

  get(id: string): Knowledge | null {
    return this.getKnowledge(id);
  }

  list(options: {
    type?: KnowledgeType;
    limit?: number;
    offset?: number;
    includeArchived?: boolean;
    visibility?: VisibilityFilter;
    reviewStatus?: ReviewStatusFilter;
  } = {}): Knowledge[] {
    const {
      type,
      limit = 50,
      offset = 0,
      includeArchived = false,
      visibility = 'all',
      reviewStatus = 'active',
    } = options;
    return listKnowledgeRecords({
      ...this.repo,
      filters: { type, limit, offset, includeArchived, visibility, reviewStatus },
    });
  }

  listAll(options: {
    type?: KnowledgeType;
    includeArchived?: boolean;
    visibility?: VisibilityFilter;
    reviewStatus?: ReviewStatusFilter;
  } = {}): Knowledge[] {
    const {
      type,
      includeArchived = false,
      visibility = 'all',
      reviewStatus = 'active',
    } = options;
    return listAllKnowledge({
      ...this.repo,
      filters: { type, includeArchived, visibility, reviewStatus },
    });
  }

  update(
    id: string,
    updates: Partial<Pick<Knowledge, 'content' | 'type' | 'tags' | 'summary'>>,
  ): Knowledge | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const { sets, params } = buildKnowledgeUpdateMutation({
      updates,
      existing,
      root: this.root,
      now,
    });

    updateKnowledgeFields(this.db, sets, params, id);
    const next = this.getKnowledge(id, true);
    if (next) {
      this.logEvent('knowledge_updated', { knowledgeId: id });
    }
    return next && !next.archived ? next : this.getKnowledge(id);
  }

  forget(id: string): boolean {
    const archived = archiveKnowledgeEntry(this.db, id, new Date().toISOString());
    if (archived) {
      this.logEvent('knowledge_archived', { knowledgeId: id });
    }
    return archived;
  }

  // ── Search ────────────────────────────────────────────

  recall(
    query: string,
    limit: number = 10,
    visibility: VisibilityFilter = 'all',
    reviewStatus: ReviewStatusFilter = 'active',
    filePath?: string,
  ): SearchResult[] {
    const ftsQuery = buildRecallFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = queryRecallRows({
      db: this.db,
      ftsQuery,
      limit,
      visibility,
      reviewStatus,
    });

    const repo = this.repo;
    return rerankRecallResults({
      rows,
      root: this.root,
      filePath,
      limit,
      toKnowledge: (row) => toKnowledgeRecord({ row, root: repo.root, defaultConfidence: repo.defaultConfidence }),
    });
  }

  focus(
    filePath: string,
    limit: number = 10,
    visibility: VisibilityFilter = 'all',
    reviewStatus: ReviewStatusFilter = 'active',
  ): SearchResult[] {
    return this.focusFiles([filePath], limit, visibility, reviewStatus);
  }

  focusFiles(
    filePaths: string[],
    limit: number = 10,
    visibility: VisibilityFilter = 'all',
    reviewStatus: ReviewStatusFilter = 'active',
  ): SearchResult[] {
    return buildFocusedKnowledge({
      entries: this.list({
        limit: 2000,
        visibility,
        reviewStatus,
      }),
      filePaths,
      root: this.root,
      limit,
      visibility,
      reviewStatus,
      getRelated: (id) => this.getRelated(id),
      matchesVisibility: (entry, scope) => this.matchesVisibility(entry, scope),
      matchesReviewStatus: (entry, status) => this.matchesReviewStatus(entry, status),
    });
  }

  warn(
    filePath: string,
    limit: number = 6,
    visibility: VisibilityFilter = 'all',
    reviewStatus: ReviewStatusFilter = 'active',
  ): SearchResult[] {
    return this.warnFiles([filePath], limit, visibility, reviewStatus);
  }

  warnFiles(
    filePaths: string[],
    limit: number = 6,
    visibility: VisibilityFilter = 'all',
    reviewStatus: ReviewStatusFilter = 'active',
  ): SearchResult[] {
    const focused = this.focusFiles(filePaths, Math.max(limit * 3, 18), visibility, reviewStatus);
    return buildWarningKnowledge(focused, limit);
  }

  stale(
    options: {
      days?: number;
      limit?: number;
      visibility?: VisibilityFilter;
    } = {},
  ): Knowledge[] {
    const { days = DEFAULT_STALE_DAYS, limit = 20, visibility = 'all' } = options;
    return buildStaleKnowledge({
      entries: this.listAll({
        visibility,
        reviewStatus: 'active',
      }),
      days,
      limit,
    });
  }

  contradictions(
    options: {
      limit?: number;
      visibility?: VisibilityFilter;
      reviewStatus?: ReviewStatusFilter;
      filePaths?: string[];
    } = {},
  ): ContradictionFinding[] {
    const {
      limit = 20,
      visibility = 'all',
      reviewStatus = 'active',
      filePaths = [],
    } = options;
    return buildContradictionFindings({
      entries: this.listAll({
        visibility,
        reviewStatus,
      }),
      filePaths,
      root: this.root,
      limit,
      supersedesEdges: listSupersedesEdges(this.db),
    });
  }

  changedContext(
    filePaths: string[],
    limit: number = 12,
    visibility: VisibilityFilter = 'all',
    reviewStatus: ReviewStatusFilter = 'active',
  ): string {
    return renderChangedFileKnowledgeContext({
      filePaths,
      limit,
      visibility,
      reviewStatus,
      root: this.root,
      projectName: this.root.split('/').pop() || 'unknown',
      focusFiles: (paths, entryLimit, scope, status) => this.focusFiles(paths, entryLimit, scope, status),
      warnFiles: (paths, warnLimit, scope, status) => this.warnFiles(paths, warnLimit, scope, status),
    });
  }

  // ── Graph ─────────────────────────────────────────────

  link(sourceId: string, targetId: string, type: EdgeType = 'relates_to'): Edge {
    const existing = getEdgeBySignature(this.db, sourceId, targetId, type);
    if (existing) return existing;

    return createKnowledgeLink({
      sourceId,
      targetId,
      type,
      getKnowledge: (id) => this.get(id),
      persistEdge: (edge) => {
        const inserted = this.allocateUniqueId(
          (id) => ({ ...edge, id }),
          (nextEdge) => insertEdge(this.db, {
            id: nextEdge.id,
            sourceId: nextEdge.source_id,
            targetId: nextEdge.target_id,
            type: nextEdge.type,
            createdAt: nextEdge.created_at,
          }),
          'edge',
        );
        edge.id = inserted.id;
      },
      logEvent: (eventType, options) => this.logEvent(eventType, options),
      generateId,
    });
  }

  getRelated(id: string): Array<{ edge: Edge; knowledge: Knowledge }> {
    return getRelatedKnowledge({
      id,
      edges: this.getEdges(id, 'both'),
      getKnowledge: (relatedId) => this.get(relatedId),
    });
  }

  trace(id: string, maxDepth: number = 4): TraversalStep[] {
    return traverseKnowledge({
      id,
      direction: 'both',
      maxDepth,
      getKnowledge: (knowledgeId) => this.get(knowledgeId),
      getEdges: (knowledgeId, direction) => this.getEdges(knowledgeId, direction),
    });
  }

  why(id: string, maxDepth: number = 4): TraversalStep[] {
    return traverseKnowledge({
      id,
      direction: 'incoming',
      maxDepth,
      getKnowledge: (knowledgeId) => this.get(knowledgeId),
      getEdges: (knowledgeId, direction) => this.getEdges(knowledgeId, direction),
    });
  }

  impact(id: string, maxDepth: number = 4): TraversalStep[] {
    return traverseKnowledge({
      id,
      direction: 'outgoing',
      maxDepth,
      getKnowledge: (knowledgeId) => this.get(knowledgeId),
      getEdges: (knowledgeId, direction) => this.getEdges(knowledgeId, direction),
    });
  }

  // ── Context Export ────────────────────────────────────

  context(
    query?: string,
    filePath?: string,
    visibility: VisibilityFilter = 'all',
    reviewStatus: ReviewStatusFilter = 'active',
  ): string {
    return renderStoreContext({
      query,
      filePath,
      root: this.root,
      projectName: this.root.split('/').pop() || 'unknown',
      recall: (searchQuery, limit, visibility, reviewStatus, scopedFilePath) =>
        this.recall(searchQuery, limit, visibility, reviewStatus, scopedFilePath),
      focus: (focusedFilePath, limit, visibility, reviewStatus) =>
        this.focus(focusedFilePath, limit, visibility, reviewStatus),
      warn: (focusedFilePath, limit, visibility, reviewStatus) =>
        this.warn(focusedFilePath, limit, visibility, reviewStatus),
      list: ({ limit }) => this.list({ limit, visibility, reviewStatus }),
    });
  }

  // ── Stats ─────────────────────────────────────────────

  stats(): StoreStats {
    const total = countActiveKnowledge(this.db);
    const typeRows = listKnowledgeTypeCounts(this.db);
    const recent = this.list({ limit: 5 });
    const stale_count = this.stale({ limit: 10000 }).length;
    const pending_count = countPendingKnowledge(this.db);
    return buildStoreStats({
      total,
      countsByTypeRows: typeRows,
      recentEntries: recent,
      staleCount: stale_count,
      pendingCount: pending_count,
    });
  }

  doctor(): DoctorReport {
    const config = this.readConfig();
    const schemaVersion = this.getSchemaVersion();
    const totalEntries = countKnowledge(this.db);
    const totalEdges = countEdges(this.db);
    const warnings = buildDoctorWarnings({ config, schemaVersion });
    if (this.lastAutoSyncError) {
      warnings.push(`Last auto-sync failed: ${this.lastAutoSyncError}`);
    }

    return {
      ...buildDoctorReport({
        root: this.root,
        config,
        schemaVersion,
        dbPath: this.getDbPath(),
        configPath: this.getConfigPath(),
        totalEntries,
        totalEdges,
      }),
      warnings,
    };
  }

  diff(options: { since?: string; limit?: number; visibility?: VisibilityFilter } = {}): KnowledgeDiffItem[] {
    const { since, limit = 20, visibility = 'all' } = options;
    return listKnowledgeTimelineItemsForDb({
      db: this.db,
      since,
      limit,
      visibility,
      getEdge: (id) => this.getEdge(id),
      getKnowledge: (id, includeArchived = false) => this.getKnowledge(id, includeArchived),
    });
  }

  history(options: {
    knowledgeId?: string;
    since?: string;
    limit?: number;
    visibility?: VisibilityFilter;
  } = {}): KnowledgeDiffItem[] {
    const { knowledgeId, since, limit = 20, visibility = 'all' } = options;
    return listKnowledgeTimelineItemsForDb({
      db: this.db,
      since,
      limit,
      visibility,
      knowledgeId,
      getEdge: (id) => this.getEdge(id),
      getKnowledge: (id, includeArchived = false) => this.getKnowledge(id, includeArchived),
    });
  }

  snapshot(options: {
    at: string;
    limit?: number;
    visibility?: VisibilityFilter;
    reviewStatus?: ReviewStatusFilter;
  }): SnapshotResult {
    const {
      at,
      limit = 50,
      visibility = 'all',
      reviewStatus = 'all',
    } = options;
    const repo = this.repo;
    return buildKnowledgeSnapshot({
      at,
      limit,
      visibility,
      reviewStatus,
      loadData: () => loadSnapshotData(repo),
      matchesVisibility: (entry, scope) => this.matchesVisibility(entry, scope),
      defaultReviewStatus: (sourceKind) => this.defaultReviewStatus(sourceKind),
    });
  }

  inferLinks(options: {
    limit?: number;
    visibility?: VisibilityFilter;
    reviewStatus?: ReviewStatusFilter;
    filePaths?: string[];
  } = {}): InferenceSuggestion[] {
    const {
      limit = 20,
      visibility = 'all',
      reviewStatus = 'active',
      filePaths = [],
    } = options;

    return buildLinkInferenceSuggestions({
      entries: this.listAll({
        visibility,
        reviewStatus,
      }),
      filePaths,
      root: this.root,
      limit,
      linkedPairs: this.linkedPairKeys(),
    });
  }

  accept(id: string, note?: string): Knowledge | null {
    const result = this.applyReviewDecision(id, 'active', 'knowledge_accepted', { note, refreshValidity: false });
    if (result) this.autoSync();
    return result;
  }

  reject(id: string, note?: string): Knowledge | null {
    return this.applyReviewDecision(id, 'rejected', 'knowledge_rejected', { note, refreshValidity: false });
  }

  refresh(id: string, note?: string): Knowledge | null {
    return this.applyReviewDecision(id, 'active', 'knowledge_refreshed', { note, refreshValidity: true });
  }

  // ── Duplicate Detection ────────────────────────────────

  findSimilar(content: string, threshold: number = 0.4): Knowledge[] {
    return this.findSimilarInLane(content, threshold, 'all');
  }

  findSimilarInLane(
    content: string,
    threshold: number = 0.4,
    visibility: VisibilityFilter = 'all',
  ): Knowledge[] {
    return findSimilarKnowledgeEntries({
      content,
      threshold,
      visibility,
      candidateRows: this.duplicateCandidates(content),
      ...this.repo,
      matchesVisibility: (entry, scope) => this.matchesVisibility(entry, scope),
      matchesReviewStatus: (entry, status) => this.matchesReviewStatus(entry, status),
    });
  }

  isDuplicate(content: string, visibility: VisibilityFilter = 'all'): { duplicate: boolean; existing?: Knowledge } {
    return detectDuplicateKnowledgeEntry({
      content,
      visibility,
      candidateRows: this.duplicateCandidates(content),
      ...this.repo,
      matchesVisibility: (entry, scope) => this.matchesVisibility(entry, scope),
      matchesReviewStatus: (entry, status) => this.matchesReviewStatus(entry, status),
    });
  }

  rememberIfNew(
    content: string,
    options: {
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
    } = {},
  ): { entry: Knowledge; isNew: boolean } {
    return rememberIfNewKnowledge({
      content,
      visibility: options.visibility || 'shared',
      detectDuplicate: (nextContent, visibility) => this.isDuplicate(nextContent, visibility),
      remember: () => this.remember(content, options),
    });
  }

  rebuildSearch(): void {
    rebuildKnowledgeSearchIndex(this.db);
  }

  // ── Auto-Sync ────────────────────────────────────────

  private _autoSyncEnabled = true;

  setAutoSync(enabled: boolean): void {
    this._autoSyncEnabled = enabled;
  }

  autoSync(): void {
    if (!this._autoSyncEnabled) return;
    try {
      const targets = detectSyncTargets(this.root);
      // Only auto-sync when a real AI tool directory exists (not just generic)
      const hasRealTarget = targets.some(t => t !== 'generic');
      if (!hasRealTarget) {
        this.lastAutoSyncError = null;
        return;
      }
      syncRules(this, { targets: [...targets, 'generic'] });
      this.lastAutoSyncError = null;
    } catch (err: unknown) {
      // sync-rules is best-effort — never block the primary operation
      this.lastAutoSyncError = (err as Error).message;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  getRoot(): string {
    return this.root;
  }

  getDbPath(): string {
    return getIvnDbPath(this.root);
  }

  // ── Private ───────────────────────────────────────────

  private getConfigPath(): string {
    return getIvnConfigPath(this.root);
  }

  private getKnowledge(id: string, includeArchived: boolean = false): Knowledge | null {
    return getKnowledgeById({ ...this.repo, id, includeArchived });
  }

  private getEdge(id: string): Edge | null {
    return getEdgeById(this.db, id);
  }

  private getSchemaVersion(): number {
    return Number(this.db.pragma('user_version', { simple: true }) || 0);
  }

  private queryDuplicateCandidates(ftsQuery: string): Array<Record<string, unknown>> {
    return queryDuplicateCandidateRows(this.db, ftsQuery);
  }

  private duplicateCandidates(content: string): Array<Record<string, unknown>> | null {
    return findDuplicateCandidateRows({
      content,
      queryCandidates: (ftsQuery) => this.queryDuplicateCandidates(ftsQuery),
    });
  }

  private readConfig(): ProjectConfig {
    return readProjectConfig(this.root, this.getSchemaVersion());
  }

  private syncConfig(): void {
    syncProjectConfig(this.root, this.getSchemaVersion());
  }

  private defaultReviewStatus(sourceKind: SourceKind): ReviewStatus {
    return defaultReviewStatusForSource(sourceKind);
  }

  private applyReviewDecision(
    id: string,
    reviewStatus: ReviewStatus,
    eventType: KnowledgeEventType,
    options: { note?: string; refreshValidity?: boolean } = {},
  ): Knowledge | null {
    return applyKnowledgeReviewDecision({
      id,
      reviewStatus,
      eventType,
      note: options.note,
      refreshValidity: options.refreshValidity,
      getKnowledge: (knowledgeId, includeArchived = false) => this.getKnowledge(knowledgeId, includeArchived),
      persistReviewState: (update) => updateKnowledgeReviewState(this.db, {
        id: update.id,
        reviewStatus: update.reviewStatus,
        reviewedAt: update.reviewedAt,
        reviewNote: update.reviewNote,
        validFrom: update.validFrom,
        validTo: update.validTo,
        updatedAt: update.updatedAt,
      }),
      logEvent: (type, logOptions) => this.logEvent(type, logOptions),
    });
  }

  private logEvent(
    type: KnowledgeEventType,
    options: { knowledgeId?: string | null; edgeId?: string | null } = {},
  ): void {
    const now = new Date().toISOString();
    this.allocateUniqueId(
      (id) => buildKnowledgeEventInsertParams({
        id,
        type,
        knowledgeId: options.knowledgeId,
        edgeId: options.edgeId,
        createdAt: now,
      }),
      (insertParams) => insertKnowledgeEvent(this.db, insertParams),
      'knowledge event',
    );
  }

  private allocateUniqueId<T>(
    buildValue: (id: string) => T,
    persist: (value: T) => void,
    label: string,
  ): T {
    return allocatePersistedUniqueId(buildValue, persist, label);
  }

  private getEdges(
    id: string,
    direction: 'incoming' | 'outgoing' | 'both' = 'both',
  ): Edge[] {
    return getEdgesForKnowledge(this.db, id, direction);
  }

  private matchesVisibility(entry: Knowledge | null, visibility: VisibilityFilter): boolean {
    return matchesVisibilityFilter(entry, visibility);
  }

  private matchesReviewStatus(
    entry: Knowledge | null,
    reviewStatus: ReviewStatusFilter | 'all_active_or_pending',
  ): boolean {
    return matchesReviewStatusFilter(entry, reviewStatus);
  }

  private linkedPairKeys(): Set<string> {
    return listLinkedPairKeys(this.db);
  }
}
