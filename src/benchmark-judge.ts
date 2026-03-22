export interface AnswerRubric {
  required: string[];
  minRequired?: number;
  anyOf?: string[][];
  forbidden?: string[];
}

export interface JudgedAnswerResult {
  matchedRequired: string[];
  missedRequired: string[];
  matchedAnyOf: string[][];
  missedAnyOf: string[][];
  forbiddenHits: string[];
  score: number;
  maxScore: number;
  passed: boolean;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function includesNormalized(haystack: string, needle: string): boolean {
  return haystack.includes(normalizeText(needle));
}

export function defaultMinimumRequired(requiredFactCount: number): number {
  if (requiredFactCount <= 3) return requiredFactCount;
  if (requiredFactCount <= 5) return requiredFactCount - 1;
  return requiredFactCount - 2;
}

export function judgeAnswer(answer: string, rubric: AnswerRubric): JudgedAnswerResult {
  const normalizedAnswer = normalizeText(answer);
  const required = rubric.required || [];
  const anyOf = rubric.anyOf || [];
  const forbidden = rubric.forbidden || [];
  const minRequired = rubric.minRequired ?? defaultMinimumRequired(required.length);

  const matchedRequired = required.filter((term) => includesNormalized(normalizedAnswer, term));
  const missedRequired = required.filter((term) => !includesNormalized(normalizedAnswer, term));

  const matchedAnyOf = anyOf.filter((group) => group.some((term) => includesNormalized(normalizedAnswer, term)));
  const missedAnyOf = anyOf.filter((group) => !group.some((term) => includesNormalized(normalizedAnswer, term)));

  const forbiddenHits = forbidden.filter((term) => includesNormalized(normalizedAnswer, term));
  const maxScore = required.length + anyOf.length;
  const rawScore = matchedRequired.length + matchedAnyOf.length - forbiddenHits.length;
  const score = Math.max(0, rawScore);

  return {
    matchedRequired,
    missedRequired,
    matchedAnyOf,
    missedAnyOf,
    forbiddenHits,
    score,
    maxScore,
    passed: matchedRequired.length >= minRequired && missedAnyOf.length === 0 && forbiddenHits.length === 0,
  };
}
