import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyKnowledge,
  detectTechnicalTags,
  tokenizeWords,
  extractMeaningfulWords,
  normalizeClassifierText,
} from '../src/knowledge-classifier.js';
import type { KnowledgeType } from '../src/types.js';

// ── Helpers ─────────────────────────────────────────────

function assertType(content: string, expected: KnowledgeType, label?: string) {
  const result = classifyKnowledge(content);
  assert.equal(
    result.type,
    expected,
    `${label || content}\n  expected: ${expected}, got: ${result.type} (scores: ${JSON.stringify(result.scores)})`,
  );
}

function assertMinConfidence(content: string, minConfidence: number) {
  const result = classifyKnowledge(content);
  assert.ok(
    result.confidence >= minConfidence,
    `"${content.slice(0, 60)}..." confidence ${result.confidence} < ${minConfidence}`,
  );
}

// ── tokenizeWords ───────────────────────────────────────

describe('tokenizeWords', () => {
  it('lowercases and splits on non-alphanumeric chars', () => {
    assert.deepEqual(tokenizeWords('Hello World!'), ['hello', 'world']);
  });

  it('handles mixed punctuation and numbers', () => {
    assert.deepEqual(tokenizeWords('Node 18+ is REQUIRED'), ['node', '18', 'is', 'required']);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(tokenizeWords(''), []);
  });
});

// ── extractMeaningfulWords ──────────────────────────────

describe('extractMeaningfulWords', () => {
  it('filters stop words and short tokens', () => {
    const words = extractMeaningfulWords('the quick brown fox');
    assert.ok(!words.includes('the'));
    assert.ok(words.includes('quick'));
    assert.ok(words.includes('brown'));
    assert.ok(words.includes('fox'));
  });
});

// ── normalizeClassifierText ─────────────────────────────

describe('normalizeClassifierText', () => {
  it('lowercases and collapses whitespace', () => {
    assert.equal(normalizeClassifierText('  Hello   World  '), 'hello world');
  });
});

// ── detectTechnicalTags ─────────────────────────────────

describe('detectTechnicalTags', () => {
  it('detects multiple technologies', () => {
    const tags = detectTechnicalTags('We use PostgreSQL with Prisma and Redis caching');
    assert.ok(tags.includes('postgres'));
    assert.ok(tags.includes('prisma'));
    assert.ok(tags.includes('redis'));
  });

  it('detects framework aliases', () => {
    const tags = detectTechnicalTags('The TSX components use React hooks');
    assert.ok(tags.includes('react'));
    assert.ok(tags.includes('typescript'));
  });

  it('returns empty for non-technical text', () => {
    assert.deepEqual(detectTechnicalTags('The weather is nice today'), []);
  });
});

// ── classifyKnowledge: decisions ────────────────────────

describe('classifyKnowledge — decisions', () => {
  const cases: Array<[string, string]> = [
    ['We decided to use PostgreSQL for ACID transactions and JSON support', 'starts-with decision phrase'],
    ['We chose React over Vue because of the larger ecosystem', 'chose X over Y'],
    ['Went with Hono instead of Express for edge-first routing', 'went-with phrase'],
    ['Settled on monorepo structure using Turborepo', 'settled-on phrase'],
    ['We adopted Zod for all runtime validation', 'adopted phrase'],
    ['Migrated from REST to GraphQL for the public API', 'migrated-from phrase'],
    ['We use PostgreSQL because it supports JSONB natively', 'we-use with tech + rationale'],
    ['feat: we decided to add OAuth2 login flow with Google provider', 'conventional commit feat + decision phrase'],
  ];

  for (const [content, label] of cases) {
    it(`classifies as decision: ${label}`, () => {
      assertType(content, 'decision', label);
    });
  }
});

// ── classifyKnowledge: gotchas ──────────────────────────

describe('classifyKnowledge — gotchas', () => {
  const cases: Array<[string, string]> = [
    ['Watch out for the 30-second timeout on the payment webhook endpoint', 'watch-out phrase'],
    ['Be careful when updating the auth middleware — session tokens break silently', 'be-careful phrase'],
    ['The Stripe webhook silently fails if the payload exceeds 64KB', 'silently-fails phrase'],
    ['API gateway times out after 29 seconds even though Lambda allows 900', 'times-out phrase'],
    ['Breaking change in v3: the response shape moved to a nested data field', 'breaking-change phrase'],
    ['The cache must happen before the database write or stale reads persist', 'must + before + failure mode'],
    ['Avoid using the deprecated auth endpoint — it drops tokens without error', 'avoid + drops tokens'],
  ];

  for (const [content, label] of cases) {
    it(`classifies as gotcha: ${label}`, () => {
      assertType(content, 'gotcha', label);
    });
  }
});

// ── classifyKnowledge: debug ────────────────────────────

describe('classifyKnowledge — debug', () => {
  const cases: Array<[string, string]> = [
    ['Fixed the crash caused by null pointer in auth middleware', 'fixed + crash phrase'],
    ['Root cause was a race condition in the WebSocket reconnection logic', 'root-cause phrase'],
    ['The problem was that connection pooling exceeded the max limit under load', 'the-problem-was phrase'],
    ['Workaround: set the pool size to 5 instead of the default 10', 'workaround phrase'],
    ['Bug in Prisma client — connection drops during hot reload in development', 'bug + tech tag'],
    ['fix: resolve deadlock in background job processor queue', 'conventional commit fix prefix'],
    ['Error in the OAuth callback: redirect URI mismatch with Google config', 'starts with error + context'],
  ];

  for (const [content, label] of cases) {
    it(`classifies as debug: ${label}`, () => {
      assertType(content, 'debug', label);
    });
  }
});

// ── classifyKnowledge: patterns ─────────────────────────

describe('classifyKnowledge — patterns', () => {
  const cases: Array<[string, string]> = [
    ['All database queries must go through the repository layer', 'policy subject + rule language'],
    ['Never call the payment API directly — always use the billing service wrapper', 'never-call phrase'],
    ['Every API endpoint should validate input with Zod before processing', 'every + should + standard'],
    ['Always use the shared logger instance instead of console.log', 'always + rule language'],
    ['We use the repository pattern via the data access layer for all models', 'we-use + via-the phrase'],
    ['refactor: reorganize the repository layer to follow the standard naming convention', 'conventional commit refactor + pattern signals'],
  ];

  for (const [content, label] of cases) {
    it(`classifies as pattern: ${label}`, () => {
      assertType(content, 'pattern', label);
    });
  }
});

// ── classifyKnowledge: todo ─────────────────────────────

describe('classifyKnowledge — todo', () => {
  const cases: Array<[string, string]> = [
    ['Need to add rate limiting before the public launch next month', 'need-to phrase'],
    ['TODO: migrate the legacy auth system to the new OAuth2 flow', 'starts with todo'],
    ['Follow up on the memory leak reported in production monitoring', 'follow-up phrase'],
    ['Future work: add support for multi-tenant database isolation', 'future-work phrase'],
    ['Plan to revisit the caching strategy after the v2 API ships', 'plan-to + revisit'],
  ];

  for (const [content, label] of cases) {
    it(`classifies as todo: ${label}`, () => {
      assertType(content, 'todo', label);
    });
  }
});

// ── classifyKnowledge: dependency ───────────────────────

describe('classifyKnowledge — dependency', () => {
  const cases: Array<[string, string]> = [
    ['Pinned to Node 18 because native fetch is required for the HTTP client', 'pinned + version + tech tag'],
    ['The SDK depends on OpenSSL 3 which is incompatible with Alpine base images', 'depends-on + incompatible'],
    ['Library upgrade: better-sqlite3 v12 requires Node 18 minimum', 'library + upgrade + version + tech'],
  ];

  for (const [content, label] of cases) {
    it(`classifies as dependency: ${label}`, () => {
      assertType(content, 'dependency', label);
    });
  }
});

// ── classifyKnowledge: context ──────────────────────────

describe('classifyKnowledge — context', () => {
  const cases: Array<[string, string]> = [
    ['The architecture uses a modular monolith with clear domain boundaries', 'architecture phrase'],
    ['For context, the API was originally built as a Rails monolith before the rewrite', 'for-context phrase'],
    ['Overview of the deployment pipeline and staging environment setup', 'overview phrase'],
    ['The project uses a hexagonal architecture with ports and adapters', 'the-project-uses phrase'],
  ];

  for (const [content, label] of cases) {
    it(`classifies as context: ${label}`, () => {
      assertType(content, 'context', label);
    });
  }
});

// ── classifyKnowledge: short/ambiguous input ────────────

describe('classifyKnowledge — edge cases', () => {
  it('falls back to context for empty input', () => {
    assertType('', 'context');
  });

  it('falls back to context for very short ambiguous input', () => {
    const result = classifyKnowledge('update something');
    assert.equal(result.type, 'context');
    assert.equal(result.confidence, 0.5);
  });

  it('returns lower confidence when two types compete', () => {
    const clear = classifyKnowledge('We decided to use PostgreSQL for ACID transactions and JSON support');
    const ambiguous = classifyKnowledge('We decided to fix the bug in the auth flow');
    assert.ok(
      clear.confidence > ambiguous.confidence,
      `clear ${clear.confidence} should beat ambiguous ${ambiguous.confidence}`,
    );
  });

  it('provides evidence trails for top-scoring types', () => {
    const result = classifyKnowledge('Watch out for the Stripe webhook timeout that silently drops requests');
    assert.ok(result.evidence.gotcha.length > 0, 'should have gotcha evidence');
    assert.ok(result.scores.gotcha > 0, 'gotcha score should be positive');
  });

  it('high confidence for unambiguous input', () => {
    assertMinConfidence('We decided to use PostgreSQL for ACID transactions', 0.7);
  });

  it('decision framing wins over incidental debug language', () => {
    assertType(
      'We decided to fix the error handling by switching to a Result type pattern',
      'decision',
      'decision framing should outrank incidental debug tokens',
    );
  });

  it('policy subject wins over incidental todo language', () => {
    assertType(
      'Always follow the naming convention and never skip the review step',
      'pattern',
      'policy subject should outrank incidental todo tokens',
    );
  });
});
