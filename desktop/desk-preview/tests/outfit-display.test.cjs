"use strict";

// 主页服饰图片与名称归属的纯逻辑测试。运行：在 desktop/desk-preview 下执行 `npm test`。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(pathToFileURL(path.join(__dirname, "../renderer/src/outfit-display.js")).href);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

test("快速换装：只应用最新一次解码成功的图片与名称", async () => {
  const { createOutfitDisplay } = await load();
  const display = createOutfitDisplay();
  const first = deferred();
  const second = deferred();
  const firstLoad = display.load("/a.png", "黑色长裙", () => first.promise);
  const secondLoad = display.load("/b.png", "白色针织裙", () => second.promise);
  second.resolve();
  await secondLoad;
  assert.deepEqual(display.current, { url: "/b.png", name: "白色针织裙" });
  first.resolve();
  await firstLoad;
  assert.deepEqual(display.current, {
    url: "/b.png",
    name: "白色针织裙"
  }, "晚完成的旧解码不能把画面切回旧图");
});

test("新图解码失败时保留旧图片和旧服饰名", async () => {
  const { createOutfitDisplay } = await load();
  const display = createOutfitDisplay();
  await display.load("/a.png", "黑色长裙", () => Promise.resolve());
  await display.load("/b.png", "蓝色外套", () => Promise.reject(new Error("decode failed")));
  assert.deepEqual(display.current, { url: "/a.png", name: "黑色长裙" });
});

test("新图加载中仍显示旧的一组，清空服饰后立即回到主题插画", async () => {
  const { createOutfitDisplay } = await load();
  const display = createOutfitDisplay();
  await display.load("/a.png", "黑色长裙", () => Promise.resolve());
  const pending = deferred();
  const loading = display.load("/b.png", "蓝色外套", () => pending.promise);
  assert.deepEqual(display.current, { url: "/a.png", name: "黑色长裙" });
  const cleared = await display.load(null, null, () => Promise.resolve());
  assert.equal(cleared, null);
  assert.equal(display.current, null);
  pending.resolve();
  await loading;
  assert.equal(display.current, null, "已清空后旧解码完成也不能重新显示");
});

test("图片渲染失败只清除同一 URL 的展示", async () => {
  const { createOutfitDisplay } = await load();
  const display = createOutfitDisplay();
  await display.load("/a.png", "黑色长裙", () => Promise.resolve());
  assert.deepEqual(display.fail("/other.png"), { url: "/a.png", name: "黑色长裙" });
  assert.equal(display.fail("/a.png"), null);
});

test("同一 URL 的新服饰信息在解码成功后一起替换", async () => {
  const { createOutfitDisplay } = await load();
  const display = createOutfitDisplay();
  await display.load("/same.png", "旧名称", () => Promise.resolve());
  await display.load("/same.png", "新名称", () => Promise.resolve());
  assert.deepEqual(display.current, { url: "/same.png", name: "新名称" });
});
