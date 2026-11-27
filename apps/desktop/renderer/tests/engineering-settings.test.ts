import assert from 'node:assert/strict';
import test from 'node:test';
import { isOrdinaryResource, memberInputs, memberStatus, moveMember, type EngineeringMember, type MemberSummary } from '../src/components/config/engineering-settings.ts';
import { mergeBindingDrafts } from '../src/components/model/binding-merge.ts';
import { createServer } from 'vite';
import { after } from 'node:test';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => vite.close());
const { ShellSetting } = await vite.ssrLoadModule('/src/components/config/ShellSetting.tsx');

const first: MemberSummary = { resourceId: 'a', modelName: 'shared', enabled: true, resourceName: '源 A', state: 'cooldown', retryAfterSeconds: 180 };
const second: MemberSummary = { ...first, resourceId: 'b', enabled: false, state: 'disabled', retryAfterSeconds: null };

test('工程排序保留独立服务和启停状态，提交字段只包含有序成员', () => {
  const members = [first, second];
  const moved = moveMember(members, 1, -1);
  assert.deepEqual(moved, [
    { resourceId: 'b', modelName: 'shared', enabled: false },
    { resourceId: 'a', modelName: 'shared', enabled: true },
  ]);
  assert.deepEqual(moveMember(moved, 0, 1), memberInputs(members));
  assert.equal(members[0], first);
});

test('工程成员可选模型参数在排序与提交字段中保留', () => {
  const members: EngineeringMember[] = [
    { resourceId: 'a', modelName: 'shared', enabled: true, maxTokens: 32768, thinkingLevel: 'medium' },
    { resourceId: 'b', modelName: 'shared', enabled: false, contextWindow: 200000 },
  ];
  assert.deepEqual(memberInputs(members), [
    { resourceId: 'a', modelName: 'shared', enabled: true, maxTokens: 32768, thinkingLevel: 'medium' },
    { resourceId: 'b', modelName: 'shared', enabled: false, contextWindow: 200000 },
  ]);
  assert.deepEqual(moveMember(members, 1, -1), [
    { resourceId: 'b', modelName: 'shared', enabled: false, contextWindow: 200000 },
    { resourceId: 'a', modelName: 'shared', enabled: true, maxTokens: 32768, thinkingLevel: 'medium' },
  ]);
  assert.deepEqual(memberInputs([{ resourceId: 'c', modelName: 'plain', enabled: true }]),
    [{ resourceId: 'c', modelName: 'plain', enabled: true }]);
});

test('本地冷却倒计时归零后等待服务报告恢复', () => {
  assert.equal(memberStatus(first, 179), '冷却中 · 1 秒');
  assert.equal(memberStatus(first, 200), '等待刷新');
  assert.equal(memberStatus(second, 0), '已停用');
  assert.equal(memberStatus({ ...first, state: 'maintenance' }, 300), '维护中');
});

test('普通扩展入口识别两种内置工程标记，保留普通 MCP 和同名外部服务', () => {
  const base = { kind: 'mcp', config: { command: 'node' } };
  assert.equal(isOrdinaryResource(base), true);
  assert.equal(isOrdinaryResource({ ...base, adminSeatOnly: true }), false);
  assert.equal(isOrdinaryResource({ ...base, config: { command: 'nowadays-pi' } }), false);
});

test('普通 MCP 保存发生修订冲突时沿用服务端的隐藏工程绑定，包含显式解绑', () => {
  const pi = { capability: 'mcp', resourceId: 'pi', enabled: true };
  const ordinary = { capability: 'mcp', resourceId: 'ordinary', enabled: true };
  for (const latest of [[pi], [{ ...pi, enabled: false }], []]) {
    const result = mergeBindingDrafts({ scope: 'ext', base: [pi], draft: [pi, ordinary], latest });
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.items, [...latest, ordinary]);
  }
});

test('工程 Shell 默认关闭，说明风险并仅提交修改字段', () => {
  const patches: unknown[] = [];
  const section = ShellSetting({ disabled: false, save: (patch: unknown) => patches.push(patch) });
  const [toggle, caption] = section.props.children;
  assert.equal(toggle.props.checked, false);
  assert.equal(toggle.props.label, '允许 Pi 使用完整本机 Shell（高风险）');
  assert.match(caption.props.children, /草稿目录.*draft_test/);
  assert.match(caption.props.children, /当前账户权限.*访问个人文件、修改文件与运行系统命令/);
  assert.match(caption.props.children, /仅影响新工程/);
  toggle.props.onCheckedChange(true);
  assert.deepEqual(patches, [{ allowShell: true }]);
  const saved = ShellSetting({ allowShell: true, disabled: false, save: (patch: unknown) => patches.push(patch) });
  const [savedToggle] = saved.props.children;
  assert.equal(savedToggle.props.checked, true);
  savedToggle.props.onCheckedChange(false);
  assert.deepEqual(patches, [{ allowShell: true }, { allowShell: false }]);
});
