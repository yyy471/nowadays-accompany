import test from 'node:test';
import assert from 'node:assert/strict';
import { isFirstActivation, wakeText } from '../src/feed/wake-label';

test('首次活动用固定说明替换内部意图', () => {
  const wake = { wakeId: 'first-activation:role-a', intent: '只有确实想主动分享才用 autonomy_share。' };
  assert.equal(isFirstActivation(wake), true);
  assert.equal(wakeText(wake), '从这时起开始记录活动。');
});

test('普通安排只按标识判断，原样保留与系统意图相同的文字', () => {
  const wake = { wakeId: 'wake:first-activation:role-a', intent: '你第一次开始活动，使用 autonomy_share。' };
  assert.equal(isFirstActivation(wake), false);
  assert.equal(wakeText(wake), wake.intent);
});
