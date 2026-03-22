import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { classifyImportedKnowledge } from './import-classifier.js';
import { IvnStore } from './store.js';
import { classifyKnowledge, detectTechnicalTags, tokenizeWords } from './knowledge-classifier.js';
import type {
  ConversationCandidate,
  ConversationCaptureResult,
  ConversationFormat,
  ConversationImportResult,
  ConversationTurn,
  KnowledgeType,
  Visibility,
} from './types.js';

interface ConversationMessage {
  role: string;
  text: string;
}

const META_SNIPPET_PHRASES = [
  'i need to inspect',
  "i'm thinking",
  'i am thinking',
  'i should inspect',
  'i could inspect',
  "let's inspect",
  'planning',
  'exploring',
  'inspecting',
  'patching',
  'tool call',
  'shell tool',
  'commentary update',
  'need to send',
  'linter',
  'terminal',
  'readfile',
  'applypatch',
  'build process',
];
const PROJECT_SPECIFIC_TOKENS = new Set([
  'api',
  'auth',
  'cache',
  'config',
  'database',
  'deploy',
  'env',
  'migration',
  'repo',
  'repository',
  'route',
  'schema',
  'secret',
  'session',
  'webhook',
]);

export async function importConversation(
  store: IvnStore,
  filePath: string,
  options: {
    limit?: number;
    dryRun?: boolean;
    visibility?: Visibility;
  } = {},
): Promise<ConversationImportResult> {
  const absPath = resolve(filePath);
  const raw = readFileSync(absPath, 'utf8');
  const { format, messages } = parseConversation(raw, absPath);
  const candidates = await extractKnowledgeCandidates(messages, options.limit || 20);
  const visibility = options.visibility || 'private';
  const source = `conversation:${basename(absPath)}`;
  const items: ConversationCandidate[] = [];

  for (const candidate of candidates) {
    const duplicate = store.isDuplicate(candidate.content, visibility);
    if (duplicate.duplicate && duplicate.existing) {
      items.push({
        ...candidate,
        duplicate: true,
        entry: duplicate.existing,
      });
      continue;
    }

    if (options.dryRun) {
      items.push({
        ...candidate,
        duplicate: false,
        entry: null,
      });
      continue;
    }

    const { entry } = store.rememberIfNew(candidate.content, {
      type: candidate.type,
      tags: ['conversation', candidate.role],
      source,
      sourceKind: 'conversation',
      sourceRef: absPath,
      confidence: candidate.confidence,
      visibility,
    });
    items.push({
      ...candidate,
      duplicate: false,
      entry,
    });
  }

  return {
    file: absPath,
    format,
    message_count: messages.length,
    candidate_count: items.length,
    imported: items.filter((item) => !item.duplicate && item.entry !== null).length,
    duplicates: items.filter((item) => item.duplicate).length,
    items,
  };
}

export async function suggestConversationCapture(
  store: IvnStore,
  turns: ConversationTurn[],
  options: {
    limit?: number;
    visibility?: Visibility;
  } = {},
): Promise<ConversationCaptureResult> {
  const visibility = options.visibility || 'private';
  const messages = normalizeTurns(turns);
  const candidates = await extractKnowledgeCandidates(messages, options.limit || 20);
  const items = candidates.map((candidate) => {
    const duplicate = store.isDuplicate(candidate.content, visibility);
    return {
      ...candidate,
      duplicate: duplicate.duplicate,
      entry: duplicate.existing || null,
    };
  });

  return {
    candidate_count: items.length,
    imported: 0,
    duplicates: items.filter((item) => item.duplicate).length,
    items,
  };
}

export async function confirmConversationCapture(
  store: IvnStore,
  captures: Array<{
    content: string;
    type?: KnowledgeType;
    confidence?: number;
    role?: string;
  }>,
  options: {
    visibility?: Visibility;
    sourceRef?: string | null;
  } = {},
): Promise<ConversationCaptureResult> {
  const visibility = options.visibility || 'private';
  const sourceRef = options.sourceRef ?? 'live';
  const items: ConversationCandidate[] = [];

  for (const capture of captures) {
    const content = normalizeWhitespace(capture.content);
    if (!content) continue;

    const duplicate = store.isDuplicate(content, visibility);
    if (duplicate.duplicate && duplicate.existing) {
      items.push({
        content,
        type: capture.type || duplicate.existing.type,
        confidence: typeof capture.confidence === 'number' ? capture.confidence : duplicate.existing.confidence,
        role: normalizeRole(capture.role),
        duplicate: true,
        entry: duplicate.existing,
      });
      continue;
    }

    const { entry } = store.rememberIfNew(content, {
      type: capture.type,
      tags: ['conversation', normalizeRole(capture.role)],
      source: `conversation:${sourceRef}`,
      sourceKind: 'conversation',
      sourceRef,
      confidence: capture.confidence,
      visibility,
    });
    items.push({
      content,
      type: entry.type,
      confidence: entry.confidence,
      role: normalizeRole(capture.role),
      duplicate: false,
      entry,
    });
  }

  return {
    candidate_count: items.length,
    imported: items.filter((item) => !item.duplicate && item.entry !== null).length,
    duplicates: items.filter((item) => item.duplicate).length,
    items,
  };
}

function parseConversation(raw: string, filePath: string): {
  format: ConversationFormat;
  messages: ConversationMessage[];
} {
  const format = detectConversationFormat(raw, filePath);
  const messages =
    format === 'jsonl'
      ? parseJsonlConversation(raw)
      : format === 'json'
        ? parseJsonConversation(raw)
        : parseTextConversation(raw);

  if (messages.length === 0) {
    throw new Error(`No conversation messages found in ${filePath}.`);
  }

  return { format, messages };
}

function detectConversationFormat(raw: string, filePath: string): ConversationFormat {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.jsonl') return 'jsonl';
  if (extension === '.json') return 'json';
  if (extension === '.md' || extension === '.markdown' || extension === '.txt') return 'text';

  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('{') && trimmed.includes('\n{')) return 'jsonl';
  if (trimmed.startsWith('{')) return 'json';
  return 'text';
}

function parseJsonlConversation(raw: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err: unknown) {
      throw new Error(`Invalid conversation JSONL: ${(err as Error).message}`);
    }
    messages.push(...extractMessagesFromJson(parsed));
  }
  return dedupeMessages(messages);
}

function parseJsonConversation(raw: string): ConversationMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`Invalid conversation JSON: ${(err as Error).message}`);
  }
  return dedupeMessages(extractMessagesFromJson(parsed));
}

function parseTextConversation(raw: string): ConversationMessage[] {
  const lines = raw.split(/\r?\n/);
  const messages: ConversationMessage[] = [];
  let currentRole = 'unknown';
  let buffer: string[] = [];
  let sawRoleMarkers = false;

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) messages.push({ role: currentRole, text });
    buffer = [];
  };

  for (const line of lines) {
    const roleMatch = line.match(/^\s*(user|assistant|system)\s*[:|-]\s*(.*)$/i);
    const headingMatch = line.match(/^\s*#{1,6}\s*(user|assistant|system)\s*$/i);
    if (roleMatch) {
      sawRoleMarkers = true;
      flush();
      currentRole = normalizeRole(roleMatch[1] || 'unknown');
      buffer.push(roleMatch[2] || '');
      continue;
    }
    if (headingMatch) {
      sawRoleMarkers = true;
      flush();
      currentRole = normalizeRole(headingMatch[1] || 'unknown');
      continue;
    }
    buffer.push(line);
  }

  flush();
  if (!sawRoleMarkers) {
    return raw.trim() ? [{ role: 'unknown', text: raw.trim() }] : [];
  }
  return dedupeMessages(messages);
}

function extractMessagesFromJson(value: unknown): ConversationMessage[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractMessagesFromJson(item));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.messages)) {
    return extractMessagesFromJson(record.messages);
  }
  if (Array.isArray(record.conversation)) {
    return extractMessagesFromJson(record.conversation);
  }

  const role = normalizeRole(
    record.role ||
    (record.author && typeof record.author === 'object' ? (record.author as Record<string, unknown>).role : undefined) ||
    (record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>).role : undefined),
  );
  const text = extractMessageText(record);
  if (text) {
    return [{ role, text }];
  }

  return [];
}

function extractMessageText(record: Record<string, unknown>): string {
  const payloads = [
    record.message,
    record.content,
    record.text,
    record.parts,
    record.value,
  ];

  for (const payload of payloads) {
    const parts = extractTextParts(payload);
    const text = normalizeWhitespace(parts.join('\n'));
    if (text) return text;
  }

  return '';
}

function extractTextParts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => extractTextParts(item));
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.text === 'string') parts.push(record.text);
  if (typeof record.value === 'string') parts.push(record.value);
  if (record.content !== undefined) parts.push(...extractTextParts(record.content));
  if (record.parts !== undefined) parts.push(...extractTextParts(record.parts));
  return parts;
}

async function extractKnowledgeCandidates(
  messages: ConversationMessage[],
  limit: number,
): Promise<Array<Omit<ConversationCandidate, 'duplicate' | 'entry'>>> {
  const seen = new Set<string>();
  const candidates: Array<Omit<ConversationCandidate, 'duplicate' | 'entry'>> = [];

  for (const message of messages) {
    for (const snippet of splitIntoSnippets(message.text)) {
      const candidate = await classifySnippet(snippet, message.role);
      if (!candidate) continue;

      const dedupeKey = `${candidate.type}:${normalizeWhitespace(candidate.content).toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      candidates.push(candidate);
      if (candidates.length >= limit) return candidates;
    }
  }

  return candidates;
}

function normalizeTurns(turns: ConversationTurn[]): ConversationMessage[] {
  return dedupeMessages(
    turns
      .map((turn) => ({
        role: normalizeRole(turn.role),
        text: normalizeWhitespace(turn.content || ''),
      }))
      .filter((turn) => turn.text),
  );
}

function splitIntoSnippets(text: string): string[] {
  const blocks = text
    .replace(/\r/g, '\n')
    .split(/\n{2,}/)
    .flatMap((block) => block.split(/\n+/))
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter(Boolean);

  const snippets: string[] = [];
  for (const block of blocks) {
    if (block.length <= 320) {
      snippets.push(block);
      continue;
    }
    snippets.push(...block.split(/(?<=[.!?])\s+(?=[A-Z0-9`])/));
  }
  return snippets;
}

async function classifySnippet(
  snippet: string,
  role: string,
): Promise<Omit<ConversationCandidate, 'duplicate' | 'entry'> | null> {
  const normalized = normalizeWhitespace(snippet);
  if (!normalized || normalized.length < 30 || normalized.length > 320) return null;
  if (normalized.includes('<user_query>') || normalized.includes('<user_info>')) return null;
  if (normalized.startsWith('#') || normalized.startsWith('**')) return null;
  if (looksLikeMetaSnippet(normalized)) return null;

  const heuristic = classifyKnowledge(normalized);
  const classification = await classifyImportedKnowledge(normalized, { heuristic });
  if (classification.type === 'context' || classification.confidence < 0.58) {
    return null;
  }

  if (!looksProjectSpecific(normalized)) return null;

  return {
    content: normalized,
    type: classification.type,
    confidence: classification.confidence,
    role,
  };
}

function looksLikeMetaSnippet(normalized: string): boolean {
  return META_SNIPPET_PHRASES.some((phrase) => normalized.toLowerCase().includes(phrase));
}

function looksProjectSpecific(normalized: string): boolean {
  if (normalized.includes('/') || normalized.includes('`') || normalized.includes('.ts') || normalized.includes('.js')) {
    return true;
  }

  const tokens = new Set(tokenizeWords(normalized));
  if (detectTechnicalTags(normalized).length > 0) return true;

  for (const token of PROJECT_SPECIFIC_TOKENS) {
    if (tokens.has(token)) return true;
  }

  return false;
}

function dedupeMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const seen = new Set<string>();
  const deduped: ConversationMessage[] = [];
  for (const message of messages) {
    const text = normalizeWhitespace(message.text);
    if (!text) continue;
    const key = `${message.role}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ role: message.role, text });
  }
  return deduped;
}

function normalizeRole(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'human') return 'user';
  if (normalized === 'ai') return 'assistant';
  return normalized;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
