import Database from 'better-sqlite3';
import type { EdgeType } from './types.js';

export function insertKnowledgeEntry(
  db: Database.Database,
  insertParams: unknown[],
): void {
  db
    .prepare(
      `INSERT INTO knowledge (
         id, type, content, summary, tags, file_refs, source, source_kind, source_ref,
         confidence, valid_from, valid_to, visibility, review_status, reviewed_at,
         review_note, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...insertParams);
}

export function updateKnowledgeFields(
  db: Database.Database,
  sets: string[],
  params: unknown[],
  id: string,
): void {
  db.prepare(`UPDATE knowledge SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
}

export function archiveKnowledgeEntry(
  db: Database.Database,
  id: string,
  updatedAt: string,
): boolean {
  const result = db
    .prepare('UPDATE knowledge SET archived = 1, updated_at = ? WHERE id = ?')
    .run(updatedAt, id);
  return result.changes > 0;
}

export function updateKnowledgeReviewState(
  db: Database.Database,
  options: {
    id: string;
    reviewStatus: string;
    reviewedAt: string;
    reviewNote: string | null;
    validFrom: string;
    validTo: string | null;
    updatedAt: string;
  },
): void {
  const { id, reviewStatus, reviewedAt, reviewNote, validFrom, validTo, updatedAt } = options;
  db
    .prepare(
      `UPDATE knowledge
       SET review_status = ?, reviewed_at = ?, review_note = ?, valid_from = ?, valid_to = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      reviewStatus,
      reviewedAt,
      reviewNote,
      validFrom,
      validTo,
      updatedAt,
      id,
    );
}

export function insertEdge(
  db: Database.Database,
  options: {
    id: string;
    sourceId: string;
    targetId: string;
    type: EdgeType;
    createdAt: string;
  },
): void {
  const { id, sourceId, targetId, type, createdAt } = options;
  db
    .prepare(
      'INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, sourceId, targetId, type, createdAt);
}

export function insertKnowledgeEvent(db: Database.Database, insertParams: unknown[]): void {
  db
    .prepare(
      `INSERT INTO knowledge_events (id, type, knowledge_id, edge_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(...insertParams);
}

export function rebuildKnowledgeSearchIndex(db: Database.Database): void {
  db.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
}
