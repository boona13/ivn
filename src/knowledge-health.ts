import type { DoctorReport, Knowledge, ProjectConfig, StoreStats } from './types.js';
import { APP_VERSION } from './version.js';

export function buildStoreStats(options: {
  total: number;
  countsByTypeRows: Array<{ type: string; count: number }>;
  recentEntries: Knowledge[];
  staleCount: number;
  pendingCount: number;
}): StoreStats {
  const { total, countsByTypeRows, recentEntries, staleCount, pendingCount } = options;
  const by_type = countsByTypeRows.reduce((acc, row) => {
    acc[row.type] = row.count;
    return acc;
  }, {} as Record<string, number>);

  return {
    total,
    by_type,
    recent: recentEntries,
    stale_count: staleCount,
    pending_count: pendingCount,
  };
}

export function buildDoctorReport(options: {
  root: string;
  config: ProjectConfig;
  schemaVersion: number;
  dbPath: string;
  configPath: string;
  totalEntries: number;
  totalEdges: number;
}): Omit<DoctorReport, 'warnings'> {
  const { root, config, schemaVersion, dbPath, configPath, totalEntries, totalEdges } = options;
  return {
    root,
    db_path: dbPath,
    config_path: configPath,
    app_version: APP_VERSION,
    schema_version: schemaVersion,
    config_version: config.version,
    config_schema_version: config.schema_version,
    total_entries: totalEntries,
    total_edges: totalEdges,
  };
}

export function buildDoctorWarnings(options: {
  config: ProjectConfig;
  schemaVersion: number;
}): string[] {
  const { config, schemaVersion } = options;
  const warnings: string[] = [];
  if (config.schema_version !== schemaVersion) {
    warnings.push(
      `Config schema version (${config.schema_version}) does not match database schema version (${schemaVersion}).`,
    );
  }
  if (config.version !== APP_VERSION) {
    warnings.push(
      `Config was created by IVN ${config.version}; current CLI is ${APP_VERSION}.`,
    );
  }
  return warnings;
}
