import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  confirmConversationCapture,
  importConversation,
  suggestConversationCapture,
} from '../src/conversations.js';
import { listIvnResources, readIvnResource } from '../src/mcp.js';
import { IvnStore } from '../src/store.js';
import { APP_VERSION, SCHEMA_VERSION } from '../src/version.js';
import {
  createLegacyProject,
  runGit,
  withTempProject,
} from './test-helpers.js';

test('doctor reports healthy config and schema on a fresh project', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    const report = store.doctor();

    assert.equal(report.app_version, APP_VERSION);
    assert.equal(report.schema_version, SCHEMA_VERSION);
    assert.equal(report.config_schema_version, SCHEMA_VERSION);
    assert.equal(report.total_entries, 0);
    assert.deepEqual(report.warnings, []);

    store.close();

    const config = JSON.parse(readFileSync(join(root, '.ivn', 'config.json'), 'utf8'));
    assert.equal(config.version, APP_VERSION);
    assert.equal(config.schema_version, SCHEMA_VERSION);
  });
});

test('remember stores provenance metadata and graph traversal stays usable', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const decision = store.remember(
      'We decided to store project memory in SQLite because local-first search matters.',
    );
    const pattern = store.remember(
      'All MCP reads should load ivn context before writing new knowledge.',
    );
    store.link(decision.id, pattern.id, 'implements');

    const saved = store.get(decision.id);
    assert.ok(saved);
    assert.equal(saved.source_kind, 'manual');
    assert.equal(saved.source_ref, null);
    assert.equal(saved.valid_from, saved.created_at);
    assert.equal(saved.valid_to, null);
    assert.ok(saved.tags.includes('sqlite'));

    const impact = store.impact(decision.id, 2);
    assert.equal(impact.length, 2);
    assert.equal(impact[1]?.knowledge.id, pattern.id);
    assert.equal(pattern.type, 'pattern');

    store.close();
  });
});

test('remember extracts file refs and focus surfaces direct plus nearby knowledge', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const decision = store.remember(
      'We decided src/auth/session.ts owns cookie rotation for the login flow.',
    );
    const gotcha = store.remember(
      'Watch out: src/auth/session.ts must refresh the session before redirect.',
    );
    const context = store.remember(
      'The login UI depends on the session refresh behavior.',
    );
    store.link(decision.id, gotcha.id, 'implements');
    store.link(gotcha.id, context.id, 'relates_to');

    assert.deepEqual(decision.file_refs, ['src/auth/session.ts']);

    const focused = store.focus('src/auth/session.ts', 10);
    assert.ok(focused.some((entry) => entry.id === decision.id));
    assert.ok(focused.some((entry) => entry.id === gotcha.id));
    assert.ok(focused.some((entry) => entry.id === context.id));
    assert.equal(focused[0]?.file_refs.includes('src/auth/session.ts'), true);

    store.close();
  });
});

test('recall can boost file-specific knowledge with --file context', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const generic = store.remember('Auth flows should fail closed when session state is missing.');
    const focused = store.remember(
      'src/auth/session.ts rotates session cookies before redirect in the auth flow.',
    );

    const results = store.recall('auth', 10, 'all', 'active', 'src/auth/session.ts');
    assert.equal(results[0]?.id, focused.id);
    assert.equal(results.some((entry) => entry.id === generic.id), true);

    store.close();
  });
});

test('freshly reviewed knowledge outranks stale matching knowledge', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const stale = store.remember('src/auth/session.ts rotates auth cookies before redirect.');
    const fresh = store.remember('src/auth/session.ts refreshes auth cookies before redirect.', {
      reviewNote: 'recently confirmed',
    });
    store.refresh(fresh.id, 'confirmed today');
    store.close();

    const db = new Database(join(root, '.ivn', 'knowledge.db'));
    const oldIso = new Date(Date.now() - 220 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE knowledge
       SET created_at = ?, updated_at = ?, reviewed_at = ?, valid_from = ?
       WHERE id = ?`,
    ).run(oldIso, oldIso, oldIso, oldIso, stale.id);
    db.close();

    const reopened = IvnStore.open(root);
    const results = reopened.recall('auth cookies redirect', 10, 'all', 'active', 'src/auth/session.ts');
    assert.equal(results[0]?.id, fresh.id);
    reopened.close();
  });
});

test('warnFiles prioritizes gotchas and constraints for the current file', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    store.remember('Watch out: src/payments/webhook.ts must ack Stripe quickly before async work.');
    store.remember('src/payments/webhook.ts requires the Stripe signing secret in env.');
    store.remember('src/payments/webhook.ts processed duplicate events in a past bug.');
    store.remember('src/payments/webhook.ts handles payment sync orchestration.');

    const warnings = store.warnFiles(['src/payments/webhook.ts'], 10);
    assert.equal(warnings.length >= 3, true);
    assert.equal(warnings[0]?.type, 'gotcha');
    assert.equal(warnings.some((entry) => entry.type === 'dependency'), true);
    assert.equal(warnings.some((entry) => entry.type === 'debug'), true);

    store.close();
  });
});

test('contradictions detect superseded active dependencies and decision-pattern conflicts', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const oldDep = store.remember('src/payments/webhook.ts requires Stripe SDK v1 for webhook handling.');
    const newDep = store.remember('src/payments/webhook.ts requires Stripe SDK v2 for webhook handling.');
    store.link(newDep.id, oldDep.id, 'supersedes');

    store.remember(
      'We decided src/auth/session.ts should bypass the repository layer for auth writes.',
    );
    store.remember(
      'All auth writes in src/auth/session.ts must go through the repository layer.',
    );

    const findings = store.contradictions({ limit: 10 });
    assert.equal(findings.some((finding) => finding.kind === 'superseded_active'), true);
    assert.equal(findings.some((finding) => finding.kind === 'decision_pattern_conflict'), true);

    const scoped = store.contradictions({ filePaths: ['src/auth/session.ts'] });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]?.kind, 'decision_pattern_conflict');
    assert.match(scoped[0]?.reason || '', /conflicts with pattern/i);

    store.close();
  });
});

test('remember infers concrete technology choices as decisions', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const entry = store.remember('We use Redis for caching session state across auth requests.');

    assert.equal(entry.type, 'decision');
    assert.equal(entry.tags.includes('redis'), true);

    store.close();
  });
});

test('contradictions ignore file overlap without semantic conflict', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    store.remember('We decided src/cache/README.md must keep onboarding steps concise.', {
      type: 'decision',
    });
    store.remember('src/cache/README.md must not include production secrets.', {
      type: 'pattern',
    });

    const findings = store.contradictions({ filePaths: ['src/cache/README.md'], limit: 10 });

    assert.equal(
      findings.some((finding) => finding.kind === 'decision_pattern_conflict'),
      false,
    );

    store.close();
  });
});

test('inferLinks suggests likely missing relationships and skips existing links', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const decision = store.remember(
      'We decided src/payments/webhook.ts should verify Stripe signatures before enqueueing work.',
    );
    const dependency = store.remember(
      'src/payments/webhook.ts requires the Stripe SDK for webhook signature verification.',
    );
    store.remember('src/auth/session.ts must rotate cookies before redirect.');

    const suggestions = store.inferLinks({ limit: 10 });
    const dependencySuggestion = suggestions.find(
      (suggestion) =>
        suggestion.source.id === decision.id &&
        suggestion.target.id === dependency.id &&
        suggestion.suggested_type === 'depends_on',
    );

    assert.ok(dependencySuggestion);
    assert.match(dependencySuggestion.reason, /Shared file context|Shared terminology/);

    store.link(decision.id, dependency.id, 'depends_on');
    const afterLink = store.inferLinks({ limit: 10 });
    assert.equal(
      afterLink.some(
        (suggestion) =>
          suggestion.source.id === decision.id && suggestion.target.id === dependency.id,
      ),
      false,
    );

    const scoped = store.inferLinks({
      filePaths: ['src/payments/webhook.ts'],
      limit: 10,
    });
    assert.equal(
      scoped.every(
        (suggestion) =>
          suggestion.source.file_refs.includes('src/payments/webhook.ts') ||
          suggestion.target.file_refs.includes('src/payments/webhook.ts'),
      ),
      true,
    );

    store.close();
  });
});

test('importConversation indexes durable knowledge from transcript jsonl files', async () => {
  await withTempProject(async (root) => {
    IvnStore.init(root);
    const transcriptPath = join(root, 'session.jsonl');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          role: 'user',
          message: {
            content: [{ type: 'text', text: 'We decided src/auth/session.ts should rotate cookies before redirect.' }],
          },
        }),
        JSON.stringify({
          role: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Watch out: src/payments/webhook.ts times out after 10 seconds unless work is queued.' }],
          },
        }),
        JSON.stringify({
          role: 'assistant',
          message: {
            content: [{ type: 'text', text: 'I need to inspect the codebase first.' }],
          },
        }),
        JSON.stringify({
          role: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Need to add rate limiting to src/api/login.ts before launch.' }],
          },
        }),
      ].join('\n') + '\n',
    );

    const store = IvnStore.open(root);
    const firstImport = await importConversation(store, transcriptPath, { limit: 10 });
    assert.equal(firstImport.format, 'jsonl');
    assert.equal(firstImport.message_count, 4);
    assert.equal(firstImport.candidate_count, 3);
    assert.equal(firstImport.imported, 3);
    assert.equal(firstImport.duplicates, 0);
    assert.equal(firstImport.items.every((item) => item.entry?.review_status === 'pending'), true);
    assert.equal(firstImport.items.every((item) => item.entry?.source_kind === 'conversation'), true);
    assert.equal(firstImport.items.every((item) => item.entry?.source_ref === transcriptPath), true);

    const secondImport = await importConversation(store, transcriptPath, { limit: 10 });
    assert.equal(secondImport.imported, 0);
    assert.equal(secondImport.duplicates, 3);
    store.close();
  });
});

test('mcp resource helpers expose live changed context, warnings, and pending review', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    runGit(root, ['init']);
    mkdirSync(join(root, 'src', 'auth'), { recursive: true });
    writeFileSync(join(root, 'src', 'auth', 'session.ts'), 'export const ready = true;\n');

    const store = IvnStore.open(root);
    store.remember('Watch out: src/auth/session.ts must rotate cookies before redirect.');
    store.remember('src/auth/session.ts requires the session secret to be loaded.');
    store.remember('Conversation import noted a follow-up for src/auth/session.ts.', {
      source: 'conversation:session.jsonl',
      sourceKind: 'conversation',
      sourceRef: 'session.jsonl',
    });
    store.close();

    writeFileSync(join(root, 'src', 'auth', 'session.ts'), 'export const ready = false;\n');

    const resources = listIvnResources(root);
    assert.deepEqual(
      resources.map((resource) => resource.uri),
      ['ivn://context', 'ivn://changed', 'ivn://warnings', 'ivn://review/pending'],
    );
    assert.match(resources.find((resource) => resource.uri === 'ivn://changed')?.description || '', /changed file|No changed files/i);
    assert.match(resources.find((resource) => resource.uri === 'ivn://review\/pending')?.description || '', /pending knowledge/i);

    const changed = readIvnResource('ivn://changed', root);
    assert.match(changed.text, /Changed File Context/);
    assert.match(changed.text, /src\/auth\/session\.ts/);

    const warnings = readIvnResource('ivn://warnings', root);
    assert.match(warnings.text, /Proactive Warnings/);
    assert.match(warnings.text, /rotate cookies before redirect/);

    const pending = readIvnResource('ivn://review/pending', root);
    assert.match(pending.text, /Pending Knowledge Review/);
    assert.match(pending.text, /session\.jsonl/);
  });
});

test('live conversation capture suggests candidates then stores only confirmed ones', async () => {
  await withTempProject(async (root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('We decided src/auth/session.ts should rotate cookies before redirect.');

    const suggested = await suggestConversationCapture(
      store,
      [
        { role: 'assistant', content: 'We decided src/auth/session.ts should rotate cookies before redirect.' },
        { role: 'assistant', content: 'Need to add rate limiting to src/api/login.ts before launch.' },
        { role: 'assistant', content: 'I need to inspect the codebase first.' },
      ],
      { limit: 10, visibility: 'shared' },
    );

    assert.equal(suggested.candidate_count, 2);
    assert.equal(suggested.duplicates, 1);
    assert.equal(suggested.items[0]?.duplicate, true);
    assert.equal(suggested.items[1]?.type, 'todo');

    const confirmed = await confirmConversationCapture(
      store,
      suggested.items
        .filter((item) => !item.duplicate)
        .map((item) => ({
          content: item.content,
          type: item.type,
          confidence: item.confidence,
          role: item.role,
        })),
      { sourceRef: 'live-session-1', visibility: 'shared' },
    );

    assert.equal(confirmed.imported, 1);
    assert.equal(confirmed.duplicates, 0);
    assert.equal(confirmed.items[0]?.entry?.review_status, 'pending');
    assert.equal(confirmed.items[0]?.entry?.source_kind, 'conversation');
    assert.equal(confirmed.items[0]?.entry?.source_ref, 'live-session-1');
    assert.match(confirmed.items[0]?.entry?.content || '', /rate limiting/);

    store.close();
  });
});

test('opening a legacy database migrates schema and backfills provenance', () => {
  withTempProject((root) => {
    createLegacyProject(root);
    const store = IvnStore.open(root);

    const migrated = store.get('deadbeef');
    assert.ok(migrated);
    assert.equal(migrated.source_kind, 'git');
    assert.equal(migrated.source_ref, 'abc12345');
    assert.equal(migrated.valid_from, '2026-03-20T00:00:00.000Z');
    assert.equal(store.doctor().schema_version, SCHEMA_VERSION);

    store.close();

    const config = JSON.parse(readFileSync(join(root, '.ivn', 'config.json'), 'utf8'));
    assert.equal(config.schema_version, SCHEMA_VERSION);
  });
});

test('diff returns reviewable knowledge events including archived entries and links', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const decision = store.remember('We chose SQLite for local-first project memory.');
    const gotcha = store.remember('Watch out: the MCP server should always load project context first.');
    const edge = store.link(decision.id, gotcha.id, 'relates_to');
    store.forget(gotcha.id);

    const diff = store.diff({ limit: 10 });
    assert.deepEqual(
      diff.map((item) => item.event.type),
      ['knowledge_archived', 'edge_added', 'knowledge_added', 'knowledge_added'],
    );
    assert.equal(diff[0]?.knowledge?.archived, true);
    assert.equal(diff[1]?.edge?.id, edge.id);
    assert.equal(diff[1]?.source?.id, decision.id);
    assert.equal(diff[1]?.target?.id, gotcha.id);

    store.close();
  });
});

test('history returns a temporal timeline and can scope events to a knowledge entry', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const first = store.remember('We decided temporal history should come from the event ledger.');
    const second = store.remember('We use event-backed timelines for project memory.', { type: 'pattern' });
    store.link(first.id, second.id, 'relates_to');
    store.refresh(first.id, 'Still valid after adding history.');

    const fullHistory = store.history({ visibility: 'all', limit: 10 });
    const scopedHistory = store.history({ knowledgeId: first.id, visibility: 'all', limit: 10 });
    store.close();

    assert.equal(fullHistory.length >= 4, true);
    assert.equal(fullHistory[0]?.event.type, 'knowledge_refreshed');
    assert.equal(scopedHistory.some((item) => item.event.type === 'knowledge_added' && item.knowledge?.id === first.id), true);
    assert.equal(scopedHistory.some((item) => item.event.type === 'edge_added' && item.edge?.source_id === first.id), true);
  });
});

test('snapshot reconstructs best-effort knowledge state at a point in time', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const first = store.remember('Original snapshot content.');
    const second = store.remember('This entry will be archived later.', { type: 'pattern' });
    const edge = store.link(first.id, second.id, 'relates_to');
    store.update(first.id, { content: 'Updated snapshot content after the chosen date.' });
    store.forget(second.id);
    store.close();

    const db = new Database(join(root, '.ivn', 'knowledge.db'));
    db.prepare('UPDATE knowledge SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:03:00.000Z', first.id);
    db.prepare('UPDATE knowledge SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:10.000Z', '2026-01-01T00:04:00.000Z', second.id);
    db.prepare('UPDATE edges SET created_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:20.000Z', edge.id);
    db.prepare('UPDATE knowledge_events SET created_at = ? WHERE type = ? AND knowledge_id = ?')
      .run('2026-01-01T00:00:00.000Z', 'knowledge_added', first.id);
    db.prepare('UPDATE knowledge_events SET created_at = ? WHERE type = ? AND knowledge_id = ?')
      .run('2026-01-01T00:00:10.000Z', 'knowledge_added', second.id);
    db.prepare('UPDATE knowledge_events SET created_at = ? WHERE type = ? AND edge_id = ?')
      .run('2026-01-01T00:00:20.000Z', 'edge_added', edge.id);
    db.prepare('UPDATE knowledge_events SET created_at = ? WHERE type = ? AND knowledge_id = ?')
      .run('2026-01-01T00:03:00.000Z', 'knowledge_updated', first.id);
    db.prepare('UPDATE knowledge_events SET created_at = ? WHERE type = ? AND knowledge_id = ?')
      .run('2026-01-01T00:04:00.000Z', 'knowledge_archived', second.id);
    db.close();

    const reopened = IvnStore.open(root);
    const earlySnapshot = reopened.snapshot({
      at: '2026-01-01T00:02:00.000Z',
      visibility: 'all',
      reviewStatus: 'all',
      limit: 10,
    });
    const lateSnapshot = reopened.snapshot({
      at: '2026-01-01T00:05:00.000Z',
      visibility: 'all',
      reviewStatus: 'all',
      limit: 10,
    });
    reopened.close();

    assert.equal(earlySnapshot.entries.length, 2);
    assert.equal(earlySnapshot.edges.length, 1);
    assert.equal(earlySnapshot.exact, false);
    const firstEntry = earlySnapshot.entries.find((entry) => entry.knowledge.id === first.id);
    assert.ok(firstEntry);
    assert.equal(firstEntry.content_may_have_changed, true);
    assert.match(firstEntry.knowledge.content, /Updated snapshot content/);

    assert.equal(lateSnapshot.entries.some((entry) => entry.knowledge.id === second.id), false);
  });
});

test('diff defaults to shared changes but can include private lane explicitly', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('Shared reviewable knowledge.', { visibility: 'shared' });
    store.remember('Private local-only knowledge.', { visibility: 'private' });
    store.close();

    const sharedStore = IvnStore.open(root);
    const sharedOnly = sharedStore.diff({ limit: 10, visibility: 'shared' });
    sharedStore.close();

    const allStore = IvnStore.open(root);
    const allVisibility = allStore.diff({ limit: 10, visibility: 'all' });
    allStore.close();

    assert.equal(sharedOnly.length, 1);
    assert.equal(sharedOnly[0]?.knowledge?.visibility, 'shared');
    assert.equal(allVisibility.length, 2);
    assert.deepEqual(
      allVisibility.map((item) => item.knowledge?.visibility),
      ['private', 'shared'],
    );
  });
});

test('automated capture defaults to pending and stays out of active recall', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const pending = store.remember('Imported from git history.', {
      source: 'git:abc12345',
      sourceKind: 'git',
    });

    assert.equal(pending.review_status, 'pending');
    assert.equal(store.list({ reviewStatus: 'pending' }).length, 1);
    assert.equal(store.recall('history').length, 0);
    assert.equal(store.recall('history', 10, 'all', 'pending').length, 1);

    store.close();
  });
});

test('accept reject and refresh implement the editorial workflow', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);

    const entry = store.remember('MCP-discovered auth constraint.', {
      source: 'mcp',
      sourceKind: 'mcp',
    });

    const accepted = store.accept(entry.id, 'Looks correct.');
    assert.ok(accepted);
    assert.equal(accepted.review_status, 'active');
    assert.equal(accepted.review_note, 'Looks correct.');
    assert.equal(store.recall('auth').length, 1);

    const refreshed = store.refresh(entry.id, 'Still valid after review.');
    assert.ok(refreshed);
    assert.equal(refreshed.review_status, 'active');
    assert.equal(refreshed.review_note, 'Still valid after review.');
    assert.equal(refreshed.valid_to, null);

    const rejected = store.reject(entry.id, 'Outdated now.');
    assert.ok(rejected);
    assert.equal(rejected.review_status, 'rejected');
    assert.equal(rejected.review_note, 'Outdated now.');
    assert.ok(rejected.valid_to);

    const diffTypes = store.diff({ limit: 10, visibility: 'all' }).map((item) => item.event.type);
    assert.deepEqual(
      diffTypes.slice(0, 4),
      ['knowledge_rejected', 'knowledge_refreshed', 'knowledge_accepted', 'knowledge_added'],
    );

    store.close();
  });
});
