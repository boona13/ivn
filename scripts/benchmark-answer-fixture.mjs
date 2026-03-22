import { readFileSync } from 'node:fs';

const casePath = process.env.IVN_BENCH_CASE_FILE || process.env.IVN_BENCH_CASE_FILE;
if (!casePath) {
  throw new Error('IVN_BENCH_CASE_FILE is required.');
}

const benchCase = JSON.parse(readFileSync(casePath, 'utf8'));
const lines = [
  `Task: ${benchCase.task.title}`,
  '',
  'Repo-specific guidance:',
  ...benchCase.rubric.required.map((term) => `- ${term}`),
  ...((benchCase.rubric.anyOf || []).map((group) => `- ${group[0]}`)),
];

process.stdout.write(lines.join('\n'));
