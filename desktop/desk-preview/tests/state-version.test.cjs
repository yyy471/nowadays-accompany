"use strict";

// 状态刷新顺序的纯逻辑测试。运行：在 desktop/desk-preview 下执行 `npm test`。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(pathToFileURL(path.join(__dirname, "../renderer/src/state-version.js")).href);

test("同角色旧版本晚到不覆盖新版本", async () => {
  const { createStateVersionGate } = await load();
  const gate = createStateVersionGate();
  gate.activate("r1");
  assert.equal(gate.accept("r1", 2), true);
  assert.equal(gate.accept("r1", 1), false, "初始请求的旧版本必须被丢弃");
  assert.equal(gate.accept("r1", 2), true, "同版本重复刷新可以应用");
  assert.equal(gate.accept("r1", 3), true);
});

test("切换角色后旧角色响应被丢弃，切回时各角色版本独立", async () => {
  const { createStateVersionGate } = await load();
  const gate = createStateVersionGate();
  gate.activate("a");
  assert.equal(gate.accept("a", 5), true);
  gate.activate("b");
  assert.equal(gate.accept("a", 6), false, "旧角色的迟到响应不能写入当前画面");
  assert.equal(gate.accept("b", 1), true);
  gate.activate("a");
  assert.equal(gate.accept("a", 4), false, "切回后仍按该角色已见版本判断");
  assert.equal(gate.accept("a", 5), true);
});

test("断线恢复后同版本可重放，更高版本正常应用", async () => {
  const { createStateVersionGate } = await load();
  const gate = createStateVersionGate();
  gate.activate("r1");
  assert.equal(gate.accept("r1", 7), true);
  // 两次轮询失败期间不调用 accept，恢复后仍以最后成功版本为基线。
  assert.equal(gate.accept("r1", 7), true);
  assert.equal(gate.accept("r1", 8), true);
  assert.equal(gate.accept("r1", 6), false);
});

test("无效版本号不被应用", async () => {
  const { createStateVersionGate } = await load();
  const gate = createStateVersionGate();
  gate.activate("r1");
  assert.equal(gate.accept("r1", Number.NaN), false);
  assert.equal(gate.accept("r1", Number.POSITIVE_INFINITY), false);
  assert.equal(gate.accept("r1", 1), true);
});
