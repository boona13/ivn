import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { IvnStore } from './store.js';
import type { KnowledgeType, EdgeType, ReviewStatusFilter, Visibility, VisibilityFilter } from './types.js';
import { APP_VERSION } from './version.js';
import { getChangedFiles } from './git.js';
import { resolveAutoKnowledgeType } from './import-classifier.js';
import { confirmConversationCapture, suggestConversationCapture } from './conversations.js';

interface IvnResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: 'text/markdown';
}

interface IvnResourceContent {
  uri: string;
  mimeType: 'text/markdown';
  text: string;
}

// ── Tool Definitions ────────────────────────────────────

const TOOL_DEFS = [
  {
    name: 'ivn_remember',
    description:
      'PROACTIVELY store project knowledge whenever you discover something important. ' +
      'Call this automatically when: a technical decision is made, a bug is found/fixed, ' +
      'a gotcha is discovered, a pattern is established, or important context is discussed. ' +
      'Use a specific type when you are confident; otherwise IVN will fall back to its local auto-classifier. ' +
      'Knowledge types: decision, pattern, gotcha, debug, context, dependency, or todo.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'The knowledge to remember. Be specific and include the "why".',
        },
        type: {
          type: 'string',
          enum: ['decision', 'pattern', 'gotcha', 'debug', 'context', 'dependency', 'todo'],
          description: 'Knowledge type (auto-detected from content if omitted)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization (e.g. ["auth", "database", "api"])',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'ivn_recall',
    description:
      'Search project knowledge by query. Use this BEFORE starting work to check what ' +
      'the project already knows about the topic. Returns ranked results from decisions, ' +
      'patterns, gotchas, debugging history, and other stored context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to search for' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        file_path: {
          type: 'string',
          description: 'Optional file path to boost knowledge connected to the file in play',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ivn_focus',
    description:
      'Load knowledge relevant to a specific file path, including directly matched notes ' +
      'and nearby graph context. Use this before editing a file to surface local history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Project-relative or absolute file path' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'ivn_changed',
    description:
      'Load knowledge relevant to files changed in the current git diff. Use this before editing ' +
      'or reviewing active changes so decisions, gotchas, and nearby graph context surface automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ref: {
          type: 'string',
          description: 'Optional git ref to compare the working tree against (default: HEAD)',
        },
        limit: { type: 'number', description: 'Max results (default 12)' },
      },
    },
  },
  {
    name: 'ivn_stale',
    description:
      'List active knowledge that has gone stale and should be re-confirmed or refreshed. ' +
      'Use this when deciding whether old project memory is still trustworthy.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          description: 'Mark knowledge stale after N days without confirmation (default 90)',
        },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'ivn_warn',
    description:
      'Surface gotchas, dependency constraints, and relevant bug history before editing. ' +
      'Use this proactively for a file path or the current git diff.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Specific file path to warn against' },
        changed: {
          type: 'boolean',
          description: 'If true, warn for files changed in the current git diff',
        },
        ref: {
          type: 'string',
          description: 'Optional git ref when changed=true (default HEAD)',
        },
        limit: { type: 'number', description: 'Max warnings (default 6)' },
      },
    },
  },
  {
    name: 'ivn_contradictions',
    description:
      'Find conflicting active project truths, such as a live dependency that has been superseded ' +
      'or a decision that conflicts with an active pattern.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Optional file path to scope contradiction checks' },
        changed: {
          type: 'boolean',
          description: 'If true, scope contradiction checks to files changed in the current git diff',
        },
        ref: {
          type: 'string',
          description: 'Optional git ref when changed=true (default HEAD)',
        },
        limit: { type: 'number', description: 'Max contradictions (default 20)' },
      },
    },
  },
  {
    name: 'ivn_infer',
    description:
      'Suggest likely missing relationships between knowledge entries based on shared files, tags, ' +
      'and terminology. Use this when related project truths feel disconnected.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Optional file path to scope inference suggestions' },
        changed: {
          type: 'boolean',
          description: 'If true, scope suggestions to files changed in the current git diff',
        },
        ref: {
          type: 'string',
          description: 'Optional git ref when changed=true (default HEAD)',
        },
        limit: { type: 'number', description: 'Max suggestions (default 20)' },
      },
    },
  },
  {
    name: 'ivn_context',
    description:
      'Load the current project knowledge dump. Call this at the start of a conversation ' +
      'to understand the decisions, patterns, gotchas, dependencies, and ongoing work IVN has stored so far.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Optional filter query' },
        file_path: { type: 'string', description: 'Optional file path to focus the context dump' },
      },
    },
  },
  {
    name: 'ivn_log',
    description: 'List recent knowledge entries, optionally filtered by type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['decision', 'pattern', 'gotcha', 'debug', 'context', 'dependency', 'todo'],
        },
        limit: { type: 'number', description: 'Max entries (default 20)' },
      },
    },
  },
  {
    name: 'ivn_status',
    description: 'Get project knowledge graph statistics.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'ivn_link',
    description:
      'Create a typed relationship between two knowledge entries. ' +
      'Types: relates_to, caused_by, depends_on, supersedes, implements.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_id: { type: 'string', description: 'Source knowledge ID' },
        target_id: { type: 'string', description: 'Target knowledge ID' },
        type: {
          type: 'string',
          enum: ['relates_to', 'caused_by', 'depends_on', 'supersedes', 'implements'],
          description: 'Relationship type (default: relates_to)',
        },
      },
      required: ['source_id', 'target_id'],
    },
  },
  {
    name: 'ivn_capture_suggest',
    description:
      'Analyze recent conversation turns and suggest durable project knowledge worth capturing. ' +
      'Use this before storing anything so the user can confirm the right items.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messages: {
          type: 'array',
          description: 'Recent conversation turns to analyze',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'user, assistant, or system' },
              content: { type: 'string', description: 'The message text' },
            },
            required: ['content'],
          },
        },
        limit: { type: 'number', description: 'Max capture suggestions (default 8)' },
      },
      required: ['messages'],
    },
  },
  {
    name: 'ivn_capture_confirm',
    description:
      'Store user-approved conversation capture suggestions as pending knowledge. ' +
      'Only call this after the user confirms which items should be remembered.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        captures: {
          type: 'array',
          description: 'Approved captures to store',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Knowledge content to store' },
              type: {
                type: 'string',
                enum: ['decision', 'pattern', 'gotcha', 'debug', 'context', 'dependency', 'todo'],
              },
              confidence: { type: 'number', description: 'Optional confidence score from suggestion stage' },
              role: { type: 'string', description: 'Conversation role that produced the capture' },
            },
            required: ['content'],
          },
        },
        source_ref: {
          type: 'string',
          description: 'Optional conversation/session identifier for provenance',
        },
      },
      required: ['captures'],
    },
  },
];

// ── System Prompt for AI Auto-Capture ───────────────────

const AUTO_CAPTURE_PROMPT = `You have access to IVN — this project's persistent memory system.

## CRITICAL: Load Context First

At the START of every conversation, call \`ivn_context\` to load all existing project knowledge.
This gives you the project's decisions, patterns, gotchas, dependencies, and active work.
Read the passive MCP resources first when available: \`ivn://context\`, \`ivn://changed\`, \`ivn://warnings\`, and \`ivn://review/pending\`.
If you are working on existing changes or a specific file, also call \`ivn_changed\` or \`ivn_focus\`.
Before editing, call \`ivn_warn\` to surface relevant gotchas and constraints.
If guidance looks inconsistent, call \`ivn_contradictions\` before trusting it.
If you see related facts that are not connected yet, call \`ivn_infer\` to discover likely missing links.

## CRITICAL: Remember Proactively

During the conversation, call \`ivn_remember\` whenever:

1. **A decision is made** — "We chose X over Y because Z"
   → type: "decision"

2. **A bug is found or fixed** — "Fixed crash caused by null pointer in auth middleware"
   → type: "debug"

3. **A gotcha is discovered** — "The API has a 30s timeout that silently drops requests"
   → type: "gotcha"

4. **A pattern is established** — "All database queries go through the repository layer"
   → type: "pattern"

5. **A dependency constraint is noted** — "Requires Node 18+ for native fetch"
   → type: "dependency"

6. **Future work is identified** — "Need to add rate limiting before launch"
   → type: "todo"

## Confirmation Flow For Live Capture

- When several important facts emerge across recent turns, call \`ivn_capture_suggest\` on those turns first.
- Show the strongest suggestions to the user and ask which ones should become durable memory.
- Only after the user confirms, call \`ivn_capture_confirm\` with the approved items.
- Use direct \`ivn_remember\` immediately only when the user has already clearly approved capture behavior in the current workflow.

## Rules

- Prefer direct \`ivn_remember\` only when the workflow already expects capture or the user has clearly opted into it.
- Be specific. Include the WHY, not just the WHAT.
- Use descriptive tags for categorization.
- Before remembering, mentally check if this is genuinely useful knowledge that would help a future developer (or AI) working on this project.
- Treat old knowledge carefully. If something looks aged or risky, call \`ivn_stale\` or ask for confirmation instead of assuming it is still true.
- The goal: a developer opening this project 6 months from now should understand every important decision and pitfall without reading a single line of code.`;

const VISIBILITY_VALUES: Visibility[] = ['shared', 'private'];
const VISIBILITY_FILTER_VALUES: VisibilityFilter[] = ['shared', 'private', 'all'];
const REVIEW_STATUS_FILTER_VALUES: ReviewStatusFilter[] = ['active', 'pending', 'rejected', 'all'];

function requireStringArg(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing or invalid \`${field}\`.`);
  }
  return value.trim();
}

function optionalStringArg(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Invalid \`${field}\`: expected a string.`);
  }
  return value.trim();
}

function optionalNumberArg(args: Record<string, unknown>, field: string): number | undefined {
  const value = args[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Invalid \`${field}\`: expected a number.`);
  }
  return value;
}

function optionalPositiveIntArg(
  args: Record<string, unknown>,
  field: string,
  fallback: number,
  max: number = 500,
): number {
  const value = optionalNumberArg(args, field);
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid \`${field}\`: expected a positive integer.`);
  }
  return Math.min(value, max);
}

function optionalBooleanArg(args: Record<string, unknown>, field: string): boolean | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid \`${field}\`: expected a boolean.`);
  }
  return value;
}

function optionalStringArrayArg(args: Record<string, unknown>, field: string): string[] | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid \`${field}\`: expected an array of strings.`);
  }
  return value as string[];
}

function optionalEnumArg<T extends string>(
  args: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid \`${field}\`: expected one of ${allowed.join(', ')}.`);
  }
  return value as T;
}

function safeGetChangedFiles(store: IvnStore): { files: string[]; error: string | null } {
  try {
    return {
      files: getChangedFiles(store.getRoot(), 'HEAD'),
      error: null,
    };
  } catch (err: unknown) {
    return {
      files: [],
      error: (err as Error).message,
    };
  }
}

function renderWarningsResource(store: IvnStore): string {
  const changed = safeGetChangedFiles(store);
  if (changed.error) {
    return `# Proactive Warnings\n\n> ${changed.error}\n`;
  }
  if (changed.files.length === 0) {
    return '# Proactive Warnings\n\nNo changed files detected.\n';
  }

  const warnings = store.warnFiles(changed.files, 6, 'shared', 'active');
  const lines = [
    '# Proactive Warnings',
    '',
    `> ${changed.files.length} changed file${changed.files.length === 1 ? '' : 's'} · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
    '',
    '## Changed Files',
    '',
    ...changed.files.map((file) => `- \`${file}\``),
    '',
  ];

  if (warnings.length === 0) {
    lines.push('No proactive warnings found.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Warnings');
  lines.push('');
  for (const warning of warnings) {
    lines.push(`- ${warning.content}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderPendingReviewResource(store: IvnStore): string {
  const entries = store.list({
    limit: 20,
    visibility: 'shared',
    reviewStatus: 'pending',
  });
  const lines = [
    '# Pending Knowledge Review',
    '',
    `> ${entries.length} pending entr${entries.length === 1 ? 'y' : 'ies'}`,
    '',
  ];

  if (entries.length === 0) {
    lines.push('No pending knowledge right now.');
    lines.push('');
    return lines.join('\n');
  }

  for (const entry of entries) {
    const provenance = entry.source_ref
      ? `${entry.source_kind}:${entry.source_ref}`
      : entry.source_kind;
    lines.push(`- \`${entry.id}\` (${entry.type} · ${provenance}) ${entry.summary}`);
  }
  lines.push('');
  lines.push('Review with `ivn review`, then accept or reject the entries you trust.');
  lines.push('');
  return lines.join('\n');
}

function buildResourceDescriptors(root?: string): IvnResourceDescriptor[] {
  const descriptors: IvnResourceDescriptor[] = [
    {
      uri: 'ivn://context',
      name: 'Project Knowledge',
      description: 'Full project knowledge context exported from IVN.',
      mimeType: 'text/markdown',
    },
    {
      uri: 'ivn://changed',
      name: 'Changed File Context',
      description: 'Live knowledge relevant to files changed in the current git diff.',
      mimeType: 'text/markdown',
    },
    {
      uri: 'ivn://warnings',
      name: 'Proactive Warnings',
      description: 'Gotchas, dependency constraints, and bug history for the current change set.',
      mimeType: 'text/markdown',
    },
    {
      uri: 'ivn://review/pending',
      name: 'Pending Review Queue',
      description: 'Knowledge waiting for editorial review before it becomes active shared memory.',
      mimeType: 'text/markdown',
    },
  ];

  try {
    const store = IvnStore.open(root);
    const stats = store.stats();
    const pending = store.list({ limit: 20, visibility: 'all', reviewStatus: 'pending' });
    const changed = safeGetChangedFiles(store);
    const warnings = changed.error ? [] : store.warnFiles(changed.files, 6, 'all', 'active');
    store.close();

    return descriptors.map((descriptor) => {
      if (descriptor.uri === 'ivn://context') {
        return {
          ...descriptor,
          description: `Project knowledge: ${stats.total} entries across ${Object.keys(stats.by_type).length} types.`,
        };
      }
      if (descriptor.uri === 'ivn://changed') {
        return {
          ...descriptor,
          description: changed.error
            ? `Changed-file context unavailable: ${changed.error}`
            : changed.files.length === 0
              ? 'No changed files detected right now.'
              : `Live context for ${changed.files.length} changed file${changed.files.length === 1 ? '' : 's'}.`,
        };
      }
      if (descriptor.uri === 'ivn://warnings') {
        return {
          ...descriptor,
          description: changed.error
            ? `Warnings unavailable: ${changed.error}`
            : `${warnings.length} proactive warning${warnings.length === 1 ? '' : 's'} for the current change set.`,
        };
      }
      if (descriptor.uri === 'ivn://review/pending') {
        return {
          ...descriptor,
          description: `${pending.length} pending knowledge entr${pending.length === 1 ? 'y' : 'ies'} waiting for review.`,
        };
      }
      return descriptor;
    });
  } catch {
    return descriptors;
  }
}

function knownResource(uri: string): boolean {
  return buildResourceDescriptors().some((resource) => resource.uri === uri);
}

function renderUnavailableResource(uri: string, message: string): IvnResourceContent {
  return {
    uri,
    mimeType: 'text/markdown',
    text: `# IVN Resource Unavailable\n\n> ${message}\n`,
  };
}

export function listIvnResources(root?: string): IvnResourceDescriptor[] {
  return buildResourceDescriptors(root);
}

export function readIvnResource(uri: string, root?: string): IvnResourceContent {
  if (!knownResource(uri)) {
    throw new Error(`Unknown resource: ${uri}`);
  }

  try {
    const store = IvnStore.open(root);
    try {
      let text: string;

      if (uri === 'ivn://context') {
        text = store.context(undefined, undefined, 'shared', 'active');
      } else if (uri === 'ivn://changed') {
        const changed = safeGetChangedFiles(store);
        text = changed.error
          ? `# Changed File Context\n\n> ${changed.error}\n`
          : changed.files.length === 0
            ? '# Changed File Context\n\nNo changed files detected.\n'
            : store.changedContext(changed.files, 12, 'shared', 'active');
      } else if (uri === 'ivn://warnings') {
        text = renderWarningsResource(store);
      } else if (uri === 'ivn://review/pending') {
        text = renderPendingReviewResource(store);
      } else {
        throw new Error(`Unknown resource: ${uri}`);
      }

      return {
        uri,
        mimeType: 'text/markdown',
        text,
      };
    } finally {
      store.close();
    }
  } catch (err: unknown) {
    return renderUnavailableResource(uri, (err as Error).message);
  }
}

// ── Server ──────────────────────────────────────────────

export async function startServer(): Promise<void> {
  const server = new Server(
    { name: 'ivn', version: APP_VERSION },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    },
  );

  // ── Tools ──

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS,
  }));

  type ToolHandler = (store: IvnStore, args: Record<string, unknown>) => Promise<unknown> | unknown;

  function resolveFilePaths(store: IvnStore, args: Record<string, unknown>): string[] | undefined {
    if (args.file_path) return [requireStringArg(args, 'file_path')];
    if (optionalBooleanArg(args, 'changed')) {
      return getChangedFiles(store.getRoot(), optionalStringArg(args, 'ref') || 'HEAD');
    }
    return undefined;
  }

  const KNOWLEDGE_TYPE_ENUM = ['decision', 'pattern', 'gotcha', 'debug', 'context', 'dependency', 'todo'] as const;
  const EDGE_TYPE_ENUM = ['relates_to', 'caused_by', 'depends_on', 'supersedes', 'implements'] as const;

  const toolHandlers: Record<string, ToolHandler> = {
    async ivn_remember(store, args) {
      const content = requireStringArg(args, 'content');
      const type = await resolveAutoKnowledgeType(content, {
        type: optionalEnumArg(args, 'type', KNOWLEDGE_TYPE_ENUM),
      });
      const { entry, isNew } = store.rememberIfNew(content, {
        type,
        tags: optionalStringArrayArg(args, 'tags'),
        source: 'mcp',
        visibility: optionalEnumArg(args, 'visibility', VISIBILITY_VALUES),
      });
      return {
        success: true,
        entry,
        note: isNew ? 'New knowledge stored.' : 'Similar knowledge already exists. Skipped duplicate.',
      };
    },

    ivn_recall(store, args) {
      const visibility = optionalEnumArg(args, 'visibility', VISIBILITY_FILTER_VALUES) || 'shared';
      const reviewStatus = optionalEnumArg(args, 'review_status', REVIEW_STATUS_FILTER_VALUES) || 'active';
      const results = store.recall(
        requireStringArg(args, 'query'),
        optionalPositiveIntArg(args, 'limit', 10),
        visibility,
        reviewStatus,
        optionalStringArg(args, 'file_path'),
      );
      return { results, count: results.length };
    },

    ivn_focus(store, args) {
      const visibility = optionalEnumArg(args, 'visibility', VISIBILITY_FILTER_VALUES) || 'shared';
      const reviewStatus = optionalEnumArg(args, 'review_status', REVIEW_STATUS_FILTER_VALUES) || 'active';
      const results = store.focus(
        requireStringArg(args, 'file_path'),
        optionalPositiveIntArg(args, 'limit', 10),
        visibility,
        reviewStatus,
      );
      return { results, count: results.length };
    },

    ivn_changed(store, args) {
      const visibility = optionalEnumArg(args, 'visibility', VISIBILITY_FILTER_VALUES) || 'shared';
      const reviewStatus = optionalEnumArg(args, 'review_status', REVIEW_STATUS_FILTER_VALUES) || 'active';
      const changedFiles = getChangedFiles(
        store.getRoot(),
        optionalStringArg(args, 'ref') || 'HEAD',
      );
      const results = store.focusFiles(
        changedFiles,
        optionalPositiveIntArg(args, 'limit', 12),
        visibility,
        reviewStatus,
      );
      return { changed_files: changedFiles, results, count: results.length };
    },

    ivn_stale(store, args) {
      const entries = store.stale({
        days: optionalPositiveIntArg(args, 'days', 90, 3650),
        limit: optionalPositiveIntArg(args, 'limit', 20),
        visibility: optionalEnumArg(args, 'visibility', VISIBILITY_FILTER_VALUES) || 'shared',
      });
      return { entries, count: entries.length };
    },

    ivn_warn(store, args) {
      const limit = optionalPositiveIntArg(args, 'limit', 6);
      const visibility = optionalEnumArg(args, 'visibility', VISIBILITY_FILTER_VALUES) || 'shared';
      const reviewStatus = optionalEnumArg(args, 'review_status', REVIEW_STATUS_FILTER_VALUES) || 'active';
      if (args.file_path) {
        const warnings = store.warn(requireStringArg(args, 'file_path'), limit, visibility, reviewStatus);
        return { warnings, count: warnings.length };
      }
      const changedFiles = getChangedFiles(
        store.getRoot(),
        optionalStringArg(args, 'ref') || 'HEAD',
      );
      const warnings = store.warnFiles(changedFiles, limit, visibility, reviewStatus);
      return { changed_files: changedFiles, warnings, count: warnings.length };
    },

    ivn_contradictions(store, args) {
      const visibility = optionalEnumArg(args, 'visibility', VISIBILITY_FILTER_VALUES) || 'shared';
      const reviewStatus = optionalEnumArg(args, 'review_status', REVIEW_STATUS_FILTER_VALUES) || 'active';
      const filePaths = resolveFilePaths(store, args);
      const findings = store.contradictions({
        filePaths,
        limit: optionalPositiveIntArg(args, 'limit', 20),
        visibility,
        reviewStatus,
      });
      return { findings, count: findings.length, file_paths: filePaths || [] };
    },

    ivn_infer(store, args) {
      const visibility = optionalEnumArg(args, 'visibility', VISIBILITY_FILTER_VALUES) || 'shared';
      const reviewStatus = optionalEnumArg(args, 'review_status', REVIEW_STATUS_FILTER_VALUES) || 'active';
      const filePaths = resolveFilePaths(store, args);
      const suggestions = store.inferLinks({
        filePaths,
        limit: optionalPositiveIntArg(args, 'limit', 20),
        visibility,
        reviewStatus,
      });
      return { suggestions, count: suggestions.length, file_paths: filePaths || [] };
    },

    ivn_context(store, args) {
      const visibility = optionalEnumArg(args, 'visibility', VISIBILITY_FILTER_VALUES) || 'shared';
      const reviewStatus = optionalEnumArg(args, 'review_status', REVIEW_STATUS_FILTER_VALUES) || 'active';
      return {
        context: store.context(
          optionalStringArg(args, 'query'),
          optionalStringArg(args, 'file_path'),
          visibility,
          reviewStatus,
        ),
      };
    },

    ivn_log(store, args) {
      const entries = store.list({
        type: optionalEnumArg(args, 'type', KNOWLEDGE_TYPE_ENUM),
        limit: optionalPositiveIntArg(args, 'limit', 20),
        visibility: optionalEnumArg(args, 'visibility', VISIBILITY_FILTER_VALUES) || 'shared',
        reviewStatus: optionalEnumArg(args, 'review_status', REVIEW_STATUS_FILTER_VALUES) || 'active',
      });
      return { entries, count: entries.length };
    },

    ivn_status(store) {
      return store.stats();
    },

    ivn_link(store, args) {
      const edge = store.link(
        requireStringArg(args, 'source_id'),
        requireStringArg(args, 'target_id'),
        optionalEnumArg(args, 'type', EDGE_TYPE_ENUM) || 'relates_to',
      );
      return { success: true, edge };
    },

    async ivn_capture_suggest(store, args) {
      const messages = args.messages;
      if (!Array.isArray(messages)) {
        throw new Error('Invalid `messages`: expected an array.');
      }
      return suggestConversationCapture(
        store,
        messages.map((message) => ({
          role: typeof (message as Record<string, unknown>).role === 'string'
            ? (message as Record<string, unknown>).role as string
            : undefined,
          content: String(message.content || ''),
        })),
        {
          limit: optionalPositiveIntArg(args, 'limit', 8),
          visibility: optionalEnumArg(args, 'visibility', VISIBILITY_VALUES),
        },
      );
    },

    async ivn_capture_confirm(store, args) {
      const captures = args.captures;
      if (!Array.isArray(captures)) {
        throw new Error('Invalid `captures`: expected an array.');
      }
      return confirmConversationCapture(
        store,
        captures.map((capture) => ({
          content: String(capture.content || ''),
          type: optionalEnumArg(capture as Record<string, unknown>, 'type', KNOWLEDGE_TYPE_ENUM),
          confidence: optionalNumberArg(capture as Record<string, unknown>, 'confidence'),
          role: typeof (capture as Record<string, unknown>).role === 'string'
            ? (capture as Record<string, unknown>).role as string
            : undefined,
        })),
        {
          sourceRef: optionalStringArg(args, 'source_ref') || 'live',
          visibility: optionalEnumArg(args, 'visibility', VISIBILITY_VALUES),
        },
      );
    },
  };

  function formatToolResult(result: unknown): string {
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }

  function toStructuredToolResult(result: unknown): Record<string, unknown> | undefined {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return undefined;
    }
    return result as Record<string, unknown>;
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs || {}) as Record<string, unknown>;

    try {
      const handler = toolHandlers[name];
      if (!handler) throw new Error(`Unknown tool: ${name}`);

      const store = IvnStore.open();
      try {
        const result = await handler(store, args);
        const structuredContent = toStructuredToolResult(result);
        return {
          content: [{ type: 'text', text: formatToolResult(result) }],
          structuredContent,
        };
      } finally {
        store.close();
      }
    } catch (err: unknown) {
      const message = `Error: ${(err as Error).message}`;
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: { error: message },
        isError: true,
      };
    }
  });

  // ── Prompts (AI auto-capture instructions) ──

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'ivn_system',
        description:
          'System prompt that instructs AI to proactively load and store project knowledge using IVN. ' +
          'Apply this prompt to enable automatic knowledge capture during conversations.',
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== 'ivn_system') {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    return {
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: AUTO_CAPTURE_PROMPT },
        },
      ],
    };
  });

  // ── Resources (passive context loading) ──

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listIvnResources(),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = readIvnResource(request.params.uri);

    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          text: resource.text,
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
