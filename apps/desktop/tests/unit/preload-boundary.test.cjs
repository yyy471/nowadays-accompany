"use strict";

// 桌面 preload 与主进程边界：渲染层不得持有宿主令牌，preload 不得同步阻塞 IPC。
// 运行：在 apps/desktop 下执行 `npm test`。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const electronDir = path.resolve(__dirname, "../../electron");
const read = name => fs.readFileSync(path.join(electronDir, name), "utf8");

test("设置 preload 零 sendSync、不暴露 hostHeaders 与 desk:config", () => {
  const preload = read("settings-preload.cjs");
  assert.doesNotMatch(preload, /sendSync/);
  assert.doesNotMatch(preload, /desk:config/);
  assert.doesNotMatch(preload, /hostHeaders/);
  assert.match(preload, /isPackaged:\s*process\.argv\.includes\("--nowadays-packaged=1"\)/);
});

test("主进程不再提供 desk:config 同步通道", () => {
  assert.doesNotMatch(read("main.cjs"), /desk:config/);
});

test("主进程代理补签宿主令牌并透传中止信号，不再注册 onBeforeSendHeaders", () => {
  const main = read("main.cjs");
  assert.doesNotMatch(main, /onBeforeSendHeaders/);
  assert.match(main, /request\.signal/);
  assert.match(main, /maxSockets:\s*64/);
});
