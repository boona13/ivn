import type { KnowledgeType } from './types.js';

type ScoreMap = Record<KnowledgeType, number>;
type EvidenceMap = Record<KnowledgeType, string[]>;

const KNOWLEDGE_ORDER: KnowledgeType[] = [
  'decision',
  'pattern',
  'gotcha',
  'debug',
  'context',
  'dependency',
  'todo',
];

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'some', 'them',
  'than', 'its', 'over', 'such', 'that', 'this', 'with', 'will', 'each',
  'from', 'they', 'were', 'which', 'their', 'said', 'what', 'when', 'who',
  'how', 'use', 'using', 'used', 'also', 'into', 'just', 'about', 'would',
  'make', 'like', 'does', 'could', 'where', 'after', 'back',
  'then', 'because', 'being', 'other', 'very', 'here', 'more', 'there',
]);

const TECH_TAG_TERMS: Record<string, string[]> = {
  typescript: ['typescript', 'tsconfig', 'tsx', 'ts'],
  javascript: ['javascript', 'jsx', 'js'],
  node: ['node', 'nodejs', 'npm'],
  react: ['react', 'jsx'],
  nextjs: ['next', 'nextjs'],
  express: ['express'],
  hono: ['hono'],
  sqlite: ['sqlite', 'fts5'],
  postgres: ['postgres', 'postgresql'],
  mysql: ['mysql'],
  mongodb: ['mongodb', 'mongo'],
  redis: ['redis'],
  prisma: ['prisma'],
  stripe: ['stripe'],
  docker: ['docker'],
  kubernetes: ['kubernetes', 'k8s'],
  git: ['git', 'gitignore', 'gitconfig'],
  github: ['github'],
  mcp: ['mcp'],
  cursor: ['cursor'],
  claude: ['claude'],
  copilot: ['copilot'],
  openai: ['openai', 'codex', 'chatgpt'],
  api: ['api', 'rest', 'graphql'],
  auth: ['auth', 'oauth', 'jwt', 'session'],
  webhook: ['webhook'],
  database: ['database', 'schema', 'migration'],
  cli: ['cli', 'command'],
  testing: ['test', 'testing', 'spec'],
};

const DECISION_PHRASES = [
  'we decided',
  'decided to',
  'we chose',
  'chose to',
  'went with',
  'picked ',
  'settled on',
  'choose between',
  'standardized on',
  'adopted ',
  'tradeoff',
  'migrated from',
  'switched from',
  'prefer ',
];

const GOTCHA_PHRASES = [
  'watch out',
  'be careful',
  'careful when',
  'breaks when',
  'fails when',
  'times out',
  'silently drops',
  'silently fails',
  'must happen before',
  'breaking change',
  'unexpected behavior',
  'surprising behavior',
  'easy to miss',
  'common mistake',
  'subtle bug',
  'not obvious',
  'counterintuitive',
];

const DEBUG_PHRASES = [
  'root cause',
  'caused by',
  'fixed ',
  'fixes ',
  'debugged ',
  'workaround',
  'stack trace',
  'reproduced by',
  'turned out',
  'the problem was',
  'the issue was',
];

const TODO_PHRASES = [
  'need to',
  'needs to',
  'follow up',
  'next step',
  'future work',
  'plan to',
  'todo',
  'revisit',
];

const PATTERN_PHRASES = [
  'we use',
  'go through',
  'via the',
  'never call',
  'repository layer',
  'standard way',
  'naming convention',
  'code style',
  'best practice',
  'follow the',
];

const DEPENDENCY_PHRASES = [
  'depends on',
  'required for',
  'pinned to',
  'version ',
];

const DECISION_TOKENS = new Set(['decided', 'decision', 'chose', 'chosen', 'picked', 'adopted', 'selected']);
const GOTCHA_TOKENS = new Set(['warning', 'warn', 'careful', 'beware', 'avoid', 'gotcha', 'trap']);
const DEBUG_TOKENS = new Set(['bug', 'bugs', 'fix', 'fixed', 'debug', 'error', 'errors', 'crash', 'issue', 'issues', 'regression', 'broke', 'broken', 'failure']);
const TODO_TOKENS = new Set(['todo', 'later', 'eventually', 'follow', 'revisit']);
const DEPENDENCY_TOKENS = new Set(['depends', 'dependency', 'dependencies', 'requires', 'require', 'library', 'package', 'packages', 'sdk', 'secret', 'token', 'env']);
const DEPENDENCY_STRONG_TOKENS = new Set(['pinned', 'version', 'upgrade', 'downgrade', 'compatible', 'incompatible']);
const POLICY_TOKENS = new Set(['always', 'never', 'must', 'should', 'prefer', 'standard', 'convention', 'rule', 'rules', 'pattern']);
const FAILURE_TOKENS = new Set(['fails', 'failure', 'timeout', 'timeouts', 'breaks', 'broken', 'drops']);
const EXPLANATION_TOKENS = new Set(['because', 'since', 'instead', 'over']);
const CONTEXT_PHRASES = [
  'the architecture',
  'overview of',
  'background on',
  'for context',
  'fyi',
  'note that',
  'important to know',
  'the project uses',
  'the codebase',
  'the stack is',
  'our stack',
  'the repo',
  'project structure',
];
const CONTEXT_TOKENS = new Set(['architecture', 'overview', 'background', 'landscape', 'context', 'structure', 'ecosystem']);

export interface KnowledgeClassification {
  type: KnowledgeType;
  confidence: number;
  scores: ScoreMap;
  evidence: EvidenceMap;
}

export function tokenizeWords(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens: string[] = [];
  let current = '';

  for (const char of lowered) {
    if (isTokenChar(char)) {
      current += char;
      continue;
    }
    if (current) {
      tokens.push(current);
      current = '';
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

export function extractMeaningfulWords(text: string): string[] {
  return tokenizeWords(text)
    .filter((word) => word.length > 2)
    .filter((word) => !STOP_WORDS.has(word));
}

export function normalizeClassifierText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function detectTechnicalTags(text: string): string[] {
  const tokens = new Set(extractMeaningfulWords(text));
  const tags = new Set<string>();

  for (const [tag, aliases] of Object.entries(TECH_TAG_TERMS)) {
    if (aliases.some((alias) => tokens.has(alias))) {
      tags.add(tag);
    }
  }

  return [...tags];
}

export function classifyKnowledge(content: string): KnowledgeClassification {
  const normalized = normalizeClassifierText(content);
  const tokens = tokenizeWords(normalized);
  const tokenSet = new Set(tokens);
  const scores = emptyScores();
  const evidence = emptyEvidence();

  if (!normalized) {
    return { type: 'context', confidence: 0.5, scores, evidence };
  }

  // Short inputs lack enough signal to classify confidently
  const shortInput = normalized.length < 30;

  if (matchesAnyStart(normalized, DECISION_PHRASES)) {
    addScore(scores, evidence, 'decision', 18, 'starts with a decision cue');
  }
  addScoreForPhrases(normalized, scores, evidence, 'decision', DECISION_PHRASES, 10, 'decision phrase');
  addScoreForTokens(tokenSet, scores, evidence, 'decision', DECISION_TOKENS, 5, 'decision token');

  if (normalized.startsWith('we use ') && detectTechnicalTags(normalized).length > 0) {
    const rationaleBoost = hasAnyToken(tokenSet, EXPLANATION_TOKENS) ? 8 : 4;
    addScore(scores, evidence, 'decision', 10 + rationaleBoost, 'technology choice with rationale');
    addScore(scores, evidence, 'pattern', 6, 'technology choice can also signal a stable pattern');
  }

  addScoreForPhrases(normalized, scores, evidence, 'gotcha', GOTCHA_PHRASES, 12, 'gotcha phrase');
  addScoreForTokens(tokenSet, scores, evidence, 'gotcha', GOTCHA_TOKENS, 6, 'warning token');
  if (hasAnyToken(tokenSet, new Set(['must', 'before'])) && hasAnyToken(tokenSet, FAILURE_TOKENS)) {
    addScore(scores, evidence, 'gotcha', 10, 'ordering constraint plus failure mode');
  }

  addScoreForPhrases(normalized, scores, evidence, 'debug', DEBUG_PHRASES, 10, 'debug phrase');
  addScoreForTokens(tokenSet, scores, evidence, 'debug', DEBUG_TOKENS, 5, 'debug token');
  if (normalized.startsWith('fixed ') || normalized.startsWith('bug ') || normalized.startsWith('error ')) {
    addScore(scores, evidence, 'debug', 8, 'starts with a bug or fix cue');
  }
  if (
    hasAnyToken(tokenSet, new Set(['bug', 'bugs', 'error', 'errors', 'crash', 'regression'])) &&
    (detectTechnicalTags(normalized).length > 0 || normalized.includes('/'))
  ) {
    addScore(scores, evidence, 'debug', 6, 'bug signal tied to concrete project context');
  }

  addScoreForPhrases(normalized, scores, evidence, 'todo', TODO_PHRASES, 12, 'todo phrase');
  addScoreForTokens(tokenSet, scores, evidence, 'todo', TODO_TOKENS, 5, 'todo token');
  if (normalized.startsWith('need to ') || normalized.startsWith('todo:') || normalized.startsWith('todo ')) {
    addScore(scores, evidence, 'todo', 10, 'starts with an explicit todo cue');
  }

  addScoreForPhrases(normalized, scores, evidence, 'pattern', PATTERN_PHRASES, 8, 'pattern phrase');
  addScoreForTokens(tokenSet, scores, evidence, 'pattern', POLICY_TOKENS, 4, 'policy token');
  if (startsWithPolicySubject(normalized) && hasAnyToken(tokenSet, POLICY_TOKENS)) {
    addScore(scores, evidence, 'pattern', 12, 'policy subject plus rule language');
  }

  addScoreForPhrases(normalized, scores, evidence, 'dependency', DEPENDENCY_PHRASES, 8, 'dependency phrase');
  addScoreForTokens(tokenSet, scores, evidence, 'dependency', DEPENDENCY_TOKENS, 4, 'dependency token');
  addScoreForTokens(tokenSet, scores, evidence, 'dependency', DEPENDENCY_STRONG_TOKENS, 8, 'strong dependency token');
  if (hasAnyToken(tokenSet, DEPENDENCY_TOKENS) && detectTechnicalTags(normalized).length > 0) {
    const versionBoost = hasAnyToken(tokenSet, DEPENDENCY_STRONG_TOKENS) ? 12 : 6;
    addScore(scores, evidence, 'dependency', versionBoost, 'dependency cue plus concrete technology');
  }

  addScoreForPhrases(normalized, scores, evidence, 'context', CONTEXT_PHRASES, 10, 'context phrase');
  addScoreForTokens(tokenSet, scores, evidence, 'context', CONTEXT_TOKENS, 4, 'context token');
  if (matchesAnyStart(normalized, CONTEXT_PHRASES)) {
    addScore(scores, evidence, 'context', 8, 'starts with context cue');
  }

  if (/^feat[\s(:]/i.test(normalized)) {
    addScore(scores, evidence, 'decision', 6, 'conventional commit feat prefix');
  }
  if (/^fix[\s(:]/i.test(normalized)) {
    addScore(scores, evidence, 'debug', 8, 'conventional commit fix prefix');
  }
  if (/^refactor[\s(:]/i.test(normalized)) {
    addScore(scores, evidence, 'pattern', 6, 'conventional commit refactor prefix');
  }

  if (scores.decision > 0 && scores.debug > 0 && matchesAnyStart(normalized, DECISION_PHRASES)) {
    addScore(scores, evidence, 'decision', 6, 'decision framing outranks incidental bug language');
  }
  if (scores.pattern > 0 && scores.todo > 0 && startsWithPolicySubject(normalized)) {
    addScore(scores, evidence, 'pattern', 6, 'policy statement outranks future-work wording');
  }
  if (scores.dependency > 0 && scores.decision > 0 && hasAnyToken(tokenSet, new Set(['instead', 'over']))) {
    addScore(scores, evidence, 'decision', 4, 'comparison language points to an architectural choice');
  }
  if (scores.gotcha > 0 && scores.pattern > 0 && hasAnyToken(tokenSet, FAILURE_TOKENS)) {
    addScore(scores, evidence, 'gotcha', 4, 'failure language keeps this cautionary');
  }
  if (scores.gotcha > 0 && scores.debug > 0 && hasAnyToken(tokenSet, GOTCHA_TOKENS)) {
    addScore(scores, evidence, 'gotcha', 6, 'cautionary framing outranks incidental debug language');
  }

  const ranked = KNOWLEDGE_ORDER
    .map((type) => ({ type, score: scores[type] }))
    .sort((left, right) => right.score - left.score || KNOWLEDGE_ORDER.indexOf(left.type) - KNOWLEDGE_ORDER.indexOf(right.type));

  const top = ranked[0] || { type: 'context' as KnowledgeType, score: 0 };
  const second = ranked[1] || { type: 'context' as KnowledgeType, score: 0 };
  const strongestScore = top.score;
  const margin = strongestScore - second.score;

  // Short inputs need stronger evidence — a single token match isn't enough
  const minScore = shortInput ? 15 : 10;
  if (strongestScore < minScore) {
    return { type: 'context', confidence: 0.5, scores, evidence };
  }

  // Confidence is driven primarily by the margin between the top two types.
  // A large margin = high confidence. A close race = we're guessing.
  const marginRatio = strongestScore > 0 ? margin / strongestScore : 0;
  let confidence: number;

  if (marginRatio >= 0.7) {
    // Clear winner — strong margin over runner-up
    confidence = Math.min(0.95, 0.8 + marginRatio * 0.15);
  } else if (marginRatio >= 0.4) {
    // Moderate confidence — leading but not dominant
    confidence = 0.65 + marginRatio * 0.25;
  } else {
    // Ambiguous — two types are close; honest about uncertainty
    confidence = 0.5 + marginRatio * 0.3;
  }

  return { type: top.type, confidence, scores, evidence };
}

function emptyScores(): ScoreMap {
  return {
    decision: 0,
    pattern: 0,
    gotcha: 0,
    debug: 0,
    context: 0,
    dependency: 0,
    todo: 0,
  };
}

function emptyEvidence(): EvidenceMap {
  return {
    decision: [],
    pattern: [],
    gotcha: [],
    debug: [],
    context: [],
    dependency: [],
    todo: [],
  };
}

function addScore(scores: ScoreMap, evidence: EvidenceMap, type: KnowledgeType, points: number, reason: string): void {
  scores[type] += points;
  evidence[type].push(reason);
}

function addScoreForPhrases(
  normalized: string,
  scores: ScoreMap,
  evidence: EvidenceMap,
  type: KnowledgeType,
  phrases: string[],
  points: number,
  label: string,
): void {
  for (const phrase of phrases) {
    if (!normalized.includes(phrase)) continue;
    addScore(scores, evidence, type, points, `${label}: ${phrase}`);
  }
}

function addScoreForTokens(
  tokenSet: Set<string>,
  scores: ScoreMap,
  evidence: EvidenceMap,
  type: KnowledgeType,
  keywords: Set<string>,
  points: number,
  label: string,
): void {
  for (const keyword of keywords) {
    if (!tokenSet.has(keyword)) continue;
    addScore(scores, evidence, type, points, `${label}: ${keyword}`);
  }
}

function hasAnyToken(tokenSet: Set<string>, keywords: Set<string>): boolean {
  for (const keyword of keywords) {
    if (tokenSet.has(keyword)) return true;
  }
  return false;
}

function matchesAnyStart(normalized: string, phrases: string[]): boolean {
  return phrases.some((phrase) => normalized.startsWith(phrase));
}

function startsWithPolicySubject(normalized: string): boolean {
  return (
    normalized.startsWith('all ') ||
    normalized.startsWith('every ') ||
    normalized.startsWith('we ') ||
    normalized.startsWith('never ') ||
    normalized.startsWith('always ')
  );
}

function isTokenChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 97 && code <= 122)
  );
}
