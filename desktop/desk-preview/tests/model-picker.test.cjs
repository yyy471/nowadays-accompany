"use strict";

// 模型名称候选过滤与测试文案。运行：在 desktop/desk-preview 下执行 `npm test`。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(
    pathToFileURL(
      path.join(__dirname, "../renderer/src/components/model/model-picker.js")
    ).href
  );

test("模型候选按输入过滤、去重并保留手填", async () => {
  const { filterModelNames } = await load();
  const models = ["gpt-a", "gpt-b", "claude-x", "gpt-a", 42, ""];
  assert.deepEqual(filterModelNames(models, ""), ["gpt-a", "gpt-b", "claude-x"]);
  assert.deepEqual(filterModelNames(models, "GPT"), ["gpt-a", "gpt-b"]);
  assert.deepEqual(filterModelNames(models, "claude"), ["claude-x"]);
  assert.deepEqual(filterModelNames(models, "missing"), []);
  assert.deepEqual(filterModelNames(undefined, "x"), []);
});

test("测试结果文案区分成功与失败", async () => {
  const { modelTestNote } = await load();
  assert.equal(modelTestNote(null), "");
  assert.equal(modelTestNote({ ok: true, elapsedMs: 12.4 }), "测试通过 · 12 ms");
  assert.equal(
    modelTestNote({ ok: false, error: { message: "模型返回 401" } }),
    "测试失败：模型返回 401"
  );
});
