"use strict";

// 绑定字段级合并：对话与记忆按用途合并，扩展按用途与资源区分（283 R06）。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(
    pathToFileURL(
      path.join(__dirname, "../renderer/src/components/model/binding-merge.js"),
    ).href
  );

const binding = (capability, resourceId, patch = {}) => ({
  capability,
  resourceId,
  modelName: capability === "chat_model" || capability === "memory_model" ? "m" : null,
  enabled: true,
  ...patch,
});

test("对话与记忆互不重叠的修改自动合并，扩展绑定保持不变", async () => {
  const { mergeBindingDrafts } = await load();
  const base = [
    binding("chat_model", "chat-a"),
    binding("memory_model", "memory-a"),
    binding("mcp", "tool-a"),
  ];
  const draft = [binding("chat_model", "chat-b"), binding("memory_model", "memory-a")];
  const latest = [
    binding("chat_model", "chat-a"),
    binding("memory_model", "memory-b"),
    binding("mcp", "tool-a"),
  ];
  const result = mergeBindingDrafts({ base, draft, latest, scope: "models" });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(
    result.items.map((item) => `${item.capability}:${item.resourceId}`).sort(),
    ["chat_model:chat-b", "mcp:tool-a", "memory_model:memory-b"],
  );
});

test("同一用途被两边改成不同模型时报冲突并保留草稿", async () => {
  const { mergeBindingDrafts } = await load();
  const base = [binding("chat_model", "chat-a")];
  const draft = [binding("chat_model", "chat-c")];
  const latest = [binding("chat_model", "chat-b")];
  const result = mergeBindingDrafts({ base, draft, latest, scope: "models" });
  assert.deepEqual(result.conflicts, ["chat_model"]);
  assert.equal(result.items.some((item) => item.capability === "chat_model"), false);
});

test("扩展按用途与资源逐项合并，不同资源的改动互不覆盖", async () => {
  const { mergeBindingDrafts } = await load();
  const base = [
    binding("mcp", "tool-a", { enabled: true }),
    binding("skill", "skill-a", { enabled: true }),
  ];
  const draft = [
    binding("mcp", "tool-a", { enabled: false }),
    binding("skill", "skill-a", { enabled: true }),
  ];
  const latest = [
    binding("mcp", "tool-a", { enabled: true }),
    binding("skill", "skill-a", { enabled: false }),
    binding("skill", "skill-b", { enabled: true }),
  ];
  const result = mergeBindingDrafts({ base, draft, latest, scope: "ext" });
  assert.deepEqual(result.conflicts, []);
  const enabledOf = (key) =>
    result.items.find((item) => `${item.capability}:${item.resourceId}` === key)
      ?.enabled;
  assert.equal(enabledOf("mcp:tool-a"), false, "用户关闭的扩展保持关闭");
  assert.equal(enabledOf("skill:skill-a"), false, "服务端关闭的扩展被采纳");
  assert.equal(enabledOf("skill:skill-b"), true, "服务端新增的扩展被保留");
});
