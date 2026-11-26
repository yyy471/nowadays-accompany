import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveCoplayShare, receiveShare, type ShareNotice } from '../src/conversation/share-notice.ts';

const share: ShareNotice = {source: 'autonomy_share', roleId: 'seat', windowId: 'main', messageId: 'm1', summary: '分享'};

test('只接收主角色主窗口正式分享，关闭或重连后按消息号去重', () => {
  const seen = new Set<string>();
  for (const event of [{...share, source: 'task_circuit_breaker'}, {...share, roleId: 'other'}, {...share, windowId: 'custom'}]) {
    assert.equal(receiveShare(event as ShareNotice, 'seat', 'main', null, seen), null);
  }
  assert.equal(receiveShare(share, 'seat', 'main', 'custom', seen), share);
  assert.equal(receiveShare(share, 'seat', 'main', null, seen), null);
});

test('在主窗口收到的消息在离开并重连后也不弹卡', () => {
  const seen = new Set<string>();
  assert.equal(receiveShare(share, 'seat', 'main', 'main', seen), null);
  assert.equal(receiveShare(share, 'seat', 'main', null, seen), null);
});

test('角色列表就绪前收下普通角色共玩分享，重连回放只追加新消息', () => {
  const first = { ...share, roleId: 'ordinary', windowId: 'other-main' };
  const second = { ...first, messageId: 'm2' };
  const seen = new Set<string>();
  const pending = [first, first, second].map(event => receiveCoplayShare(event, null, seen)).filter(Boolean);
  assert.deepEqual(pending, [first, second]);
});
