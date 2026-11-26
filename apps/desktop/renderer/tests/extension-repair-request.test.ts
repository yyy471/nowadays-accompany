import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepairSender, hasExtensionFault, repairMessage } from '../src/extensions/repair-request';

const item = { extId: 'labels', version: 'v1', status: 'enabled', lastError: null };
const seat = { roleId: 'main', defaultWindowId: 'home', status: 'ready', displayName: '主角色', initError: null };

test('修复入口只依据故障快照，忽略开关请求的临时错误', () => {
  const toggleFailure = { ...item, error: '暂时无法停用此扩展。' };
  assert.equal(hasExtensionFault(toggleFailure), false);
  assert.equal(hasExtensionFault({ ...item, status: 'failed' }), true);
  assert.equal(hasExtensionFault({ ...item, lastError: { message: '升级失败' } }), true);
});

test('求助只带安装快照四项，错误省略堆栈并兼容缺失的错误码或诊断', () => {
  const prefix = ['请排查并修复这个扩展。', 'extId：labels', 'version：v1', 'status：enabled'].join('\n');
  const error = { code: 'EXTENSION_LOAD_FAILED', message: '升级失败\n    at activate()' };
  const label = '最近错误（扩展原始诊断文本）：';
  assert.equal(repairMessage({ ...item, lastError: error }), prefix + '\n' + label + 'EXTENSION_LOAD_FAILED · 升级失败');
  assert.equal(repairMessage({ ...item, lastError: { message: '错'.repeat(300) } }), prefix + '\n' + label + '错'.repeat(240));
  assert.equal(repairMessage({ ...item, status: 'failed' }).split('\n').at(-1), label + '暂无错误摘要');
});

test('未就绪时留页提示，回执丢失后手动重试使用原提交，成功只返回行内提示', async t => {
  const submissions: string[] = [];
  const post = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/v1/roles/main/windows/home/messages');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(String(init.body));
    assert.equal(body.content, repairMessage(item));
    assert.ok(body.submissionId);
    submissions.push(body.submissionId);
    if (submissions.length === 1) throw new TypeError('回执丢失');
    return Response.json({ duplicate: true });
  });
  const { send } = createRepairSender();
  assert.deepEqual(await send(undefined, item), { sent: false, notice: '主角色尚未就绪' });
  assert.equal(post.mock.callCount(), 0);
  assert.deepEqual(await send(seat, item), { sent: false, notice: '暂未确认送达，请重试' });
  assert.deepEqual(await send(seat, item), { sent: true, notice: '已交给主角色排查' });
  assert.deepEqual(submissions, [submissions[0], submissions[0]]);
});

test('同一窗口和扩展只重试当前完整故障，恢复、换版和移除均清理旧提交', async t => {
  const ids: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_: string, init: RequestInit) => {
    ids.push(JSON.parse(String(init.body)).submissionId);
    throw new TypeError('回执丢失');
  });
  const { send, reconcile } = createRepairSender();
  const a = { ...item, lastError: { code: 'LOAD', message: '失败\n堆栈 A' } };
  const b = { ...a, lastError: { ...a.lastError, message: '失败\n堆栈 B' } };
  assert.equal(repairMessage(a), repairMessage(b));
  await send(seat, a);
  reconcile([a]);
  await send(seat, a);
  assert.equal(ids[0], ids[1]);
  await send(seat, b);
  await send(seat, a);
  for (const snapshot of [[item], [{ ...a, version: 'v2' }], []]) {
    reconcile(snapshot);
    await send(seat, a);
  }
  assert.equal(new Set(ids.slice(1)).size, ids.length - 1);
});
