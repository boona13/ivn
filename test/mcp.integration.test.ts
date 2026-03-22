import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { IvnStore } from '../src/store.js';
import { CLI_ENTRY, TSX_BIN, withTempProject } from './test-helpers.js';

function testEnv(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    IVN_DISABLE_ML_IMPORTS: '1',
  };
}

test('MCP stdio server returns structured tool results and live resources', async () => {
  await withTempProject(async (root) => {
    IvnStore.init(root);
    mkdirSync(join(root, 'src', 'auth'), { recursive: true });
    writeFileSync(join(root, 'src', 'auth', 'session.ts'), 'export const rotateSession = true;\n');

    const store = IvnStore.open(root);
    store.remember('Use the repository layer for auth writes.', {
      type: 'pattern',
      fileRefs: ['src/auth/session.ts'],
    });
    store.remember('Imported git note waiting for review.', {
      type: 'context',
      source: 'git:abc1234',
      sourceKind: 'git',
    });
    store.close();

    const transport = new StdioClientTransport({
      command: TSX_BIN,
      args: [CLI_ENTRY, 'serve'],
      cwd: root,
      env: testEnv(),
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'ivn-test-client', version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      assert.equal(tools.tools.some((tool) => tool.name === 'ivn_remember'), true);
      assert.equal(tools.tools.some((tool) => tool.name === 'ivn_recall'), true);

      const resources = await client.listResources();
      assert.equal(resources.resources.some((resource) => resource.uri === 'ivn://review/pending'), true);

      const rememberResult = await client.callTool({
        name: 'ivn_remember',
        arguments: {
          content: 'MCP round-trip knowledge about auth session rotation.',
          type: 'context',
          tags: ['mcp', 'auth'],
        },
      });
      assert.equal(rememberResult.isError, undefined);
      assert.equal(typeof rememberResult.structuredContent, 'object');
      assert.match(JSON.stringify(rememberResult.structuredContent), /New knowledge stored|Skipped duplicate/);

      const recallResult = await client.callTool({
        name: 'ivn_recall',
        arguments: {
          query: 'MCP round-trip knowledge',
          review_status: 'all',
        },
      });
      assert.equal(typeof recallResult.structuredContent, 'object');
      assert.match(JSON.stringify(recallResult.structuredContent), /MCP round-trip knowledge/);

      const pendingResource = await client.readResource({ uri: 'ivn://review/pending' });
      const pendingText = 'text' in pendingResource.contents[0]! ? pendingResource.contents[0].text : '';
      assert.match(pendingText, /Pending Knowledge Review/);
      assert.match(pendingText, /Imported git note waiting for review/);
      assert.match(pendingText, /MCP round-trip knowledge/);
    } finally {
      await client.close();
    }
  });
});
