import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IVN_DIR } from './project-config.js';
import { IvnStore } from './store.js';
import { APP_VERSION } from './version.js';
const DEFAULT_BACKUP_DIR = join(IVN_DIR, 'backups');
const BACKUP_IGNORE_ENTRY = 'backups/';

export interface BackupFileEntry {
  name: string;
  relative_path: string;
  bytes: number;
}

export interface BackupManifest {
  kind: 'ivn-local-backup';
  version: 1;
  created_at: string;
  app_version: string;
  project_root: string;
  db_path: string;
  config_path: string;
  schema_version: number;
  total_entries: number;
  total_edges: number;
  files: BackupFileEntry[];
}

export interface BackupResult {
  backup_dir: string;
  manifest_path: string;
  created_at: string;
  total_entries: number;
  total_edges: number;
  files: BackupFileEntry[];
}

export function createBackup(from?: string, options: { outDir?: string } = {}): BackupResult {
  const store = IvnStore.open(from);
  const report = store.doctor();
  const root = store.getRoot();
  store.close();

  ensureBackupIgnored(root);

  const createdAt = new Date().toISOString();
  const backupParent = resolve(root, options.outDir || DEFAULT_BACKUP_DIR);
  const backupDir = join(backupParent, `backup-${safeTimestamp(createdAt)}`);
  mkdirSync(backupDir, { recursive: true });

  const files = copyBackupFiles(root, backupDir);
  const manifest: BackupManifest = {
    kind: 'ivn-local-backup',
    version: 1,
    created_at: createdAt,
    app_version: APP_VERSION,
    project_root: root,
    db_path: report.db_path,
    config_path: report.config_path,
    schema_version: report.schema_version,
    total_entries: report.total_entries,
    total_edges: report.total_edges,
    files,
  };

  const manifestPath = join(backupDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return {
    backup_dir: backupDir,
    manifest_path: manifestPath,
    created_at: createdAt,
    total_entries: report.total_entries,
    total_edges: report.total_edges,
    files,
  };
}

function copyBackupFiles(root: string, backupDir: string): BackupFileEntry[] {
  const ivnDir = join(root, IVN_DIR);
  const relativeFiles = [
    'config.json',
    '.gitignore',
    'knowledge.db',
    'knowledge.db-wal',
    'knowledge.db-shm',
  ];

  const copied: BackupFileEntry[] = [];
  for (const relativePath of relativeFiles) {
    const sourcePath = join(ivnDir, relativePath);
    if (!existsSync(sourcePath)) continue;
    const targetPath = join(backupDir, relativePath);
    copyFileSync(sourcePath, targetPath);
    copied.push({
      name: relativePath,
      relative_path: relativePath,
      bytes: statSync(targetPath).size,
    });
  }
  return copied;
}

function ensureBackupIgnored(root: string): void {
  const ignorePath = join(root, IVN_DIR, '.gitignore');
  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.includes(BACKUP_IGNORE_ENTRY)) {
    lines.push(BACKUP_IGNORE_ENTRY);
    writeFileSync(ignorePath, lines.join('\n') + '\n');
  }
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, '-');
}
