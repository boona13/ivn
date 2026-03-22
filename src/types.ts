export type KnowledgeType =
  | 'decision'
  | 'pattern'
  | 'gotcha'
  | 'debug'
  | 'context'
  | 'dependency'
  | 'todo';

export type EdgeType =
  | 'relates_to'
  | 'caused_by'
  | 'depends_on'
  | 'supersedes'
  | 'implements';

export type SourceKind = 'manual' | 'git' | 'mcp' | 'import' | 'external' | 'conversation';
export type Visibility = 'shared' | 'private';
export type VisibilityFilter = Visibility | 'all';
export type ReviewStatus = 'active' | 'pending' | 'rejected';
export type ReviewStatusFilter = ReviewStatus | 'all';

export interface Knowledge {
  id: string;
  type: KnowledgeType;
  content: string;
  summary: string;
  tags: string[];
  file_refs: string[];
  source: string;
  source_kind: SourceKind;
  source_ref: string | null;
  confidence: number;
  valid_from: string;
  valid_to: string | null;
  visibility: Visibility;
  review_status: ReviewStatus;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

export interface Edge {
  id: string;
  source_id: string;
  target_id: string;
  type: EdgeType;
  created_at: string;
}

export type TraversalDirection = 'start' | 'incoming' | 'outgoing';

export type KnowledgeEventType =
  | 'knowledge_added'
  | 'knowledge_updated'
  | 'knowledge_archived'
  | 'knowledge_accepted'
  | 'knowledge_rejected'
  | 'knowledge_refreshed'
  | 'edge_added';

export interface TraversalStep {
  depth: number;
  knowledge: Knowledge;
  edge: Edge | null;
  direction: TraversalDirection;
}

export interface KnowledgeEvent {
  id: string;
  type: KnowledgeEventType;
  knowledge_id: string | null;
  edge_id: string | null;
  created_at: string;
}

export interface KnowledgeDiffItem {
  event: KnowledgeEvent;
  knowledge: Knowledge | null;
  edge: Edge | null;
  source: Knowledge | null;
  target: Knowledge | null;
}

export interface KnowledgeDiffSummary {
  knowledge_added: number;
  knowledge_updated: number;
  knowledge_archived: number;
  knowledge_accepted: number;
  knowledge_rejected: number;
  knowledge_refreshed: number;
  edge_added: number;
}

export interface SnapshotEntry {
  knowledge: Knowledge;
  content_may_have_changed: boolean;
}

export interface SnapshotResult {
  at: string;
  exact: boolean;
  entries: SnapshotEntry[];
  edges: Edge[];
}

export interface InferenceSuggestion {
  source: Knowledge;
  target: Knowledge;
  suggested_type: EdgeType;
  score: number;
  reason: string;
  shared_tags: string[];
  shared_file_refs: string[];
  shared_terms: string[];
}

export interface SearchResult extends Knowledge {
  rank: number;
}

export type ContradictionKind = 'superseded_active' | 'decision_pattern_conflict';
export type ContradictionSeverity = 'high' | 'medium';

export interface ContradictionFinding {
  kind: ContradictionKind;
  severity: ContradictionSeverity;
  reason: string;
  primary: Knowledge;
  secondary: Knowledge;
  edge: Edge | null;
  shared_tags: string[];
  shared_file_refs: string[];
  shared_terms: string[];
}

export type ConversationFormat = 'jsonl' | 'json' | 'text';

export interface ConversationTurn {
  role?: string;
  content: string;
}

export interface ConversationCandidate {
  content: string;
  type: KnowledgeType;
  confidence: number;
  role: string;
  duplicate: boolean;
  entry: Knowledge | null;
}

export interface ConversationImportResult {
  file: string;
  format: ConversationFormat;
  message_count: number;
  candidate_count: number;
  imported: number;
  duplicates: number;
  items: ConversationCandidate[];
}

export interface ConversationCaptureResult {
  candidate_count: number;
  imported: number;
  duplicates: number;
  items: ConversationCandidate[];
}

export interface ProjectConfig {
  name: string;
  created_at: string;
  version: string;
  schema_version: number;
  tag_globs?: Record<string, { globs: string[]; title?: string }>;
}

export interface StoreStats {
  total: number;
  stale_count: number;
  pending_count: number;
  by_type: Record<string, number>;
  recent: Knowledge[];
}

export interface DoctorReport {
  root: string;
  db_path: string;
  config_path: string;
  app_version: string;
  schema_version: number;
  config_version: string;
  config_schema_version: number;
  total_entries: number;
  total_edges: number;
  warnings: string[];
}

export const KNOWLEDGE_TYPES: KnowledgeType[] = [
  'decision', 'pattern', 'gotcha', 'debug', 'context', 'dependency', 'todo',
];

export const EDGE_TYPES: EdgeType[] = [
  'relates_to', 'caused_by', 'depends_on', 'supersedes', 'implements',
];
