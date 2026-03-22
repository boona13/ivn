import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildCoreMarkdown, buildManagedMarkdownBlock, upsertManagedMarkdown } from './core.js';
import type { RuleAdapter, RuleSyncTarget } from './types.js';

function createManagedMarkdownAdapter(
  id: RuleSyncTarget,
  label: string,
  relativePath: string,
  options: { ensureParentDir?: boolean; detectPath?: string } = {},
): RuleAdapter {
  return {
    id,
    label,
    detect(root) {
      return existsSync(join(root, options.detectPath || relativePath));
    },
    sync(root, blocks) {
      const path = join(root, relativePath);
      if (options.ensureParentDir) {
        mkdirSync(dirname(path), { recursive: true });
      }

      const block = buildManagedMarkdownBlock('# Project Knowledge (via ivn)', buildCoreMarkdown(blocks));
      upsertManagedMarkdown(path, block);
      return { target: label, path };
    },
  };
}

export const managedMarkdownAdapters: RuleAdapter[] = [
  createManagedMarkdownAdapter('claude-code', 'Claude Code', 'CLAUDE.md'),
  createManagedMarkdownAdapter('codex', 'OpenAI Codex', 'AGENTS.md'),
  createManagedMarkdownAdapter('copilot', 'GitHub Copilot', join('.github', 'copilot-instructions.md'), {
    ensureParentDir: true,
    detectPath: '.github',
  }),
];
