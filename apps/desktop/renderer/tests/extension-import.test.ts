import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api';
import { isCommandMcp, mcpSummary, skillIssue, parseMcpImport, personalArgument } from '../src/components/config/extension-import';

test('识别本地命令模式及 npm 脚本，工作空间模式不触发', () => {
  assert.equal(isCommandMcp({ command: 'node', args: ['--import', 'tsx', 'src/mcp/local-server.ts', '--mode', 'command'] }), true);
  assert.equal(isCommandMcp({ command: 'C:\\node\\npm.cmd', args: ['run', 'mcp:local:command'] }), true);
  assert.equal(isCommandMcp({ command: 'npm', args: ['--prefix', 'apps/backend', 'run', 'mcp:local', '--', '--mode', 'command'] }), true);
  assert.equal(isCommandMcp({ command: 'node', args: ['./local-server.js', '--mode', 'command'] }), true);
  for (const script of ['dist/mcp/local-server.js', 'C:\\app\\dist\\mcp\\local-server.js']) {
    assert.equal(isCommandMcp({ command: 'node', args: [script, '--mode', 'command'] }), true);
    assert.equal(isCommandMcp({ command: 'node', args: [script, '--mode', 'workspace'] }), false);
    assert.equal(isCommandMcp({ command: 'node', args: [script] }), false);
  }
  assert.equal(isCommandMcp({ command: 'node', args: ['dist/mcp/local-server.ts', '--mode', 'command'] }), false);
  assert.equal(isCommandMcp({ command: 'node', args: ['src/mcp/local-server.ts', '--mode', 'workspace'] }), false);
  assert.equal(isCommandMcp({ command: 'npm', args: ['run', 'mcp:local', '--', '--mode', 'workspace'] }), false);
  assert.equal(isCommandMcp({ command: 'node', args: ['third-party/local-server.js', '--mode', 'command'] }), false);
  assert.equal(isCommandMcp({ command: 'node', args: ['other-server.ts', '--mode', 'command'] }), false);
});

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

test('安全摘要仅列命令末级、参数数和待补键，不回显个人目录、参数或环境值', () => {
  for (const command of ['"C:\\Users\\owner\\my tools\\node.exe"', '/Users/owner/bin/node.exe', '\\\\share\\private\\node.exe']) {
    assert.equal(mcpSummary('摘录', command, ['--secret=private'], { TOKEN:'private', KEY:'', PATH_KEY:'${VALUE}' }),
      '摘录 · node.exe · 1 个参数 · 待补 KEY、PATH_KEY');
  }
});

test('扫描状态区分空目录、不可读取与导入时目录变更', () => {
  assert.equal(skillIssue(undefined), undefined);
  for (const [status, code, role] of [[400,'EMPTY','status'], [400,'UNREADABLE','alert'], [409,'CHANGED','alert']] as const) {
    assert.equal(skillIssue(new ApiError('', status, 'SKILL_DIRECTORY_' + code))?.role, role);
  }
  assert.equal(skillIssue(new ApiError('', 500, 'SKILL_DIRECTORY_EMPTY')), undefined);
});
