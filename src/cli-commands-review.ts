import type { Command } from 'commander';
import chalk from 'chalk';
import {
  formatDiff,
  formatDiffMarkdown,
  formatHistory,
  formatKnowledge,
  formatList,
  formatReviewSummaryMarkdown,
  formatSnapshot,
  summarizeDiff,
} from './display.js';
import {
  appendOutput,
  emitOutput,
  formatCommandHelp,
  parseIsoDateTime,
  parseReviewStatus,
  parseVisibility,
} from './cli-helpers.js';
import { handleCommand, withOpenStore } from './cli-runtime.js';
import type { Knowledge } from './types.js';

function summarizePendingSources(entries: Knowledge[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.source_kind, (counts.get(entry.source_kind) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([source, count]) => `${count} ${source}`)
    .join(', ');
}

export function registerReviewCommands(program: Command): void {
  program
    .command('review')
    .description('View pending knowledge waiting for acceptance or rejection')
    .addHelpText(
      'after',
      formatCommandHelp(
        {
          title: 'When to use this:',
          lines: [
            '  Use `ivn review` after auto-capture, `ivn git-import`, or `ivn import-chat`.',
            '  Pending knowledge stays out of active project truth until you accept it.',
          ],
        },
        {
          title: 'Examples:',
          lines: [
            '  ivn review',
            '  ivn accept a1b2c3d4 --note "Confirmed in code review"',
            '  ivn reject a1b2c3d4 --note "Superseded by the new auth flow"',
          ],
        },
      ),
    )
    .option('-l, --limit <n>', 'Max entries', '20')
    .option('--visibility <scope>', 'Show shared, private, or all pending knowledge', 'shared')
    .action(handleCommand((opts: { limit: string; visibility?: string }) => {
      const entries = withOpenStore((store) =>
        store.list({
          limit: parseInt(opts.limit, 10),
          visibility: parseVisibility(opts.visibility, 'shared'),
          reviewStatus: 'pending',
        }),
      );

      console.log(chalk.bold('\n  Pending Review Queue\n'));
      console.log(formatList(entries));
      console.log();
    }));

  program
    .command('accept')
    .description('Accept knowledge into the durable active set')
    .argument('[id]', 'Knowledge ID (omit when using --all)')
    .option('--note <text>', 'Optional review note')
    .option('--all', 'Accept all pending knowledge entries')
    .option('--force', 'Required with --all to confirm bulk promotion')
    .action(handleCommand((id: string | undefined, opts: { note?: string; all?: boolean; force?: boolean }) => {
      if (opts.all) {
        if (id) {
          throw new Error('Do not pass an ID when using --all.');
        }
        const pending = withOpenStore((store) =>
          store.list({ reviewStatus: 'pending', limit: 10000, visibility: 'all' }),
        );
        if (pending.length === 0) {
          console.log(chalk.dim('\n  No pending entries to accept.\n'));
          return;
        }
        if (!opts.force) {
          const sourceSummary = summarizePendingSources(pending);
          throw new Error(
            `Bulk accept is guarded because it would promote ${pending.length} pending entries (${sourceSummary}). ` +
            'Review with `ivn review`, accept IDs individually, or rerun with `ivn accept --all --force`.',
          );
        }
        withOpenStore((store) => {
          for (const entry of pending) store.accept(entry.id, opts.note);
        });
        const sourceSummary = summarizePendingSources(pending);
        console.log(`\n  ${chalk.green('\u2713')} Accepted ${pending.length} pending entries\n`);
        console.log(chalk.dim(`  Sources: ${sourceSummary}\n`));
        return;
      }

      if (!id) {
        throw new Error('Provide a knowledge ID or use --all to accept all pending entries.');
      }

      const entry = withOpenStore((store) => {
        const accepted = store.accept(id, opts.note);
        if (!accepted) {
          throw new Error(`Knowledge #${id} not found`);
        }
        return accepted;
      });
      console.log(`\n  ${chalk.green('\u2713')} Accepted ${chalk.dim(`#${id}`)}\n`);
      console.log(formatKnowledge(entry, { verbose: true }));
      console.log();
    }));

  program
    .command('reject')
    .description('Reject knowledge so it stays out of active project truth')
    .argument('<id>', 'Knowledge ID')
    .option('--note <text>', 'Optional review note')
    .action(handleCommand((id: string, opts: { note?: string }) => {
      const entry = withOpenStore((store) => {
        const rejected = store.reject(id, opts.note);
        if (!rejected) {
          throw new Error(`Knowledge #${id} not found`);
        }
        return rejected;
      });
      console.log(`\n  ${chalk.green('\u2713')} Rejected ${chalk.dim(`#${id}`)}\n`);
      console.log(formatKnowledge(entry, { verbose: true }));
      console.log();
    }));

  program
    .command('refresh')
    .description('Re-confirm knowledge so it stays fresh and active')
    .argument('<id>', 'Knowledge ID')
    .option('--note <text>', 'Optional refresh note')
    .action(handleCommand((id: string, opts: { note?: string }) => {
      const entry = withOpenStore((store) => {
        const refreshed = store.refresh(id, opts.note);
        if (!refreshed) {
          throw new Error(`Knowledge #${id} not found`);
        }
        return refreshed;
      });
      console.log(`\n  ${chalk.green('\u2713')} Refreshed ${chalk.dim(`#${id}`)}\n`);
      console.log(formatKnowledge(entry, { verbose: true }));
      console.log();
    }));

  program
    .command('diff')
    .description('Review recent knowledge changes')
    .addHelpText(
      'after',
      formatCommandHelp(
        {
          title: 'When to use this:',
          lines: [
            '  Use `ivn diff` when you want a human or CI-friendly review feed of memory changes.',
            '  This is the handoff layer after the core loop, not the first command to learn.',
          ],
        },
        {
          title: 'Examples:',
          lines: [
            '  ivn diff',
            '  ivn diff --pr-summary',
            '  ivn diff --since-git HEAD --markdown',
          ],
        },
      ),
    )
    .option('--since <iso>', 'Only show changes since an ISO timestamp')
    .option('--since-git [ref]', 'Only show changes since a git ref timestamp (default: HEAD)')
    .option('--visibility <scope>', 'Review shared, private, or all knowledge changes', 'shared')
    .option('--json', 'Output diff as JSON')
    .option('--markdown', 'Output diff as PR-friendly markdown')
    .option('--pr-summary', 'Output a compact PR-ready summary of decisions, gotchas, TODOs, and pending review')
    .option('-o, --out <file>', 'Write diff output to a file')
    .option('--append-pr-template <file>', 'Append markdown review output to a PR template or draft file')
    .option('--github-step-summary', 'Append markdown review output to $GITHUB_STEP_SUMMARY')
    .option('-l, --limit <n>', 'Max changes', '20')
    .action(
      handleCommand(
        async (opts: {
          since?: string;
          sinceGit?: string | boolean;
          visibility?: string;
          json?: boolean;
          markdown?: boolean;
          prSummary?: boolean;
          out?: string;
          appendPrTemplate?: string;
          githubStepSummary?: boolean;
          limit: string;
        }) => {
          if (opts.since && opts.sinceGit) {
            throw new Error('Use either --since or --since-git, not both.');
          }
          const formatCount = [opts.json, opts.markdown, opts.prSummary].filter(Boolean).length;
          if (formatCount > 1) {
            throw new Error('Use only one of: --json, --markdown, --pr-summary.');
          }
          if (opts.json && (opts.appendPrTemplate || opts.githubStepSummary)) {
            throw new Error('Publishing adapters require markdown output, not --json.');
          }
          if (opts.githubStepSummary && !process.env.GITHUB_STEP_SUMMARY) {
            throw new Error(
              'GITHUB_STEP_SUMMARY is not set. Run inside GitHub Actions or set the variable explicitly.',
            );
          }

          let since = opts.since;
          if (opts.sinceGit) {
            const { getCommitTimestamp } = await import('./git.js');
            const ref = typeof opts.sinceGit === 'string' ? opts.sinceGit : 'HEAD';
            since = getCommitTimestamp(process.cwd(), ref);
          }

          const items = withOpenStore((store) =>
            store.diff({
              since,
              limit: parseInt(opts.limit, 10),
              visibility: parseVisibility(opts.visibility, 'shared'),
            }),
          );
          const usePrSummary = Boolean(
            opts.prSummary ||
              ((opts.appendPrTemplate || opts.githubStepSummary) && !opts.markdown && !opts.json),
          );
          const rendered = opts.json
            ? JSON.stringify(
                {
                  since: since || null,
                  count: items.length,
                  summary: summarizeDiff(items),
                  items,
                },
                null,
                2,
              )
            : usePrSummary
              ? formatReviewSummaryMarkdown(items)
              : opts.markdown
                ? formatDiffMarkdown(items)
                : formatDiff(items);

          emitOutput(rendered, opts.out);
          if (opts.appendPrTemplate) {
            appendOutput(rendered, opts.appendPrTemplate, 'Appended review output to');
          }
          if (opts.githubStepSummary) {
            appendOutput(rendered, process.env.GITHUB_STEP_SUMMARY!, 'Published review output to');
          }
        },
      ),
    );

  program
    .command('history')
    .description('Inspect how project knowledge changed over time')
    .argument('[id]', 'Optional knowledge ID to scope the timeline')
    .option('--since <iso>', 'Only show history since an ISO timestamp')
    .option('--since-git [ref]', 'Only show history since a git ref timestamp (default: HEAD)')
    .option('--visibility <scope>', 'Show shared, private, or all timeline events', 'shared')
    .option('--json', 'Output history as JSON')
    .option('-l, --limit <n>', 'Max timeline events', '20')
    .action(
      handleCommand(
        async (id: string | undefined, opts: {
          since?: string;
          sinceGit?: string | boolean;
          visibility?: string;
          json?: boolean;
          limit: string;
        }) => {
          if (opts.since && opts.sinceGit) {
            throw new Error('Use either --since or --since-git, not both.');
          }

          let since = opts.since;
          if (opts.sinceGit) {
            const { getCommitTimestamp } = await import('./git.js');
            const ref = typeof opts.sinceGit === 'string' ? opts.sinceGit : 'HEAD';
            since = getCommitTimestamp(process.cwd(), ref);
          }

          const items = withOpenStore((store) =>
            store.history({
              knowledgeId: id,
              since,
              limit: parseInt(opts.limit, 10),
              visibility: parseVisibility(opts.visibility, 'shared'),
            }),
          );
          const rendered = opts.json
            ? JSON.stringify(
                {
                  knowledge_id: id || null,
                  since: since || null,
                  count: items.length,
                  summary: summarizeDiff(items),
                  items,
                },
                null,
                2,
              )
            : formatHistory(items, id);
          console.log(rendered);
        },
      ),
    );

  program
    .command('snapshot')
    .description('Reconstruct a best-effort knowledge snapshot at a point in time')
    .argument('<at>', 'ISO date/time to reconstruct against')
    .option('--visibility <scope>', 'Show shared, private, or all knowledge', 'shared')
    .option('--review-status <status>', 'Show active, pending, rejected, or all knowledge', 'all')
    .option('--json', 'Output the snapshot as JSON')
    .option('-l, --limit <n>', 'Max entries in the snapshot', '50')
    .action(
      handleCommand(
        (at: string, opts: { visibility?: string; reviewStatus?: string; json?: boolean; limit: string }) => {
          const snapshot = withOpenStore((store) =>
            store.snapshot({
              at: parseIsoDateTime(at),
              limit: parseInt(opts.limit, 10),
              visibility: parseVisibility(opts.visibility, 'shared'),
              reviewStatus: parseReviewStatus(opts.reviewStatus, 'all'),
            }),
          );
          const rendered = opts.json ? JSON.stringify(snapshot, null, 2) : formatSnapshot(snapshot);
          console.log(rendered);
        },
      ),
    );
}
