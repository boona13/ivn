import type { Command } from 'commander';
import chalk from 'chalk';
import {
  formatContradictions,
  formatDoctor,
  formatInferenceSuggestions,
  formatKnowledge,
  formatSearchResult,
  formatStatus,
} from './display.js';
import { createBackup } from './backup.js';
import { checkFiles as checkFilesImpl, checkChanged as checkChangedImpl } from './check.js';
import { formatCommandHelp, parseDays, parseReviewStatus, parseVisibility } from './cli-helpers.js';
import {
  getChangedFilesForCommand,
  handleCommand,
  withOpenStore,
  withOpenStoreAsync,
} from './cli-runtime.js';
import type { SearchResult } from './types.js';

export function registerAnalysisCommands(program: Command): void {
  program
    .command('warn')
    .description('Surface gotchas, constraints, and bug history before you edit')
    .option('--file <path>', 'Warn for a specific file path')
    .option('--changed', 'Warn for files changed in the current git diff')
    .option('--since-git [ref]', 'Compare changed files to a git ref when using diff-based warnings')
    .option('-l, --limit <n>', 'Max warnings', '6')
    .option('--json', 'Emit warnings as JSON')
    .option('--visibility <scope>', 'Search shared, private, or all knowledge', 'all')
    .option('--review-status <status>', 'Search active, pending, rejected, or all knowledge', 'active')
    .action(
      handleCommand(
        async (opts: {
          file?: string;
          changed?: boolean;
          sinceGit?: string | boolean;
          limit: string;
          json?: boolean;
          visibility?: string;
          reviewStatus?: string;
        }) => {
          if (opts.file && opts.changed) {
            throw new Error('Use either --file or --changed, not both.');
          }

          const limit = parseInt(opts.limit, 10);
          const visibility = parseVisibility(opts.visibility, 'all');
          const reviewStatus = parseReviewStatus(opts.reviewStatus, 'active');

          const { targetLabel, changedFiles, warnings } = await withOpenStoreAsync(async (store) => {
            if (opts.file) {
              return {
                targetLabel: opts.file,
                changedFiles: [] as string[],
                warnings: store.warn(opts.file, limit, visibility, reviewStatus),
              };
            }

            const { ref, changedFiles } = await getChangedFilesForCommand(store, opts.sinceGit);
            return {
              targetLabel: `changed files since ${ref}`,
              changedFiles,
              warnings: store.warnFiles(changedFiles, limit, visibility, reviewStatus),
            };
          });

          if (!opts.file && changedFiles.length === 0) {
            console.log(chalk.dim('\n  No changed files detected.\n'));
            return;
          }

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  target: targetLabel,
                  changed_files: changedFiles,
                  count: warnings.length,
                  warnings,
                },
                null,
                2,
              ),
            );
          } else if (warnings.length === 0) {
            console.log(chalk.dim(`\n  No proactive warnings found for ${targetLabel}.\n`));
          } else {
            console.log(chalk.bold(`\n  Proactive Warnings for ${targetLabel}\n`));
            warnings.forEach((warning, index) => {
              console.log(formatSearchResult(warning, index));
              console.log();
            });
          }
        },
      ),
    );

  program
    .command('contradictions')
    .description('Find conflicting active project truths')
    .option('--file <path>', 'Only inspect contradictions relevant to a specific file path')
    .option('--changed', 'Inspect contradictions relevant to files changed in the current git diff')
    .option('--since-git [ref]', 'Compare changed files to a git ref when using --changed')
    .option('-l, --limit <n>', 'Max contradictions', '20')
    .option('--json', 'Emit contradictions as JSON')
    .option('--visibility <scope>', 'Search shared, private, or all knowledge', 'all')
    .option('--review-status <status>', 'Search active, pending, rejected, or all knowledge', 'active')
    .action(
      handleCommand(
        async (opts: {
          file?: string;
          changed?: boolean;
          sinceGit?: string | boolean;
          limit: string;
          json?: boolean;
          visibility?: string;
          reviewStatus?: string;
        }) => {
          if (opts.file && opts.changed) {
            throw new Error('Use either --file or --changed, not both.');
          }

          const visibility = parseVisibility(opts.visibility, 'all');
          const reviewStatus = parseReviewStatus(opts.reviewStatus, 'active');
          const { filePaths, findings } = await withOpenStoreAsync(async (store) => {
            let filePaths: string[] | undefined;
            if (opts.file) {
              filePaths = [opts.file];
            } else if (opts.changed) {
              filePaths = (await getChangedFilesForCommand(store, opts.sinceGit)).changedFiles;
            }
            return {
              filePaths,
              findings: store.contradictions({
                limit: parseInt(opts.limit, 10),
                visibility,
                reviewStatus,
                filePaths,
              }),
            };
          });

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  count: findings.length,
                  file_paths: filePaths || [],
                  findings,
                },
                null,
                2,
              ),
            );
          } else {
            console.log(formatContradictions(findings));
          }
        },
      ),
    );

  program
    .command('infer')
    .description('Suggest likely missing relationships between knowledge entries')
    .option('--file <path>', 'Only inspect relationships relevant to a specific file path')
    .option('--changed', 'Inspect relationships relevant to files changed in the current git diff')
    .option('--since-git [ref]', 'Compare changed files to a git ref when using --changed')
    .option('-l, --limit <n>', 'Max suggestions', '20')
    .option('--json', 'Emit suggestions as JSON')
    .option('--visibility <scope>', 'Search shared, private, or all knowledge', 'all')
    .option('--review-status <status>', 'Search active, pending, rejected, or all knowledge', 'active')
    .action(
      handleCommand(
        async (opts: {
          file?: string;
          changed?: boolean;
          sinceGit?: string | boolean;
          limit: string;
          json?: boolean;
          visibility?: string;
          reviewStatus?: string;
        }) => {
          if (opts.file && opts.changed) {
            throw new Error('Use either --file or --changed, not both.');
          }

          const visibility = parseVisibility(opts.visibility, 'all');
          const reviewStatus = parseReviewStatus(opts.reviewStatus, 'active');
          const { filePaths, suggestions } = await withOpenStoreAsync(async (store) => {
            let filePaths: string[] | undefined;
            if (opts.file) {
              filePaths = [opts.file];
            } else if (opts.changed) {
              filePaths = (await getChangedFilesForCommand(store, opts.sinceGit)).changedFiles;
            }
            return {
              filePaths,
              suggestions: store.inferLinks({
                limit: parseInt(opts.limit, 10),
                visibility,
                reviewStatus,
                filePaths,
              }),
            };
          });

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  count: suggestions.length,
                  file_paths: filePaths || [],
                  suggestions,
                },
                null,
                2,
              ),
            );
          } else {
            console.log(formatInferenceSuggestions(suggestions));
          }
        },
      ),
    );

  program
    .command('changed')
    .description('Load knowledge relevant to files changed in the current git diff')
    .addHelpText(
      'after',
      formatCommandHelp(
        {
          title: 'When to use this:',
          lines: [
            '  Reach for `ivn changed` after you start editing or before review.',
            '  It combines file-aware warnings with nearby project memory in one pass.',
          ],
        },
        {
          title: 'Examples:',
          lines: [
            '  ivn changed',
            '  ivn changed --context',
            '  ivn changed --since-git HEAD~1 --json',
          ],
        },
      ),
    )
    .option('--since-git [ref]', 'Compare the working tree to a git ref (default: HEAD)')
    .option('-l, --limit <n>', 'Max results', '12')
    .option('--context', 'Emit a markdown context block for the current change set')
    .option('--json', 'Emit changed files and relevant knowledge as JSON')
    .option('--visibility <scope>', 'Search shared, private, or all knowledge', 'all')
    .option('--review-status <status>', 'Search active, pending, rejected, or all knowledge', 'active')
    .action(
      handleCommand(
        async (opts: {
          sinceGit?: string | boolean;
          limit: string;
          context?: boolean;
          json?: boolean;
          visibility?: string;
          reviewStatus?: string;
        }) => {
          if (opts.context && opts.json) {
            throw new Error('Use either --context or --json, not both.');
          }

          const limit = parseInt(opts.limit, 10);
          const visibility = parseVisibility(opts.visibility, 'all');
          const reviewStatus = parseReviewStatus(opts.reviewStatus, 'active');
          const result = await withOpenStoreAsync(async (store) => {
            const { ref, changedFiles } = await getChangedFilesForCommand(store, opts.sinceGit);
            if (changedFiles.length === 0) {
              return {
                ref,
                changedFiles,
                renderedContext: null,
                warnings: [],
                results: [] as SearchResult[],
              };
            }
            if (opts.context) {
              return {
                ref,
                changedFiles,
                renderedContext: store.changedContext(changedFiles, limit, visibility, reviewStatus),
                warnings: [],
                results: [] as SearchResult[],
              };
            }
            const warnings = store.warnFiles(
              changedFiles,
              Math.max(3, Math.min(6, limit)),
              visibility,
              reviewStatus,
            );
            const warningIds = new Set(warnings.map((entry) => entry.id));
            const results = store
              .focusFiles(changedFiles, limit, visibility, reviewStatus)
              .filter((entry) => !warningIds.has(entry.id));
            return { ref, changedFiles, renderedContext: null, warnings, results };
          });

          if (result.changedFiles.length === 0) {
            console.log(chalk.dim('\n  No changed files detected.\n'));
            return;
          }

          if (result.renderedContext) {
            console.log(result.renderedContext);
            return;
          }

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  ref: result.ref,
                  changed_files: result.changedFiles,
                  warning_count: result.warnings.length,
                  count: result.results.length,
                  warnings: result.warnings,
                  results: result.results,
                },
                null,
                2,
              ),
            );
          } else {
            console.log(chalk.bold(`\n  Changed files (${result.changedFiles.length})\n`));
            result.changedFiles.forEach((file) => {
              console.log(`  ${chalk.dim('-')} ${file}`);
            });
            console.log();

            if (result.warnings.length > 0) {
              console.log(chalk.bold('  Warnings\n'));
              result.warnings.forEach((warning, index) => {
                console.log(formatSearchResult(warning, index));
                console.log();
              });
            }

            if (result.warnings.length === 0 && result.results.length === 0) {
              console.log(chalk.dim('  No related knowledge found.\n'));
            } else if (result.results.length > 0) {
              console.log(chalk.bold('  Additional context\n'));
              result.results.forEach((entry, index) => {
                console.log(formatSearchResult(entry, index));
                console.log();
              });
            }
          }
        },
      ),
    );

  program
    .command('stale')
    .description('List active knowledge that should be reviewed or refreshed')
    .option('--days <n>', 'Mark knowledge stale after N days without confirmation', '90')
    .option('-l, --limit <n>', 'Max entries', '20')
    .option('--json', 'Emit stale entries as JSON')
    .option('--visibility <scope>', 'Search shared, private, or all knowledge', 'all')
    .action(
      handleCommand((opts: { days?: string; limit: string; json?: boolean; visibility?: string }) => {
        const days = parseDays(opts.days, 90);
        const stale = withOpenStore((store) =>
          store.stale({
            days,
            limit: parseInt(opts.limit, 10),
            visibility: parseVisibility(opts.visibility, 'all'),
          }),
        );

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                days,
                count: stale.length,
                entries: stale,
              },
              null,
              2,
            ),
          );
        } else if (stale.length === 0) {
          console.log(chalk.dim('\n  No stale knowledge found.\n'));
        } else {
          console.log(chalk.bold('\n  Stale Knowledge\n'));
            console.log(chalk.dim('  Refresh important entries with `ivn refresh <id>`.\n'));
          stale.forEach((entry) => {
            console.log(formatKnowledge(entry));
            console.log();
          });
        }
      }),
    );

  program
    .command('status')
    .description('Show project knowledge overview')
    .action(handleCommand(() => {
      const { stats, root } = withOpenStore((store) => ({
        stats: store.stats(),
        root: store.getRoot(),
      }));
      console.log(formatStatus(stats, root));
    }));

  program
    .command('doctor')
    .description('Validate ivn config, schema, and storage health')
    .action(handleCommand(() => {
      console.log(formatDoctor(withOpenStore((store) => store.doctor())));
    }));

  program
    .command('check')
    .description('Validate changed files against known gotchas and patterns')
    .option('--file <paths...>', 'Specific file paths to check')
    .option('--changed', 'Check files changed in the current git diff')
    .option('--json', 'Emit results as JSON')
    .action(handleCommand((opts: { file?: string[]; changed?: boolean; json?: boolean }) => {
      const result = opts.file
        ? withOpenStore((store) => checkFilesImpl(store, opts.file!))
        : withOpenStore((store) => checkChangedImpl(store));

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.violations.length === 0) {
        console.log(
          `\n  ${chalk.green('✓')} No violations found (checked ${result.files.length} files against ${result.gotchasChecked} gotchas, ${result.patternsChecked} patterns)\n`,
        );
        return;
      }

      console.log(
        chalk.bold(`\n  ${chalk.red('✗')} ${result.violations.length} violation(s) found\n`),
      );

      for (const v of result.violations) {
        console.log(`  ${chalk.red('✗')} ${chalk.bold(v.file)}:${v.line}`);
        console.log(`    ${chalk.dim('Matched:')} ${v.matchedText}`);
        console.log(`    ${chalk.yellow(v.message)}`);
        console.log();
      }

      process.exitCode = 1;
    }));

  program
    .command('backup')
    .description('Snapshot the local .ivn state into a recovery directory')
    .option('-o, --out <dir>', 'Parent directory for backup snapshots', '.ivn/backups')
    .action(handleCommand((opts: { out?: string }) => {
      const result = createBackup(process.cwd(), { outDir: opts.out });
      console.log(chalk.bold('\n  IVN Backup Created\n'));
      console.log(`  ${chalk.dim('Directory:')} ${result.backup_dir}`);
      console.log(`  ${chalk.dim('Manifest:')}  ${result.manifest_path}`);
      console.log(`  ${chalk.dim('Entries:')}   ${result.total_entries}`);
      console.log(`  ${chalk.dim('Edges:')}     ${result.total_edges}`);
      console.log(`  ${chalk.dim('Files:')}     ${result.files.map((file) => file.name).join(', ')}`);
      console.log();
    }));
}
