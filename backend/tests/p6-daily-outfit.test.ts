import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createBackendApp } from "../src/bootstrap/app.js";
import type { ModelEvent } from "../src/domain/model.js";
import {
  createFixture,
  ScriptedChatModel,
  type Fixture,
} from "./p2-05-fixture.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function submit(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}

function toolCall(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): ModelEvent[] {
  return [
    { type: "tool_call", callId, name, arguments: args },
    { type: "completed", stopReason: "tool_calls" },
  ];
}

function reply(text: string): ModelEvent[] {
  return [
    { type: "text_delta", text },
    { type: "completed", stopReason: "stop" },
  ];
}

async function importOutfit(
  fixture: Fixture,
  name: string,
  description?: string,
): Promise<string> {
  return (await fixture.app.services.appearance.importOutfit(fixture.roleId, {
    name,
    ...(description === undefined ? {} : { description }),
    home: { fileName: "home.png", data: PNG_1X1 },
  })).outfitId;
}

test("the first decision of the day sees the wardrobe and registers the date", { timeout: 60_000 }, async () => {
  const clock = { now: new Date("2026-11-08T01:00:00.000Z") };
  let blackId = "";
  let whiteId = "";
  const fixture = createFixture(
    [
      (request) => {
        assert.match(request.system, /今日穿搭（业务本地日期 2026-11-08）/);
        assert.match(request.system, /黑白长裙/);
        assert.match(request.system, /白色针织裙/);
        assert.match(request.system, /日常外出/);
        assert.match(request.system, /今天还没有完成穿搭决定/);
        assert.match(request.system, /当前没有已选择的服饰/);
        return toolCall("wire-outfit-first", "state_update", {
          patch: { outfitId: blackId, mood: "愉快" },
        });
      },
      reply("今天穿黑白长裙。"),
      (request) => {
        assert.match(request.system, /今天已完成穿搭决定/);
        assert.match(request.system, /当前穿着：黑白长裙/);
        assert.match(request.system, /业务本地日期 2026-11-08/);
        return toolCall("wire-outfit-switch", "state_update", {
          patch: { outfitId: whiteId },
        });
      },
      reply("换上白色针织裙。"),
      (request) => {
        assert.match(request.system, /业务本地日期 2026-11-09/);
        assert.match(request.system, /今天还没有完成穿搭决定/);
        assert.match(request.system, /当前穿着：白色针织裙/);
        return reply("新的一天，先继续穿这一套。");
      },
    ],
    { now: () => clock.now },
  );
  try {
    blackId = await importOutfit(fixture, "黑白长裙", "日常外出");
    whiteId = await importOutfit(fixture, "白色针织裙", "居家");

    submit(fixture, "今天穿什么？");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    let state = fixture.app.services.roles.getState(fixture.roleId).state;
    assert.equal(state.outfitId, blackId);
    assert.equal(state.outfitReviewedOn, "2026-11-08");
    assert.equal(state.mood, "愉快");

    submit(fixture, "换一套吧。");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    state = fixture.app.services.roles.getState(fixture.roleId).state;
    assert.equal(state.outfitId, whiteId);
    assert.equal(state.outfitReviewedOn, "2026-11-08");

    clock.now = new Date("2026-11-09T01:00:00.000Z");
    submit(fixture, "早上好。");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    state = fixture.app.services.roles.getState(fixture.roleId).state;
    assert.equal(state.outfitId, whiteId, "未提交新决定时保留原服饰");
    assert.equal(state.outfitReviewedOn, "2026-11-08");
  } finally {
    await fixture.close();
  }
});

test("state_update rejects foreign or missing outfits and lets the model retry", { timeout: 60_000 }, async () => {
  const clock = { now: new Date("2026-11-08T01:00:00.000Z") };
  let validId = "";
  let foreignId = "";
  const fixture = createFixture(
    [
      () =>
        toolCall("wire-outfit-foreign", "state_update", {
          patch: { outfitId: foreignId },
        }),
      (request) => {
        assert.match(
          JSON.stringify(request.messages),
          /OUTFIT_NOT_FOUND/,
          "模型应收到可修正的工具结果",
        );
        return toolCall("wire-outfit-retry", "state_update", {
          patch: { outfitId: validId },
        });
      },
      reply("已经换好衣服。"),
    ],
    { now: () => clock.now },
  );
  try {
    validId = await importOutfit(fixture, "黑白长裙");
    const other = fixture.app.services.roles.createRole({
      displayName: "另一个角色",
      definition: { text: "测试角色" },
      state: {},
    });
    foreignId = (await fixture.app.services.appearance.importOutfit(other.roleId, {
      name: "别人的裙子",
      home: { fileName: "home.png", data: PNG_1X1 },
    })).outfitId;

    submit(fixture, "换衣服。");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const state = fixture.app.services.roles.getState(fixture.roleId).state;
    assert.equal(state.outfitId, validId);
    assert.equal(state.outfitReviewedOn, "2026-11-08");
  } finally {
    await fixture.close();
  }
});

test("an empty wardrobe adds no outfit context", { timeout: 60_000 }, async () => {
  const clock = { now: new Date("2026-11-08T01:00:00.000Z") };
  const fixture = createFixture(
    [
      (request) => {
        assert.doesNotMatch(request.system, /今日穿搭/);
        return reply("普通回复。");
      },
    ],
    { now: () => clock.now },
  );
  try {
    submit(fixture, "你好。");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const state = fixture.app.services.roles.getState(fixture.roleId).state;
    assert.equal(state.outfitId, undefined);
    assert.equal(state.outfitReviewedOn, undefined);
  } finally {
    await fixture.close();
  }
});

test("outfit date follows the round start across local midnight", { timeout: 60_000 }, async () => {
  const clock = { now: new Date("2026-11-08T15:59:58.000Z") };
  let outfitId = "";
  const fixture = createFixture(
    [
      (request) => {
        assert.match(request.system, /业务本地日期 2026-11-08/);
        // 模拟模型决策期间跨过本地零点，登记仍使用本轮开始日期。
        clock.now = new Date("2026-11-08T16:00:02.000Z");
        return toolCall("wire-outfit-midnight", "state_update", {
          patch: { outfitId },
        });
      },
      reply("跨零点前决定好了。"),
      (request) => {
        assert.match(request.system, /业务本地日期 2026-11-09/);
        assert.match(request.system, /今天还没有完成穿搭决定/);
        return reply("早上好。");
      },
    ],
    { now: () => clock.now },
  );
  try {
    outfitId = await importOutfit(fixture, "黑白长裙");
    submit(fixture, "还没睡吗？");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const state = fixture.app.services.roles.getState(fixture.roleId).state;
    assert.equal(state.outfitId, outfitId);
    assert.equal(state.outfitReviewedOn, "2026-11-08");

    submit(fixture, "早上好。");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const after = fixture.app.services.roles.getState(fixture.roleId).state;
    assert.equal(after.outfitReviewedOn, "2026-11-08");
  } finally {
    await fixture.close();
  }
});

test("outfit state and wardrobe are readable after restart without model calls", { timeout: 60_000 }, async () => {
  const clock = { now: new Date("2026-11-08T01:00:00.000Z") };
  let outfitId = "";
  const fixture = createFixture(
    [
      () =>
        toolCall("wire-outfit-restart", "state_update", {
          patch: { outfitId },
        }),
      reply("穿好了。"),
    ],
    { now: () => clock.now },
  );
  let restarted: ReturnType<typeof createBackendApp> | undefined;
  try {
    outfitId = await importOutfit(fixture, "黑白长裙", "外出");
    submit(fixture, "换衣服。");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    await fixture.app.close();
    const model = new ScriptedChatModel([]);
    restarted = createBackendApp(fixture.app.config, {
      disableMemoryRuntime: true,
      now: () => clock.now,
      modelPortFactory: () => model,
    });
    const state = restarted.services.roles.getState(fixture.roleId).state;
    assert.equal(state.outfitId, outfitId);
    assert.equal(state.outfitReviewedOn, "2026-11-08");
    const wardrobe = restarted.services.appearance.list(fixture.roleId);
    assert.equal(wardrobe.items[0]?.outfitId, outfitId);
    assert.equal(model.requests.length, 0, "读取状态与衣柜不调用模型");
  } finally {
    await restarted?.close();
    await fixture.close();
  }
});

test("submitting the current outfit again registers today's decision", { timeout: 60_000 }, async () => {
  const clock = { now: new Date("2026-11-08T01:00:00.000Z") };
  let outfitId = "";
  const fixture = createFixture(
    [
      (request) => {
        assert.match(request.system, /今天还没有完成穿搭决定/);
        assert.match(request.system, /当前穿着：黑白长裙/);
        return toolCall("wire-outfit-continue", "state_update", {
          patch: { outfitId },
        });
      },
      reply("今天就继续穿这一套。"),
    ],
    { now: () => clock.now },
  );
  try {
    outfitId = await importOutfit(fixture, "黑白长裙");
    const current = fixture.app.services.roles.getState(fixture.roleId);
    fixture.app.services.roles.setState(fixture.roleId, {
      state: { ...current.state, outfitId, outfitReviewedOn: "2026-11-07" },
      expectedVersion: current.stateVersion,
    });
    submit(fixture, "今天穿什么？");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const state = fixture.app.services.roles.getState(fixture.roleId).state;
    assert.equal(state.outfitId, outfitId);
    assert.equal(state.outfitReviewedOn, "2026-11-08");
  } finally {
    await fixture.close();
  }
});
