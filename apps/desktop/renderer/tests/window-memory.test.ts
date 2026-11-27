// 壳层按角色记忆对话窗口的纯逻辑测试。运行：在 apps/desktop/renderer 下执行 `npm test`。
import test from "node:test";
import assert from "node:assert/strict";
import { createRoleWindowMemory } from "../src/conversation/window-memory.ts";

test("remember/get 按角色隔离记忆，未记忆角色返回空", () => {
  const memory = createRoleWindowMemory();
  memory.remember("r1", "w1");
  memory.remember("r2", "w2");
  assert.equal(memory.get("r1"), "w1");
  assert.equal(memory.get("r2"), "w2");
  assert.equal(memory.get("r3"), null);
});

test("工厂实例之间互不共享记忆", () => {
  const first = createRoleWindowMemory();
  const second = createRoleWindowMemory();
  first.remember("r1", "w1");
  assert.equal(second.get("r1"), null);
});

test("resolvePreferredWindow 遵循 initialTarget > 已记忆 > defaultWindowId", () => {
  const memory = createRoleWindowMemory();
  memory.remember("r1", "remembered");
  assert.equal(
    memory.resolvePreferredWindow("r1", {
      initialTarget: { roleId: "r1", windowId: "target" },
      defaultWindowId: "main",
    }),
    "target",
  );
  assert.equal(
    memory.resolvePreferredWindow("r1", {
      initialTarget: { roleId: "r2", windowId: "target" },
      defaultWindowId: "main",
    }),
    "remembered",
  );
  assert.equal(memory.resolvePreferredWindow("r2", { initialTarget: null, defaultWindowId: "main" }), "main");
  assert.equal(memory.resolvePreferredWindow("r3", {}), null);
});

test("forget 删除角色记忆后回退默认主窗口", () => {
  const memory = createRoleWindowMemory();
  memory.remember("r1", "w1");
  memory.forget("r1");
  assert.equal(memory.get("r1"), null);
  assert.equal(memory.resolvePreferredWindow("r1", { defaultWindowId: "main" }), "main");
});

test("空角色或空窗口不覆盖已有记忆", () => {
  const memory = createRoleWindowMemory();
  memory.remember("r1", "");
  assert.equal(memory.get("r1"), null);
  memory.remember("", "w2");
  assert.equal(memory.get(""), null);
  memory.remember("r1", "w1");
  memory.remember("r1", "");
  memory.remember("r1", null);
  memory.remember("r1", undefined);
  assert.equal(memory.get("r1"), "w1");
});
