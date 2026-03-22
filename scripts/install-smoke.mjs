import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(command, args, cwd, extraEnv = {}) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

function runGit(cwd, args) {
  run('git', args, cwd);
}

function resolveTarballPath() {
  const explicit = process.argv[2];
  if (explicit) {
    const explicitPath = resolve(ROOT, explicit);
    if (existsSync(explicitPath) && statSync(explicitPath).isDirectory()) {
      const tarballs = readdirSync(explicitPath).filter((file) => file.endsWith('.tgz')).sort();
      if (tarballs.length === 1) {
        return join(explicitPath, tarballs[0]);
      }
      throw new Error(`Expected exactly one tarball in ${explicitPath}, found ${tarballs.length}.`);
    }
    return explicitPath;
  }

  const previewPath = join(ROOT, 'pack-preview.json');
  if (existsSync(previewPath)) {
    try {
      const preview = JSON.parse(readFileSync(previewPath, 'utf8'));
      const first = Array.isArray(preview) ? preview[0] : null;
      if (first?.filename) {
        return resolve(ROOT, first.filename);
      }
    } catch {
      // Fall through to local tarball discovery when the preview file is unavailable or malformed.
    }
  }

  const tarballs = readdirSync(ROOT).filter((file) => file.endsWith('.tgz')).sort();
  if (tarballs.length === 1) {
    return join(ROOT, tarballs[0]);
  }

  throw new Error('Could not resolve package tarball. Pass the tarball path explicitly or generate pack-preview.json first.');
}

function assertStatusOutput(output) {
  if (!/Total entries:\s+2/.test(output)) {
    throw new Error(`Smoke install failed: expected two stored entries after git import.\n\n${output}`);
  }
}

const tarballPath = resolveTarballPath();
const workspace = mkdtempSync(join(tmpdir(), 'ivn-install-smoke-'));
const consumerRoot = join(workspace, 'consumer');
const projectRoot = join(consumerRoot, 'smoke-project');

try {
  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'ivn-install-smoke',
    private: true,
    version: '0.0.0',
  }, null, 2));

  run(npmCmd, ['install', '--no-package-lock', tarballPath], consumerRoot);

  mkdirSync(projectRoot, { recursive: true });
  run(npxCmd, ['--no-install', 'ivn', 'init'], projectRoot);
  runGit(projectRoot, ['init']);
  mkdirSync(join(projectRoot, 'src', 'auth'), { recursive: true });
  writeFileSync(join(projectRoot, 'src', 'auth', 'session.ts'), 'export const SESSION_TTL = 86400;\n');
  runGit(projectRoot, ['add', '.']);
  runGit(projectRoot, [
    '-c', 'user.name=IVN Smoke',
    '-c', 'user.email=smoke@example.com',
    'commit',
    '-m',
    'feat(auth): add session ttl',
    '-m',
    'Keep session handling centralized for packaged install smoke coverage.',
  ]);
  run(npxCmd, ['--no-install', 'ivn', 'remember', 'Smoke install check for packaged IVN.', '--type', 'context'], projectRoot);
  run(npxCmd, ['--no-install', 'ivn', 'git-import', '--last', '1'], projectRoot);
  run(npxCmd, ['--no-install', 'ivn', 'accept', '--all', '--force'], projectRoot);
  run(npxCmd, ['--no-install', 'ivn', 'sync-rules', '--target', 'generic'], projectRoot);

  const statusOutput = execFileSync(npxCmd, ['--no-install', 'ivn', 'status'], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
  });
  assertStatusOutput(statusOutput);
  const knowledgePath = join(projectRoot, 'KNOWLEDGE.md');
  if (!existsSync(knowledgePath)) {
    throw new Error('Smoke install failed: expected KNOWLEDGE.md after sync-rules.');
  }
  const knowledgeFile = readFileSync(knowledgePath, 'utf8');
  if (!/feat\(auth\): add session ttl/i.test(knowledgeFile)) {
    throw new Error(`Smoke install failed: expected imported git knowledge in KNOWLEDGE.md.\n\n${knowledgeFile}`);
  }

  console.log(`\nIVN install smoke passed for ${tarballPath}\n`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
