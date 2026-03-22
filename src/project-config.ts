import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProjectConfig } from './types.js';
import { APP_VERSION, SCHEMA_VERSION } from './version.js';

export const IVN_DIR = '.ivn';
export const DB_FILE = 'knowledge.db';
export const CONFIG_FILE = 'config.json';

export function findIvnRoot(from?: string): string | null {
  let dir = resolve(from || process.cwd());
  while (true) {
    if (existsSync(join(dir, IVN_DIR))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

export function getDbPath(root: string): string {
  return join(root, IVN_DIR, DB_FILE);
}

export function getConfigPath(root: string): string {
  return join(root, IVN_DIR, CONFIG_FILE);
}

export function initializeProjectConfig(dir?: string): { root: string; config: ProjectConfig } {
  const root = resolve(dir || process.cwd());
  const ivnDir = join(root, IVN_DIR);

  if (existsSync(ivnDir)) {
    throw new Error(`Already initialized: ${ivnDir}`);
  }

  mkdirSync(ivnDir, { recursive: true });

  const config: ProjectConfig = {
    name: root.split('/').pop() || 'unknown',
    created_at: new Date().toISOString(),
    version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
  };

  writeFileSync(getConfigPath(root), JSON.stringify(config, null, 2));
  writeFileSync(
    join(ivnDir, '.gitignore'),
    'knowledge.db\nknowledge.db-wal\nknowledge.db-shm\nbackups/\n',
  );

  return { root, config };
}

export function readProjectConfig(root: string, schemaVersion: number): ProjectConfig {
  const configPath = getConfigPath(root);
  const defaultConfig: ProjectConfig = {
    name: root.split('/').pop() || 'unknown',
    created_at: new Date().toISOString(),
    version: APP_VERSION,
    schema_version: schemaVersion,
  };

  if (!existsSync(configPath)) {
    return defaultConfig;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<ProjectConfig>;
    return {
      name: raw.name || defaultConfig.name,
      created_at: raw.created_at || defaultConfig.created_at,
      version: raw.version || APP_VERSION,
      schema_version: raw.schema_version || schemaVersion,
      tag_globs: raw.tag_globs,
    };
  } catch (err: unknown) {
    throw new Error(`Invalid ivn config at ${configPath}: ${(err as Error).message}`);
  }
}

export function syncProjectConfig(root: string, schemaVersion: number): ProjectConfig {
  const config = readProjectConfig(root, schemaVersion);
  const nextConfig: ProjectConfig = {
    ...config,
    version: APP_VERSION,
    schema_version: schemaVersion,
  };
  writeFileSync(getConfigPath(root), JSON.stringify(nextConfig, null, 2) + '\n');
  return nextConfig;
}
