import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importFromGit } from '../src/git.js';
import { exportKnowledge, mergeKnowledgePack, syncKnowledgePack, syncRules } from '../src/share.js';
import { IVN_KNOWLEDGE_SPEC_VERSION } from '../src/spec.js';
import { IvnStore } from '../src/store.js';
import { validateJsonFile } from '../src/validate.js';
import {
  CLI_ENTRY,
  FIXTURES_ROOT,
  REPO_ROOT,
  runCli,
  runGit,
  withTempProject,
} from './test-helpers.js';

test('private knowledge is excluded from shared exports by default', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('Shared architectural truth.', { visibility: 'shared' });
    store.remember('Personal scratch note.', { visibility: 'private' });

    const result = exportKnowledge(store, { format: 'json', outDir: root });
    store.close();

    const exported = JSON.parse(readFileSync(result.jsonPath!, 'utf8')) as {
      entries: Array<{ content: string; visibility: string }>;
    };

    assert.equal(exported.entries.length, 1);
    assert.equal(exported.entries[0]?.content, 'Shared architectural truth.');
    assert.equal(exported.entries[0]?.visibility, 'shared');
  });
});

test('exports and pack manifests include stable spec metadata', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('Shared architectural truth.', { visibility: 'shared' });

    const exportResult = exportKnowledge(store, { format: 'json', outDir: root });
    const packResult = syncKnowledgePack(store);
    store.close();

    const exported = JSON.parse(readFileSync(exportResult.jsonPath!, 'utf8')) as {
      spec: string;
      spec_version: string;
    };
    assert.equal(exported.spec, 'ivn-knowledge-export');
    assert.equal(exported.spec_version, IVN_KNOWLEDGE_SPEC_VERSION);

    const manifest = JSON.parse(readFileSync(packResult.manifestPath, 'utf8')) as {
      spec: string;
      spec_version: string;
    };
    assert.equal(manifest.spec, 'ivn-knowledge-pack-manifest');
    assert.equal(manifest.spec_version, IVN_KNOWLEDGE_SPEC_VERSION);
  });
});

test('pack sync writes a tracked manifest and pack files', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('Shared architectural truth.', { visibility: 'shared' });
    store.remember('Private scratch note.', { visibility: 'private' });

    const result = syncKnowledgePack(store);
    store.close();

    assert.equal(existsSync(result.manifestPath), true);
    assert.equal(existsSync(result.jsonPath!), true);
    assert.equal(existsSync(result.mdPath!), true);

    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
      count: number;
      visibility: string;
      files: { json?: string; markdown?: string };
    };
    assert.equal(manifest.count, 1);
    assert.equal(manifest.visibility, 'shared');
    assert.equal(manifest.files.json, 'knowledge-pack.json');
    assert.equal(manifest.files.markdown, 'KNOWLEDGE.md');
  });
});

test('pack merge imports from a pack directory and deduplicates on repeat', () => {
  withTempProject((sourceRoot) => {
    IvnStore.init(sourceRoot);
    const sourceStore = IvnStore.open(sourceRoot);
    sourceStore.remember('We decided to ship reviewed memory as a tracked pack.');
    const synced = syncKnowledgePack(sourceStore);
    sourceStore.close();

    withTempProject((targetRoot) => {
      IvnStore.init(targetRoot);
      const targetStore = IvnStore.open(targetRoot);

      const first = mergeKnowledgePack(targetStore, synced.packDir);
      assert.equal(first.imported, 1);
      assert.equal(first.duplicates, 0);

      const second = mergeKnowledgePack(targetStore, synced.manifestPath);
      assert.equal(second.imported, 0);
      assert.equal(second.duplicates, 1);
      assert.equal(targetStore.recall('tracked pack').length, 1);

      targetStore.close();
    });
  });
});

test('spec CLI can emit metadata and export schema files', () => {
  withTempProject((root) => {
    const jsonOutput = runCli(REPO_ROOT, ['spec', '--json']);
    const parsed = JSON.parse(jsonOutput) as {
      version: string;
      export_schema_path: string;
      pack_manifest_schema_path: string;
      service_openapi_path: string;
      spec_doc_path: string;
    };
    assert.equal(parsed.version, IVN_KNOWLEDGE_SPEC_VERSION);
    assert.equal(existsSync(parsed.export_schema_path), true);
    assert.equal(existsSync(parsed.pack_manifest_schema_path), true);
    assert.equal(existsSync(parsed.service_openapi_path), true);
    assert.equal(existsSync(parsed.spec_doc_path), true);

    const outDir = join(root, 'schemas');
    runCli(REPO_ROOT, ['spec', '--out', outDir]);

    assert.equal(existsSync(join(outDir, 'ivn-export.schema.json')), true);
    assert.equal(existsSync(join(outDir, 'ivn-pack-manifest.schema.json')), true);
    assert.equal(existsSync(join(outDir, 'ivn-service.openapi.json')), true);
    assert.equal(existsSync(join(outDir, 'SPEC.md')), true);
  });
});

test('distribution scaffolding is publish-ready and release check passes', () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    files?: string[];
    repository?: { url?: string };
    homepage?: string;
    bugs?: { url?: string };
    publishConfig?: { access?: string };
    scripts?: Record<string, string>;
  };

  assert.deepEqual(packageJson.files, ['dist', 'examples', 'spec', 'README.md', 'LICENSE']);
  assert.equal(packageJson.repository?.url, 'git+https://github.com/boona13/ivn.git');
  assert.equal(packageJson.homepage, 'https://github.com/boona13/ivn#readme');
  assert.equal(packageJson.bugs?.url, 'https://github.com/boona13/ivn/issues');
  assert.equal(packageJson.publishConfig?.access, 'public');
  assert.equal(packageJson.scripts?.['release:check'], 'node scripts/release-check.mjs');
  assert.equal(packageJson.scripts?.['pack:dry-run'], 'npm pack --dry-run');
  assert.equal(packageJson.scripts?.lint, 'biome lint --diagnostic-level=error src test scripts package.json tsconfig.json tsconfig.test.json biome.json');
  assert.equal(packageJson.scripts?.typecheck, 'tsc --noEmit -p tsconfig.test.json');
  assert.equal(packageJson.scripts?.check, 'npm run lint && npm run typecheck && npm test');
  assert.match(packageJson.scripts?.prepack || '', /npm run build && npm run release:check/);

  assert.equal(existsSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml')), true);
  assert.equal(existsSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml')), true);
  assert.equal(existsSync(join(REPO_ROOT, 'examples', 'README.md')), true);
  assert.equal(existsSync(join(REPO_ROOT, 'examples', 'cursor-mcp.json')), true);
  assert.equal(existsSync(join(REPO_ROOT, 'examples', 'http-ingest.mjs')), true);
  assert.equal(existsSync(join(REPO_ROOT, 'LICENSE')), true);

  execFileSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
  });

  const output = execFileSync('node', [join(REPO_ROOT, 'scripts', 'release-check.mjs')], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
  });
  assert.match(output, /IVN release check passed/);
});

test('init CLI can list built-in templates without creating project state', () => {
  withTempProject((root) => {
    const output = runCli(root, ['init', '--list-templates']);
    assert.match(output, /Built-in IVN templates/);
    assert.match(output, /nextjs/);
    assert.match(output, /express/);
    assert.match(output, /django/);
    assert.equal(existsSync(join(root, '.ivn')), false);
  });
});

test('init CLI can seed starter knowledge from a built-in template', () => {
  withTempProject((root) => {
    const projectRoot = join(root, 'next-app');
    mkdirSync(projectRoot, { recursive: true });

    const output = runCli(REPO_ROOT, ['init', projectRoot, '--template', 'nextjs']);
    assert.match(output, /Template:/);
    assert.match(output, /Next\.js App/);

    const store = IvnStore.open(projectRoot);
    const seeded = store.list({ limit: 20, reviewStatus: 'all', visibility: 'all' });
    store.close();

    assert.equal(seeded.length >= 5, true);
    assert.equal(seeded.some((entry) => entry.source === 'template:nextjs'), true);
    assert.equal(seeded.some((entry) => entry.tags.includes('nextjs')), true);
    assert.equal(seeded.every((entry) => entry.review_status === 'active'), true);
  });
});

test('generated exports and manifests validate against the compatibility contract', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    const store = IvnStore.open(root);
    store.remember('We decided the compatibility suite should validate exported artifacts.');

    const exported = exportKnowledge(store, { format: 'json', outDir: root });
    const pack = syncKnowledgePack(store);
    store.close();

    const exportReport = validateJsonFile(exported.jsonPath!);
    const manifestReport = validateJsonFile(pack.manifestPath);

    assert.equal(exportReport.status, 'valid');
    assert.equal(exportReport.kind, 'export');
    assert.equal(manifestReport.status, 'valid');
    assert.equal(manifestReport.kind, 'pack-manifest');
  });
});

test('adapter golden fixtures stay stable for generic and cursor outputs', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    mkdirSync(join(root, '.cursor'), { recursive: true });

    const store = IvnStore.open(root);
    store.remember('The compatibility suite keeps adapters honest.', { type: 'context' });
    store.remember('We decided every exported rule file should be fixture-tested.', { type: 'decision' });
    store.remember('We use adapter registries instead of monolithic sync files.', { type: 'pattern' });
    store.remember('Watch out: managed markdown blocks must preserve user-written content.', { type: 'gotcha' });
    store.remember('This depends on stable spec versions and deterministic markdown output.', { type: 'dependency' });
    store.remember('Add more fixture projects for future adapters.', { type: 'todo' });
    syncRules(store, { targets: ['generic', 'cursor'] });
    store.close();

    const expectedGeneric = readFileSync(join(FIXTURES_ROOT, 'golden', 'KNOWLEDGE.md'), 'utf8').trimEnd();
    const expectedCursor = readFileSync(join(FIXTURES_ROOT, 'golden', 'ivn-knowledge.mdc'), 'utf8').trimEnd();
    const actualGeneric = readFileSync(join(root, 'KNOWLEDGE.md'), 'utf8').trimEnd();
    const actualCursor = readFileSync(join(root, '.cursor', 'rules', 'ivn-knowledge.mdc'), 'utf8').trimEnd();

    assert.equal(actualGeneric, expectedGeneric);
    assert.equal(actualCursor, expectedCursor);
  });
});

test('validate CLI reports invalid compatibility artifacts with non-zero exit', () => {
  const invalidFixture = join(FIXTURES_ROOT, 'invalid-export.json');

  try {
    runCli(REPO_ROOT, ['validate', invalidFixture]);
    assert.fail('expected validate command to fail for invalid fixture');
  } catch (err: unknown) {
    const failure = err as { status?: number; stdout?: string };
    assert.equal(failure.status, 1);
    assert.match(failure.stdout || '', /Status: invalid/);
    assert.match(failure.stdout || '', /Unsupported IVN knowledge spec version 2.0.0/);
    assert.match(failure.stdout || '', /\$\.edges: Expected an array\./);
  }
});

test('syncRules auto-detects installed adapters and always writes generic knowledge', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '# Existing Claude Notes\n');

    const store = IvnStore.open(root);
    store.remember('We decided project memory should sync into every active AI tool.');
    const result = syncRules(store);
    store.close();

    assert.deepEqual(
      result.files.map((file) => file.target),
      ['Cursor', 'Claude Code', 'Generic (KNOWLEDGE.md)'],
    );
    assert.equal(existsSync(join(root, '.cursor', 'rules', 'ivn-knowledge.mdc')), true);
    assert.equal(existsSync(join(root, 'CLAUDE.md')), true);
    assert.equal(existsSync(join(root, 'KNOWLEDGE.md')), true);
  });
});

test('syncRules generates scoped Cursor rules from custom tag_globs in config', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    mkdirSync(join(root, '.cursor'), { recursive: true });

    const config = JSON.parse(readFileSync(join(root, '.ivn', 'config.json'), 'utf8'));
    config.tag_globs = {
      payments: { globs: ['src/payments/**', 'src/checkout/**'], title: 'Payments Domain' },
    };
    writeFileSync(join(root, '.ivn', 'config.json'), JSON.stringify(config, null, 2));

    const store = IvnStore.open(root);
    store.remember('Stripe webhook signature must be verified before parsing the body.', {
      type: 'gotcha',
      tags: ['payments'],
    });
    syncRules(store, { targets: ['cursor'] });
    store.close();

    const scopedPath = join(root, '.cursor', 'rules', 'ivn-payments.mdc');
    assert.equal(existsSync(scopedPath), true, 'Custom tag should produce scoped rule file');

    const content = readFileSync(scopedPath, 'utf8');
    assert.match(content, /src\/payments\/\*\*/);
    assert.match(content, /src\/checkout\/\*\*/);
    assert.match(content, /Payments Domain/);
    assert.match(content, /Stripe webhook signature/);
  });
});

test('syncRules treats prototype-like tags as plain data instead of crashing', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    mkdirSync(join(root, '.cursor'), { recursive: true });

    const store = IvnStore.open(root);
    store.remember('Wildcard router handling must avoid JavaScript prototype keys.', {
      type: 'gotcha',
      tags: ['constructor', 'prototype'],
    });
    syncRules(store, { targets: ['cursor'] });
    store.close();

    assert.equal(existsSync(join(root, '.cursor', 'rules', 'ivn-knowledge.mdc')), true);
  });
});

test('syncRules keeps older file-scoped knowledge beyond the first hundred entries', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    mkdirSync(join(root, '.cursor'), { recursive: true });

    const store = IvnStore.open(root);
    for (let index = 0; index < 105; index++) {
      store.remember(`AWS Lambda adapter lesson ${index}: preserve encoded query state.`, {
        type: 'debug',
        tags: ['benchmark'],
        fileRefs: ['src/adapter/aws-lambda/handler.ts'],
      });
    }
    syncRules(store, { targets: ['cursor'] });
    store.close();

    const scopedPath = join(root, '.cursor', 'rules', 'ivn-file-src-adapter-aws-lambda.mdc');
    assert.equal(existsSync(scopedPath), true);

    const content = readFileSync(scopedPath, 'utf8');
    assert.match(content, /AWS Lambda adapter lesson 0/);
    assert.match(content, /AWS Lambda adapter lesson 104/);
  });
});

test('syncRules includes capture reminder in global rule output', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    mkdirSync(join(root, '.cursor'), { recursive: true });

    const store = IvnStore.open(root);
    store.remember('Always validate with Zod.', { type: 'pattern' });
    syncRules(store, { targets: ['cursor'] });
    store.close();

    const globalPath = join(root, '.cursor', 'rules', 'ivn-knowledge.mdc');
    const content = readFileSync(globalPath, 'utf8');
    assert.match(content, /Capture New Knowledge/);
    assert.match(content, /ivn remember/);
    assert.match(content, /decision.*pattern.*gotcha.*debug.*dependency.*todo/i);
  });
});

test('syncRules includes domain-specific capture hint in scoped Cursor rules', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    mkdirSync(join(root, '.cursor'), { recursive: true });

    const store = IvnStore.open(root);
    store.remember('Stripe webhooks MUST use Node.js runtime, not Edge.', {
      type: 'gotcha',
      tags: ['billing'],
    });
    syncRules(store, { targets: ['cursor'] });
    store.close();

    const scopedPath = join(root, '.cursor', 'rules', 'ivn-billing.mdc');
    assert.equal(existsSync(scopedPath), true);

    const content = readFileSync(scopedPath, 'utf8');
    assert.match(content, /ivn remember.*--tags billing/);
  });
});

test('git-import stores changed files as file refs for imported commits', async () => {
  await withTempProject(async (root) => {
    mkdirSync(join(root, 'src', 'auth'), { recursive: true });
    writeFileSync(join(root, 'src', 'auth', 'session.ts'), 'export const SESSION_TTL = 86400;\n');

    runGit(root, ['init']);
    runGit(root, ['add', '.']);
    execFileSync(
      'git',
      ['-c', 'user.name=IVN Test', '-c', 'user.email=ivn@example.com', 'commit', '-m', 'feat(auth): add session ttl'],
      {
        cwd: root,
        env: process.env,
        encoding: 'utf8',
      },
    );

    IvnStore.init(root);
    const store = IvnStore.open(root);
    const result = await importFromGit(store, { last: 1 });
    store.close();

    assert.equal(result.imported, 1);
    assert.deepEqual(result.entries[0]?.entry.file_refs, ['src/auth/session.ts']);
  });
});

test('syncRules includes capture reminder in generic KNOWLEDGE.md', () => {
  withTempProject((root) => {
    IvnStore.init(root);

    const store = IvnStore.open(root);
    store.remember('Use repository layer for all DB access.', { type: 'pattern' });
    syncRules(store, { targets: ['generic'] });
    store.close();

    const content = readFileSync(join(root, 'KNOWLEDGE.md'), 'utf8');
    assert.match(content, /Capture New Knowledge/);
    assert.match(content, /ivn remember/);
  });
});

test('syncRules preserves manual content while replacing managed markdown blocks', () => {
  withTempProject((root) => {
    IvnStore.init(root);
    writeFileSync(
      join(root, 'CLAUDE.md'),
      [
        '# Team Playbook',
        '',
        'Keep this intro.',
        '',
        '<!-- IVN:START -->',
        'stale knowledge block',
        '<!-- IVN:END -->',
        '',
      ].join('\n'),
    );

    const store = IvnStore.open(root);
    store.remember('We decided every auth change must update IVN rules.');
    syncRules(store, { targets: ['claude-code'] });
    syncRules(store, { targets: ['claude-code'] });
    store.close();

    const content = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    assert.match(content, /# Team Playbook/);
    assert.match(content, /Keep this intro\./);
    assert.match(content, /## Architectural Decisions/);
    assert.doesNotMatch(content, /stale knowledge block/);
    assert.equal((content.match(/<!-- IVN:START -->/g) || []).length, 1);
    assert.equal((content.match(/<!-- IVN:END -->/g) || []).length, 1);
  });
});
