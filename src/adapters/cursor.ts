import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigPath } from '../project-config.js';
import { buildCoreMarkdown } from './core.js';
import type { Knowledge, ProjectConfig } from '../types.js';
import type { RuleAdapter, KnowledgeBlocks, SyncFileResult } from './types.js';

interface ScopedRule {
  slug: string;
  title: string;
  globs: string[];
  entries: Knowledge[];
}

function inferGlobs(entry: Knowledge): string[] {
  const globs = new Set<string>();

  for (const ref of entry.file_refs) {
    const dir = ref.includes('/') ? ref.slice(0, ref.lastIndexOf('/')) : '';
    globs.add(ref);
    if (dir) globs.add(`${dir}/**`);
  }

  return [...globs];
}

const TAG_GLOB_MAP: Record<string, { globs: string[]; title: string; slug: string }> = {
  api:          { globs: ['src/app/api/**', 'src/routes/**', 'src/api/**', 'api/**', 'pages/api/**'], title: 'API Conventions', slug: 'api' },
  auth:         { globs: ['**/auth/**', '**/session/**', '**/login/**', '**/middleware/auth*'], title: 'Auth & Sessions', slug: 'auth' },
  session:      { globs: ['**/auth/**', '**/session/**', '**/middleware/**'], title: 'Auth & Sessions', slug: 'auth' },
  database:     { globs: ['**/prisma/**', '**/db/**', '**/repositories/**', '**/models/**', '**/migrations/**'], title: 'Database', slug: 'database' },
  prisma:       { globs: ['**/prisma/**', '**/repositories/**', '**/models/**'], title: 'Database', slug: 'database' },
  postgres:     { globs: ['**/prisma/**', '**/repositories/**', '**/db/**'], title: 'Database', slug: 'database' },
  postgresql:   { globs: ['**/prisma/**', '**/repositories/**', '**/db/**'], title: 'Database', slug: 'database' },
  stripe:       { globs: ['**/stripe/**', '**/billing/**', '**/payment**', '**/webhook**'], title: 'Billing & Payments', slug: 'billing' },
  billing:      { globs: ['**/billing/**', '**/payment**', '**/subscription**'], title: 'Billing & Payments', slug: 'billing' },
  webhook:      { globs: ['**/webhook**'], title: 'Webhooks', slug: 'billing' },
  redis:        { globs: ['**/redis**', '**/cache**', '**/session**'], title: 'Redis & Caching', slug: 'redis' },
  cache:        { globs: ['**/cache**', '**/redis**'], title: 'Redis & Caching', slug: 'redis' },
  testing:      { globs: ['test/**', 'tests/**', 'spec/**', '**/*.test.*', '**/*.spec.*'], title: 'Testing', slug: 'testing' },
  nextjs:       { globs: ['src/app/**', 'app/**', 'pages/**', 'src/components/**'], title: 'Next.js & React', slug: 'nextjs' },
  react:        { globs: ['src/components/**', 'src/app/**', '**/*.tsx', '**/*.jsx'], title: 'Next.js & React', slug: 'nextjs' },
  component:    { globs: ['src/components/**', 'src/app/**', '**/*.tsx', '**/*.jsx'], title: 'Next.js & React', slug: 'nextjs' },
  hydration:    { globs: ['src/components/**', 'src/app/**', '**/*.tsx', '**/*.jsx'], title: 'Next.js & React', slug: 'nextjs' },
  ssr:          { globs: ['src/app/**', 'app/**', 'pages/**', 'src/components/**'], title: 'Next.js & React', slug: 'nextjs' },
  docker:       { globs: ['Dockerfile*', 'docker-compose*', '.docker/**'], title: 'Docker', slug: 'docker' },
  ci:           { globs: ['.github/**', '.gitlab-ci*', 'Jenkinsfile*'], title: 'CI/CD', slug: 'ci' },
  email:        { globs: ['**/email**', '**/mail**', '**/notification**'], title: 'Email & Notifications', slug: 'email' },
  resend:       { globs: ['**/email**', '**/mail**', '**/notification**'], title: 'Email & Notifications', slug: 'email' },
  sendgrid:     { globs: ['**/email**', '**/mail**', '**/notification**'], title: 'Email & Notifications', slug: 'email' },
  middleware:    { globs: ['**/middleware/**', '**/middleware.*'], title: 'Middleware', slug: 'middleware' },
  validation:   { globs: ['src/app/api/**', '**/validation**', '**/schemas**', '**/validators/**'], title: 'API Conventions', slug: 'api' },
  zod:          { globs: ['src/app/api/**', '**/validation**', '**/schemas**'], title: 'API Conventions', slug: 'api' },
};

interface TagGlobMapping {
  globs: string[];
  title: string;
  slug: string;
}

function createTagGlobRecord(): Record<string, TagGlobMapping> {
  return Object.create(null) as Record<string, TagGlobMapping>;
}

function getOwnMapping(
  map: Record<string, TagGlobMapping>,
  key: string,
): TagGlobMapping | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function slugify(value: string): string {
  return value
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function buildFileScopedMapping(fileRef: string): TagGlobMapping | null {
  const normalized = fileRef
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');

  if (!normalized || normalized.includes('..')) return null;

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  const dirParts = parts.slice(0, -1);
  const scopeParts = dirParts.length > 0 ? dirParts.slice(-3) : [parts[0].replace(/\.[a-z0-9]+$/i, '')];
  const slugBase = slugify(scopeParts.join('-'));
  if (!slugBase) return null;

  return {
    slug: `file-${slugBase}`,
    title: `File Context: ${scopeParts.join('/')}`,
    globs: dirParts.length > 0 ? [normalized, `${dirParts.join('/')}/**`] : [normalized],
  };
}

function readCustomTagGlobs(root: string): Record<string, TagGlobMapping> | null {
  const configPath = getConfigPath(root);
  if (!existsSync(configPath)) return null;

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<ProjectConfig>;
    if (!config.tag_globs || typeof config.tag_globs !== 'object') return null;

    const custom = createTagGlobRecord();
    for (const [tag, value] of Object.entries(config.tag_globs)) {
      if (value && Array.isArray(value.globs) && value.globs.length > 0) {
        const slug = tag.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        custom[tag] = {
          globs: value.globs,
          title: value.title || `${tag.charAt(0).toUpperCase() + tag.slice(1)} Rules`,
          slug,
        };
      }
    }
    return Object.keys(custom).length > 0 ? custom : null;
  } catch {
    return null;
  }
}

function resolveTagGlobMap(root: string): Record<string, TagGlobMapping> {
  const base = Object.assign(createTagGlobRecord(), TAG_GLOB_MAP);
  const custom = readCustomTagGlobs(root);
  if (!custom) return base;

  for (const [tag, mapping] of Object.entries(custom)) {
    const existing = getOwnMapping(base, tag);
    if (existing) {
      base[tag] = {
        ...existing,
        globs: [...new Set([...mapping.globs, ...existing.globs])],
        title: mapping.title || existing.title,
      };
    } else {
      base[tag] = mapping;
    }
  }
  return base;
}

function appendRuleEntry(
  ruleMap: Map<string, ScopedRule>,
  mapping: TagGlobMapping,
  entry: Knowledge,
  fileGlobs: string[],
): void {
  const existing = ruleMap.get(mapping.slug);
  if (existing) {
    existing.entries.push(entry);
    for (const g of mapping.globs) existing.globs.push(g);
    for (const g of fileGlobs) existing.globs.push(g);
    return;
  }

  ruleMap.set(mapping.slug, {
    slug: mapping.slug,
    title: mapping.title,
    globs: [...mapping.globs, ...fileGlobs],
    entries: [entry],
  });
}

function buildScopedRules(blocks: KnowledgeBlocks, root: string = ''): ScopedRule[] {
  const allEntries = [
    ...blocks.decisions,
    ...blocks.patterns,
    ...blocks.gotchas,
    ...blocks.debugs,
    ...blocks.dependencies,
    ...blocks.todos,
    ...blocks.contexts,
  ];

  const tagGlobMap = resolveTagGlobMap(root);
  const ruleMap = new Map<string, ScopedRule>();

  for (const entry of allEntries) {
    const fileGlobs = inferGlobs(entry);
    let matchedMappedTag = false;

    for (const tag of entry.tags) {
      const mapping = getOwnMapping(tagGlobMap, tag);
      if (!mapping) continue;
      matchedMappedTag = true;
      appendRuleEntry(ruleMap, mapping, entry, fileGlobs);
    }

    if (!matchedMappedTag) {
      for (const ref of entry.file_refs) {
        const mapping = buildFileScopedMapping(ref);
        if (!mapping) continue;
        appendRuleEntry(ruleMap, mapping, entry, fileGlobs);
      }
    }
  }

  // Dedupe globs and entries
  for (const rule of ruleMap.values()) {
    rule.globs = [...new Set(rule.globs)];
    const seen = new Set<string>();
    rule.entries = rule.entries.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }

  return [...ruleMap.values()].filter(r => r.entries.length >= 1);
}

function renderScopedMdc(rule: ScopedRule): string {
  const globList = rule.globs.map(g => `  - ${g}`).join('\n');

  const decisions = rule.entries.filter(e => e.type === 'decision');
  const patterns = rule.entries.filter(e => e.type === 'pattern');
  const gotchas = rule.entries.filter(e => e.type === 'gotcha');
  const deps = rule.entries.filter(e => e.type === 'dependency');
  const debug = rule.entries.filter(e => e.type === 'debug');

  let body = '';

  if (decisions.length) {
    body += '## Decisions\n\nThese decisions have been made. Follow them:\n\n';
    for (const d of decisions) body += `- ${d.content}\n`;
    body += '\n';
  }
  if (patterns.length) {
    body += '## Patterns\n\nAlways follow these:\n\n';
    for (const p of patterns) body += `- ${p.content}\n`;
    body += '\n';
  }
  if (gotchas.length) {
    body += '## Gotchas\n\nWatch out for these:\n\n';
    for (const g of gotchas) body += `- \u26A0 ${g.content}\n`;
    body += '\n';
  }
  if (deps.length) {
    body += '## Constraints\n\n';
    for (const d of deps) body += `- ${d.content}\n`;
    body += '\n';
  }
  if (debug.length) {
    body += '## Past Issues\n\nThese bugs have been fixed before. Avoid reintroducing them:\n\n';
    for (const d of debug) body += `- ${d.content}\n`;
    body += '\n';
  }

  body += `> Discovered a new ${rule.slug} gotcha or pattern? Run: \`ivn remember "..." --type gotcha --tags ${rule.slug}\`\n`;

  return `---
description: "${rule.title} — project knowledge from ivn"
globs:
${globList}
---

# ${rule.title}

> Auto-generated by \`ivn sync-rules\`. Do not edit.

${body}`;
}

function cleanOldScopedRules(dir: string): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (file.startsWith('ivn-') && file.endsWith('.mdc') && file !== 'ivn-knowledge.mdc') {
      unlinkSync(join(dir, file));
    }
  }
}

export const cursorRuleAdapter: RuleAdapter = {
  id: 'cursor',
  label: 'Cursor',
  detect(root) {
    return existsSync(join(root, '.cursor'));
  },
  sync(root, blocks) {
    const dir = join(root, '.cursor', 'rules');
    mkdirSync(dir, { recursive: true });

    // Clean old scoped rules before regenerating
    cleanOldScopedRules(dir);

    // 1. Global always-apply rule (decisions + patterns + gotchas overview)
    const globalContent = `---
description: Project knowledge auto-synced from ivn.
globs: []
alwaysApply: true
---

# Project Knowledge (via ivn)

> Auto-generated by \`ivn sync-rules\`. Do not edit manually.

${buildCoreMarkdown(blocks)}`;

    const globalPath = join(dir, 'ivn-knowledge.mdc');
    writeFileSync(globalPath, globalContent);

    // 2. Scoped per-topic rules (activate when editing relevant files)
    const scoped = buildScopedRules(blocks, root);
    for (const rule of scoped) {
      const path = join(dir, `ivn-${rule.slug}.mdc`);
      writeFileSync(path, renderScopedMdc(rule));
    }

    return { target: this.label, path: globalPath };
  },
};
