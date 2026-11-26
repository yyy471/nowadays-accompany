import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpImport, personalArgument } from '../src/components/config/extension-import';

test('原样保留 MCP 参数中的空格、空串和次序，列出配置里的各个本地服务', () => {
  const servers = parseMcpImport(JSON.stringify({ mcpServers: {
    search: { command: 'node', args: ['C:\\my tools\\search.js', '', '--limit=4'], env: { KEY: 'example' } },
    wiki: { type: 'stdio', command: 'npx' },
  } }));
  assert.deepEqual(servers.map(item => item.name), ['search', 'wiki']);
  assert.deepEqual(servers[0]!.args, ['C:\\my tools\\search.js', '', '--limit=4']);
  assert.deepEqual(servers[1]!.env, {});
  assert.ok(personalArgument(servers[0]!.args[0]!));
  assert.equal(personalArgument('@example/search'), false);
  assert.throws(() => parseMcpImport('{"url":"https://example.com"}'), /远程/);
  assert.throws(() => parseMcpImport('{"command":"node","cwd":"tmp"}'), /cwd/);
});
