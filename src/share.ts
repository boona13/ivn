import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pluralTypeLabel } from './knowledge-ranking.js';
import { IVN_DIR } from './project-config.js';
import type { Edge, EdgeType, Knowledge, KnowledgeType, VisibilityFilter } from './types.js';
import { EDGE_TYPES } from './types.js';
import { IvnStore } from './store.js';
import { APP_VERSION } from './version.js';
import { IVN_KNOWLEDGE_SPEC_VERSION, assertSupportedSpecVersion } from './spec.js';
import { resolvePackFilePath } from './pack-paths.js';

// ── Export Format ───────────────────────────────────────

interface IvnExport {
  spec: 'ivn-knowledge-export';
  spec_version: string;
  version: string;
  exported_at: string;
  project: string;
  entries: Knowledge[];
  edges: Array<{
    source_id: string;
    target_id: string;
    type: string;
  }>;
}

interface KnowledgePackManifest {
  spec: 'ivn-knowledge-pack-manifest';
  spec_version: string;
  version: string;
  exported_at: string;
  project: string;
  visibility: VisibilityFilter;
  count: number;
  merge_strategy: string;
  files: {
    json?: string;
    markdown?: string;
  };
}

const DEFAULT_PACK_DIR = join(IVN_DIR, 'pack');
const PACK_JSON_FILE = 'knowledge-pack.json';
const PACK_MARKDOWN_FILE = 'KNOWLEDGE.md';
const PACK_MANIFEST_FILE = 'manifest.json';

// ── Export ───────────────────────────────────────────────

export function exportKnowledge(
  store: IvnStore,
  options: {
    format?: 'json' | 'markdown' | 'both';
    outDir?: string;
    includePrivate?: boolean;
    jsonFileName?: string;
    markdownFileName?: string;
    exportedAt?: string;
  } = {},
): { jsonPath?: string; mdPath?: string; count: number } {
  const format = options.format || 'both';
  const outDir = resolveOutputDir(store.getRoot(), options.outDir);
  const projectName = store.getRoot().split('/').pop() || 'project';
  const visibility: VisibilityFilter = options.includePrivate ? 'all' : 'shared';
  const exportedAt = options.exportedAt || new Date().toISOString();

  const entries = store.list({ limit: 10000, visibility });
  const result: { jsonPath?: string; mdPath?: string; count: number } = {
    count: entries.length,
  };

  if (entries.length === 0) {
    const hasPrivateOnly = !options.includePrivate && store.list({ limit: 1, visibility: 'all' }).length > 0;
    if (hasPrivateOnly) {
      throw new Error('No shared knowledge to export. Re-run with `--include-private` to export local-only notes.');
    }
    throw new Error('No knowledge to export. Run `ivn remember` first.');
  }

  mkdirSync(outDir, { recursive: true });

  if (format === 'json' || format === 'both') {
    const data: IvnExport = {
      spec: 'ivn-knowledge-export',
      spec_version: IVN_KNOWLEDGE_SPEC_VERSION,
      version: APP_VERSION,
      exported_at: exportedAt,
      project: projectName,
      entries,
      edges: collectEdges(store, entries),
    };

    const jsonPath = join(outDir, options.jsonFileName || '.ivn-export.json');
    writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');
    result.jsonPath = jsonPath;
  }

  if (format === 'markdown' || format === 'both') {
    const md = buildExportMarkdown(projectName, entries);
    const mdPath = join(outDir, options.markdownFileName || '.ivn-export.md');
    writeFileSync(mdPath, md);
    result.mdPath = mdPath;
  }

  return result;
}

export interface SyncKnowledgePackResult {
  packDir: string;
  manifestPath: string;
  jsonPath?: string;
  mdPath?: string;
  count: number;
}

export function syncKnowledgePack(
  store: IvnStore,
  options: { dir?: string; format?: 'json' | 'markdown' | 'both'; includePrivate?: boolean } = {},
): SyncKnowledgePackResult {
  const exportedAt = new Date().toISOString();
  const packDir = resolveOutputDir(store.getRoot(), options.dir || DEFAULT_PACK_DIR);
  const visibility: VisibilityFilter = options.includePrivate ? 'all' : 'shared';
  const projectName = store.getRoot().split('/').pop() || 'project';
  const result = exportKnowledge(store, {
    format: options.format || 'both',
    outDir: packDir,
    includePrivate: options.includePrivate,
    jsonFileName: PACK_JSON_FILE,
    markdownFileName: PACK_MARKDOWN_FILE,
    exportedAt,
  });

  const manifest: KnowledgePackManifest = {
    spec: 'ivn-knowledge-pack-manifest',
    spec_version: IVN_KNOWLEDGE_SPEC_VERSION,
    version: APP_VERSION,
    exported_at: exportedAt,
    project: projectName,
    visibility,
    count: result.count,
    merge_strategy: 'dedupe-by-content-and-link-replay',
    files: {
      json: result.jsonPath ? basename(result.jsonPath) : undefined,
      markdown: result.mdPath ? basename(result.mdPath) : undefined,
    },
  };

  const manifestPath = join(packDir, PACK_MANIFEST_FILE);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return {
    packDir,
    manifestPath,
    jsonPath: result.jsonPath,
    mdPath: result.mdPath,
    count: result.count,
  };
}

function collectEdges(
  store: IvnStore,
  entries: Knowledge[],
): Array<{ source_id: string; target_id: string; type: string }> {
  const edges: Array<{ source_id: string; target_id: string; type: string }> = [];
  const seen = new Set<string>();
  const includedIds = new Set(entries.map((entry) => entry.id));

  for (const entry of entries) {
    const related = store.getRelated(entry.id);
    for (const { edge } of related) {
      if (!includedIds.has(edge.source_id) || !includedIds.has(edge.target_id)) continue;
      const key = [edge.source_id, edge.target_id, edge.type].sort().join(':');
      if (!seen.has(key)) {
        seen.add(key);
        edges.push({
          source_id: edge.source_id,
          target_id: edge.target_id,
          type: edge.type,
        });
      }
    }
  }
  return edges;
}

function buildExportMarkdown(project: string, entries: Knowledge[]): string {
  const grouped = new Map<string, Knowledge[]>();
  for (const e of entries) {
    const group = grouped.get(e.type) || [];
    group.push(e);
    grouped.set(e.type, group);
  }

  const typeOrder: KnowledgeType[] = [
    'context', 'decision', 'pattern', 'gotcha', 'dependency', 'debug', 'todo',
  ];

  let md = `# ${project} — Project Knowledge\n\n`;
  md += `> Exported by [ivn](https://github.com/boona13/ivn) · ${entries.length} entries · ${new Date().toISOString().slice(0, 10)}\n\n`;
  md += `This file is auto-generated. Commit it to share project knowledge with your team.\n\n`;

  for (const type of typeOrder) {
    const items = grouped.get(type);
    if (!items?.length) continue;

    const label = pluralTypeLabel(type);
    md += `## ${label}\n\n`;

    for (const item of items) {
      md += `- **${item.content}**`;
      if (item.tags.length) md += `  \n  _Tags: ${item.tags.join(', ')}_`;
      if (item.source !== 'manual') md += `  \n  _Source: ${item.source}_`;
      md += '\n\n';
    }
  }

  return md;
}

// ── Import ──────────────────────────────────────────────

export interface ImportResult {
  total: number;
  imported: number;
  duplicates: number;
  edges_created: number;
}

export function importKnowledge(
  store: IvnStore,
  filePath: string,
): ImportResult {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  const raw = readFileSync(absPath, 'utf-8');
  let data: Partial<IvnExport>;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON. Use a file created by `ivn export`.');
  }

  assertSupportedSpecVersion(data.spec_version || null);

  if (!data.version || !Array.isArray(data.entries)) {
    throw new Error('Invalid ivn export format. Missing version or entries.');
  }

  const result: ImportResult = {
    total: data.entries.length,
    imported: 0,
    duplicates: 0,
    edges_created: 0,
  };

  const idMap = new Map<string, string>();

  for (const entry of data.entries) {
    const { entry: stored, isNew } = store.rememberIfNew(entry.content, {
      type: entry.type as KnowledgeType,
      tags: entry.tags,
      fileRefs: entry.file_refs,
      source: entry.source || 'import',
      sourceKind: entry.source_kind || 'import',
      sourceRef: entry.source_ref || null,
      confidence: entry.confidence,
      visibility: entry.visibility || 'shared',
      reviewStatus: entry.review_status || 'active',
      reviewNote: entry.review_note || null,
      summary: entry.summary,
    });

    idMap.set(entry.id, stored.id);

    if (isNew) {
      result.imported++;
    } else {
      result.duplicates++;
    }
  }

  if (Array.isArray(data.edges)) {
    for (const edge of data.edges) {
      const sourceId = idMap.get(edge.source_id);
      const targetId = idMap.get(edge.target_id);
      if (sourceId && targetId) {
        if (!EDGE_TYPES.includes(edge.type as EdgeType)) {
          continue;
        }
        try {
          store.link(sourceId, targetId, edge.type as EdgeType);
          result.edges_created++;
        } catch {
          // edge already exists or nodes missing — skip silently
        }
      }
    }
  }

  return result;
}

export interface MergeKnowledgePackResult extends ImportResult {
  packDir: string;
  jsonPath: string;
  manifestPath?: string;
}

export function mergeKnowledgePack(
  store: IvnStore,
  inputPath?: string,
): MergeKnowledgePackResult {
  const resolved = resolvePackInput(store.getRoot(), inputPath);
  const result = importKnowledge(store, resolved.jsonPath);
  return {
    ...result,
    packDir: resolved.packDir,
    jsonPath: resolved.jsonPath,
    manifestPath: resolved.manifestPath,
  };
}

function resolvePackInput(
  root: string,
  inputPath?: string,
): { packDir: string; jsonPath: string; manifestPath?: string } {
  const candidate = resolveOutputDir(root, inputPath || DEFAULT_PACK_DIR);
  if (!existsSync(candidate)) {
    throw new Error(`Knowledge pack not found: ${candidate}`);
  }

  if (statSync(candidate).isDirectory()) {
    const manifestPath = join(candidate, PACK_MANIFEST_FILE);
    if (existsSync(manifestPath)) {
      const manifest = readPackManifest(manifestPath);
      const jsonFile = manifest.files.json || PACK_JSON_FILE;
      const jsonPath = resolvePackFilePath(candidate, jsonFile, 'manifest.files.json');
      if (!existsSync(jsonPath)) {
        throw new Error(`Knowledge pack manifest points to a missing JSON file: ${jsonPath}`);
      }
      return { packDir: candidate, jsonPath, manifestPath };
    }

    const packJsonPath = join(candidate, PACK_JSON_FILE);
    if (existsSync(packJsonPath)) {
      return { packDir: candidate, jsonPath: packJsonPath };
    }

    const currentLegacyJsonPath = join(candidate, '.ivn-export.json');
    if (existsSync(currentLegacyJsonPath)) {
      return { packDir: candidate, jsonPath: currentLegacyJsonPath };
    }

    const oldLegacyJsonPath = join(candidate, '.ivn-export.json');
    if (existsSync(oldLegacyJsonPath)) {
      return { packDir: candidate, jsonPath: oldLegacyJsonPath };
    }

    throw new Error(`No knowledge pack JSON found in ${candidate}`);
  }

  if (basename(candidate) === PACK_MANIFEST_FILE) {
    const manifest = readPackManifest(candidate);
    const packDir = resolve(candidate, '..');
    const jsonFile = manifest.files.json || PACK_JSON_FILE;
    const jsonPath = resolvePackFilePath(packDir, jsonFile, 'manifest.files.json');
    if (!existsSync(jsonPath)) {
      throw new Error(`Knowledge pack manifest points to a missing JSON file: ${jsonPath}`);
    }
    return { packDir, jsonPath, manifestPath: candidate };
  }

  return {
    packDir: resolve(candidate, '..'),
    jsonPath: candidate,
  };
}

function readPackManifest(path: string): KnowledgePackManifest {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<KnowledgePackManifest>;
    assertSupportedSpecVersion(parsed.spec_version || null);
    if (!parsed || typeof parsed !== 'object' || !parsed.files) {
      throw new Error('Missing `files` block.');
    }
    return {
      spec: parsed.spec || 'ivn-knowledge-pack-manifest',
      spec_version: parsed.spec_version || IVN_KNOWLEDGE_SPEC_VERSION,
      version: parsed.version || APP_VERSION,
      exported_at: parsed.exported_at || new Date().toISOString(),
      project: parsed.project || 'unknown',
      visibility: parsed.visibility || 'shared',
      count: parsed.count || 0,
      merge_strategy: parsed.merge_strategy || 'dedupe-by-content-and-link-replay',
      files: parsed.files,
    };
  } catch (err: unknown) {
    throw new Error(`Invalid knowledge pack manifest at ${path}: ${(err as Error).message}`);
  }
}

function resolveOutputDir(root: string, outDir?: string): string {
  return outDir ? resolve(root, outDir) : root;
}

export { syncRules, SYNC_TARGETS, type SyncRulesResult, type SyncTarget } from './adapters/index.js';
