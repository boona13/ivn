#!/usr/bin/env node

import { program } from 'commander';
import { registerAnalysisCommands } from './cli-commands-analysis.js';
import { registerCompatibilityCommands } from './cli-commands-compatibility.js';
import { registerCoreCommands } from './cli-commands-core.js';
import { registerIntegrationCommands } from './cli-commands-integrations.js';
import { registerReviewCommands } from './cli-commands-review.js';
import { APP_VERSION } from './version.js';

program
  .name('ivn')
  .description('A local-first project memory CLI')
  .addHelpText(
    'after',
    `
Core loop:
  ivn remember "..."    Capture a durable decision, gotcha, pattern, or todo
  ivn recall "..."      Search project memory
  ivn context           Export AI-ready project context
  ivn focus <path>      Load memory for the file you are editing
  ivn status            Review the current memory state

Next layer:
  ivn diff              Review recent memory changes
  ivn review            Accept or reject pending captured knowledge
  ivn sync-rules        Project memory into AI instruction files
  ivn serve             Expose live memory over MCP or local HTTP

Advanced compatibility:
  ivn export            Share reviewed memory as portable files
  ivn pack sync         Materialize a git-tracked knowledge pack
  ivn validate          Check exported artifacts in CI or adapters
`,
  )
  .version(APP_VERSION);

registerCoreCommands(program);
registerAnalysisCommands(program);
registerReviewCommands(program);
registerIntegrationCommands(program);
registerCompatibilityCommands(program);

program.parse();
