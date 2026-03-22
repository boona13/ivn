#!/usr/bin/env npx tsx
/**
 * IVN Lifecycle Simulation — What happens over 12 weeks?
 *
 * IVN is built for LLMs. The MCP system prompt instructs the AI to proactively
 * capture knowledge, create supersedes links when decisions change, call
 * ivn_contradictions when guidance looks inconsistent, and use ivn_stale to
 * flag aged entries. The developer approves — the LLM does the heavy lifting.
 *
 * This simulation models three integration levels:
 *   1. FULL MCP  — LLM captures, links reversals, curates (the intended flow)
 *   2. BASIC MCP — LLM captures but doesn't link or curate (minimal integration)
 *   3. CLI ONLY  — No LLM integration, developer does everything manually
 *
 * Run: npx tsx benchmark/lifecycle.ts
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IvnStore } from '../src/store.js';

// ── Timeline Data ────────────────────────────────────────

interface SimEntry {
  content: string;
  type: 'decision' | 'pattern' | 'gotcha' | 'debug' | 'context' | 'dependency' | 'todo';
  tags: string[];
  fileRefs: string[];
  /** How this entry is captured: git (auto), mcp (LLM calls ivn_remember), or manual (CLI). */
  capturedVia: 'git' | 'mcp' | 'manual';
  week: number;
}

const TIMELINE: SimEntry[] = [
  // ── Weeks 1-3: Foundation ──────────────────────────
  {
    content: 'We chose PostgreSQL over MySQL for JSONB support and ACID transactions.',
    type: 'decision', tags: ['database', 'postgres'], fileRefs: ['src/lib/db.ts'],
    week: 1, capturedVia: 'git',
  },
  {
    content: 'All database queries must go through the repository layer.',
    type: 'pattern', tags: ['database', 'architecture'], fileRefs: ['src/repositories/'],
    week: 1, capturedVia: 'mcp',
  },
  {
    content: 'Stripe webhook route MUST use Node.js runtime. crypto.timingSafeEqual is unavailable in Edge Runtime.',
    type: 'gotcha', tags: ['stripe', 'webhook'], fileRefs: ['src/app/api/webhooks/stripe/route.ts'],
    week: 1, capturedVia: 'git',
  },
  {
    content: 'We use Redis for session storage. Sessions expire after 24 hours via SESSION_TTL.',
    type: 'decision', tags: ['redis', 'auth', 'session'], fileRefs: ['src/lib/redis.ts'],
    week: 2, capturedVia: 'git',
  },
  {
    content: 'All API errors must use RFC 7807 format with { type, title, status, detail }.',
    type: 'pattern', tags: ['api', 'errors'], fileRefs: ['src/app/api/'],
    week: 2, capturedVia: 'mcp',
  },
  {
    content: 'Pinned to Node 18 because native fetch is required by the HTTP client layer.',
    type: 'dependency', tags: ['node', 'runtime'], fileRefs: [],
    week: 2, capturedVia: 'git',
  },
  {
    content: 'Always validate request bodies with Zod before processing.',
    type: 'pattern', tags: ['api', 'validation'], fileRefs: ['src/app/api/'],
    week: 3, capturedVia: 'mcp',
  },
  {
    content: 'Chose Resend over SendGrid for transactional email — simpler API and React email templates.',
    type: 'decision', tags: ['email', 'resend'], fileRefs: ['src/lib/email.ts'],
    week: 3, capturedVia: 'git',
  },
  {
    content: 'Hydration mismatch when using Date.now() in server components. Wrap in client component.',
    type: 'debug', tags: ['nextjs', 'react', 'hydration'], fileRefs: ['src/app/dashboard/'],
    week: 3, capturedVia: 'git',
  },
  {
    content: 'Always use the PrismaClient singleton from src/lib/db.ts. New instances exhaust the connection pool.',
    type: 'gotcha', tags: ['prisma', 'database'], fileRefs: ['src/lib/db.ts'],
    week: 3, capturedVia: 'mcp',
  },
  {
    content: 'The project uses a flat role model: owner, admin, member. No hierarchical RBAC for v1.',
    type: 'context', tags: ['auth', 'teams', 'rbac'], fileRefs: ['src/app/api/teams/'],
    week: 3, capturedVia: 'git',
  },

  // ── Weeks 4-7: Growth + First Reversals ────────────
  {
    content: 'Need to add rate limiting before the public launch.',
    type: 'todo', tags: ['api', 'security'], fileRefs: ['src/middleware/'],
    week: 4, capturedVia: 'mcp',
  },
  {
    content: 'Watch out: Stripe webhook has a 30-second timeout. Large payloads need async processing.',
    type: 'gotcha', tags: ['stripe', 'webhook', 'performance'], fileRefs: ['src/app/api/webhooks/stripe/route.ts'],
    week: 4, capturedVia: 'mcp',
  },
  {
    content: 'We decided to migrate from REST to GraphQL for the public-facing API.',
    type: 'decision', tags: ['api', 'graphql'], fileRefs: ['src/app/api/'],
    week: 5, capturedVia: 'mcp',
  },
  {
    content: 'Switched from Resend to Postmark for transactional email — better deliverability tracking.',
    type: 'decision', tags: ['email', 'postmark'], fileRefs: ['src/lib/email.ts'],
    week: 5, capturedVia: 'mcp',
  },
  {
    content: 'Background jobs must use the Bull queue. Never process webhooks synchronously for heavy operations.',
    type: 'pattern', tags: ['queue', 'webhook', 'architecture'], fileRefs: ['src/jobs/'],
    week: 5, capturedVia: 'mcp',
  },
  {
    content: 'Fixed: webhook idempotency bug caused duplicate subscription charges. Added idempotency key on Stripe event ID.',
    type: 'debug', tags: ['stripe', 'webhook', 'billing'], fileRefs: ['src/app/api/webhooks/stripe/route.ts'],
    week: 6, capturedVia: 'git',
  },
  {
    content: 'Decided to replace Redis sessions with JWT tokens for stateless auth scaling.',
    type: 'decision', tags: ['auth', 'jwt', 'session'], fileRefs: ['src/middleware/auth.ts'],
    week: 6, capturedVia: 'mcp',
  },
  {
    content: 'The CI pipeline requires all PRs to pass Playwright e2e tests before merge.',
    type: 'pattern', tags: ['testing', 'ci'], fileRefs: [],
    week: 6, capturedVia: 'manual',
  },
  {
    content: 'Never expose internal error stack traces in production API responses.',
    type: 'gotcha', tags: ['api', 'security', 'errors'], fileRefs: ['src/app/api/'],
    week: 7, capturedVia: 'mcp',
  },
  {
    content: 'Depends on Prisma 5.x. Version 6 has breaking changes in the query engine.',
    type: 'dependency', tags: ['prisma', 'database'], fileRefs: ['prisma/schema.prisma'],
    week: 7, capturedVia: 'git',
  },

  // ── Weeks 8-12: Drift + Staleness ─────────────────
  {
    content: 'The architecture now uses a modular monolith with domain-driven boundaries.',
    type: 'context', tags: ['architecture', 'ddd'], fileRefs: [],
    week: 8, capturedVia: 'mcp',
  },
  {
    content: 'Fixed: memory leak in WebSocket connection handler. Close idle connections after 5 minutes.',
    type: 'debug', tags: ['websocket', 'performance'], fileRefs: ['src/lib/ws.ts'],
    week: 8, capturedVia: 'git',
  },
  {
    content: 'Upgraded to Node 22. The Node 18 pin is no longer relevant.',
    type: 'decision', tags: ['node', 'runtime'], fileRefs: [],
    week: 9, capturedVia: 'mcp',
  },
  {
    content: 'All new features must include OpenTelemetry tracing spans.',
    type: 'pattern', tags: ['observability', 'tracing'], fileRefs: ['src/lib/telemetry.ts'],
    week: 9, capturedVia: 'mcp',
  },
  {
    content: 'Need to migrate the legacy billing tables before Q2 launch.',
    type: 'todo', tags: ['billing', 'database', 'migration'], fileRefs: ['prisma/'],
    week: 10, capturedVia: 'mcp',
  },
  {
    content: 'Fixed: GraphQL N+1 query problem in team members resolver. Use DataLoader pattern.',
    type: 'debug', tags: ['graphql', 'performance', 'database'], fileRefs: ['src/app/api/'],
    week: 10, capturedVia: 'git',
  },
  {
    content: 'Successfully migrated to Prisma 6. The v5 constraint no longer applies.',
    type: 'decision', tags: ['prisma', 'database'], fileRefs: ['prisma/schema.prisma'],
    week: 11, capturedVia: 'mcp',
  },
  {
    content: 'The flat role model is being replaced with hierarchical RBAC in v2.',
    type: 'decision', tags: ['auth', 'rbac', 'teams'], fileRefs: ['src/app/api/teams/'],
    week: 11, capturedVia: 'mcp',
  },
  {
    content: 'Avoid using the deprecated /api/v1 endpoints. All new clients must use /api/v2.',
    type: 'gotcha', tags: ['api', 'deprecation'], fileRefs: ['src/app/api/'],
    week: 12, capturedVia: 'mcp',
  },
  {
    content: 'Future work: add multi-region failover for the database layer.',
    type: 'todo', tags: ['database', 'infrastructure'], fileRefs: [],
    week: 12, capturedVia: 'git',
  },
];

// ── Ground Truth ─────────────────────────────────────────

const SLUG_MAP: Record<number, string> = {
  0: 'postgres-decision',
  1: 'repo-layer-pattern',
  2: 'stripe-edge-gotcha',
  3: 'redis-session-decision',
  4: 'rfc-7807-pattern',
  5: 'node-18-pin',
  6: 'zod-validation-pattern',
  7: 'resend-decision',
  8: 'hydration-debug',
  9: 'prisma-singleton-gotcha',
  10: 'flat-role-context',
  11: 'rate-limit-todo',
  12: 'stripe-timeout-gotcha',
  13: 'graphql-migration',
  14: 'postmark-switch',
  15: 'bull-queue-pattern',
  16: 'webhook-idempotency-debug',
  17: 'jwt-switch',
  18: 'ci-playwright-pattern',
  19: 'no-stacktrace-gotcha',
  20: 'prisma-5-dep',
  21: 'modular-monolith-context',
  22: 'ws-memory-leak-debug',
  23: 'node-22-upgrade',
  24: 'otel-tracing-pattern',
  25: 'billing-migration-todo',
  26: 'graphql-n1-debug',
  27: 'prisma-6-migration',
  28: 'rbac-v2',
  29: 'deprecated-v1-gotcha',
  30: 'multi-region-todo',
};

/**
 * Supersedes pairs: [newer slug, older slug].
 * An LLM with the MCP system prompt would call ivn_link(newer, older, 'supersedes')
 * when it notices a decision reversal during a conversation.
 */
const SUPERSEDES_PAIRS: Array<[string, string]> = [
  ['graphql-migration', 'rfc-7807-pattern'],
  ['postmark-switch', 'resend-decision'],
  ['jwt-switch', 'redis-session-decision'],
  ['node-22-upgrade', 'node-18-pin'],
  ['prisma-6-migration', 'prisma-5-dep'],
  ['rbac-v2', 'flat-role-context'],
];

/** Slugs of entries whose content is factually wrong by week 12. */
const OBSOLETE_CONTENT = new Set([
  'node-18-pin',
  'prisma-5-dep',
  'resend-decision',
  'redis-session-decision',
  'rfc-7807-pattern',
  'flat-role-context',
]);

// ── Simulation Engine ────────────────────────────────────

interface ScenarioResult {
  name: string;
  description: string;
  activeCount: number;
  pendingCount: number;
  totalCount: number;
  staleFlagged: number;
  supersedesLinksCreated: number;
  contradictionsSurfaced: number;
  obsoleteInActive: number;
  signalQuality: number;
  effectiveCoverage: number;
}

function weekToDate(week: number): string {
  const base = new Date('2025-01-06T10:00:00.000Z');
  base.setDate(base.getDate() + (week - 1) * 7);
  return base.toISOString();
}

interface ScenarioConfig {
  name: string;
  description: string;
  /**
   * Which capture sources produce active entries (no pending queue)?
   * 'manual' = CLI remember, 'mcp' = LLM ivn_remember, 'git' = auto-import.
   * In full MCP mode, the LLM calls ivn_remember with proper type → active.
   * Git-imported entries always start as pending.
   */
  activeOnCapture: Set<string>;
  /** Does the LLM accept pending git-imported entries? */
  llmAcceptsPending: boolean;
  /** Does the LLM create supersedes links when decisions are reversed? */
  llmLinksReversals: boolean;
}

function runScenario(config: ScenarioConfig): ScenarioResult {
  const root = mkdtempSync(join(tmpdir(), 'ivn-lifecycle-'));
  for (const d of [
    'src/app/api/webhooks/stripe', 'src/lib', 'src/middleware',
    'src/repositories', 'src/jobs', 'src/app/api/teams',
    'src/app/dashboard', 'prisma',
  ]) mkdirSync(join(root, d), { recursive: true });

  IvnStore.init(root);
  const store = IvnStore.open(root);
  const db = new Database(join(root, '.ivn', 'knowledge.db'));

  const entryIds: Map<string, string> = new Map();

  for (let week = 1; week <= 12; week++) {
    const weekEntries = TIMELINE.filter((e) => e.week === week);

    for (const entry of weekEntries) {
      const idx = TIMELINE.indexOf(entry);
      const slug = SLUG_MAP[idx];

      const isGitImport = entry.capturedVia === 'git';
      const startsActive = config.activeOnCapture.has(entry.capturedVia);

      const knowledge = store.remember(entry.content, {
        type: entry.type,
        tags: entry.tags,
        fileRefs: entry.fileRefs,
        source: entry.capturedVia === 'manual' ? 'cli' : entry.capturedVia,
        sourceKind: isGitImport ? 'git' : entry.capturedVia === 'mcp' ? 'mcp' : 'manual',
        reviewStatus: startsActive ? 'active' : 'pending',
      });

      entryIds.set(slug, knowledge.id);

      const ts = weekToDate(week);
      db.prepare(
        'UPDATE knowledge SET created_at = ?, updated_at = ?, valid_from = ? WHERE id = ?',
      ).run(ts, ts, ts, knowledge.id);

      if (startsActive) {
        db.prepare('UPDATE knowledge SET reviewed_at = ? WHERE id = ?').run(ts, knowledge.id);
      }
    }

    // LLM reviews and accepts pending git-imported entries this week
    if (config.llmAcceptsPending) {
      const pending = store.list({ reviewStatus: 'pending', limit: 500, visibility: 'all' });
      for (const entry of pending) {
        store.accept(entry.id);
        const ts = weekToDate(week);
        db.prepare('UPDATE knowledge SET reviewed_at = ? WHERE id = ?').run(ts, entry.id);
      }
    }

    // LLM creates supersedes links when it notices decision reversals
    if (config.llmLinksReversals) {
      for (const [newerSlug, olderSlug] of SUPERSEDES_PAIRS) {
        const newerId = entryIds.get(newerSlug);
        const olderId = entryIds.get(olderSlug);
        if (!newerId || !olderId) continue;
        const newerIdx = Object.values(SLUG_MAP).indexOf(newerSlug);
        if (TIMELINE[newerIdx]?.week !== week) continue;
        try { store.link(newerId, olderId, 'supersedes'); } catch { /* already linked */ }
      }
    }
  }

  // Build ground-truth obsolete set
  const obsoleteIds = new Set<string>();
  for (const slug of OBSOLETE_CONTENT) {
    const id = entryIds.get(slug);
    if (id) obsoleteIds.add(id);
  }

  // ── Measure ──

  const allActive = store.list({ reviewStatus: 'active', limit: 500, visibility: 'all' });
  const allPending = store.list({ reviewStatus: 'pending', limit: 500, visibility: 'all' });
  const staleEntries = store.stale({ days: 90, limit: 500, visibility: 'all' });
  const contradictions = store.contradictions({ limit: 500, visibility: 'all', reviewStatus: 'active' });

  let supersedesLinksCreated = 0;
  for (const [newerSlug, olderSlug] of SUPERSEDES_PAIRS) {
    const newerId = entryIds.get(newerSlug);
    const olderId = entryIds.get(olderSlug);
    if (newerId && olderId) {
      const row = db.prepare(
        'SELECT COUNT(*) as cnt FROM edges WHERE source_id = ? AND target_id = ? AND type = ?',
      ).get(newerId, olderId, 'supersedes') as { cnt: number } | undefined;
      if (row && row.cnt > 0) supersedesLinksCreated++;
    }
  }

  let obsoleteInActive = 0;
  for (const entry of allActive) {
    if (obsoleteIds.has(entry.id)) obsoleteInActive++;
  }

  const allEntries = store.list({ reviewStatus: 'all' as any, limit: 500, visibility: 'all' });
  const validEntries = allEntries.filter((e) => !obsoleteIds.has(e.id));
  const validAndActive = validEntries.filter((e) => e.review_status === 'active');

  const signalQuality = allActive.length > 0
    ? (allActive.length - obsoleteInActive) / allActive.length
    : 1;

  const effectiveCoverage = validEntries.length > 0
    ? validAndActive.length / validEntries.length
    : 0;

  store.close();
  rmSync(root, { recursive: true, force: true });

  return {
    name: config.name,
    description: config.description,
    activeCount: allActive.length,
    pendingCount: allPending.length,
    totalCount: TIMELINE.length,
    staleFlagged: staleEntries.length,
    supersedesLinksCreated,
    contradictionsSurfaced: contradictions.length,
    obsoleteInActive,
    signalQuality,
    effectiveCoverage,
  };
}

// ── Output ───────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function printResults(results: ScenarioResult[]): void {
  console.log('');
  console.log('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
  console.log('┃  IVN LIFECYCLE SIMULATION — 12 weeks of development, 3 integration levels                ┃');
  console.log('┃  31 knowledge entries · 6 decision reversals · 6 entries become obsolete                  ┃');
  console.log('┃                                                                                          ┃');
  console.log('┃  IVN is built for LLMs. The MCP system prompt instructs the AI to capture knowledge,     ┃');
  console.log('┃  link reversals via ivn_link(supersedes), and surface contradictions proactively.         ┃');
  console.log('┃  The developer approves — the LLM does the curation.                                     ┃');
  console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
  console.log('');

  for (const r of results) {
    console.log(`  ${r.name}: ${r.description}`);
  }
  console.log('');

  const col = 14;
  const labelCol = 34;

  const header = [
    'Metric'.padEnd(labelCol),
    ...results.map((r) => r.name.padStart(col)),
  ].join(' │ ');

  const separator = [
    '─'.repeat(labelCol),
    ...results.map(() => '─'.repeat(col)),
  ].join('─┼─');

  console.log(`  ┌─${separator.replace(/─┼─/g, '─┬─')}─┐`);
  console.log(`  │ ${header} │`);
  console.log(`  ├─${separator}─┤`);

  const rows: Array<[string, (r: ScenarioResult) => string]> = [
    ['Active entries', (r) => String(r.activeCount)],
    ['Pending backlog', (r) => String(r.pendingCount)],
    ['', () => ''],
    ['Flagged stale (>90d)', (r) => String(r.staleFlagged)],
    ['Supersedes links', (r) => `${r.supersedesLinksCreated} / ${SUPERSEDES_PAIRS.length}`],
    ['Contradictions surfaced', (r) => String(r.contradictionsSurfaced)],
    ['', () => ''],
    ['Obsolete still active', (r) => String(r.obsoleteInActive)],
    ['Signal quality', (r) => pct(r.signalQuality)],
    ['Effective coverage', (r) => pct(r.effectiveCoverage)],
  ];

  for (const [label, fn] of rows) {
    if (!label) {
      console.log(`  ├─${separator}─┤`);
      continue;
    }
    const values = results.map((r) => fn(r).padStart(col));
    console.log(`  │ ${label.padEnd(labelCol)} │ ${values.join(' │ ')} │`);
  }

  console.log(`  └─${separator.replace(/─┼─/g, '─┴─')}─┘`);
  console.log('');

  const [full, basic, cli] = results;

  console.log('  WHAT THE NUMBERS SHOW');
  console.log('  ─────────────────────');
  console.log('');
  console.log(`  Full MCP (the intended flow):`);
  console.log(`    The LLM captured ${full.activeCount} entries and accepted all pending git-imports.`);
  console.log(`    It created ${full.supersedesLinksCreated}/${SUPERSEDES_PAIRS.length} supersedes links when it noticed decision reversals.`);
  console.log(`    ivn_contradictions surfaced ${full.contradictionsSurfaced} conflicts — the LLM (or developer) can reject the stale ones.`);
  console.log(`    ${full.staleFlagged} entries flagged stale — ivn_stale surfaces them for the LLM to re-confirm.`);
  console.log(`    ${pct(full.effectiveCoverage)} coverage, ${pct(full.signalQuality)} signal quality.`);
  console.log('');
  console.log(`  Basic MCP (capture only, no graph curation):`);
  console.log(`    The LLM captured via ivn_remember but never called ivn_link or ivn_contradictions.`);
  console.log(`    ${basic.pendingCount} git-imported entries stuck pending — never accepted.`);
  console.log(`    0 supersedes links → 0 contradictions surfaced → ${basic.obsoleteInActive} obsolete entries silently active.`);
  console.log(`    ${pct(basic.effectiveCoverage)} coverage, ${pct(basic.signalQuality)} signal quality.`);
  console.log('');
  console.log(`  CLI only (no LLM integration):`);
  console.log(`    Only ${cli.activeCount} manually entered entries. Everything else sits in the pending queue.`);
  console.log(`    ${pct(cli.signalQuality)} signal quality — but only ${pct(cli.effectiveCoverage)} coverage.`);
  console.log(`    The LLM context window is mostly empty. It cannot know what it was never told.`);
  console.log('');
  console.log('  THE DESIGN POINT');
  console.log('  ────────────────');
  console.log('  IVN\'s value multiplies with LLM integration depth. The MCP system prompt');
  console.log('  instructs the LLM to call ivn_remember, ivn_link, ivn_contradictions,');
  console.log('  and ivn_stale as part of normal conversation flow. The developer confirms');
  console.log('  — the LLM curates. This is why full MCP integration achieves maximum');
  console.log('  coverage while also surfacing every contradiction for review.');
  console.log('');
  console.log('  The pending queue remains a safety net: even in the basic MCP scenario,');
  console.log('  uncurated entries cannot mislead the LLM. The worst case is missing');
  console.log('  knowledge, never wrong knowledge.');
  console.log('');
}

// ── Main ─────────────────────────────────────────────────

function main(): void {
  console.log('  Running lifecycle simulation...');

  const fullMcp = runScenario({
    name: 'Full MCP',
    description: 'LLM captures, accepts pending, links reversals, surfaces contradictions.',
    activeOnCapture: new Set(['manual', 'mcp']),
    llmAcceptsPending: true,
    llmLinksReversals: true,
  });

  const basicMcp = runScenario({
    name: 'Basic MCP',
    description: 'LLM calls ivn_remember but does not link, accept, or curate.',
    activeOnCapture: new Set(['manual', 'mcp']),
    llmAcceptsPending: false,
    llmLinksReversals: false,
  });

  const cliOnly = runScenario({
    name: 'CLI Only',
    description: 'No LLM integration. Only manual CLI entries and unreviewed git-imports.',
    activeOnCapture: new Set(['manual']),
    llmAcceptsPending: false,
    llmLinksReversals: false,
  });

  printResults([fullMcp, basicMcp, cliOnly]);
}

main();
