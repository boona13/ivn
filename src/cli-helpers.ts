import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import chalk from 'chalk';
import { formatKnowledge } from './display.js';
import { getSpecInfo } from './spec.js';
import type { ReviewStatusFilter, TraversalStep, VisibilityFilter } from './types.js';

export function parseDepth(value?: string): number {
  const depth = value ? parseInt(value, 10) : 4;
  if (!Number.isFinite(depth) || depth < 1) return 4;
  return Math.min(depth, 8);
}

export function parseVisibility(
  value?: string,
  fallback: VisibilityFilter = 'all',
): VisibilityFilter {
  if (!value) return fallback;
  if (value === 'shared' || value === 'private' || value === 'all') return value;
  throw new Error('Visibility must be one of: shared, private, all');
}

export function parseReviewStatus(
  value?: string,
  fallback: ReviewStatusFilter = 'active',
): ReviewStatusFilter {
  if (!value) return fallback;
  if (value === 'active' || value === 'pending' || value === 'rejected' || value === 'all') {
    return value;
  }
  throw new Error('Review status must be one of: active, pending, rejected, all');
}

export function parseDays(value: string | undefined, fallback: number): number {
  const parsed = value ? parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('Days must be a positive integer.');
  }
  return parsed;
}

export function parsePort(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error('Port must be an integer between 0 and 65535.');
  }
  return parsed;
}

export function parseIsoDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Expected an ISO date/time value.');
  }
  return parsed.toISOString();
}

export function formatCommandHelp(
  ...sections: Array<{ title: string; lines: string[] }>
): string {
  return [
    '',
    ...sections.flatMap((section) => [section.title, ...section.lines, '']),
  ].join('\n');
}

export function formatTraversal(title: string, steps: TraversalStep[]): string {
  const lines: string[] = ['', `  ${chalk.bold(title)}`, ''];

  for (const step of steps) {
    if (step.depth === 0) {
      lines.push(formatKnowledge(step.knowledge));
      lines.push('');
      continue;
    }

    const arrow = step.direction === 'incoming' ? '\u2190' : '\u2192';
    lines.push(
      `  ${'  '.repeat(Math.max(0, step.depth - 1))}${chalk.dim(`${arrow} ${step.edge?.type}`)}`,
    );
    lines.push(formatKnowledge(step.knowledge));
    lines.push('');
  }

  if (steps.length === 1) {
    lines.push(chalk.dim('  No linked knowledge found.\n'));
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function emitOutput(output: string, outPath?: string): void {
  if (!outPath) {
    console.log(output);
    return;
  }

  const absPath = resolve(outPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, output.endsWith('\n') ? output : `${output}\n`);
  console.log(`\n  ${chalk.green('\u2713')} Wrote review output to ${chalk.dim(absPath)}\n`);
}

export function appendOutput(output: string, outPath: string, successLabel: string): void {
  const absPath = resolve(outPath);
  mkdirSync(dirname(absPath), { recursive: true });
  const hasContent = existsSync(absPath) && readFileSync(absPath, 'utf8').trim().length > 0;
  const normalized = output.endsWith('\n') ? output.trimEnd() : output;
  appendFileSync(absPath, `${hasContent ? '\n\n' : ''}${normalized}\n`);
  console.log(`\n  ${chalk.green('\u2713')} ${successLabel} ${chalk.dim(absPath)}\n`);
}

export function formatSpecInfo(info: ReturnType<typeof getSpecInfo>): string {
  return [
    '',
    `  ${chalk.bold('IVN Knowledge Spec')}`,
    `  ${chalk.dim('Version:')} ${info.version}`,
    `  ${chalk.dim('Directory:')} ${info.directory}`,
    '',
    `  ${chalk.dim('Export schema:')} ${info.export_schema_path}`,
    `  ${chalk.dim('Pack schema:')}   ${info.pack_manifest_schema_path}`,
    `  ${chalk.dim('HTTP OpenAPI:')}  ${info.service_openapi_path}`,
    `  ${chalk.dim('Spec doc:')}      ${info.spec_doc_path}`,
    '',
  ].join('\n');
}
