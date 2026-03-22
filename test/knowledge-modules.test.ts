import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseImportedClassification,
  resolveAutoKnowledgeType,
  shouldBypassModelForImport,
} from '../src/import-classifier.js';
import { classifyKnowledge } from '../src/knowledge-classifier.js';
import { buildDuplicateSearchQuery, detectDuplicateKnowledge, findSimilarKnowledge } from '../src/knowledge-duplicates.js';
import { detectContradictions } from '../src/knowledge-insights.js';
import type { Knowledge, KnowledgeType, VisibilityFilter } from '../src/types.js';

function makeKnowledge(overrides: Partial<Knowledge> & Pick<Knowledge, 'id' | 'content' | 'type'>): Knowledge {
  const now = '2026-03-21T00:00:00.000Z';
  return {
    id: overrides.id,
    type: overrides.type,
    content: overrides.content,
    summary: overrides.summary || overrides.content,
    tags: overrides.tags || [],
    file_refs: overrides.file_refs || [],
    source: overrides.source || 'manual',
    source_kind: overrides.source_kind || 'manual',
    source_ref: overrides.source_ref ?? null,
    confidence: overrides.confidence ?? 1,
    valid_from: overrides.valid_from || now,
    valid_to: overrides.valid_to ?? null,
    visibility: overrides.visibility || 'shared',
    review_status: overrides.review_status || 'active',
    reviewed_at: overrides.reviewed_at || now,
    review_note: overrides.review_note ?? null,
    created_at: overrides.created_at || now,
    updated_at: overrides.updated_at || now,
    archived: overrides.archived ?? false,
  };
}

function asRow(entry: Knowledge): Record<string, unknown> {
  return {
    ...entry,
    tags: JSON.stringify(entry.tags),
    file_refs: JSON.stringify(entry.file_refs),
    archived: entry.archived ? 1 : 0,
  };
}

function toKnowledge(row: Record<string, unknown>): Knowledge {
  return makeKnowledge({
    id: String(row.id),
    type: row.type as KnowledgeType,
    content: String(row.content),
    summary: String(row.summary || row.content),
    tags: JSON.parse(String(row.tags || '[]')) as string[],
    file_refs: JSON.parse(String(row.file_refs || '[]')) as string[],
    visibility: (row.visibility as Knowledge['visibility']) || 'shared',
    review_status: (row.review_status as Knowledge['review_status']) || 'active',
  });
}

function matchesVisibility(entry: Knowledge | null, visibility: VisibilityFilter): boolean {
  if (!entry) return false;
  return visibility === 'all' || entry.visibility === visibility;
}

function matchesReviewStatus(entry: Knowledge | null): boolean {
  if (!entry) return false;
  return entry.review_status !== 'rejected' && !entry.archived;
}

test('classifyKnowledge prefers a decision over incidental bug language', () => {
  const result = classifyKnowledge(
    'We decided not to fix the auth bug yet because the repository rewrite replaces that flow next week.',
  );

  assert.equal(result.type, 'decision');
  assert.equal(result.confidence >= 0.7, true);
});

test('classifyKnowledge recognizes stable policy patterns', () => {
  const result = classifyKnowledge(
    'All auth writes should go through the repository layer so session rules stay consistent.',
  );

  assert.equal(result.type, 'pattern');
});

test('classifyKnowledge recognizes cautionary gotchas', () => {
  const result = classifyKnowledge(
    'Watch out: src/payments/webhook.ts breaks when retries happen before the Stripe signature is verified.',
  );

  assert.equal(result.type, 'gotcha');
});

test('classifyKnowledge treats concrete technology choices as decisions', () => {
  const result = classifyKnowledge(
    'We use Redis for caching session state across auth requests.',
  );

  assert.equal(result.type, 'decision');
});

test('classifyKnowledge detects conventional commit fix prefix as debug', () => {
  const result = classifyKnowledge(
    'fix(billing): checkout 500 from duplicate subscriptions. Webhook was not idempotent.',
  );

  assert.equal(result.type, 'debug');
});

test('classifyKnowledge detects breaking change gotcha', () => {
  const result = classifyKnowledge(
    'Breaking change in v3: the response format changed from array to paginated object.',
  );

  assert.equal(result.type, 'gotcha');
});

test('classifyKnowledge detects explicit context signals', () => {
  const result = classifyKnowledge(
    'The architecture uses a hexagonal pattern with adapters for each external service.',
  );

  assert.equal(result.type, 'context');
});

test('classifyKnowledge detects migration decisions', () => {
  const result = classifyKnowledge(
    'Migrated from Express to Hono for better edge runtime support and faster cold starts.',
  );

  assert.equal(result.type, 'decision');
});

test('classifyKnowledge handles workaround as debug', () => {
  const result = classifyKnowledge(
    'Workaround: the Prisma client crashes on M1 Macs with Node 18. Pin to Node 20.',
  );

  assert.equal(result.type, 'debug');
});

test('chooseImportedClassification upgrades context heuristics when ML sees a real todo', () => {
  const heuristic = classifyKnowledge(
    'Need to add rate limiting to src/api/login.ts before launch.',
  );
  const ml = {
    type: 'todo' as const,
    confidence: 0.74,
    scores: {
      decision: 4,
      pattern: 5,
      gotcha: 7,
      debug: 3,
      context: 21,
      dependency: 9,
      todo: 74,
    },
    evidence: {
      decision: [],
      pattern: [],
      gotcha: [],
      debug: [],
      context: [],
      dependency: [],
      todo: ['ml zero-shot: future task, follow-up, or todo item'],
    },
  };

  const chosen = chooseImportedClassification(heuristic, ml, false);
  assert.equal(chosen.type, 'todo');
});

test('chooseImportedClassification keeps strong heuristics when requested', () => {
  const heuristic = classifyKnowledge(
    'fix(auth): login crash caused by a missing session secret.',
  );
  const ml = {
    type: 'context' as const,
    confidence: 0.46,
    scores: {
      decision: 8,
      pattern: 11,
      gotcha: 12,
      debug: 34,
      context: 46,
      dependency: 5,
      todo: 4,
    },
    evidence: {
      decision: [],
      pattern: [],
      gotcha: [],
      debug: ['ml zero-shot: debugging note, root cause, or fixed bug'],
      context: ['ml zero-shot: background context or project overview'],
      dependency: [],
      todo: [],
    },
  };

  const chosen = chooseImportedClassification(heuristic, ml, true);
  assert.equal(chosen.type, heuristic.type);
});

test('shouldBypassModelForImport skips ML for strong preferred heuristics', () => {
  const heuristic = classifyKnowledge(
    'fix(auth): login crash caused by a missing session secret.',
  );

  assert.equal(shouldBypassModelForImport(heuristic, true), true);
});

test('shouldBypassModelForImport keeps ML enabled for weaker heuristics', () => {
  const weakContextHeuristic = {
    ...classifyKnowledge('Background note about the current deployment setup.'),
    type: 'context' as const,
    confidence: 0.6,
  };
  const weakHeuristic = {
    ...weakContextHeuristic,
    type: 'debug' as const,
    confidence: 0.6,
  };

  assert.equal(shouldBypassModelForImport(weakContextHeuristic, true), false);
  assert.equal(shouldBypassModelForImport(weakHeuristic, true), false);
  assert.equal(shouldBypassModelForImport(weakHeuristic, false), false);
});

test('shouldBypassModelForImport skips ML for strong preferred context heuristics', () => {
  const heuristic = {
    ...classifyKnowledge('docs: update onboarding and deployment guide'),
    type: 'context' as const,
    confidence: 0.86,
  };

  assert.equal(shouldBypassModelForImport(heuristic, true), true);
});

test('resolveAutoKnowledgeType returns explicit types without invoking classifier', async () => {
  let invoked = false;
  const type = await resolveAutoKnowledgeType('This should stay a gotcha.', {
    type: 'gotcha',
    classify: async () => {
      invoked = true;
      return classifyKnowledge('Need to revisit auth rate limiting later.');
    },
  });

  assert.equal(type, 'gotcha');
  assert.equal(invoked, false);
});

test('resolveAutoKnowledgeType uses the shared classifier when type is omitted', async () => {
  const type = await resolveAutoKnowledgeType('Need to revisit auth rate limiting later.', {
    classify: async () => ({
      type: 'todo',
      confidence: 0.82,
      scores: {
        decision: 2,
        pattern: 4,
        gotcha: 5,
        debug: 3,
        context: 4,
        dependency: 6,
        todo: 82,
      },
      evidence: {
        decision: [],
        pattern: [],
        gotcha: [],
        debug: [],
        context: [],
        dependency: [],
        todo: ['ml zero-shot: future task, follow-up, or todo item'],
      },
    }),
  });

  assert.equal(type, 'todo');
});

test('duplicate helpers find similar knowledge without a store', () => {
  const candidate = makeKnowledge({
    id: 'a1',
    type: 'gotcha',
    content: 'Auth session cookies must rotate before redirect or login fails.',
  });

  const similar = findSimilarKnowledge({
    content: 'Rotate auth session cookies before redirect or login fails.',
    candidateRows: [asRow(candidate)],
    threshold: 0.4,
    visibility: 'all',
    toKnowledge,
    matchesVisibility,
    matchesReviewStatus: (entry) => matchesReviewStatus(entry),
  });

  assert.equal(similar.length, 1);
  assert.equal(similar[0]?.id, candidate.id);
});

test('detectDuplicateKnowledge keeps weak overlap from becoming duplicates', () => {
  const existing = makeKnowledge({
    id: 'b1',
    type: 'context',
    content: 'The marketing site deploys separately from the application backend.',
  });

  const result = detectDuplicateKnowledge({
    content: 'Auth sessions rotate before redirect.',
    candidateRows: [asRow(existing)],
    visibility: 'all',
    toKnowledge,
    matchesVisibility,
    matchesReviewStatus: (entry) => matchesReviewStatus(entry),
  });

  assert.equal(result.duplicate, false);
});

test('buildDuplicateSearchQuery returns null for empty noise-only text', () => {
  assert.equal(buildDuplicateSearchQuery('the and for but'), null);
});

test('detectContradictions works directly on module inputs', () => {
  const decision = makeKnowledge({
    id: 'd1',
    type: 'decision',
    content: 'We decided src/auth/session.ts should bypass the repository layer for auth writes.',
    file_refs: ['src/auth/session.ts'],
    tags: ['auth'],
  });
  const pattern = makeKnowledge({
    id: 'p1',
    type: 'pattern',
    content: 'All auth writes in src/auth/session.ts must go through the repository layer.',
    file_refs: ['src/auth/session.ts'],
    tags: ['auth'],
  });
  const findings = detectContradictions({
    entries: [decision, pattern],
    supersedesEdges: [],
    normalizedFilePaths: ['src/auth/session.ts'],
    root: '/tmp/project',
    limit: 10,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, 'decision_pattern_conflict');
});

test('detectContradictions ignores file overlap without a real semantic clash', () => {
  const decision = makeKnowledge({
    id: 'd2',
    type: 'decision',
    content: 'We decided src/cache/README.md must keep onboarding steps concise.',
    file_refs: ['src/cache/README.md'],
    tags: ['docs'],
  });
  const pattern = makeKnowledge({
    id: 'p2',
    type: 'pattern',
    content: 'src/cache/README.md must not include production secrets.',
    file_refs: ['src/cache/README.md'],
    tags: ['docs'],
  });
  const findings = detectContradictions({
    entries: [decision, pattern],
    supersedesEdges: [],
    normalizedFilePaths: ['src/cache/README.md'],
    root: '/tmp/project',
    limit: 10,
  });

  assert.equal(findings.some((finding) => finding.kind === 'decision_pattern_conflict'), false);
});
