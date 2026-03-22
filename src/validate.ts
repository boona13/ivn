import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { EDGE_TYPES, KNOWLEDGE_TYPES } from './types.js';
import { IVN_KNOWLEDGE_SPEC_VERSION, assertSupportedSpecVersion } from './spec.js';
import { assertSafePackRelativePath } from './pack-paths.js';

const SOURCE_KINDS = ['manual', 'git', 'mcp', 'import', 'external', 'conversation'] as const;
const VISIBILITIES = ['shared', 'private'] as const;
const REVIEW_STATUSES = ['active', 'pending', 'rejected'] as const;
const MANIFEST_VISIBILITIES = ['shared', 'private', 'all'] as const;

export type ValidationKind = 'export' | 'pack-manifest' | 'unknown';
export type ValidationStatus = 'valid' | 'legacy-compatible' | 'invalid';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationReport {
  file: string;
  kind: ValidationKind;
  status: ValidationStatus;
  spec_version: string | null;
  issues: ValidationIssue[];
}

type JsonRecord = Record<string, unknown>;

export function validateJsonFile(filePath: string): ValidationReport {
  const absPath = resolve(filePath);
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (err: unknown) {
    return {
      file: absPath,
      kind: 'unknown',
      status: 'invalid',
      spec_version: null,
      issues: [{ path: '$', message: `Invalid JSON: ${(err as Error).message}` }],
    };
  }

  const kind = inferValidationKind(parsed, absPath);
  if (kind === 'export') return validateExportDocument(parsed, absPath);
  if (kind === 'pack-manifest') return validatePackManifestDocument(parsed, absPath);

  return {
    file: absPath,
    kind: 'unknown',
    status: 'invalid',
    spec_version: null,
    issues: [{
      path: '$',
      message: 'Could not determine whether this is an IVN export or pack manifest.',
    }],
  };
}

export function formatValidationReport(report: ValidationReport): string {
  const lines = [
    '',
    '  IVN Compatibility Check',
    '',
    `  File: ${report.file}`,
    `  Kind: ${report.kind}`,
    `  Status: ${report.status}`,
    `  Spec: ${report.spec_version || 'unknown'}`,
  ];

  if (report.issues.length === 0) {
    lines.push('', `  Compatible with IVN knowledge spec ${IVN_KNOWLEDGE_SPEC_VERSION}`, '');
  } else {
    lines.push('', '  Issues:', '');
    for (const issue of report.issues) {
      lines.push(`  - ${issue.path}: ${issue.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function validateExportDocument(input: unknown, file: string): ValidationReport {
  const issues: ValidationIssue[] = [];
  const data = asRecord(input, '$', issues);
  const specVersion = validateSpecEnvelope(data, '$', issues, 'ivn-knowledge-export');

  validateString(data, 'version', '$.version', issues);
  validateIsoDateTime(data, 'exported_at', '$.exported_at', issues);
  validateString(data, 'project', '$.project', issues);

  const entries = validateArray(data, 'entries', '$.entries', issues);
  const edges = validateArray(data, 'edges', '$.edges', issues);

  entries?.forEach((entry, index) => {
    validateKnowledgeEntry(entry, `$.entries[${index}]`, issues);
  });
  edges?.forEach((edge, index) => {
    validateEdge(edge, `$.edges[${index}]`, issues);
  });

  return makeReport(file, 'export', specVersion, issues);
}

function validatePackManifestDocument(input: unknown, file: string): ValidationReport {
  const issues: ValidationIssue[] = [];
  const data = asRecord(input, '$', issues);
  const specVersion = validateSpecEnvelope(data, '$', issues, 'ivn-knowledge-pack-manifest');

  validateString(data, 'version', '$.version', issues);
  validateIsoDateTime(data, 'exported_at', '$.exported_at', issues);
  validateString(data, 'project', '$.project', issues);
  validateEnum(data, 'visibility', '$.visibility', issues, MANIFEST_VISIBILITIES);
  validateNumber(data, 'count', '$.count', issues, { integer: true, min: 0 });
  validateString(data, 'merge_strategy', '$.merge_strategy', issues);

  const files = asRecord(data?.files, '$.files', issues);
  if (files) {
    validateOptionalString(files, 'json', '$.files.json', issues);
    validateOptionalString(files, 'markdown', '$.files.markdown', issues);
    validateSafePackRelativePath(files, 'json', '$.files.json', issues);
    validateSafePackRelativePath(files, 'markdown', '$.files.markdown', issues);
  }

  return makeReport(file, 'pack-manifest', specVersion, issues);
}

function validateKnowledgeEntry(input: unknown, path: string, issues: ValidationIssue[]): void {
  const entry = asRecord(input, path, issues);
  if (!entry) return;

  validateString(entry, 'id', `${path}.id`, issues);
  validateEnum(entry, 'type', `${path}.type`, issues, KNOWLEDGE_TYPES);
  validateString(entry, 'content', `${path}.content`, issues);
  validateString(entry, 'summary', `${path}.summary`, issues);
  validateStringArray(entry, 'tags', `${path}.tags`, issues);
  validateStringArray(entry, 'file_refs', `${path}.file_refs`, issues);
  validateString(entry, 'source', `${path}.source`, issues);
  validateEnum(entry, 'source_kind', `${path}.source_kind`, issues, SOURCE_KINDS);
  validateNullableString(entry, 'source_ref', `${path}.source_ref`, issues);
  validateNumber(entry, 'confidence', `${path}.confidence`, issues);
  validateIsoDateTime(entry, 'valid_from', `${path}.valid_from`, issues);
  validateNullableIsoDateTime(entry, 'valid_to', `${path}.valid_to`, issues);
  validateEnum(entry, 'visibility', `${path}.visibility`, issues, VISIBILITIES);
  validateEnum(entry, 'review_status', `${path}.review_status`, issues, REVIEW_STATUSES);
  validateNullableIsoDateTime(entry, 'reviewed_at', `${path}.reviewed_at`, issues);
  validateNullableString(entry, 'review_note', `${path}.review_note`, issues);
  validateIsoDateTime(entry, 'created_at', `${path}.created_at`, issues);
  validateIsoDateTime(entry, 'updated_at', `${path}.updated_at`, issues);
  validateBoolean(entry, 'archived', `${path}.archived`, issues);
}

function validateEdge(input: unknown, path: string, issues: ValidationIssue[]): void {
  const edge = asRecord(input, path, issues);
  if (!edge) return;

  validateString(edge, 'source_id', `${path}.source_id`, issues);
  validateString(edge, 'target_id', `${path}.target_id`, issues);
  validateEnum(edge, 'type', `${path}.type`, issues, EDGE_TYPES);
}

function validateSpecEnvelope(
  data: JsonRecord | null,
  path: string,
  issues: ValidationIssue[],
  expectedSpec: 'ivn-knowledge-export' | 'ivn-knowledge-pack-manifest',
): string | null {
  if (!data) return null;

  const spec = data.spec;
  if (spec !== undefined && spec !== expectedSpec) {
    issues.push({ path: `${path}.spec`, message: `Expected "${expectedSpec}".` });
  }

  const rawVersion = data.spec_version;
  if (rawVersion === undefined || rawVersion === null) return 'legacy';
  if (typeof rawVersion !== 'string' || rawVersion.trim() === '') {
    issues.push({ path: `${path}.spec_version`, message: 'Expected a non-empty string.' });
    return null;
  }

  try {
    return assertSupportedSpecVersion(rawVersion);
  } catch (err: unknown) {
    issues.push({ path: `${path}.spec_version`, message: (err as Error).message });
    return rawVersion;
  }
}

function inferValidationKind(input: unknown, filePath: string): ValidationKind {
  if (!isRecord(input)) return 'unknown';

  if (input.spec === 'ivn-knowledge-export') return 'export';
  if (input.spec === 'ivn-knowledge-pack-manifest') return 'pack-manifest';
  if (Array.isArray(input.entries) && Array.isArray(input.edges)) return 'export';
  if (isRecord(input.files) && typeof input.count === 'number') return 'pack-manifest';
  if (basename(filePath) === 'manifest.json') return 'pack-manifest';
  return 'unknown';
}

function makeReport(
  file: string,
  kind: ValidationKind,
  specVersion: string | null,
  issues: ValidationIssue[],
): ValidationReport {
  const status: ValidationStatus = issues.length > 0
    ? 'invalid'
    : specVersion === 'legacy'
      ? 'legacy-compatible'
      : 'valid';

  return {
    file,
    kind,
    status,
    spec_version: specVersion,
    issues,
  };
}

function asRecord(value: unknown, path: string, issues: ValidationIssue[]): JsonRecord | null {
  if (!isRecord(value)) {
    issues.push({ path, message: 'Expected an object.' });
    return null;
  }
  return value;
}

function validateArray(
  data: JsonRecord | null,
  key: string,
  path: string,
  issues: ValidationIssue[],
): unknown[] | null {
  const value = data?.[key];
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'Expected an array.' });
    return null;
  }
  return value;
}

function validateString(data: JsonRecord | null, key: string, path: string, issues: ValidationIssue[]): void {
  if (typeof data?.[key] !== 'string' || (data[key] as string).trim() === '') {
    issues.push({ path, message: 'Expected a non-empty string.' });
  }
}

function validateOptionalString(data: JsonRecord | null, key: string, path: string, issues: ValidationIssue[]): void {
  const value = data?.[key];
  if (value !== undefined && typeof value !== 'string') {
    issues.push({ path, message: 'Expected a string when present.' });
  }
}

function validateSafePackRelativePath(
  data: JsonRecord | null,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  const value = data?.[key];
  if (value === undefined) return;
  if (typeof value !== 'string') return;

  try {
    assertSafePackRelativePath(value, path);
  } catch (err: unknown) {
    issues.push({ path, message: (err as Error).message });
  }
}

function validateNullableString(data: JsonRecord | null, key: string, path: string, issues: ValidationIssue[]): void {
  const value = data?.[key];
  if (value !== null && value !== undefined && typeof value !== 'string') {
    issues.push({ path, message: 'Expected a string or null.' });
  }
}

function validateNumber(
  data: JsonRecord | null,
  key: string,
  path: string,
  issues: ValidationIssue[],
  options: { integer?: boolean; min?: number } = {},
): void {
  const value = data?.[key];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    issues.push({ path, message: 'Expected a number.' });
    return;
  }
  if (options.integer && !Number.isInteger(value)) {
    issues.push({ path, message: 'Expected an integer.' });
  }
  if (options.min !== undefined && value < options.min) {
    issues.push({ path, message: `Expected a value >= ${options.min}.` });
  }
}

function validateBoolean(data: JsonRecord | null, key: string, path: string, issues: ValidationIssue[]): void {
  if (typeof data?.[key] !== 'boolean') {
    issues.push({ path, message: 'Expected a boolean.' });
  }
}

function validateStringArray(data: JsonRecord | null, key: string, path: string, issues: ValidationIssue[]): void {
  const value = data?.[key];
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'Expected an array of strings.' });
    return;
  }
  for (let index = 0; index < value.length; index++) {
    if (typeof value[index] !== 'string') {
      issues.push({ path: `${path}[${index}]`, message: 'Expected a string.' });
    }
  }
}

function validateEnum(
  data: JsonRecord | null,
  key: string,
  path: string,
  issues: ValidationIssue[],
  allowed: readonly string[],
): void {
  const value = data?.[key];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.push({ path, message: `Expected one of: ${allowed.join(', ')}.` });
  }
}

function validateIsoDateTime(data: JsonRecord | null, key: string, path: string, issues: ValidationIssue[]): void {
  const value = data?.[key];
  if (typeof value !== 'string' || !isIsoDateTime(value)) {
    issues.push({ path, message: 'Expected an ISO date-time string.' });
  }
}

function validateNullableIsoDateTime(data: JsonRecord | null, key: string, path: string, issues: ValidationIssue[]): void {
  const value = data?.[key];
  if (value !== null && value !== undefined && (typeof value !== 'string' || !isIsoDateTime(value))) {
    issues.push({ path, message: 'Expected an ISO date-time string or null.' });
  }
}

function isIsoDateTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
