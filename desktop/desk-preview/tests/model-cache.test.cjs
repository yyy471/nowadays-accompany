"use strict";

// 已保存供应商的模型候选缓存：按服务配置与凭据版本隔离。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(
    pathToFileURL(
      path.join(__dirname, "../renderer/src/components/model/model-cache.js")
    ).href
  );

const provider = (patch = {}) => ({
  resourceId: "m1",
  config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:8000" },
  credential: { status: "stored", reference: null },
  ...patch,
});

test("候选缓存按服务、地址与凭据版本隔离", async () => {
  const { providerCacheKey, readModelCache, writeModelCache } = await load();
  const base = providerCacheKey(provider());
  assert.notEqual(
    providerCacheKey(provider({ config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:8001" } })),
    base,
    "地址变化应换键"
  );
  assert.notEqual(
    providerCacheKey(provider({ credential: { status: "missing", reference: null } })),
    base,
    "凭据状态变化应换键"
  );
  writeModelCache(base, ["alpha", "beta"]);
  assert.deepEqual(readModelCache(base), ["alpha", "beta"]);
  assert.equal(readModelCache("other"), null);
});

test("写入候选会通知订阅者并返回副本", async () => {
  const { writeModelCache, readModelCache, subscribeModelCache, getModelCacheVersion } = await load();
  let notified = 0;
  const unsubscribe = subscribeModelCache(() => { notified += 1; });
  const before = getModelCacheVersion();
  writeModelCache("k", ["alpha"]);
  assert.ok(getModelCacheVersion() > before);
  assert.equal(notified, 1);
  const copy = readModelCache("k");
  copy.push("mutated");
  assert.deepEqual(readModelCache("k"), ["alpha"]);
  unsubscribe();
  writeModelCache("k", ["beta"]);
  assert.equal(notified, 1);
});

test("清理缓存会通知订阅者并让共享页清空候选", async () => {
  const { writeModelCache, readModelCache, clearModelCache, subscribeModelCache } = await load();
  writeModelCache("rotated", ["old-alpha"]);
  let notified = 0;
  const unsubscribe = subscribeModelCache(() => { notified += 1; });
  clearModelCache("rotated");
  assert.equal(readModelCache("rotated"), null);
  assert.equal(notified, 1);
  clearModelCache("rotated");
  assert.equal(notified, 2, "再次清理会推进代次并通知");
  unsubscribe();
});

test("清理缓存会推进代次，使换密钥前的在途探测无法写回", async () => {
  const { getModelCacheEpoch, clearModelCache, writeModelCache, readModelCache } = await load();
  const before = getModelCacheEpoch("provider");
  writeModelCache("provider", ["old-alpha", "old-beta"]);
  clearModelCache("provider");
  assert.equal(readModelCache("provider"), null);
  assert.equal(getModelCacheEpoch("provider"), before + 1, "即使缓存为空也推进代次");
});
