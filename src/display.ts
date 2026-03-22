import chalk from 'chalk';
import { pluralTypeLabel } from './knowledge-ranking.js';
import { MS_PER_DAY } from './version.js';
import type {
  ContradictionFinding,
  DoctorReport,
  InferenceSuggestion,
  Knowledge,
  KnowledgeDiffItem,
  KnowledgeDiffSummary,
  KnowledgeType,
  SnapshotResult,
  SearchResult,
  StoreStats,
} from './types.js';
import { APP_VERSION, DEFAULT_STALE_DAYS } from './version.js';

export const TYPE_COLORS: Record<KnowledgeType, (s: string) => string> = {
  decision:   chalk.blue,
  pattern:    chalk.green,
  gotcha:     chalk.yellow,
  debug:      chalk.red,
  context:    chalk.cyan,
  dependency: chalk.magenta,
  todo:       chalk.white,
};

const TYPE_ICONS: Record<KnowledgeType, string> = {
  decision:   '\u25C6',
  pattern:    '\u25C8',
  gotcha:     '\u26A0',
  debug:      '\u2716',
  context:    '\u25CF',
  dependency: '\u25CE',
  todo:       '\u2610',
};

export function banner(): string {
  return [
    '',
    chalk.bold.cyan('  \u2566\u2554\u2557\u2554\u2566  \u2566'),
    chalk.bold.cyan('  \u2551\u2551\u2551\u2551\u255A\u2557\u2554\u255D'),
    chalk.bold.cyan('  \u2569\u255D\u255A\u255D \u255A\u255D') + '  ' + chalk.dim(`v${APP_VERSION}`),
    chalk.dim('  The memory layer for your projects'),
    '',
  ].join('\n');
}

export function formatKnowledge(
  entry: Knowledge,
  options: { verbose?: boolean } = {},
): string {
  const color = TYPE_COLORS[entry.type] || chalk.white;
  const icon = TYPE_ICONS[entry.type] || '\u25CF';
  const age = timeAgo(entry.created_at);

  const lines: string[] = [];
  lines.push(
    `  ${color(icon)} ${chalk.bold(color(entry.type.toUpperCase()))} ${chalk.dim('#' + entry.id)}${formatKnowledgeBadges(entry)} ${chalk.dim('\u00B7 ' + age)}`,
  );
  lines.push(`  ${entry.content}`);

  if (entry.tags.length > 0) {
    lines.push(`  ${entry.tags.map((t) => chalk.dim.italic('#' + t)).join(' ')}`);
  }

  if (entry.file_refs.length > 0) {
    lines.push(`  ${chalk.dim('files: ' + summarizeFileRefs(entry.file_refs))}`);
  }

  if (options.verbose) {
    lines.push(
      `  ${chalk.dim('source: ' + entry.source + ' \u00B7 ' + entry.created_at)}`,
    );
    lines.push(
      `  ${chalk.dim('review: ' + entry.review_status + (entry.reviewed_at ? ' \u00B7 ' + entry.reviewed_at : ''))}`,
    );
    lines.push(
      `  ${chalk.dim('freshness: ' + (isStale(entry) ? 'stale' : 'fresh') + ' \u00B7 last-confirmed ' + freshnessTimestamp(entry))}`,
    );
    if (entry.review_note) {
      lines.push(`  ${chalk.dim('note: ' + entry.review_note)}`);
    }
  }

  return lines.join('\n');
}

export function formatSearchResult(result: SearchResult, index: number): string {
  const color = TYPE_COLORS[result.type] || chalk.white;
  const icon = TYPE_ICONS[result.type] || '\u25CF';
  const age = timeAgo(result.created_at);

  const lines: string[] = [];
  lines.push(
    `  ${chalk.dim((index + 1) + '.')} ${color(icon)} ${chalk.bold(color(result.type))} ${chalk.dim('#' + result.id)}${formatKnowledgeBadges(result)} ${chalk.dim('\u00B7 ' + age)}`,
  );
  lines.push(`     ${result.content}`);

  if (result.tags.length > 0) {
    lines.push(`     ${result.tags.map((t) => chalk.dim.italic('#' + t)).join(' ')}`);
  }

  if (result.file_refs.length > 0) {
    lines.push(`     ${chalk.dim('files: ' + summarizeFileRefs(result.file_refs))}`);
  }

  return lines.join('\n');
}

export function formatList(entries: Knowledge[]): string {
  if (entries.length === 0) return chalk.dim('  No knowledge found.\n');
  return entries.map((e) => formatKnowledge(e)).join('\n\n');
}

export function formatStatus(stats: StoreStats, root: string): string {
  const name = root.split('/').pop() || 'project';
  const lines: string[] = [];

  lines.push('');
  lines.push(`  ${chalk.bold('Project:')} ${chalk.cyan(name)}`);
  lines.push(`  ${chalk.dim('Root:    ' + root)}`);
  lines.push('');
  lines.push(`  ${chalk.bold('Knowledge Graph')}`);
  lines.push(`  ${chalk.dim('\u2500'.repeat(40))}`);
  lines.push(`  Total entries: ${chalk.bold(String(stats.total))}`);
  const reviewCount = stats.pending_count + stats.stale_count;
  const reviewParts: string[] = [];
  if (stats.pending_count > 0) reviewParts.push(`${stats.pending_count} pending`);
  if (stats.stale_count > 0) reviewParts.push(`${stats.stale_count} stale`);
  lines.push(`  Needs review:  ${reviewCount > 0 ? chalk.yellow.bold(String(reviewCount)) + chalk.dim(` (${reviewParts.join(', ')})`) : chalk.dim('0')}`);
  lines.push('');

  if (Object.keys(stats.by_type).length > 0) {
    const maxCount = Math.max(...Object.values(stats.by_type));
    for (const [type, count] of Object.entries(stats.by_type)) {
      const color = TYPE_COLORS[type as KnowledgeType] || chalk.white;
      const icon = TYPE_ICONS[type as KnowledgeType] || '\u25CF';
      const barLen = maxCount > 0 ? Math.max(1, Math.round((count / maxCount) * 25)) : 1;
      const bar = color('\u2588'.repeat(barLen));
      lines.push(`  ${color(icon)} ${color(type.padEnd(12))} ${bar} ${chalk.bold(String(count))}`);
    }
  } else {
    lines.push(chalk.dim('  Empty \u2014 run `ivn remember` to add knowledge'));
  }

  if (stats.recent.length > 0) {
    lines.push('');
    lines.push(`  ${chalk.bold('Recent')}`);
    lines.push(`  ${chalk.dim('\u2500'.repeat(40))}`);
    for (const entry of stats.recent) {
      const color = TYPE_COLORS[entry.type] || chalk.white;
      const icon = TYPE_ICONS[entry.type] || '\u25CF';
      lines.push(`  ${color(icon)} ${chalk.dim('#' + entry.id)}${formatKnowledgeBadges(entry)} ${entry.summary}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export function formatInitSuccess(
  root: string,
  name: string,
  template?: { label: string; count: number },
): string {
  const lines = [
    banner(),
    `  ${chalk.green('\u2713')} Initialized ivn in ${chalk.bold(root + '/.ivn')}`,
    `  ${chalk.dim('Project:')} ${chalk.bold(name)}`,
  ];

  if (template) {
    lines.push(`  ${chalk.dim('Template:')} ${chalk.bold(template.label)} ${chalk.dim(`(${template.count} starter entries)`)}`);
  }

  lines.push(
    '',
    `  ${chalk.bold('Core loop:')}`,
    `  ${chalk.cyan('ivn remember')} ${chalk.dim('"We chose PostgreSQL for JSON support"')}`,
    `  ${chalk.cyan('ivn recall')}   ${chalk.dim('"database"')}`,
    `  ${chalk.cyan('ivn context')}  ${chalk.dim('Export AI-ready project context')}`,
    `  ${chalk.cyan('ivn status')}   ${chalk.dim('Project overview')}`,
    `  ${chalk.cyan('ivn log')}      ${chalk.dim('View the recent knowledge timeline')}`,
    '',
    `  ${chalk.bold('When ready:')}`,
    `  ${chalk.cyan('ivn diff')}     ${chalk.dim('Review knowledge changes before sharing')}`,
    `  ${chalk.cyan('ivn sync-rules')} ${chalk.dim('Project knowledge into AI rule files')}`,
    `  ${chalk.cyan('ivn serve')}    ${chalk.dim('Start MCP server for AI tools')}`,
    '',
  );

  return lines.join('\n');
}

export function formatDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${chalk.bold('IVN Doctor')}`);
  lines.push(`  ${chalk.dim('\u2500'.repeat(40))}`);
  lines.push(`  ${chalk.bold('Root:')}           ${report.root}`);
  lines.push(`  ${chalk.bold('DB:')}             ${report.db_path}`);
  lines.push(`  ${chalk.bold('Config:')}         ${report.config_path}`);
  lines.push(`  ${chalk.bold('CLI Version:')}    ${report.app_version}`);
  lines.push(`  ${chalk.bold('Schema Version:')} ${report.schema_version}`);
  lines.push(`  ${chalk.bold('Config Version:')} ${report.config_version}`);
  lines.push(`  ${chalk.bold('Entries:')}        ${report.total_entries}`);
  lines.push(`  ${chalk.bold('Edges:')}          ${report.total_edges}`);

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(`  ${chalk.yellow.bold('Warnings')}`);
    for (const warning of report.warnings) {
      lines.push(`  ${chalk.yellow('\u26A0')} ${warning}`);
    }
  } else {
    lines.push('');
    lines.push(`  ${chalk.green('\u2713')} Config and schema look healthy.`);
  }

  lines.push('');
  return lines.join('\n');
}

export function formatDiff(items: KnowledgeDiffItem[]): string {
  return formatKnowledgeTimeline('Knowledge Diff', 'No knowledge changes found.', items);
}

export function formatHistory(items: KnowledgeDiffItem[], knowledgeId?: string): string {
  return formatKnowledgeTimeline(
    knowledgeId ? `History for #${knowledgeId}` : 'Knowledge History',
    knowledgeId ? `No history found for #${knowledgeId}.` : 'No knowledge history found.',
    items,
  );
}

function formatKnowledgeTimeline(title: string, emptyMessage: string, items: KnowledgeDiffItem[]): string {
  if (items.length === 0) {
    return chalk.dim(`\n  ${emptyMessage}\n`);
  }

  const lines: string[] = [];
  const counts = summarizeDiff(items);
  lines.push('');
  lines.push(`  ${chalk.bold(title)}`);
  lines.push('');
  lines.push(
    `  ${chalk.green('+')} ${counts.knowledge_added} added  ` +
    `${chalk.cyan('~')} ${counts.knowledge_updated} updated  ` +
    `${chalk.yellow('-')} ${counts.knowledge_archived} archived  ` +
    `${chalk.green('✓')} ${counts.knowledge_accepted} accepted  ` +
    `${chalk.red('×')} ${counts.knowledge_rejected} rejected  ` +
    `${chalk.blue('↻')} ${counts.knowledge_refreshed} refreshed  ` +
    `${chalk.magenta('→')} ${counts.edge_added} linked`,
  );
  lines.push('');

  for (const item of items) {
    const age = timeAgo(item.event.created_at);

    if (item.event.type === 'knowledge_added' && item.knowledge) {
      lines.push(`  ${chalk.green('+')} ${chalk.bold('added')} ${labelKnowledge(item.knowledge)} ${chalk.dim('· ' + age)}`);
      lines.push(`    ${item.knowledge.summary}`);
    } else if (item.event.type === 'knowledge_updated' && item.knowledge) {
      lines.push(`  ${chalk.cyan('~')} ${chalk.bold('updated')} ${labelKnowledge(item.knowledge)} ${chalk.dim('· ' + age)}`);
      lines.push(`    ${item.knowledge.summary}`);
    } else if (item.event.type === 'knowledge_archived' && item.knowledge) {
      lines.push(`  ${chalk.yellow('-')} ${chalk.bold('archived')} ${labelKnowledge(item.knowledge)} ${chalk.dim('· ' + age)}`);
      lines.push(`    ${item.knowledge.summary}`);
    } else if (item.event.type === 'knowledge_accepted' && item.knowledge) {
      lines.push(`  ${chalk.green('✓')} ${chalk.bold('accepted')} ${labelKnowledge(item.knowledge)} ${chalk.dim('· ' + age)}`);
      lines.push(`    ${item.knowledge.summary}`);
    } else if (item.event.type === 'knowledge_rejected' && item.knowledge) {
      lines.push(`  ${chalk.red('×')} ${chalk.bold('rejected')} ${labelKnowledge(item.knowledge)} ${chalk.dim('· ' + age)}`);
      lines.push(`    ${item.knowledge.summary}`);
    } else if (item.event.type === 'knowledge_refreshed' && item.knowledge) {
      lines.push(`  ${chalk.blue('↻')} ${chalk.bold('refreshed')} ${labelKnowledge(item.knowledge)} ${chalk.dim('· ' + age)}`);
      lines.push(`    ${item.knowledge.summary}`);
    } else if (item.event.type === 'edge_added' && item.edge) {
      const source = item.source ? labelKnowledge(item.source) : chalk.dim('#' + item.edge.source_id);
      const target = item.target ? labelKnowledge(item.target) : chalk.dim('#' + item.edge.target_id);
      lines.push(`  ${chalk.magenta('→')} ${chalk.bold('linked')} ${source} ${chalk.cyan(item.edge.type)} ${target} ${chalk.dim('· ' + age)}`);
    } else {
      lines.push(`  ${chalk.dim('?')} ${item.event.type} ${chalk.dim('· ' + age)}`);
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function formatSnapshot(snapshot: SnapshotResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${chalk.bold('Knowledge Snapshot')}`);
  lines.push(`  ${chalk.dim('As of:')} ${snapshot.at}`);
  lines.push(`  ${chalk.dim('Entries:')} ${snapshot.entries.length}  ${chalk.dim('Edges:')} ${snapshot.edges.length}`);
  if (!snapshot.exact) {
    lines.push(`  ${chalk.yellow('!')} ${chalk.yellow('Best effort snapshot: some entry content may have changed after this date.')}`);
  }
  lines.push('');

  if (snapshot.entries.length === 0) {
    lines.push(`  ${chalk.dim('No knowledge matched this snapshot.')}`);
    lines.push('');
    return lines.join('\n');
  }

  const grouped = new Map<KnowledgeType, SnapshotResult['entries']>();
  for (const entry of snapshot.entries) {
    const group = grouped.get(entry.knowledge.type) || [];
    group.push(entry);
    grouped.set(entry.knowledge.type, group);
  }

  for (const type of TYPE_ORDER) {
    const items = grouped.get(type);
    if (!items?.length) continue;
    lines.push(`  ${chalk.bold(typeSectionLabel(type))}`);
    lines.push('');
    for (const item of items) {
      lines.push(formatKnowledge(item.knowledge));
      if (item.content_may_have_changed) {
        lines.push(`  ${chalk.yellow('[current content may differ from snapshot time]')}`);
      }
      lines.push('');
    }
  }

  if (snapshot.edges.length > 0) {
    lines.push(`  ${chalk.bold('Relationships')}`);
    lines.push('');
    for (const edge of snapshot.edges) {
      lines.push(`  ${chalk.magenta('→')} ${chalk.dim('#' + edge.source_id)} ${chalk.cyan(edge.type)} ${chalk.dim('#' + edge.target_id)}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function formatDiffMarkdown(items: KnowledgeDiffItem[]): string {
  if (items.length === 0) {
    return [
      '# IVN Knowledge Diff',
      '',
      '> No knowledge changes found.',
      '',
    ].join('\n');
  }

  const counts = summarizeDiff(items);
  const lines: string[] = [];
  const grouped = groupKnowledgeDiff(items);

  lines.push('# IVN Knowledge Diff');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- ${counts.knowledge_added} knowledge entr${counts.knowledge_added === 1 ? 'y' : 'ies'} added`);
  lines.push(`- ${counts.knowledge_updated} knowledge entr${counts.knowledge_updated === 1 ? 'y' : 'ies'} updated`);
  lines.push(`- ${counts.knowledge_archived} knowledge entr${counts.knowledge_archived === 1 ? 'y' : 'ies'} archived`);
  lines.push(`- ${counts.knowledge_accepted} knowledge entr${counts.knowledge_accepted === 1 ? 'y' : 'ies'} accepted`);
  lines.push(`- ${counts.knowledge_rejected} knowledge entr${counts.knowledge_rejected === 1 ? 'y' : 'ies'} rejected`);
  lines.push(`- ${counts.knowledge_refreshed} knowledge entr${counts.knowledge_refreshed === 1 ? 'y' : 'ies'} refreshed`);
  lines.push(`- ${counts.edge_added} relationship${counts.edge_added === 1 ? '' : 's'} added`);

  for (const type of TYPE_ORDER) {
    const section = grouped[type];
    if (!section.length) continue;
    lines.push('');
    lines.push(`## ${typeSectionLabel(type)}`);
    lines.push('');

    for (const item of section) {
      const entry = item.knowledge!;
      const action = describeKnowledgeAction(item.event.type);
      lines.push(`- ${action} \`${entry.id}\`: ${entry.summary}`);
    }
  }

  if (grouped.relationships.length > 0) {
    lines.push('');
    lines.push('## Relationships');
    lines.push('');
    for (const item of grouped.relationships) {
      if (!item.edge) continue;
      const source = item.source ? `\`${item.source.id}\` (${item.source.type})` : `\`${item.edge.source_id}\``;
      const target = item.target ? `\`${item.target.id}\` (${item.target.type})` : `\`${item.edge.target_id}\``;
      lines.push(`- Linked ${source} \`${item.edge.type}\` ${target}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export function formatContradictions(findings: ContradictionFinding[]): string {
  if (findings.length === 0) {
    return chalk.dim('\n  No contradictions found.\n');
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${chalk.bold('Contradictions')}`);
  lines.push('');

  for (const finding of findings) {
    const severity = finding.severity === 'high'
      ? chalk.red.bold('[high]')
      : chalk.yellow.bold('[medium]');
    lines.push(`  ${severity} ${finding.reason}`);
    lines.push(`    ${labelKnowledge(finding.primary)} ${chalk.dim('vs')} ${labelKnowledge(finding.secondary)}`);

    if (finding.shared_file_refs.length > 0) {
      lines.push(`    ${chalk.dim('files: ' + summarizeFileRefs(finding.shared_file_refs))}`);
    } else if (finding.shared_tags.length > 0) {
      lines.push(`    ${chalk.dim('tags: ' + finding.shared_tags.map((tag) => '#' + tag).join(' '))}`);
    } else if (finding.shared_terms.length > 0) {
      lines.push(`    ${chalk.dim('terms: ' + finding.shared_terms.join(', '))}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function formatInferenceSuggestions(suggestions: InferenceSuggestion[]): string {
  if (suggestions.length === 0) {
    return chalk.dim('\n  No inferred relationships found.\n');
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${chalk.bold('Inferred Relationships')}`);
  lines.push('');

  for (const suggestion of suggestions) {
    lines.push(
      `  ${chalk.cyan('→')} ${labelKnowledge(suggestion.source)} ${chalk.cyan(suggestion.suggested_type)} ${labelKnowledge(suggestion.target)} ${chalk.dim(`(score ${suggestion.score})`)}`,
    );
    lines.push(`    ${suggestion.reason}`);
    if (suggestion.shared_file_refs.length > 0) {
      lines.push(`    ${chalk.dim('files: ' + summarizeFileRefs(suggestion.shared_file_refs))}`);
    }
    if (suggestion.shared_tags.length > 0) {
      lines.push(`    ${chalk.dim('tags: ' + suggestion.shared_tags.map((tag) => '#' + tag).join(' '))}`);
    }
    if (suggestion.shared_terms.length > 0) {
      lines.push(`    ${chalk.dim('terms: ' + suggestion.shared_terms.join(', '))}`);
    }
    lines.push(
      `    ${chalk.dim(`link with: ivn link ${suggestion.source.id} ${suggestion.target.id} --type ${suggestion.suggested_type}`)}`,
    );
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function formatReviewSummaryMarkdown(items: KnowledgeDiffItem[]): string {
  const summaryItems = collectReviewSummaryItems(items);
  const lines: string[] = ['## IVN Review Summary', ''];

  if (
    summaryItems.decisions.length === 0 &&
    summaryItems.gotchas.length === 0 &&
    summaryItems.todos.length === 0 &&
    summaryItems.pending.length === 0
  ) {
    lines.push('- No new decisions, gotchas, TODOs, or pending review items in this range.');
    lines.push('');
    return lines.join('\n');
  }

  if (summaryItems.decisions.length > 0) {
    lines.push('### Decisions');
    lines.push('');
    for (const item of summaryItems.decisions) {
      lines.push(`- ${formatReviewSummaryBullet(item)}`);
    }
    lines.push('');
  }

  if (summaryItems.gotchas.length > 0) {
    lines.push('### Gotchas');
    lines.push('');
    for (const item of summaryItems.gotchas) {
      lines.push(`- ${formatReviewSummaryBullet(item)}`);
    }
    lines.push('');
  }

  if (summaryItems.todos.length > 0) {
    lines.push('### TODOs');
    lines.push('');
    for (const item of summaryItems.todos) {
      lines.push(`- ${formatReviewSummaryBullet(item)}`);
    }
    lines.push('');
  }

  if (summaryItems.pending.length > 0) {
    lines.push('### Pending Review');
    lines.push('');
    for (const item of summaryItems.pending) {
      lines.push(`- ${formatPendingReviewBullet(item)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function labelKnowledge(entry: Knowledge): string {
  const color = TYPE_COLORS[entry.type] || chalk.white;
  return `${color(entry.type)} ${chalk.dim('#' + entry.id)}${formatKnowledgeBadges(entry)}`;
}

export function summarizeDiff(items: KnowledgeDiffItem[]): KnowledgeDiffSummary {
  const counts: KnowledgeDiffSummary = {
    knowledge_added: 0,
    knowledge_updated: 0,
    knowledge_archived: 0,
    knowledge_accepted: 0,
    knowledge_rejected: 0,
    knowledge_refreshed: 0,
    edge_added: 0,
  };

  for (const item of items) {
    if (item.event.type in counts) {
      counts[item.event.type as keyof typeof counts]++;
    }
  }

  return counts;
}

const TYPE_ORDER: KnowledgeType[] = [
  'decision',
  'pattern',
  'gotcha',
  'debug',
  'context',
  'dependency',
  'todo',
];

function groupKnowledgeDiff(items: KnowledgeDiffItem[]): Record<string, KnowledgeDiffItem[]> {
  const grouped: Record<string, KnowledgeDiffItem[]> = {
    decision: [],
    pattern: [],
    gotcha: [],
    debug: [],
    context: [],
    dependency: [],
    todo: [],
    relationships: [],
  };

  for (const item of items) {
    if (item.knowledge) {
      grouped[item.knowledge.type].push(item);
    } else if (item.edge) {
      grouped.relationships.push(item);
    }
  }

  return grouped;
}

function typeSectionLabel(type: KnowledgeType): string {
  return pluralTypeLabel(type);
}

function describeKnowledgeAction(type: KnowledgeDiffItem['event']['type']): string {
  if (type === 'knowledge_added') return 'Added';
  if (type === 'knowledge_updated') return 'Updated';
  if (type === 'knowledge_archived') return 'Archived';
  if (type === 'knowledge_accepted') return 'Accepted';
  if (type === 'knowledge_rejected') return 'Rejected';
  if (type === 'knowledge_refreshed') return 'Refreshed';
  return 'Changed';
}

function formatKnowledgeBadges(entry: Knowledge): string {
  const badges: string[] = [];
  if (entry.visibility === 'private') badges.push(chalk.yellow('[private]'));
  if (entry.review_status === 'pending') badges.push(chalk.yellow('[pending]'));
  if (entry.review_status === 'rejected') badges.push(chalk.red('[rejected]'));
  if (isStale(entry)) badges.push(chalk.yellow('[stale]'));
  return badges.length > 0 ? ' ' + badges.join(' ') : '';
}

function summarizeFileRefs(fileRefs: string[]): string {
  const visible = fileRefs.slice(0, 3);
  const suffix = fileRefs.length > 3 ? ` +${fileRefs.length - 3} more` : '';
  return visible.join(', ') + suffix;
}

function freshnessTimestamp(entry: Knowledge): string {
  return entry.reviewed_at || entry.updated_at || entry.valid_from || entry.created_at;
}

function isStale(entry: Knowledge): boolean {
  if (entry.archived || entry.review_status !== 'active' || entry.valid_to !== null) return false;
  const ageMs = Date.now() - Date.parse(freshnessTimestamp(entry));
  if (!Number.isFinite(ageMs) || ageMs <= 0) return false;
  return ageMs / MS_PER_DAY >= DEFAULT_STALE_DAYS;
}

function collectReviewSummaryItems(items: KnowledgeDiffItem[]): {
  decisions: KnowledgeDiffItem[];
  gotchas: KnowledgeDiffItem[];
  todos: KnowledgeDiffItem[];
  pending: KnowledgeDiffItem[];
} {
  const categorized = {
    decisions: [] as KnowledgeDiffItem[],
    gotchas: [] as KnowledgeDiffItem[],
    todos: [] as KnowledgeDiffItem[],
    pending: [] as KnowledgeDiffItem[],
  };

  const seen = new Set<string>();
  for (const item of items) {
    const entry = item.knowledge;
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);

    if (entry.review_status === 'pending') {
      categorized.pending.push(item);
      continue;
    }

    if (entry.archived || entry.review_status === 'rejected') continue;
    if (item.event.type === 'knowledge_archived' || item.event.type === 'knowledge_rejected') continue;

    if (entry.type === 'decision') categorized.decisions.push(item);
    if (entry.type === 'gotcha') categorized.gotchas.push(item);
    if (entry.type === 'todo') categorized.todos.push(item);
  }

  return categorized;
}

function formatReviewSummaryBullet(item: KnowledgeDiffItem): string {
  const entry = item.knowledge!;
  const action = describeKnowledgeAction(item.event.type);
  const badges: string[] = [];
  if (entry.visibility === 'private') badges.push('private');
  return `${action} \`${entry.id}\`${badges.length > 0 ? ` [${badges.join(', ')}]` : ''}: ${entry.summary}`;
}

function formatPendingReviewBullet(item: KnowledgeDiffItem): string {
  const entry = item.knowledge!;
  const badges: string[] = [entry.type];
  if (entry.visibility === 'private') badges.push('private');
  return `\`${entry.id}\` [${badges.join(', ')}]: ${entry.summary}`;
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_WEEK = 604800;
const SECONDS_PER_MONTH = 2592000;

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 5) return 'just now';
  if (sec < SECONDS_PER_MINUTE) return sec + 's ago';
  if (sec < SECONDS_PER_HOUR) return Math.floor(sec / SECONDS_PER_MINUTE) + 'm ago';
  if (sec < SECONDS_PER_DAY) return Math.floor(sec / SECONDS_PER_HOUR) + 'h ago';
  if (sec < SECONDS_PER_WEEK) return Math.floor(sec / SECONDS_PER_DAY) + 'd ago';
  if (sec < SECONDS_PER_MONTH) return Math.floor(sec / SECONDS_PER_WEEK) + 'w ago';
  return Math.floor(sec / SECONDS_PER_MONTH) + 'mo ago';
}
