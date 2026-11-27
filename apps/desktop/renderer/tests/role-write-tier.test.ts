// 对话模型首次绑定的启用默认值：只有停机且从未保存过对话模型时才默认勾选。
import test from "node:test";
import assert from "node:assert/strict";
import * as targetModule from "../src/components/config/role-write-tier.ts";

const load = async () => targetModule;

test("shouldDefaultEnableOnChatBind：停机的首次绑定默认启用", async () => {
  const { shouldDefaultEnableOnChatBind } = await load();
  assert.equal(shouldDefaultEnableOnChatBind({ activityState: "stopped", hasSavedChat: false }), true);
});

test("shouldDefaultEnableOnChatBind：已保存过对话模型不再默认启用", async () => {
  const { shouldDefaultEnableOnChatBind } = await load();
  assert.equal(shouldDefaultEnableOnChatBind({ activityState: "stopped", hasSavedChat: true }), false);
});

test("shouldDefaultEnableOnChatBind：活动中的角色不默认启用", async () => {
  const { shouldDefaultEnableOnChatBind } = await load();
  for (const hasSavedChat of [false, true]) {
    assert.equal(shouldDefaultEnableOnChatBind({ activityState: "active", hasSavedChat }), false);
    assert.equal(shouldDefaultEnableOnChatBind({ activityState: "stopping", hasSavedChat }), false);
  }
});

test("shouldDefaultEnableOnChatBind：状态未知时不默认启用", async () => {
  const { shouldDefaultEnableOnChatBind } = await load();
  assert.equal(shouldDefaultEnableOnChatBind({ hasSavedChat: false }), false);
  assert.equal(shouldDefaultEnableOnChatBind({ activityState: undefined, hasSavedChat: true }), false);
});
