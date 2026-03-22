import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultMinimumRequired, judgeAnswer } from '../src/benchmark-judge.js';

test('defaultMinimumRequired scales rubric strictness by task size', () => {
  assert.equal(defaultMinimumRequired(2), 2);
  assert.equal(defaultMinimumRequired(4), 3);
  assert.equal(defaultMinimumRequired(7), 5);
});

test('judgeAnswer passes grounded answers that satisfy required facts and anyOf groups', () => {
  const result = judgeAnswer(
    'Use PostgreSQL with JSONB, keep Prisma on the singleton path, and avoid connection pool exhaustion. Prefer problem+json for API errors.',
    {
      required: ['postgresql', 'jsonb', 'prisma', 'singleton'],
      anyOf: [['rfc 7807', 'problem+json']],
    },
  );

  assert.equal(result.passed, true);
  assert.deepEqual(result.missedRequired, []);
  assert.equal(result.missedAnyOf.length, 0);
  assert.equal(result.forbiddenHits.length, 0);
});

test('judgeAnswer fails when a grounded-looking answer misses too many required facts', () => {
  const result = judgeAnswer('Use PostgreSQL for the new service.', {
    required: ['postgresql', 'jsonb', 'prisma', 'singleton'],
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.matchedRequired, ['postgresql']);
  assert.deepEqual(result.missedRequired, ['jsonb', 'prisma', 'singleton']);
});

test('judgeAnswer fails answers that include forbidden contradictory guidance', () => {
  const result = judgeAnswer(
    'Keep the Stripe webhook on Edge runtime for low latency.',
    {
      required: ['stripe', 'webhook'],
      forbidden: ['edge runtime'],
    },
  );

  assert.equal(result.passed, false);
  assert.deepEqual(result.forbiddenHits, ['edge runtime']);
});
