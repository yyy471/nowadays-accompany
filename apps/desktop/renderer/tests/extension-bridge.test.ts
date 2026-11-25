import assert from 'node:assert/strict';
import test from 'node:test';
import { sendTheme, slotCommand } from '../src/extensions/slot-bridge';

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
