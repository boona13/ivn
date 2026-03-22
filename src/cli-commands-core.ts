import type { Command } from 'commander';
import chalk from 'chalk';
import { formatInitSuccess, formatKnowledge, formatList, formatSearchResult, TYPE_COLORS } from './display.js';
import { resolveAutoKnowledgeType } from './import-classifier.js';
import {
  formatTraversal,
  parseDepth,
  parseReviewStatus,
  parseVisibility,
} from './cli-helpers.js';
import {
  handleCommand,
  parseTags,
  requireEntry,
  withOpenStore,
  withOpenStoreAsync,
} from './cli-runtime.js';
import { IvnStore } from './store.js';
import { listInitTemplates, seedInitTemplate } from './templates.js';
import { EDGE_TYPES, KNOWLEDGE_TYPES } from './types.js';
import type { EdgeType, KnowledgeType } from './types.js';

export function registerCoreCommands(program: Command): void {
  program
    .command('init')
    .description('Initialize .ivn in the current project')
    .argument('[directory]', 'Directory to initialize', '.')
    .option('--template <name>', 'Seed built-in starter knowledge (nextjs, express, django)')
    .option('--list-templates', 'List built-in starter templates and exit')
    .action(handleCommand((dir: string, opts: { template?: string; listTemplates?: boolean }) => {
      if (opts.listTemplates) {
        console.log('\n  Built-in IVN templates\n');
        for (const template of listInitTemplates()) {
          console.log(
            `  ${chalk.cyan(template.id)} ${chalk.dim(`- ${template.label}: ${template.description}`)}`,
          );
        }
        console.log();
        return;
      }

      const { root, config } = IvnStore.init(dir === '.' ? undefined : dir);
      const templateResult = opts.template
        ? withOpenStore((store) => {
            const seeded = seedInitTemplate(store, opts.template!);
            return {
              label: seeded.template.label,
              count: seeded.count,
            };
          }, root)
        : undefined;

      console.log(formatInitSuccess(root, config.name, templateResult));
    }));

  program
    .command('remember')
    .description('Store a piece of project knowledge')
    .argument('<content>', 'What to remember (wrap in quotes)')
    .option('-t, --type <type>', `Knowledge type: ${KNOWLEDGE_TYPES.join(', ')}`)
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--private', 'Keep this knowledge local-only and exclude it from shared outputs')
    .option('-s, --source <source>', 'Source of this knowledge', 'manual')
    .action(
      handleCommand(
        async (content: string, opts: { type?: string; tags?: string; source?: string; private?: boolean }) => {
          if (!content || !content.trim()) {
            console.log(`\n  ${chalk.red('✗')} Content cannot be empty.\n`);
            return;
          }

          const type = await resolveAutoKnowledgeType(content, {
            type: opts.type as KnowledgeType | undefined,
          });
          const { entry, isNew } = await withOpenStoreAsync((store) =>
            store.rememberIfNew(content, {
              type,
              tags: parseTags(opts.tags),
              source: opts.source,
              visibility: opts.private ? 'private' : 'shared',
            }),
          );

          if (!isNew) {
            const color = TYPE_COLORS[entry.type] || chalk.white;
            console.log(
              `\n  ${chalk.yellow('~')} Similar knowledge already exists: ${chalk.bold(color(entry.type))} ${chalk.dim(`#${entry.id}`)}\n`,
            );
            console.log(formatKnowledge(entry));
            console.log();
            return;
          }

          const color = TYPE_COLORS[entry.type] || chalk.white;
          console.log(
            `\n  ${chalk.green('\u2713')} Remembered as ${chalk.bold(color(entry.type))} ${chalk.dim(`#${entry.id}`)}\n`,
          );
          console.log(formatKnowledge(entry));
          console.log();
        },
      ),
    );

  program
    .command('recall')
    .description('Search your project knowledge')
    .argument('<query>', 'Search query')
    .option('-l, --limit <n>', 'Max results', '10')
    .option('--file <path>', 'Boost knowledge connected to a specific file path')
    .option('--visibility <scope>', 'Search shared, private, or all knowledge', 'all')
    .option('--review-status <status>', 'Search active, pending, rejected, or all knowledge', 'active')
    .option('--json', 'Output results as JSON')
    .action(
      handleCommand(
        (query: string, opts: { limit: string; file?: string; visibility?: string; reviewStatus?: string; json?: boolean }) => {
          const results = withOpenStore((store) =>
            store.recall(
              query,
              parseInt(opts.limit, 10),
              parseVisibility(opts.visibility, 'all'),
              parseReviewStatus(opts.reviewStatus, 'active'),
              opts.file,
            ),
          );

          if (opts.json) {
            console.log(JSON.stringify(results, null, 2));
            return;
          }

          if (results.length === 0) {
            console.log(chalk.dim(`\n  No knowledge found for "${query}"\n`));
          } else {
            console.log(
              chalk.bold(
                `\n  Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n`,
              ),
            );
            results.forEach((result, index) => {
              console.log(formatSearchResult(result, index));
              console.log();
            });
          }
        },
      ),
    );

  program
    .command('log')
    .description('View knowledge timeline')
    .option('-t, --type <type>', 'Filter by type')
    .option('-l, --limit <n>', 'Max entries', '20')
    .option('--visibility <scope>', 'Show shared, private, or all knowledge', 'all')
    .option('--review-status <status>', 'Show active, pending, rejected, or all knowledge', 'active')
    .action(
      handleCommand(
        (opts: { type?: string; limit: string; visibility?: string; reviewStatus?: string }) => {
          const entries = withOpenStore((store) =>
            store.list({
              type: opts.type as KnowledgeType | undefined,
              limit: parseInt(opts.limit, 10),
              visibility: parseVisibility(opts.visibility, 'all'),
              reviewStatus: parseReviewStatus(opts.reviewStatus, 'active'),
            }),
          );

          const heading = opts.type ? `Knowledge Log (${opts.type})` : 'Knowledge Log';
          console.log(chalk.bold(`\n  ${heading}\n`));
          console.log(formatList(entries));
          console.log();
        },
      ),
    );

  program
    .command('get')
    .description('Get a specific knowledge entry by ID')
    .argument('<id>', 'Knowledge ID (e.g. a1b2c3d4)')
    .action(handleCommand((id: string) => {
      const { entry, related } = withOpenStore((store) => ({
        entry: requireEntry(store, id),
        related: store.getRelated(id),
      }));

      console.log();
      console.log(formatKnowledge(entry, { verbose: true }));

      if (related.length > 0) {
        console.log();
        console.log(chalk.bold('  Related:'));
        console.log();
        for (const { edge, knowledge } of related) {
          console.log(`  ${chalk.dim(`${edge.type} \u2192`)}`);
          console.log(formatKnowledge(knowledge));
        }
      }
      console.log();
    }));

  program
    .command('forget')
    .description('Archive a knowledge entry (soft delete)')
    .argument('<id>', 'Knowledge ID')
    .action(handleCommand((id: string) => {
      const entry = withOpenStore((store) => {
        const current = requireEntry(store, id);
        store.forget(id);
        return current;
      });
      console.log(
        `\n  ${chalk.green('\u2713')} Archived ${chalk.dim(`#${id}`)} ${chalk.dim(`(${entry.summary})`)}\n`,
      );
    }));

  program
    .command('link')
    .description('Create a relationship between two knowledge entries')
    .argument('<source>', 'Source knowledge ID')
    .argument('<target>', 'Target knowledge ID')
    .option('-t, --type <type>', `Relationship: ${EDGE_TYPES.join(', ')}`, 'relates_to')
    .action(handleCommand((source: string, target: string, opts: { type: string }) => {
      const edge = withOpenStore((store) => store.link(source, target, opts.type as EdgeType));
      console.log(
        `\n  ${chalk.green('\u2713')} Linked ${chalk.dim(`#${source}`)} ${chalk.cyan(edge.type)} ${chalk.dim(`#${target}`)}\n`,
      );
    }));

  program
    .command('trace')
    .description('Traverse related knowledge in all directions')
    .argument('<id>', 'Knowledge ID')
    .option('-d, --depth <n>', 'Max traversal depth', '4')
    .action(handleCommand((id: string, opts: { depth?: string }) => {
      const steps = withOpenStore((store) => store.trace(id, parseDepth(opts.depth)));
      console.log(formatTraversal(`Trace for #${id}`, steps));
    }));

  program
    .command('why')
    .description('Show upstream knowledge that explains an entry')
    .argument('<id>', 'Knowledge ID')
    .option('-d, --depth <n>', 'Max traversal depth', '4')
    .action(handleCommand((id: string, opts: { depth?: string }) => {
      const steps = withOpenStore((store) => store.why(id, parseDepth(opts.depth)));
      console.log(formatTraversal(`Why #${id}`, steps));
    }));

  program
    .command('impact')
    .description('Show downstream knowledge affected by an entry')
    .argument('<id>', 'Knowledge ID')
    .option('-d, --depth <n>', 'Max traversal depth', '4')
    .action(handleCommand((id: string, opts: { depth?: string }) => {
      const steps = withOpenStore((store) => store.impact(id, parseDepth(opts.depth)));
      console.log(formatTraversal(`Impact of #${id}`, steps));
    }));

  program
    .command('context')
    .description('Export knowledge as a context block (paste into any AI chat)')
    .argument('[query]', 'Optional query to filter context')
    .option('--file <path>', 'Focus the context block on a specific file path')
    .action(handleCommand((query: string | undefined, opts: { file?: string }) => {
      console.log(withOpenStore((store) => store.context(query, opts.file)));
    }));

  program
    .command('focus')
    .description('Load knowledge relevant to the file you are about to edit')
    .argument('<path>', 'Project-relative or absolute file path')
    .option('-l, --limit <n>', 'Max results', '10')
    .option('--visibility <scope>', 'Search shared, private, or all knowledge', 'all')
    .option('--review-status <status>', 'Search active, pending, rejected, or all knowledge', 'active')
    .action(
      handleCommand(
        (path: string, opts: { limit: string; visibility?: string; reviewStatus?: string }) => {
          const limit = parseInt(opts.limit, 10);
          const visibility = parseVisibility(opts.visibility, 'all');
          const reviewStatus = parseReviewStatus(opts.reviewStatus, 'active');
          const { warnings, results } = withOpenStore((store) => {
            const warnings = store.warn(path, Math.max(3, Math.min(6, limit)), visibility, reviewStatus);
            const warningIds = new Set(warnings.map((entry) => entry.id));
            const results = store
              .focus(path, limit, visibility, reviewStatus)
              .filter((entry) => !warningIds.has(entry.id));
            return { warnings, results };
          });

          if (warnings.length === 0 && results.length === 0) {
            console.log(chalk.dim(`\n  No focused knowledge found for "${path}"\n`));
          } else {
            console.log(chalk.bold(`\n  Focused knowledge for "${path}":\n`));
            if (warnings.length > 0) {
              console.log(chalk.bold('  Warnings\n'));
              warnings.forEach((warning, index) => {
                console.log(formatSearchResult(warning, index));
                console.log();
              });
            }
            if (results.length > 0) {
              console.log(chalk.bold('  Additional context\n'));
              results.forEach((result, index) => {
                console.log(formatSearchResult(result, index));
                console.log();
              });
            }
          }
        },
      ),
    );
}
