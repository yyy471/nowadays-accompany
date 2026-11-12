"use strict";

// 对话推进的点击/键盘判定。运行：在 desktop/desk-preview 下执行 `npm test`。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(
    pathToFileURL(
      path.join(__dirname, "../renderer/src/conversation/advance.js")
    ).href
  );

test("点击正文与动作推进，交互控件和选区不推进", async () => {
  const { shouldAdvanceFromClick } = await load();
  const plain = { closest: () => null };
  const button = {
    closest: (selector) => (selector.includes("button") ? {} : null),
  };
  assert.equal(shouldAdvanceFromClick(plain, false), true);
  assert.equal(shouldAdvanceFromClick(button, false), false);
  assert.equal(shouldAdvanceFromClick(plain, true), false);
  assert.equal(shouldAdvanceFromClick(null, false), true);
});

test("消息区焦点下 Enter/空格推进，内部控件不处理", async () => {
  const { shouldAdvanceFromKey } = await load();
  const host = {};
  assert.equal(shouldAdvanceFromKey("Enter", host, host), true);
  assert.equal(shouldAdvanceFromKey(" ", host, host), true);
  assert.equal(shouldAdvanceFromKey("Tab", host, host), false);
  assert.equal(shouldAdvanceFromKey("Enter", {}, host), false);
});
