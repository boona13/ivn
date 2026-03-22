import type { Command } from 'commander';
import { resolve } from 'node:path';
import { formatCommandHelp, formatSpecInfo } from './cli-helpers.js';
import { handleCommand } from './cli-runtime.js';
import { exportSpecFiles, getSpecInfo } from './spec.js';
import { formatValidationReport, validateJsonFile } from './validate.js';

export function registerCompatibilityCommands(program: Command): void {
  program
    .command('spec')
    .description('Advanced: show or export IVN compatibility artifacts')
    .addHelpText(
      'after',
      formatCommandHelp(
        {
          title: 'When to use this:',
          lines: [
            '  Use `ivn spec` for adapter work, compatibility docs, or external integrations.',
            '  Most daily IVN usage does not need direct access to these artifacts.',
          ],
        },
        {
          title: 'Examples:',
          lines: [
            '  ivn spec',
            '  ivn spec --json',
            '  ivn spec --out ./schemas/ivn',
          ],
        },
      ),
    )
    .option('--json', 'Emit spec metadata as JSON')
    .option('-o, --out <dir>', 'Copy the spec artifacts into a directory')
    .action(handleCommand((opts: { json?: boolean; out?: string }) => {
      const info = opts.out ? exportSpecFiles(resolve(opts.out)) : getSpecInfo();
      if (opts.json) {
        console.log(JSON.stringify(info, null, 2));
      } else {
        console.log(formatSpecInfo(info));
      }
    }));

  program
    .command('validate')
    .description('Advanced: validate an export or pack against the compatibility contract')
    .addHelpText(
      'after',
      formatCommandHelp(
        {
          title: 'When to use this:',
          lines: [
            '  Use `ivn validate` in CI, fixture tests, or adapter development to prove exported artifacts stay compatible.',
            '  It is a compatibility check, not part of the everyday capture and recall workflow.',
          ],
        },
        {
          title: 'Examples:',
          lines: [
            '  ivn validate .ivn-export.json',
            '  ivn validate .ivn/pack/manifest.json',
            '  ivn validate .ivn-export.json --json',
          ],
        },
      ),
    )
    .argument('<file>', 'Path to an IVN export JSON or pack manifest JSON')
    .option('--json', 'Emit the validation report as JSON')
    .action(handleCommand((file: string, opts: { json?: boolean }) => {
      const report = validateJsonFile(file);
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatValidationReport(report));
      }

      if (report.status === 'invalid') {
        process.exit(1);
      }
    }));
}
