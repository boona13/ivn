import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { IvnStore } from '../src/store.js';
import { runCli, runCliExpectFailure, runGit, REPO_ROOT, withTempProject } from './test-helpers.js';

test('doctor CLI prints a healthy report for an initialized project', () => {
  withTempProject((root) => {
    IvnStore.init(root);

    const output = runCli(root, ['doctor']);
    assert.match(output, /IVN Doctor/);
    assert.match(output, /Config and schema look healthy/);
  });
});

test('backup CLI snapshots local ivn state into a recovery directory', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('We decided backups should exist before risky operations.');
    store.close();

    const output = runCli(root, ['backup']);
    assert.match(output, /IVN Backup Created/);

    const backupParent = join(root, '.ivn', 'backups');
    const [backupDirName] = readdirSync(backupParent);
    assert.equal(typeof backupDirName, 'string');

    const backupDir = join(backupParent, backupDirName!);
    assert.equal(existsSync(join(backupDir, 'knowledge.db')), true);
    assert.equal(existsSync(join(backupDir, 'config.json')), true);
    assert.equal(existsSync(join(backupDir, 'manifest.json')), true);

    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as {
      kind: string;
      total_entries: number;
      total_edges: number;
      files: Array<{ name: string }>;
    };
    assert.equal(manifest.kind, 'ivn-local-backup');
    assert.equal(manifest.total_entries, 1);
    assert.equal(manifest.total_edges, 0);
    assert.equal(manifest.files.some((file) => file.name === 'knowledge.db'), true);

    const ignoreContents = readFileSync(join(root, '.ivn', '.gitignore'), 'utf8');
    assert.match(ignoreContents, /backups\//);
  });
});

test('diff CLI prints human-readable knowledge changes', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    const decision = store.remember('We decided to keep project knowledge local-first.');
    const pattern = store.remember('All agent flows should start by loading ivn context.');
    store.link(decision.id, pattern.id, 'implements');
    store.close();

    const output = runCli(root, ['diff']);
    assert.match(output, /Knowledge Diff/);
    assert.match(output, /linked/);
    assert.match(output, /added/);
  });
});

test('diff CLI can emit JSON for integrations', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('We decided to keep project memory portable across AI tools.');
    store.close();

    const output = runCli(root, ['diff', '--json']);
    const parsed = JSON.parse(output) as {
      since: string | null;
      count: number;
      summary: { knowledge_added: number };
      items: Array<{ event: { type: string } }>;
    };

    assert.equal(parsed.since, null);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.summary.knowledge_added, 1);
    assert.equal(parsed.items[0]?.event.type, 'knowledge_added');
  });
});

test('history CLI can emit scoped json timelines', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    const entry = store.remember('We decided history should stay queryable over time.');
    store.refresh(entry.id, 'Temporal query still matters.');
    store.close();

    const parsed = JSON.parse(
      runCli(root, ['history', entry.id, '--json', '--visibility', 'all']),
    ) as {
      knowledge_id: string;
      count: number;
      items: Array<{ event: { type: string } }>;
    };

    assert.equal(parsed.knowledge_id, entry.id);
    assert.equal(parsed.count >= 2, true);
    assert.equal(parsed.items.some((item) => item.event.type === 'knowledge_refreshed'), true);
  });
});

test('snapshot CLI can emit json snapshots with reconstruction metadata', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    const entry = store.remember('We decided snapshots should be queryable.');
    store.close();

    const db = new Database(join(root, '.ivn', 'knowledge.db'));
    db.prepare('UPDATE knowledge SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', entry.id);
    db.prepare('UPDATE knowledge_events SET created_at = ? WHERE type = ? AND knowledge_id = ?')
      .run('2026-01-01T00:00:00.000Z', 'knowledge_added', entry.id);
    db.close();

    const parsed = JSON.parse(
      runCli(root, [
        'snapshot',
        '2026-01-01T00:01:00.000Z',
        '--json',
        '--visibility',
        'all',
        '--review-status',
        'all',
      ]),
    ) as {
      at: string;
      exact: boolean;
      entries: Array<{ knowledge: { id: string } }>;
      edges: unknown[];
    };

    assert.equal(parsed.at, '2026-01-01T00:01:00.000Z');
    assert.equal(parsed.exact, true);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0]?.knowledge.id, entry.id);
    assert.equal(parsed.edges.length, 0);
  });
});

test('diff CLI can scope changes to a git ref timestamp', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    writeFileSync(join(root, 'README.md'), '# temp\n');
    runGit(root, ['init']);
    runGit(root, ['add', '.']);
    runGit(root, ['-c', 'user.name=IVN Test', '-c', 'user.email=ivn@example.com', 'commit', '-m', 'init']);

    const store = IvnStore.open(root);
    store.remember('We chose SQLite because this project must stay local-first.');
    store.close();

    const output = runCli(root, ['diff', '--since-git', 'HEAD', '--json']);
    const parsed = JSON.parse(output) as {
      since: string | null;
      count: number;
      items: Array<{ event: { type: string } }>;
    };

    assert.ok(parsed.since);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.items[0]?.event.type, 'knowledge_added');
  });
});

test('diff CLI can emit PR-friendly markdown output', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    const decision = store.remember('We decided to make IVN local-first by default.');
    const pattern = store.remember('All review flows should emit machine-readable output.');
    store.link(decision.id, pattern.id, 'implements');
    store.close();

    const output = runCli(root, ['diff', '--markdown']);
    assert.match(output, /# IVN Knowledge Diff/);
    assert.match(output, /## Summary/);
    assert.match(output, /## Decisions/);
    assert.match(output, /## Patterns/);
    assert.match(output, /## Relationships/);
    assert.match(output, /Linked/);
  });
});

test('diff CLI can emit a compact PR summary', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('We decided to make review output publishable from CI.');
    store.remember('Watch out: pending knowledge should not silently become durable truth.');
    store.remember('TODO: publish review output into pull request summaries.');
    store.remember('MCP-discovered deployment constraint.', {
      source: 'mcp',
      sourceKind: 'mcp',
    });
    store.close();

    const output = runCli(root, ['diff', '--pr-summary', '--visibility', 'all']);
    assert.match(output, /## IVN Review Summary/);
    assert.match(output, /### Decisions/);
    assert.match(output, /### Gotchas/);
    assert.match(output, /### TODOs/);
    assert.match(output, /### Pending Review/);
  });
});

test('diff CLI can write review output to a file', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('We decided to keep IVN review output portable.');
    store.close();

    const outPath = join(root, 'artifacts', 'ivn-review.md');
    const stdout = runCli(root, ['diff', '--markdown', '--out', outPath]);

    assert.match(stdout, /Wrote review output/);
    assert.equal(existsSync(outPath), true);

    const written = readFileSync(outPath, 'utf8');
    assert.match(written, /# IVN Knowledge Diff/);
    assert.match(written, /## Summary/);
  });
});

test('diff CLI can append PR summary output to a template file', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('We decided review output should plug into PR templates.');
    store.close();

    const templatePath = join(root, '.github', 'pull_request_template.md');
    mkdirSync(dirname(templatePath), { recursive: true });
    writeFileSync(templatePath, '## Existing Template\n');

    const stdout = runCli(root, [
      'diff',
      '--pr-summary',
      '--append-pr-template',
      templatePath,
    ]);

    assert.match(stdout, /Appended review output/);

    const written = readFileSync(templatePath, 'utf8');
    assert.match(written, /## Existing Template/);
    assert.match(written, /## IVN Review Summary/);
    assert.match(written, /### Decisions/);
  });
});

test('diff CLI can publish review output to github step summary', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('We decided CI should publish review summaries automatically.');
    store.close();

    const stepSummaryPath = join(root, 'artifacts', 'github-step-summary.md');
    const stdout = runCli(root, ['diff', '--pr-summary', '--github-step-summary'], {
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: stepSummaryPath,
      },
    });

    assert.match(stdout, /Published review output/);
    const published = readFileSync(stepSummaryPath, 'utf8');
    assert.match(published, /## IVN Review Summary/);
    assert.match(published, /### Decisions/);
  });
});

test('review CLI shows pending entries and accept promotes them', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    const entry = store.remember('Auto-captured review candidate.', {
      source: 'mcp',
      sourceKind: 'mcp',
    });
    store.close();

    const reviewOutput = runCli(root, ['review']);
    assert.match(reviewOutput, /Pending Review Queue/);
    assert.match(reviewOutput, /\[pending\]/);

    const acceptOutput = runCli(root, ['accept', entry.id, '--note', 'accepted']);
    assert.match(acceptOutput, /Accepted/);

    const reopened = IvnStore.open(root);
    const accepted = reopened.get(entry.id);
    assert.ok(accepted);
    assert.equal(accepted.review_status, 'active');
    reopened.close();
  });
});

test('recall CLI supports --json flag for machine-readable output', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('PostgreSQL chosen for JSONB support and ACID transactions.');
    store.close();

    const output = runCli(root, ['recall', 'PostgreSQL', '--json']);
    const parsed = JSON.parse(output);
    assert.ok(Array.isArray(parsed), 'JSON output should be an array');
    assert.equal(parsed.length, 1);
    assert.match(parsed[0].content, /PostgreSQL/);
    assert.ok('rank' in parsed[0], 'Each result should include a rank field');
    assert.ok('id' in parsed[0], 'Each result should include an id field');
  });
});

test('accept --all requires --force before promoting pending knowledge', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('First auto-captured entry.', { source: 'git:aaa', sourceKind: 'git' });
    store.remember('Second auto-captured entry.', { source: 'git:bbb', sourceKind: 'git' });
    store.remember('Third auto-captured entry.', { source: 'git:ccc', sourceKind: 'git' });
    assert.equal(store.list({ reviewStatus: 'pending' }).length, 3);
    store.close();

    const failure = runCliExpectFailure(root, ['accept', '--all']);
    assert.match(failure, /Bulk accept is guarded/);
    assert.match(failure, /ivn accept --all --force/);

    const reopened = IvnStore.open(root);
    assert.equal(reopened.list({ reviewStatus: 'pending' }).length, 3);
    assert.equal(reopened.list({ reviewStatus: 'active' }).length, 0);
    reopened.close();
  });
});

test('accept --all --force promotes every pending entry to active', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('First auto-captured entry.', { source: 'git:aaa', sourceKind: 'git' });
    store.remember('Second auto-captured entry.', { source: 'mcp', sourceKind: 'mcp' });
    store.remember('Third auto-captured entry.', { source: 'conversation:live', sourceKind: 'conversation' });
    assert.equal(store.list({ reviewStatus: 'pending' }).length, 3);
    store.close();

    const output = runCli(root, ['accept', '--all', '--force']);
    assert.match(output, /Accepted 3 pending/);
    assert.match(output, /Sources: /);

    const reopened = IvnStore.open(root);
    assert.equal(reopened.list({ reviewStatus: 'pending' }).length, 0);
    assert.equal(reopened.list({ reviewStatus: 'active' }).length, 3);
    reopened.close();
  });
});

test('stale store query and CLI surface aging knowledge for review', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    const oldEntry = store.remember('Legacy auth flow note that needs reconfirmation.');
    store.remember('Fresh auth flow note.');
    store.close();

    const db = new Database(join(root, '.ivn', 'knowledge.db'));
    const oldIso = new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE knowledge
       SET created_at = ?, updated_at = ?, reviewed_at = ?, valid_from = ?
       WHERE id = ?`,
    ).run(oldIso, oldIso, oldIso, oldIso, oldEntry.id);
    db.close();

    const reopened = IvnStore.open(root);
    const staleEntries = reopened.stale({ days: 90 });
    assert.equal(staleEntries.length, 1);
    assert.equal(staleEntries[0]?.id, oldEntry.id);
    assert.equal(reopened.stats().stale_count, 1);
    reopened.close();

    const output = runCli(root, ['stale', '--days', '90']);
    assert.match(output, /Stale Knowledge/);
    assert.match(output, /\[stale\]/);
    assert.match(output, /ivn refresh <id>/);
  });
});

test('warn CLI can surface proactive warnings for a specific file', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('Watch out: src/auth/session.ts must rotate cookies before redirect.');
    store.remember('src/auth/session.ts requires the session secret to be loaded.');
    store.close();

    const output = runCli(root, ['warn', '--file', 'src/auth/session.ts']);
    assert.match(output, /Proactive Warnings/);
    assert.match(output, /rotate cookies before redirect/);
    assert.match(output, /session secret/);
  });
});

test('contradictions CLI can emit scoped json findings', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('We decided src/auth/session.ts should bypass the repository layer for auth writes.');
    store.remember('All auth writes in src/auth/session.ts must go through the repository layer.');
    store.close();

    const output = runCli(root, ['contradictions', '--file', 'src/auth/session.ts', '--json']);
    const parsed = JSON.parse(output) as {
      count: number;
      file_paths: string[];
      findings: Array<{ kind: string; reason: string }>;
    };

    assert.deepEqual(parsed.file_paths, ['src/auth/session.ts']);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.findings[0]?.kind, 'decision_pattern_conflict');
    assert.match(parsed.findings[0]?.reason || '', /src\/auth\/session\.ts/);
  });
});

test('import-chat CLI can preview transcript candidates as json', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const transcriptPath = join(root, 'chat.md');
    writeFileSync(
      transcriptPath,
      [
        '# User',
        'We decided src/auth/session.ts should rotate cookies before redirect.',
        '',
        '# Assistant',
        'Watch out: src/auth/session.ts breaks when cookies are not rotated first.',
        '',
        '# Assistant',
        'I need to inspect the codebase first.',
      ].join('\n'),
    );

    const output = runCli(root, ['import-chat', transcriptPath, '--dry-run', '--json']);
    const parsed = JSON.parse(output) as {
      format: string;
      candidate_count: number;
      imported: number;
      duplicates: number;
      items: Array<{ type: string; duplicate: boolean; entry: unknown }>;
    };

    assert.equal(parsed.format, 'text');
    assert.equal(parsed.candidate_count, 2);
    assert.equal(parsed.imported, 0);
    assert.equal(parsed.duplicates, 0);
    assert.deepEqual(parsed.items.map((item) => item.type), ['decision', 'gotcha']);
    assert.equal(parsed.items.every((item) => item.duplicate === false && item.entry === null), true);

    const reopened = IvnStore.open(root);
    assert.equal(reopened.list({ reviewStatus: 'pending', visibility: 'all' }).length, 0);
    reopened.close();
  });
});

test('infer CLI can emit scoped json suggestions', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    const decision = store.remember(
      'We decided src/payments/webhook.ts should verify Stripe signatures before enqueueing work.',
    );
    const dependency = store.remember(
      'src/payments/webhook.ts requires the Stripe SDK for webhook signature verification.',
    );
    store.close();

    const output = runCli(root, ['infer', '--file', 'src/payments/webhook.ts', '--json']);
    const parsed = JSON.parse(output) as {
      count: number;
      file_paths: string[];
      suggestions: Array<{
        source: { id: string };
        target: { id: string };
        suggested_type: string;
      }>;
    };

    assert.deepEqual(parsed.file_paths, ['src/payments/webhook.ts']);
    assert.equal(parsed.count >= 1, true);
    assert.equal(
      parsed.suggestions.some(
        (suggestion) =>
          suggestion.source.id === decision.id &&
          suggestion.target.id === dependency.id &&
          suggestion.suggested_type === 'depends_on',
      ),
      true,
    );
  });
});

test('focus CLI shows file-relevant knowledge', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('src/billing/webhook.ts should enqueue Stripe retries instead of blocking.');
    store.close();

    const output = runCli(root, ['focus', 'src/billing/webhook.ts']);
    assert.match(output, /Focused knowledge/);
    assert.match(output, /src\/billing\/webhook\.ts/);
    assert.match(output, /files:/);
  });
});

test('context CLI can focus output on a file path', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('src/api/auth.ts should always validate session freshness.');
    store.remember('The marketing site deploys independently.');
    store.close();

    const output = runCli(root, ['context', '--file', 'src/api/auth.ts']);
    assert.match(output, /Focused on `src\/api\/auth\.ts`/);
    assert.match(output, /src\/api\/auth\.ts should always validate session freshness/);
  });
});

test('changed CLI works before the first commit by falling back to git status', () => {
  withTempProject((root) => {
    runGit(root, ['init']);
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('Watch out: src/auth/session.ts must rotate cookies before redirect.');
    store.close();

    mkdirSync(join(root, 'src', 'auth'), { recursive: true });
    writeFileSync(join(root, 'src', 'auth', 'session.ts'), 'export const session = true;\n');

    const output = runCli(root, ['changed', '--context']);
    assert.match(output, /# Changed File Context/);
    assert.match(output, /## Warnings/);
    assert.match(output, /src\/auth\/session\.ts/);
    assert.match(output, /rotate cookies before redirect/);
  });
});

test('changed CLI can emit json for working tree changes since a git ref', () => {
  withTempProject((root) => {
    runGit(root, ['init']);
    IvnStore.init(root);
    mkdirSync(join(root, 'src', 'billing'), { recursive: true });
    writeFileSync(join(root, 'src', 'billing', 'webhook.ts'), 'export const webhook = 1;\n');
    runGit(root, ['add', '.']);
    runGit(root, ['-c', 'user.name=IVN Test', '-c', 'user.email=ivn@example.com', 'commit', '-m', 'init']);

    const store = IvnStore.open(root);
    store.remember('src/billing/webhook.ts should enqueue Stripe retries instead of blocking.');
    store.close();

    writeFileSync(join(root, 'src', 'billing', 'webhook.ts'), 'export const webhook = 2;\n');

    const output = runCli(root, ['changed', '--since-git', 'HEAD', '--json']);
    const parsed = JSON.parse(output) as {
      ref: string;
      changed_files: string[];
      count: number;
      results: Array<{ content: string; file_refs: string[] }>;
    };

    assert.equal(parsed.ref, 'HEAD');
    assert.deepEqual(parsed.changed_files, ['src/billing/webhook.ts']);
    assert.equal(parsed.count, 1);
    assert.match(parsed.results[0]?.content || '', /enqueue Stripe retries/);
    assert.deepEqual(parsed.results[0]?.file_refs, ['src/billing/webhook.ts']);
  });
});

test('hook install can enable pack sync after auto-capture', () => {
  withTempProject((root) => {
    writeFileSync(join(root, 'README.md'), '# temp\n');
    runGit(root, ['init']);
    IvnStore.init(root);

    const stdout = runCli(root, [
      'hook',
      'install',
      '--sync-pack',
      '--pack-dir',
      '.ivn/packs/current',
    ]);

    assert.match(stdout, /Post-commit hook/);

    const hook = readFileSync(join(root, '.git', 'hooks', 'post-commit'), 'utf8');
    assert.match(hook, /ivn git-import --last 1/);
    assert.match(hook, /ivn pack sync --dir ".ivn\/packs\/current"/);
  });
});

test('top-level CLI help keeps advanced compatibility commands at the end', () => {
  const output = runCli(REPO_ROOT, ['--help']);

  const reviewIndex = output.indexOf('  review [options]');
  const syncRulesIndex = output.indexOf('  sync-rules [options]');
  const serveIndex = output.indexOf('  serve [options]');
  const specIndex = output.indexOf('  spec [options]');
  const validateIndex = output.indexOf('  validate [options] <file>');

  assert.notEqual(reviewIndex, -1);
  assert.notEqual(syncRulesIndex, -1);
  assert.notEqual(serveIndex, -1);
  assert.notEqual(specIndex, -1);
  assert.notEqual(validateIndex, -1);
  assert.equal(reviewIndex < syncRulesIndex, true);
  assert.equal(syncRulesIndex < serveIndex, true);
  assert.equal(serveIndex < specIndex, true);
  assert.equal(specIndex < validateIndex, true);
  assert.match(output, /Advanced compatibility:/);
});

test('subcommand help explains workflow intent for advanced commands', () => {
  const syncRulesHelp = runCli(REPO_ROOT, ['sync-rules', '--help']);
  const serveHelp = runCli(REPO_ROOT, ['serve', '--help']);
  const validateHelp = runCli(REPO_ROOT, ['validate', '--help']);

  assert.match(syncRulesHelp, /When to use this:/);
  assert.match(syncRulesHelp, /after the core loop is already useful/);
  assert.match(syncRulesHelp, /Examples:/);

  assert.match(serveHelp, /live tool integrations/);
  assert.match(serveHelp, /Default MCP mode stays on stdio/);

  assert.match(validateHelp, /compatibility check/);
  assert.match(validateHelp, /CI, fixture tests, or adapter development/);
});
