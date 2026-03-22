import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const requiredPaths = [
  'dist/cli.js',
  'dist/backup.js',
  'dist/mcp.js',
  'dist/http.js',
  'dist/web.js',
  'dist/web-dashboard.html',
  'dist/web-dashboard.css',
  'dist/web-dashboard.js',
  'examples/README.md',
  'examples/cursor-mcp.json',
  'examples/http-ingest.mjs',
  'spec/SPEC.md',
  'spec/ivn-export.schema.json',
  'spec/ivn-pack-manifest.schema.json',
  'spec/ivn-service.openapi.json',
  'README.md',
  'LICENSE',
];

const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const versionSource = readFileSync(resolve(ROOT, 'src', 'version.ts'), 'utf8');

const issues = [];

for (const relativePath of requiredPaths) {
  const absolutePath = resolve(ROOT, relativePath);
  if (!existsSync(absolutePath)) {
    issues.push(`Missing required release artifact: ${relativePath}`);
    continue;
  }

  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    issues.push(`Release artifact must be a file: ${relativePath}`);
  }
}

for (const field of ['repository', 'homepage', 'bugs', 'files', 'publishConfig']) {
  if (!(field in packageJson)) {
    issues.push(`package.json is missing \`${field}\``);
  }
}

if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
  issues.push('package.json `files` must be a non-empty array.');
}

if (!packageJson.bin?.ivn) {
  issues.push('package.json must expose the `ivn` binary.');
}

if (!packageJson.scripts?.prepack || !packageJson.scripts?.['release:check'] || !packageJson.scripts?.['smoke:install']) {
  issues.push('package.json must define `prepack`, `release:check`, and `smoke:install` scripts.');
}

const versionMatch = versionSource.match(/APP_VERSION\s*=\s*'([^']+)'/);
if (!versionMatch) {
  issues.push('src/version.ts must export APP_VERSION.');
} else if (versionMatch[1] !== packageJson.version) {
  issues.push(`package.json version (${packageJson.version}) must match src/version.ts APP_VERSION (${versionMatch[1]}).`);
}

if (issues.length > 0) {
  console.error('\nIVN release check failed:\n');
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  console.error();
  process.exit(1);
}

console.log('\nIVN release check passed.\n');
