import type { Command } from 'commander';
import chalk from 'chalk';
import { formatKnowledge } from './display.js';
import { formatCommandHelp, parsePort } from './cli-helpers.js';
import { handleCommand, withOpenStore, withOpenStoreAsync } from './cli-runtime.js';

export function registerIntegrationCommands(program: Command): void {
  program
    .command('git-import')
    .description('Import knowledge from git commit history')
    .option('--since <period>', 'Import commits since (e.g. "7 days ago", "2024-01-01")')
    .option('--last <n>', 'Import only the last N commits')
    .option('--path <paths...>', 'Limit imported history to one or more repo paths')
    .option('--dry-run', 'Preview what would be imported without storing')
    .action(handleCommand(async (opts: { since?: string; last?: string; path?: string[]; dryRun?: boolean }) => {
      const { importFromGit } = await import('./git.js');
      const result = await withOpenStoreAsync((store) =>
        importFromGit(store, {
          since: opts.since,
          last: opts.last ? parseInt(opts.last, 10) : undefined,
          paths: opts.path,
          dryRun: opts.dryRun,
        }),
      );

      if (opts.dryRun) {
        console.log(chalk.bold(`\n  Dry run — ${result.total} commits scanned\n`));
      } else {
        console.log(chalk.bold('\n  Git Import Complete\n'));
      }

      console.log(`  ${chalk.dim('Commits scanned:')}  ${result.total}`);
      console.log(`  ${chalk.dim('Noise filtered:')}   ${result.skipped}`);
      console.log(`  ${chalk.green('New knowledge:')}    ${result.imported}`);
      if (result.duplicates > 0) {
        console.log(`  ${chalk.yellow('Duplicates skipped:')} ${result.duplicates}`);
      }
      console.log();

      if (result.entries.length > 0) {
        const label = opts.dryRun ? 'Would import:' : 'Imported:';
        console.log(chalk.bold(`  ${label}\n`));
        for (const { entry, isNew } of result.entries) {
          if (isNew || opts.dryRun) {
            console.log(formatKnowledge(entry));
            console.log();
          }
        }
      }
    }));

  const hookCmd = program
    .command('hook')
    .description('Manage git hooks for automatic knowledge capture');

  hookCmd
    .command('install')
    .description('Install git hooks for automatic knowledge capture and validation')
    .option('--sync-pack', 'Also sync the tracked knowledge pack after each commit')
    .option('--pack-dir <dir>', 'Pack directory to sync when using --sync-pack', '.ivn/pack')
    .option('--pre-commit', 'Also install pre-commit hook that runs `ivn check` on staged files')
    .action(handleCommand(async (opts: { syncPack?: boolean; packDir?: string; preCommit?: boolean }) => {
      const { installHook, installPreCommitHook } = await import('./git.js');
      const { hookPath, alreadyExists, updated } = withOpenStore((store) =>
        installHook(store.getRoot(), {
          syncPack: opts.syncPack,
          packDir: opts.packDir,
        }),
      );

      if (alreadyExists) {
        console.log(chalk.yellow(`\n  Hook already installed at ${hookPath}\n`));
      } else if (updated) {
        console.log(`\n  ${chalk.green('\u2713')} Post-commit hook updated`);
        console.log(chalk.dim(`  ${hookPath}`));
        if (opts.syncPack) {
          console.log(chalk.dim(`  Pack sync enabled for ${opts.packDir}\n`));
        } else {
          console.log();
        }
      } else {
        console.log(`\n  ${chalk.green('\u2713')} Post-commit hook installed`);
        console.log(chalk.dim(`  ${hookPath}`));
        console.log(chalk.dim('  Knowledge auto-captured + AI rules synced on every commit.\n'));
      }

      if (opts.preCommit) {
        const pcResult = withOpenStore((store) => installPreCommitHook(store.getRoot()));
        if (pcResult.installed) {
          console.log(`  ${chalk.green('\u2713')} Pre-commit hook installed`);
          console.log(chalk.dim(`  ${pcResult.hookPath}`));
          console.log(chalk.dim('  Staged files will be checked against known gotchas before commit.\n'));
        } else {
          console.log(chalk.yellow(`  Pre-commit check already installed at ${pcResult.hookPath}\n`));
        }
      }
    }));

  hookCmd
    .command('uninstall')
    .description('Remove the ivn post-commit hook')
    .action(handleCommand(async () => {
      const { uninstallHook } = await import('./git.js');
      const removed = withOpenStore((store) => uninstallHook(store.getRoot()));

      if (removed) {
        console.log(`\n  ${chalk.green('\u2713')} Post-commit hook removed.\n`);
      } else {
        console.log(chalk.dim('\n  No ivn hook found.\n'));
      }
    }));

  program
    .command('export')
    .description('Export knowledge to shareable files (commit to git for team sharing)')
    .addHelpText(
      'after',
      formatCommandHelp(
        {
          title: 'When to use this:',
          lines: [
            '  Use `ivn export` when you want portable files for git sharing or handoff.',
            '  Day-to-day local use does not require export; the core loop works directly from `.ivn`.',
          ],
        },
        {
          title: 'Examples:',
          lines: [
            '  ivn export',
            '  ivn export --format markdown',
            '  ivn export --include-private --out ./tmp/ivn-share',
          ],
        },
      ),
    )
    .option('-f, --format <format>', 'Output format: json, markdown, or both', 'both')
    .option('--include-private', 'Include private knowledge in the export')
    .option('-o, --out <dir>', 'Output directory (default: project root)')
    .action(handleCommand(async (opts: { format: string; out?: string; includePrivate?: boolean }) => {
      const { exportKnowledge } = await import('./share.js');
      const result = withOpenStore((store) =>
        exportKnowledge(store, {
          format: opts.format as 'json' | 'markdown' | 'both',
          outDir: opts.out,
          includePrivate: opts.includePrivate,
        }),
      );

      console.log(chalk.bold(`\n  Exported ${result.count} knowledge entries\n`));
      if (result.jsonPath) {
        console.log(`  ${chalk.green('\u2713')} ${chalk.dim(result.jsonPath)}`);
      }
      if (result.mdPath) {
        console.log(`  ${chalk.green('\u2713')} ${chalk.dim(result.mdPath)}`);
      }
      console.log(chalk.dim('\n  Commit these files to share knowledge with your team.\n'));
    }));

  const packCmd = program
    .command('pack')
    .description('Manage git-tracked knowledge packs');

  packCmd
    .command('sync')
    .description('Write the current reviewed knowledge into a tracked pack directory')
    .addHelpText(
      'after',
      formatCommandHelp(
        {
          title: 'When to use this:',
          lines: [
            '  Use `ivn pack sync` when the repo itself should carry reviewed project memory.',
            '  Packs are for durable, git-tracked sharing rather than everyday local capture.',
          ],
        },
        {
          title: 'Examples:',
          lines: [
            '  ivn pack sync',
            '  ivn pack sync --dir .ivn/packs/current',
            '  ivn pack sync --include-private',
          ],
        },
      ),
    )
    .option('-f, --format <format>', 'Output format: json, markdown, or both', 'both')
    .option('--include-private', 'Include private knowledge in the pack')
    .option('--dir <dir>', 'Pack directory relative to the project root', '.ivn/pack')
    .action(handleCommand(async (opts: { format: string; dir?: string; includePrivate?: boolean }) => {
      const { syncKnowledgePack } = await import('./share.js');
      const result = withOpenStore((store) =>
        syncKnowledgePack(store, {
          format: opts.format as 'json' | 'markdown' | 'both',
          dir: opts.dir,
          includePrivate: opts.includePrivate,
        }),
      );

      console.log(chalk.bold(`\n  Synced knowledge pack (${result.count} entries)\n`));
      console.log(`  ${chalk.green('\u2713')} ${chalk.dim(result.manifestPath)}`);
      if (result.jsonPath) {
        console.log(`  ${chalk.green('\u2713')} ${chalk.dim(result.jsonPath)}`);
      }
      if (result.mdPath) {
        console.log(`  ${chalk.green('\u2713')} ${chalk.dim(result.mdPath)}`);
      }
      console.log(chalk.dim('\n  Commit this pack directory to ship reviewed project memory with the repo.\n'));
    }));

  packCmd
    .command('merge')
    .description('Merge a knowledge pack into the local store using dedupe-aware import')
    .argument('[path]', 'Pack directory, manifest, or knowledge-pack.json path', '.ivn/pack')
    .action(handleCommand(async (path: string) => {
      const { mergeKnowledgePack } = await import('./share.js');
      const result = withOpenStore((store) => mergeKnowledgePack(store, path));

      console.log(chalk.bold('\n  Merged knowledge pack\n'));
      console.log(`  ${chalk.dim('Source:')}         ${result.jsonPath}`);
      console.log(`  ${chalk.dim('Entries scanned:')} ${result.total}`);
      console.log(`  ${chalk.green('Imported:')}      ${result.imported}`);
      if (result.duplicates > 0) {
        console.log(`  ${chalk.yellow('Duplicates:')}    ${result.duplicates}`);
      }
      if (result.edges_created > 0) {
        console.log(`  ${chalk.cyan('Links created:')}  ${result.edges_created}`);
      }
      console.log();
    }));

  program
    .command('import-chat')
    .description('Extract durable project knowledge from a chat transcript file')
    .addHelpText(
      'after',
      formatCommandHelp(
        {
          title: 'When to use this:',
          lines: [
            '  Use `ivn import-chat` to recover durable decisions, gotchas, and todos from past conversations.',
            '  Imported items land in pending review by default so you can curate them before they become active truth.',
          ],
        },
        {
          title: 'Examples:',
          lines: [
            '  ivn import-chat ./cursor-session.jsonl --dry-run',
            '  ivn import-chat ./chat.md --limit 10',
            '  ivn import-chat ./chat.json --json',
          ],
        },
      ),
    )
    .argument('<file>', 'Path to a transcript export (.jsonl, .json, .md, .txt)')
    .option('-l, --limit <n>', 'Max candidates to index', '20')
    .option('--dry-run', 'Preview extracted candidates without writing them')
    .option('--private', 'Store imported candidates in the private lane (default)')
    .option('--shared', 'Store imported candidates in the shared lane')
    .option('--json', 'Emit the import result as JSON')
    .action(
      handleCommand(
        async (
          file: string,
          opts: { limit: string; dryRun?: boolean; private?: boolean; shared?: boolean; json?: boolean },
        ) => {
          const { importConversation } = await import('./conversations.js');
          const result = await withOpenStoreAsync((store) =>
            importConversation(store, file, {
              limit: parseInt(opts.limit, 10),
              dryRun: opts.dryRun,
              visibility: opts.shared ? 'shared' : 'private',
            }),
          );

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log(chalk.bold('\n  Chat Import\n'));
          console.log(`  ${chalk.dim('File:')}        ${result.file}`);
          console.log(`  ${chalk.dim('Format:')}      ${result.format}`);
          console.log(`  ${chalk.dim('Messages:')}    ${result.message_count}`);
          console.log(`  ${chalk.dim('Candidates:')}  ${result.candidate_count}`);
          console.log(`  ${chalk.green('Imported:')}    ${result.imported}`);
          if (result.duplicates > 0) {
            console.log(`  ${chalk.yellow('Duplicates:')}  ${result.duplicates}`);
          }
          console.log();

          if (result.items.length === 0) {
            console.log(chalk.dim('  No durable project knowledge was detected in this transcript.\n'));
            return;
          }

          result.items.forEach((item) => {
            const status = item.duplicate
              ? chalk.yellow('[duplicate]')
              : opts.dryRun
                ? chalk.cyan('[candidate]')
                : chalk.green('[imported]');
            console.log(
              `  ${status} ${chalk.bold(item.type)} ${chalk.dim(
                `(${item.role}, confidence ${item.confidence.toFixed(2)})`,
              )}`,
            );
            console.log(`    ${item.content}`);
            if (item.entry) {
              console.log(`    ${chalk.dim(`#${item.entry.id}`)} ${chalk.dim(`[${item.entry.review_status}]`)}`);
            }
            console.log();
          });

          if (!opts.dryRun && result.imported > 0) {
            console.log(chalk.dim('  Imported chat knowledge is pending by default. Review it with `ivn review`.\n'));
          }
        },
      ),
    );

  program
    .command('import')
    .description('Import knowledge from an exported JSON file')
    .argument('<file>', 'Path to .ivn-export.json file')
    .action(handleCommand(async (file: string) => {
      const { importKnowledge } = await import('./share.js');
      const result = withOpenStore((store) => importKnowledge(store, file));

      console.log(chalk.bold('\n  Import Complete\n'));
      console.log(`  ${chalk.dim('Total entries:')}     ${result.total}`);
      console.log(`  ${chalk.green('New imported:')}      ${result.imported}`);
      if (result.duplicates > 0) {
        console.log(`  ${chalk.yellow('Duplicates skipped:')} ${result.duplicates}`);
      }
      if (result.edges_created > 0) {
        console.log(`  ${chalk.cyan('Relationships:')}     ${result.edges_created}`);
      }
      console.log();
    }));

  program
    .command('sync-rules')
    .description('Sync knowledge to AI tool rule files (auto-detects tools, or specify targets)')
    .addHelpText(
      'after',
      formatCommandHelp(
        {
          title: 'When to use this:',
          lines: [
            '  Use `ivn sync-rules` after the core loop is already useful and you want AI tools to read project memory on startup.',
            '  This is static projection into instruction files, not live MCP access.',
          ],
        },
        {
          title: 'Examples:',
          lines: [
            '  ivn sync-rules',
            '  ivn sync-rules --target cursor,codex',
            '  ivn sync-rules --include-private',
          ],
        },
      ),
    )
    .option(
      '-t, --target <targets>',
      'Comma-separated targets: cursor, claude-code, codex, copilot, windsurf, cline, generic, all',
    )
    .option('--include-private', 'Include private knowledge in generated rule files')
    .action(handleCommand(async (opts: { target?: string; includePrivate?: boolean }) => {
      const { syncRules } = await import('./share.js');
      const targets = opts.target
        ? (opts.target.split(',').map((target) => target.trim()) as any[])
        : undefined;
      const result = withOpenStore((store) =>
        syncRules(store, { targets, includePrivate: opts.includePrivate }),
      );

      console.log(chalk.bold('\n  Rules Synced\n'));
      for (const file of result.files) {
        console.log(`  ${chalk.green('\u2713')} ${chalk.bold(file.target)} ${chalk.dim(`\u2192 ${file.path}`)}`);
      }
      console.log();
      if (result.decisionCount) console.log(`  ${chalk.blue('\u25C6')} ${result.decisionCount} decisions`);
      if (result.patternCount) console.log(`  ${chalk.green('\u25C8')} ${result.patternCount} patterns`);
      if (result.gotchaCount) console.log(`  ${chalk.yellow('\u26A0')} ${result.gotchaCount} gotchas`);
      if (result.debugCount) console.log(`  ${chalk.red('\u2716')} ${result.debugCount} past bugs`);
      if (result.dependencyCount) console.log(`  ${chalk.magenta('\u25CE')} ${result.dependencyCount} dependencies`);
      if (result.todoCount) console.log(`  ${chalk.white('\u2610')} ${result.todoCount} todos`);
      console.log(chalk.dim('\n  Supported AI tools can now read the generated project knowledge files.\n'));
    }));

  program
    .command('web')
    .description('Open interactive knowledge dashboard in your browser')
    .option('-p, --port <port>', 'Port number (default: random)')
    .option('--no-open', 'Do not auto-open browser')
    .action(handleCommand(async (opts: { port?: string; open?: boolean }) => {
      withOpenStore(() => undefined);
      const { startDashboard } = await import('./web.js');
      const { url } = await startDashboard({
        port: opts.port ? parseInt(opts.port, 10) : 0,
        root: process.cwd(),
      });

      console.log(`\n  ${chalk.green('\u2713')} Dashboard running at ${chalk.bold.cyan(url)}\n`);
      console.log(chalk.dim('  Press Ctrl+C to stop.\n'));

      if (opts.open !== false) {
        const { execSync } = await import('node:child_process');
        try {
          const cmd =
            process.platform === 'darwin'
              ? 'open'
              : process.platform === 'win32'
                ? 'start'
                : 'xdg-open';
          execSync(`${cmd} ${url}`, { stdio: 'ignore' });
        } catch {
          // Browser open failed; the user can navigate manually.
        }
      }
    }));

  program
    .command('serve')
    .description('Start IVN as an MCP server or local HTTP service')
    .addHelpText(
      'after',
      formatCommandHelp(
        {
          title: 'When to use this:',
          lines: [
            '  Use `ivn serve` for live tool integrations after the local memory loop is working well.',
            '  Default MCP mode stays on stdio; HTTP mode binds to localhost unless you intentionally widen it.',
          ],
        },
        {
          title: 'Examples:',
          lines: [
            '  ivn serve',
            '  ivn serve --http',
            '  ivn serve --http --port 3103 --host 127.0.0.1',
          ],
        },
      ),
    )
    .option('--http', 'Start HTTP service mode instead of MCP stdio')
    .option('-p, --port <n>', 'HTTP port (default: 3103, use 0 for a random port)')
    .option('--host <host>', 'HTTP host address', '127.0.0.1')
    .option('--auth-token <token>', 'Explicit auth token for HTTP write/private access')
    .action(handleCommand(async (opts: { http?: boolean; port?: string; host?: string; authToken?: string }) => {
      withOpenStore(() => undefined);

      if (opts.http) {
        const { startHttpServer } = await import('./http.js');
        const server = await startHttpServer({
          port: parsePort(opts.port, 3103),
          host: opts.host,
          root: process.cwd(),
          authToken: opts.authToken,
        });
        console.error(chalk.cyan(`  ivn HTTP service running at ${server.url}`));
        console.error(chalk.dim(`  Health:   ${server.url}/health`));
        console.error(chalk.dim(`  OpenAPI:  ${server.url}/openapi.json`));
        console.error(chalk.dim(`  Spec:     ${server.url}/v1/spec\n`));
        console.error(chalk.yellow('  Auth token required for writes or private visibility requests.'));
        console.error(chalk.dim(`  X-Ivn-Token: ${server.authToken}\n`));
        return;
      }

      const { startServer: startMcpServer } = await import('./mcp.js');
      console.error(chalk.cyan('  ivn MCP server starting...'));
      console.error(chalk.dim('  Waiting for AI tool connections via stdio\n'));
      await startMcpServer();
    }));
}
