import { test } from "node:test";
import assert from "node:assert/strict";
import * as typingStateModule from "../src/conversation/typing-state.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("输入连续刷新，一秒后按顺序退出输入状态", async () => {
  const { createTypingState } = typingStateModule;
  const calls = [];
  let timer;
  const input = createTypingState({
    update: async value => { calls.push(value); },
    clear: async () => { calls.push("clear"); },
    setTimer: callback => { timer = callback; return callback; },
    cancelTimer: () => {}
  });
  input.input();
  await tick();
  input.input();
  await tick();
  timer();
  await tick();
  await input.close();
  assert.deepEqual(calls, [true, true, false, "clear"]);
});

test("窗口关闭等待在途输入请求，清理后不会再发送旧状态", async () => {
  const { createTypingState } = typingStateModule;
  const calls = [];
  let release;
  let timer;
  const input = createTypingState({
    update: value => {
      calls.push(value);
      return new Promise(resolve => { release = resolve; });
    },
    clear: async () => { calls.push("clear"); },
    setTimer: callback => { timer = callback; return callback; },
    cancelTimer: () => {}
  });
  input.input();
  await tick();
  input.input();
  const closed = input.close();
  timer();
  assert.deepEqual(calls, [true]);
  release();
  await closed;
  assert.deepEqual(calls, [true, "clear"]);
});
