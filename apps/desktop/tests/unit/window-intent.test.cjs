'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindowIntent } = require('../../electron/window-intent.cjs');

test('关窗与退出共用请求号，过期、重复与无效决定均不生效', () => {
  const sent = [], committed = [];
  const guard = createWindowIntent({ send: (...args) => sent.push(args), commit: a => committed.push(a) });
  guard.request('hide');
  guard.request('quit');
  guard.reply(0, true);
  guard.reply(1, 'yes');
  assert.deepEqual(sent, [['request', { id: 1, action: 'hide' }]]);
  guard.reply(1, false);
  guard.request('quit');
  guard.reply(1, true);
  guard.reply(2, true);
  guard.reply(2, true);
  assert.deepEqual(committed, ['quit']);
});

test('心跳延长阅读时间，失联后原生确认独占回执', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let revealed = 0, decide;
  const sent = [], committed = [];
  const guard = createWindowIntent({
    timeout: 100, send: (...args) => sent.push(args), reveal: () => revealed++,
    fallback: () => new Promise(resolve => { decide = resolve; }), commit: a => committed.push(a)
  });
  guard.request('quit');
  t.mock.timers.tick(90);
  guard.waiting(1);
  t.mock.timers.tick(90);
  assert.equal(decide, undefined);
  guard.waiting(1);
  assert.equal(revealed, 1);
  t.mock.timers.tick(101);
  assert.deepEqual(sent.at(-1), ['cancel', 1]);
  guard.reply(1, true);
  guard.request('quit');
  assert.deepEqual(committed, []);
  decide(true);
  await Promise.resolve();
  assert.deepEqual(committed, ['quit']);
});
