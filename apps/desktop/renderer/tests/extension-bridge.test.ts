import assert from 'node:assert/strict';
import test from 'node:test';
import { bindSlotBridge, sendTheme, slotCommand } from '../src/extensions/slot-bridge';
import { ApiError } from '../src/api';

test('相同不透明来源的兄弟窗口与未知消息不能控制槽位', () => {
  const frame = {} as Window;
  const event = (source: Window | null, data: unknown) => ({ source, origin: 'null', data }) as MessageEvent;
  assert.equal(slotCommand(frame, event({} as Window, {type:'ext:dismiss'})), undefined);
  assert.equal(slotCommand(null, event(null, {type:'ext:ready'})), undefined);
  assert.equal(slotCommand(frame, event(frame, {type:'open'})), undefined);
  assert.equal(slotCommand(frame, event(frame, {type:'ext:resize', height:Infinity})), undefined);
  assert.deepEqual(slotCommand(frame, event(frame, {type:'ext:resize', height:1000})), {type:'ext:resize', height:640});
  assert.deepEqual(slotCommand(frame, event(frame, {type:'ext:ready'})), {type:'ext:ready'});
});

test('向所挂载的子窗下发当前预置计算出的语义令牌', t => {
  let color = 'white';
  const names = ['--nd-semantic-color-text', '--nd-primitive-color-ink', 'display'];
  const style = Object.assign(names, {getPropertyValue: () => color});
  const original = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'getComputedStyle', {configurable:true, value:() => style});
  t.after(() => original ? Object.defineProperty(globalThis, 'getComputedStyle', original) : Reflect.deleteProperty(globalThis, 'getComputedStyle'));
  const messages: unknown[] = [];
  const frame = {contentWindow:{postMessage:(...args: unknown[]) => messages.push(args)}} as unknown as HTMLIFrameElement;
  sendTheme(frame, 'daylight');
  color = 'black';
  sendTheme(frame, 'nightwave');
  assert.deepEqual(messages, ['daylight','nightwave'].map((preset, i) => [
    {type:'host:theme', preset, tokens:{'--nd-semantic-color-text':i ? 'black' : 'white'}}, '*'
  ]));
});

function actionFrame() {
  const parent = new EventTarget();
  const replies: unknown[] = [];
  const child = {postMessage: (value: unknown) => replies.push(value)};
  const element = Object.assign(new EventTarget(), {ownerDocument: {defaultView: parent}, isConnected: true, contentWindow: child});
  const emit = (source: object, changes: object = {}) => {
    const data = {type:'ext:action', id:'req-1', action:'count', payload:null, ...changes};
    parent.dispatchEvent(Object.assign(new Event('message'), {source, data}));
  };
  return {frame: element as unknown as HTMLIFrameElement, emit, child, replies};
}

test('双向动作绑定发送窗口和宿主版本，成功与错误各回包一次', async () => {
  const {frame, emit, child, replies} = actionFrame();
  const calls: unknown[] = [];
  const release = bindSlotBridge(frame, 'counter', 'v1', () => {}, async (path, options) => {
    calls.push([path, options]);
    if (calls.length > 1) throw new ApiError('未知动作', 404, 'EXTENSION_UI_ACTION_NOT_FOUND');
    return {data: 1};
  });
  const sibling = actionFrame();
  const cycle: unknown[] = [];
  cycle.push(cycle);
  emit(sibling.child);
  for (const payload of [cycle, new Map(), 1n, Infinity, {x:undefined}, () => {}, Symbol(), '界'.repeat(5461)]) emit(child, {payload});
  for (const changes of [{id:''}, {id:1}, {id:'a'.repeat(65)}, {action:'/v1/roles'}, {action:'a'.repeat(65)}]) emit(child, changes);
  assert.deepEqual(calls, []);
  emit(child, {extId:'other', version:'v2', payload:{delta:1}});
  emit(child, {action:'unknown', id:'req-2'});
  await Promise.resolve();
  assert.deepEqual(calls, [
    ['/v1/extensions/counter/ui-action', {method:'POST', body:{version:'v1', action:'count', payload:{delta:1}}}],
    ['/v1/extensions/counter/ui-action', {method:'POST', body:{version:'v1', action:'unknown', payload:null}}]
  ]);
  assert.deepEqual(replies, [
    {type:'host:action-result', id:'req-1', ok:true, data:1},
    {type:'host:action-result', id:'req-2', ok:false, error:'EXTENSION_UI_ACTION_NOT_FOUND'}
  ]);
  release();
});

test('卸载、换版和同一 contentWindow 再导航均丢弃迟到回包', async () => {
  for (const transition of ['unmount', 'upgrade', 'navigate']) {
    const {frame, emit, child, replies} = actionFrame();
    const pending = Promise.withResolvers<{data: unknown}>();
    let calls = 0;
    const release = bindSlotBridge(frame, 'counter', 'v1', () => {}, () => { calls++; return pending.promise; });
    emit(child);
    assert.equal(calls, 1);
    let releaseNext;
    if (transition === 'navigate') frame.dispatchEvent(new Event('load'));
    else {
      release();
      if (transition === 'upgrade') {
        releaseNext = bindSlotBridge(frame, 'counter', 'v2', () => {}, async () => ({data:'v2'}));
        emit(child);
      }
    }
    pending.resolve({data:'v1'});
    await Promise.resolve();
    assert.deepEqual(replies, transition === 'upgrade' ? [{type:'host:action-result', id:'req-1', ok:true, data:'v2'}] : []);
    releaseNext?.();
    release();
  }
});
