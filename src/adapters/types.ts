import type {
  Knowledge,
  KnowledgeType,
  ReviewStatusFilter,
  VisibilityFilter,
} from '../types.js';

export type SyncTarget =
  | 'cursor'
  | 'claude-code'
  | 'codex'
  | 'copilot'
  | 'windsurf'
  | 'cline'
  | 'generic'
  | 'all';

export type RuleSyncTarget = Exclude<SyncTarget, 'all'>;

export const SYNC_TARGETS: RuleSyncTarget[] = [
  'cursor', 'claude-code', 'codex', 'copilot', 'windsurf', 'cline', 'generic',
];

export interface SyncFileResult {
  target: string;
  path: string;
}

export interface SyncRulesResult {
  files: SyncFileResult[];
  patternCount: number;
  gotchaCount: number;
  debugCount: number;
  decisionCount: number;
  dependencyCount: number;
  todoCount: number;
}

export interface KnowledgeBlocks {
  decisions: Knowledge[];
  patterns: Knowledge[];
  gotchas: Knowledge[];
  debugs: Knowledge[];
  dependencies: Knowledge[];
  todos: Knowledge[];
  contexts: Knowledge[];
}

export interface SyncKnowledgeSource {
  getRoot(): string;
  list(options?: {
    type?: KnowledgeType;
    limit?: number;
    offset?: number;
    includeArchived?: boolean;
    visibility?: VisibilityFilter;
    reviewStatus?: ReviewStatusFilter;
  }): Knowledge[];
  listAll(options?: {
    type?: KnowledgeType;
    includeArchived?: boolean;
    visibility?: VisibilityFilter;
    reviewStatus?: ReviewStatusFilter;
  }): Knowledge[];
}

export interface RuleAdapter {
  id: RuleSyncTarget;
  label: string;
  detect(root: string): boolean;
  sync(root: string, blocks: KnowledgeBlocks): SyncFileResult;
}
