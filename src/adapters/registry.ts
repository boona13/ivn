import { gatherKnowledge, hasContent } from './core.js';
import { cursorRuleAdapter } from './cursor.js';
import { managedMarkdownAdapters } from './managed-markdown.js';
import { simpleMarkdownAdapters } from './simple-markdown.js';
import {
  SYNC_TARGETS,
  type RuleAdapter,
  type RuleSyncTarget,
  type SyncKnowledgeSource,
  type SyncRulesResult,
  type SyncTarget,
} from './types.js';

const RULE_ADAPTERS: RuleAdapter[] = [
  cursorRuleAdapter,
  ...managedMarkdownAdapters,
  ...simpleMarkdownAdapters,
];

const RULE_ADAPTERS_BY_ID = new Map<RuleSyncTarget, RuleAdapter>(
  RULE_ADAPTERS.map((adapter) => [adapter.id, adapter]),
);

export function detectSyncTargets(root: string): RuleSyncTarget[] {
  const detected = RULE_ADAPTERS
    .filter((adapter) => adapter.id !== 'generic' && adapter.detect(root))
    .map((adapter) => adapter.id);
  return detected.length > 0 ? detected : ['generic'];
}

export function listRuleAdapters(): Array<{ id: RuleSyncTarget; label: string }> {
  return RULE_ADAPTERS.map((adapter) => ({ id: adapter.id, label: adapter.label }));
}

export function syncRules(
  store: SyncKnowledgeSource,
  options: { targets?: SyncTarget[]; includePrivate?: boolean } = {},
): SyncRulesResult {
  const root = store.getRoot();
  const blocks = gatherKnowledge(store, options.includePrivate ? 'all' : 'shared');

  if (!hasContent(blocks)) {
    const hasPrivateOnly = !options.includePrivate && store.list({ limit: 1, visibility: 'all' }).length > 0;
    if (hasPrivateOnly) {
      throw new Error('No shared knowledge to sync. Re-run with `--include-private` to generate rules from local-only notes.');
    }
    throw new Error('No knowledge to sync. Run `ivn remember` first.');
  }

  const targets = resolveTargets(root, options.targets);
  const files = targets.map((target) => RULE_ADAPTERS_BY_ID.get(target)!.sync(root, blocks));

  return {
    files,
    patternCount: blocks.patterns.length,
    gotchaCount: blocks.gotchas.length,
    debugCount: blocks.debugs.length,
    decisionCount: blocks.decisions.length,
    dependencyCount: blocks.dependencies.length,
    todoCount: blocks.todos.length,
  };
}

function resolveTargets(root: string, requested?: SyncTarget[]): RuleSyncTarget[] {
  if (requested && requested.length > 0) {
    if (requested.includes('all')) {
      return [...SYNC_TARGETS];
    }
    return dedupeTargets(requested.filter((target): target is RuleSyncTarget => target !== 'all'));
  }

  const detected = detectSyncTargets(root);
  return detected.includes('generic') ? detected : [...detected, 'generic'];
}

function dedupeTargets(targets: RuleSyncTarget[]): RuleSyncTarget[] {
  return [...new Set(targets)];
}
