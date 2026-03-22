import { readFileSync, existsSync } from 'node:fs';
import type { Knowledge } from './types.js';
import { IvnStore } from './store.js';
import { getChangedFiles } from './git.js';

export interface CheckViolation {
  file: string;
  line: number;
  knowledge: Knowledge;
  matchedText: string;
  message: string;
}

export interface CheckResult {
  files: string[];
  violations: CheckViolation[];
  gotchasChecked: number;
  patternsChecked: number;
}

interface CheckRule {
  knowledge: Knowledge;
  antiPatterns: RegExp[];
  message: string;
  global: boolean;
}

const NEGATION_VERB = /(?:never|must not|do not|don't|cannot|should not|avoid)\s+(?:use|call|import|create|add|set|enable|return|put|place|store|hardcode|expose|raise|throw)\s+/i;

const QUALIFIER_BOUNDARY = /\s+(?:in|on|for|from|when|during|within|across|before|after|because|unless|until|if|except|at)\s+/i;

function extractForbiddenTerm(content: string): string | null {
  const lower = content.toLowerCase();
  const neverMatch = lower.match(new RegExp(NEGATION_VERB.source + '(.+?)(?:\\.|,|—|;|$)', 'i'));
  if (!neverMatch) return null;

  let raw = neverMatch[1].trim();
  const qualifierSplit = raw.match(QUALIFIER_BOUNDARY);
  if (qualifierSplit && qualifierSplit.index !== undefined && qualifierSplit.index >= 4) {
    raw = raw.slice(0, qualifierSplit.index).trim();
  }

  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escaped.length > 3 && escaped.length < 60) return escaped;
  return null;
}

function buildCheckRules(entries: Knowledge[]): CheckRule[] {
  const rules: CheckRule[] = [];

  for (const entry of entries) {
    const lower = entry.content.toLowerCase();
    const antiPatterns: RegExp[] = [];
    let message = '';
    let forceGlobal = false;

    const forbidden = extractForbiddenTerm(entry.content);
    if (forbidden) {
      antiPatterns.push(new RegExp(forbidden, 'i'));
      message = `Violates: ${entry.content.slice(0, 140)}`;
    }

    if (
      lower.includes('not edge') ||
      lower.includes('never use edge') ||
      lower.includes('must use node') ||
      (lower.includes('edge runtime') && /never|unavailable|not|avoid|don't/.test(lower))
    ) {
      antiPatterns.push(/runtime\s*=\s*['"]edge['"]/i);
      message = message || `Gotcha: ${entry.content.slice(0, 140)}`;
      forceGlobal = true;
    }

    if (lower.includes('singleton') && (lower.includes('prisma') || lower.includes('database'))) {
      antiPatterns.push(/new\s+PrismaClient\s*\(/);
      message = message || `Pattern: use the singleton client. ${entry.content.slice(0, 100)}`;
      forceGlobal = true;
    }

    if (/(?:never|do not|don't|avoid)\s+hardcode/.test(lower)) {
      antiPatterns.push(/['"][a-z]+_(?:live|test)_[A-Za-z0-9_]{20,}['"]/);
      antiPatterns.push(/['"]sk_(?:live|test)_[A-Za-z0-9_]+['"]/);
      message = message || `Hardcoded secret: ${entry.content.slice(0, 140)}`;
      forceGlobal = true;
    }

    const mustUseMatch = lower.match(/(?:always|must)\s+use\s+(\w+)\s+(?:instead of|not|over|rather than)\s+(\w+)/i);
    if (mustUseMatch) {
      const banned = mustUseMatch[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (banned.length > 2) {
        antiPatterns.push(new RegExp(`(?:import|require|from).*['"]${banned}`, 'i'));
        antiPatterns.push(new RegExp(`new\\s+${banned}`, 'i'));
        message = message || `Violates: ${entry.content.slice(0, 140)}`;
      }
    }

    const preferMatch = lower.match(/prefer\s+(\w+)\s+(?:over|instead of|rather than)\s+(\w+)/i);
    if (preferMatch) {
      const banned = preferMatch[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (banned.length > 2) {
        antiPatterns.push(new RegExp(`(?:import|require|from).*['"]${banned}`, 'i'));
        antiPatterns.push(new RegExp(`new\\s+${banned}`, 'i'));
        message = message || `Prefer: ${entry.content.slice(0, 140)}`;
      }
    }

    if (entry.type === 'debug' && lower.includes('idempoten')) {
      forceGlobal = false;
    }

    if (antiPatterns.length > 0) {
      const global = forceGlobal || entry.file_refs.length === 0;
      rules.push({ knowledge: entry, antiPatterns, message, global });
    }
  }

  return rules;
}

function relevantRulesForFile(rules: CheckRule[], filePath: string): CheckRule[] {
  const lower = filePath.toLowerCase();
  return rules.filter(rule => {
    if (rule.global) return true;
    if (rule.knowledge.file_refs.length > 0) {
      return rule.knowledge.file_refs.some(ref => lower.includes(ref.toLowerCase()));
    }
    const pathParts = lower.split('/');
    return rule.knowledge.tags.some(tag =>
      pathParts.some(part => part.includes(tag)) ||
      lower.includes(tag)
    );
  });
}

export function checkFiles(store: IvnStore, filePaths: string[]): CheckResult {
  const root = store.getRoot();

  const gotchas = store.listAll({ type: 'gotcha', reviewStatus: 'active' });
  const patterns = store.listAll({ type: 'pattern', reviewStatus: 'active' });
  const debugs = store.listAll({ type: 'debug', reviewStatus: 'active' });
  const deps = store.listAll({ type: 'dependency', reviewStatus: 'active' });
  const allEntries = [...gotchas, ...patterns, ...debugs, ...deps];
  const rules = buildCheckRules(allEntries);

  const violations: CheckViolation[] = [];

  for (const filePath of filePaths) {
    const absPath = filePath.startsWith('/') ? filePath : `${root}/${filePath}`;
    if (!existsSync(absPath)) continue;

    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EISDIR') continue;
      if (code !== 'ENOENT') {
        violations.push({
          file: filePath,
          line: 0,
          knowledge: { id: '', type: 'gotcha', content: '', summary: '', tags: [], file_refs: [], source: 'ivn-check', source_kind: 'manual', source_ref: null, confidence: 1, valid_from: '', valid_to: null, visibility: 'shared', review_status: 'active', reviewed_at: null, review_note: null, created_at: '', updated_at: '', archived: false },
          matchedText: '',
          message: `Could not read file: ${(err as Error).message}`,
        });
      }
      continue;
    }

    const applicable = relevantRulesForFile(rules, filePath);
    const lines = content.split('\n');

    for (const rule of applicable) {
      for (const pattern of rule.antiPatterns) {
        for (let i = 0; i < lines.length; i++) {
          const match = lines[i].match(pattern);
          if (match) {
            violations.push({
              file: filePath,
              line: i + 1,
              knowledge: rule.knowledge,
              matchedText: match[0],
              message: rule.message,
            });
          }
        }
      }
    }
  }

  const seen = new Set<string>();
  const deduped = violations.filter(v => {
    const key = `${v.file}:${v.line}:${v.knowledge.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    files: filePaths,
    violations: deduped,
    gotchasChecked: gotchas.length,
    patternsChecked: patterns.length,
  };
}

export function checkChanged(store: IvnStore): CheckResult {
  const root = store.getRoot();
  const files = getChangedFiles(root, 'HEAD');
  return checkFiles(store, files);
}
