import type Database from 'better-sqlite3';
import { SCHEMA_VERSION } from './version.js';

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES knowledge(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES knowledge(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge(created_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_archived ON knowledge(archived);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  content,
  summary,
  tags,
  content='knowledge',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, content, summary, tags)
  VALUES (new.rowid, new.content, new.summary, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, summary, tags)
  VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_fts_update AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, summary, tags)
  VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
  INSERT INTO knowledge_fts(rowid, content, summary, tags)
  VALUES (new.rowid, new.content, new.summary, new.tags);
END;
`;

type Migration = {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initialize core knowledge schema',
    up(db) {
      db.exec(CORE_SCHEMA);
      db.exec(FTS_SCHEMA);
      db.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
    },
  },
  {
    version: 2,
    description: 'add provenance and validity metadata',
    up(db) {
      ensureColumn(db, 'knowledge', 'source_kind', "TEXT NOT NULL DEFAULT 'manual'");
      ensureColumn(db, 'knowledge', 'source_ref', 'TEXT');
      ensureColumn(db, 'knowledge', 'confidence', 'REAL NOT NULL DEFAULT 1.0');
      ensureColumn(db, 'knowledge', 'valid_from', 'TEXT');
      ensureColumn(db, 'knowledge', 'valid_to', 'TEXT');

      db.prepare(
        `UPDATE knowledge
         SET source_kind = CASE
           WHEN source LIKE 'git:%' THEN 'git'
           WHEN source = 'mcp' THEN 'mcp'
           WHEN source = 'import' THEN 'import'
           WHEN source = 'manual' THEN 'manual'
           ELSE 'external'
         END
         WHERE source_kind IS NULL OR source_kind = '' OR source_kind = 'manual'`,
      ).run();

      db.prepare(
        `UPDATE knowledge
         SET source_ref = substr(source, 5)
         WHERE source LIKE 'git:%' AND (source_ref IS NULL OR source_ref = '')`,
      ).run();

      db.prepare(
        `UPDATE knowledge
         SET valid_from = created_at
         WHERE valid_from IS NULL OR valid_from = ''`,
      ).run();
    },
  },
  {
    version: 3,
    description: 'add knowledge event log for reviewable diffs',
    up(db) {
      db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  knowledge_id TEXT,
  edge_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge(id) ON DELETE SET NULL,
  FOREIGN KEY (edge_id) REFERENCES edges(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_events_created ON knowledge_events(created_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_events_knowledge ON knowledge_events(knowledge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_events_edge ON knowledge_events(edge_id);
      `);
    },
  },
  {
    version: 4,
    description: 'add visibility lanes for shared vs private knowledge',
    up(db) {
      ensureColumn(db, 'knowledge', 'visibility', "TEXT NOT NULL DEFAULT 'shared'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_visibility ON knowledge(visibility);');
      db.prepare(
        `UPDATE knowledge
         SET visibility = 'shared'
         WHERE visibility IS NULL OR visibility = ''`,
      ).run();
    },
  },
  {
    version: 5,
    description: 'add editorial review workflow metadata',
    up(db) {
      ensureColumn(db, 'knowledge', 'review_status', "TEXT NOT NULL DEFAULT 'active'");
      ensureColumn(db, 'knowledge', 'reviewed_at', 'TEXT');
      ensureColumn(db, 'knowledge', 'review_note', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_review_status ON knowledge(review_status);');
      db.prepare(
        `UPDATE knowledge
         SET review_status = 'active'
         WHERE review_status IS NULL OR review_status = ''`,
      ).run();
    },
  },
  {
    version: 6,
    description: 'add file references for adaptive context retrieval',
    up(db) {
      ensureColumn(db, 'knowledge', 'file_refs', "TEXT NOT NULL DEFAULT '[]'");
      db.prepare(
        `UPDATE knowledge
         SET file_refs = '[]'
         WHERE file_refs IS NULL OR file_refs = ''`,
      ).run();
    },
  },
  {
    version: 7,
    description: 'deduplicate graph edges and enforce unique edge signatures',
    up(db) {
      db.exec(`
DELETE FROM edges
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM edges
  GROUP BY source_id, target_id, type
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique_signature
  ON edges(source_id, target_id, type);
      `);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  const currentVersion = Number(db.pragma('user_version', { simple: true }) || 0);

  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `This .ivn database uses schema v${currentVersion}, but this build supports up to v${SCHEMA_VERSION}.`,
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    const tx = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      tx();
    } catch (err: unknown) {
      throw new Error(
        `Failed to apply schema migration v${migration.version} (${migration.description}): ${(err as Error).message}`,
      );
    }
  }
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;

  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
