import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareWirePrefixes,
  DEFAULT_DIALOGUE_INPUT_TOKENS,
  DEFAULT_DIALOGUE_OUTPUT_TOKENS,
  estimateTextTokens,
  resolveDialogueBudget,
  StaticTokenCountCache,
} from "../../src/application/conversation/context-budget.js";
import { selectAgentContext } from "../../src/application/conversation/agent-context.js";
import {
  getWindowContextState,
  selectCycleHistory,
  tryCommitWindowSummary,
  type WindowSummaryCompactor,
} from "../../src/application/conversation/window-context-cycle.js";
import { splitRoleCardForDialogue } from "../../src/application/role/role-card-dialogue.js";
import { createBackendApp, type BackendAppOptions } from "../../src/bootstrap/app.js";
import { parseBackendConfig } from "../../src/bootstrap/config.js";
import type { ModelProtocol, ModelRequest } from "../../src/domain/model.js";
import { serializeModelRequest } from "../../src/model/protocols.js";
import { BUSINESS_SCHEMA_VERSION } from "../../src/storage/core/schema.js";
import {
  createFixtureWithModel,
  ScriptedChatModel,
  withStorage,
  type Fixture,
} from "../fixtures/conversation-fixture.js";

const ALL_PROTOCOLS: ModelProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-gemini",
];

function submitMessage(fixture: Fixture, windowId: string, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}

function createCustomFixture(
  model: ScriptedChatModel,
  extraOptions: Partial<BackendAppOptions> = {},
  definitionText = "你是一个沉稳克制的角色。",
  definitionPayload: Record<string, unknown> = {},
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-dl202-"));
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const app = createBackendApp(config, {
    disableMemoryRuntime: true,
    disablePresetAssistant: true,
    typingMs: 20,
    modelPortFactory: () => ({
      async *stream(request) {
        if (request.system.includes("立绘标注器") || request.system.includes("segmentId")) {
          yield { type: "text_delta", text: '{"annotations":[]}' };
          yield { type: "completed", stopReason: "stop" };
          return;
        }
        yield* model.stream(request);
      },
    }),
    ...extraOptions,
  });
  const resource = app.services.resources.create({
    name: "DL-202 离线测试模型",
    kind: "model",
    config: {
      protocol: "openai-chat",
      baseUrl: "http://offline.invalid/v1",
    },
  });
  const role = app.services.roles.createRole({
    displayName: "林知夏",
    definition: { text: definitionText, payload: definitionPayload },
  });
  app.services.resources.replaceBindings(role.roleId, [
    {
      capability: "chat_model",
      resourceId: resource.resourceId,
      modelName: "gpt-4.1",
      enabled: true,
    },
  ]);
  // 本测试专注主对话上下文与 30+n 周期，关闭首次启用自主唤醒避免干扰请求序号。
  app.roleAccess.withStore(role.roleId, (storage) => {
    storage.business.db
      .prepare("UPDATE roles SET first_activation_pending = 0 WHERE role_id = ?")
      .run(role.roleId);
  });
  app.services.activity.resume(role.roleId);
  return {
    root,
    app,
    roleId: role.roleId,
    windowId: role.defaultWindowId,
    model,
    close: async () => {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

test("DL-202 预算解析：默认 128k/10k、总窗口扣输出预留、旧字符口径与小模型超限诊断", () => {
  // 默认无声明：128,000 输入 / 10,000 输出
  const def = resolveDialogueBudget({});
  assert.equal(def.mode, "tokens");
  assert.equal(def.effectiveInputLimit, DEFAULT_DIALOGUE_INPUT_TOKENS);
  assert.equal(def.effectiveOutputLimit, DEFAULT_DIALOGUE_OUTPUT_TOKENS);
  assert.equal(def.wireMaxOutputTokens, 10_000);

  // 总窗口 128,000、输出预留 10,000 -> 输入最多 118,000
  const window128k = resolveDialogueBudget({ contextWindowTokens: 128_000 });
  assert.equal(window128k.mode, "tokens");
  assert.equal(window128k.effectiveOutputLimit, 10_000);
  assert.equal(window128k.effectiveInputLimit, 118_000);

  // 小模型 8,192 总窗口、2,048 输出 -> 输入最多 6,144
  const small = resolveDialogueBudget({ contextWindowTokens: 8_192, maxOutputTokens: 2_048 });
  assert.equal(small.effectiveOutputLimit, 2_048);
  assert.equal(small.effectiveInputLimit, 6_144);

  // 旧字符配置保留字符单位，不混用 token
  const legacy = resolveDialogueBudget({ maxInputChars: 16_000, maxOutputChars: 2_000 });
  assert.equal(legacy.mode, "chars");
  assert.equal(legacy.effectiveInputLimit, 16_000);
  assert.equal(legacy.effectiveOutputLimit, 2_000);
  assert.equal(legacy.wireMaxOutputTokens, undefined);

  // 静态块计数按内容版本复用
  const cache = new StaticTokenCountCache(8);
  const first = cache.count("card", "角色设定正文".repeat(100), "openai-chat", "gpt-4.1");
  const second = cache.count("card", "角色设定正文".repeat(100), "openai-chat", "gpt-4.1");
  assert.equal(first, second);
  assert.equal(cache.size, 1);

  // 小模型超限返回有效窗口、各项占用与超额量
  assert.throws(
    () =>
      selectAgentContext({
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        contextWindowTokens: 4_096,
        maxOutputTokens: 1_024,
        tokenCountCache: cache,
        resuming: false,
        evidenceQuery: "测试",
        prompt: {
          required: "",
          stablePrefix: "极长核心设定正文。".repeat(1_500),
          turnRequired: "当前状态：{}",
          optional: [],
        },
        request: {
          modelName: "claude-sonnet-4",
          system: "",
          tools: [{ name: "history_lookup", description: "查历史", inputSchema: { type: "object" } }],
          messages: [{ role: "user", content: "你好", source: { currentUserRequest: true } }],
        },
      }),
    (error: unknown) => {
      const err = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(err.code, "MODEL_CONTEXT_EXCEEDED");
      assert.equal(err.details?.budgetMode, "tokens");
      assert.equal(err.details?.effectiveContextWindowTokens, 4_096);
      assert.equal(err.details?.effectiveInputTokens, 3_072);
      assert.equal(err.details?.effectiveOutputTokens, 1_024);
      assert.ok(Number(err.details?.overflowTokens) > 0);
      assert.ok(err.details?.breakdown && typeof err.details.breakdown === "object");
      assert.ok(err.details?.estimationAccuracy && typeof err.details.estimationAccuracy === "object");
      return true;
    },
  );
});

test("DL-202 长卡（>10,000 汉字与 ~12k token）完整常驻稳定前缀、去重且按需查看不击穿前缀缓存", async () => {
  const tailMarker = "CARD_TAIL_SENTINEL_9941_不可截断的性格尾段";
  // 构造 >10,500 汉字、约 ~12k+ token 的纯文本长卡，并附带可按需展开的开场白与示例对话
  const longCore = [
    "# 林知夏（完整长卡）",
    "背景与核心设定：".concat("她在海港图书馆担任古籍修复师，熟悉纸张纹理与装帧工艺，说话温和克制。".repeat(360)),
    `核心尾段标记：${tailMarker}`,
  ].join("\n");
  assert.ok(Array.from(longCore).length > 10_000, "应超过一万中文字符");
  assert.ok(
    estimateTextTokens(longCore, "openai-chat", "gpt-4.1") >= 11_000,
    "应达到约 12k token 规模",
  );
  const fullCard = [
    longCore,
    "### 开场白",
    "OPENING_SENTINEL_在雨天窗边翻书。",
    "### 对话示例",
    "{{user}}：你喜欢喝什么？",
    "{{char}}：EXAMPLE_SENTINEL_手冲耶加雪菲。",
  ].join("\n");

  // 结构化字段与正文重复时去重，原卡对象不受修改
  const rawPayload = {
    description: longCore,
    data: { description: longCore, personality: "沉静细致", first_mes: "STRUCT_OPENING_1", mes_example: "STRUCT_EXAMPLE_1" },
  };
  const originalPayload = structuredClone(rawPayload);
  const normalSplit = splitRoleCardForDialogue(fullCard, rawPayload, ["今天天气真好"], false);
  assert.ok(normalSplit.coreText.includes(tailMarker));
  assert.doesNotMatch(normalSplit.coreText, /OPENING_SENTINEL|EXAMPLE_SENTINEL/);
  assert.equal(normalSplit.onDemandReference, null);
  assert.ok(normalSplit.corePayloadJson && !normalSplit.corePayloadJson.includes(tailMarker));
  assert.ok(normalSplit.corePayloadJson.includes("沉静细致"));
  assert.deepEqual(rawPayload, originalPayload, "原卡结构化字段不得被修改");

  // 当轮请求查看开场白时：coreText 字节级不变，按需内容进入 onDemandReference
  const openingSplit = splitRoleCardForDialogue(fullCard, rawPayload, ["请给我看看开场白"], false);
  assert.equal(openingSplit.coreText, normalSplit.coreText);
  assert.equal(openingSplit.corePayloadJson, normalSplit.corePayloadJson);
  assert.ok(openingSplit.onDemandReference?.includes("OPENING_SENTINEL"));
  assert.ok(openingSplit.onDemandReference?.includes("STRUCT_OPENING_1"));

  // 验证四种协议请求均完整保留卡尾、显式透传 maxOutputTokens，且 Anthropic 正确落位 cache_control 断点
  for (const protocol of ALL_PROTOCOLS) {
    const selected = selectAgentContext({
      protocol,
      baseUrl: "https://offline.invalid/v1",
      resuming: false,
      evidenceQuery: "你好",
      prompt: {
        required: normalSplit.coreText,
        stablePrefix: normalSplit.coreText,
        cycleStable: "当前窗口早期历史滚动摘要（版本 v1，覆盖至消息序号 #20）：\n讨论了旧书修复。",
        turnRequired: "当前状态（版本 1）：{}\n当前时间：2026-11-28T10:00:00.000Z",
        optional: [],
      },
      request: {
        modelName: protocol === "anthropic-messages" ? "claude-sonnet-4" : "gpt-4.1",
        system: "",
        tools: [{ name: "history_lookup", description: "回查原文", inputSchema: { type: "object" } }],
        messages: [
          { role: "user", content: "历史问题一", source: { messageId: "m1" } },
          { role: "assistant", content: "历史回答一", source: { messageId: "m2" } },
          { role: "user", content: "本轮问题", source: { currentUserRequest: true, messageId: "m3" } },
        ],
      },
    });
    assert.equal(selected.maxOutputTokens, 10_000, protocol);
    const wire = serializeModelRequest(protocol, "https://offline.invalid/v1", selected);
    assert.ok(wire.includes(tailMarker), `${protocol} 必须完整保留长卡尾部`);
    assert.ok(wire.includes("10000"), `${protocol} 必须显式透传有效输出上限`);
    if (protocol === "anthropic-messages") {
      const parsed = JSON.parse(wire) as {
        system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
        tools: Array<{ cache_control?: { type: string } }>;
        messages: Array<{ role: string; content: Array<{ type: string; text?: string; cache_control?: { type: string } }> }>;
      };
      assert.equal(parsed.system.length, 2);
      assert.equal(parsed.system[0]?.cache_control?.type, "ephemeral");
      assert.equal(parsed.system[1]?.cache_control?.type, "ephemeral");
      assert.equal(parsed.tools.at(-1)?.cache_control?.type, "ephemeral");
      // 已提交历史末尾落位第 4 个缓存断点，总数 <= 4
      assert.equal(parsed.messages[1]?.content.at(-1)?.cache_control?.type, "ephemeral");
      const totalBreakpoints = (wire.match(/"cache_control":\{"type":"ephemeral"\}/g) ?? []).length;
      assert.ok(totalBreakpoints <= 4 && totalBreakpoints >= 3, `Anthropic 断点总数应受限 <=4，实际 ${totalBreakpoints}`);
    }
  }
});

test("DL-202 主对话全链路：相邻轮次前缀稳定、按需查开场白与跨日状态不击穿前缀、修卡与换窗生效、工具续轮配对完整", async () => {
  let currentNow = new Date("2026-11-28T09:00:00.000Z");
  const tailMarker = "LONG_CARD_TAIL_8820";
  const card = [
    "# 漫长核心设定",
    "喜欢收集老电影票根和修补旧书。".repeat(350),
    `尾段核心：${tailMarker}`,
    "### 开场白",
    "OPENING_ONLY_WHEN_ASKED_771",
  ].join("\n");

  const model = new ScriptedChatModel([
    // Turn 1: 普通对话 + 状态变更
    () => [
      { type: "tool_call", callId: "c1", name: "state_update", arguments: { patch: { mood: "calm" } } },
      { type: "completed", stopReason: "tool_calls" },
    ],
    () => [
      { type: "text_delta", text: "第一轮回复。" },
      { type: "completed", stopReason: "stop" },
    ],
    // Turn 2: 跨日 + 用户问开场白（不应破坏稳定前缀！）
    () => [
      { type: "text_delta", text: "这是开场白。" },
      { type: "completed", stopReason: "stop" },
    ],
    // Turn 3: 新窗口独立对话
    () => [
      { type: "text_delta", text: "新窗口回复。" },
      { type: "completed", stopReason: "stop" },
    ],
    // Turn 4: 修订角色卡后生效
    () => [
      { type: "text_delta", text: "已按新设定回复。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);

  const fixture = createCustomFixture(model, { now: () => currentNow }, card);
  try {
    // 校验业务库已升级至 V33 且含 window_context_states
    withStorage(fixture, ({ business }) => {
      assert.equal(business.schemaVersion, BUSINESS_SCHEMA_VERSION);
      const row = business.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='window_context_states'")
        .get() as { name: string } | undefined;
      assert.equal(row?.name, "window_context_states");
    });

    // Turn 1（含工具续轮 Round 0 -> Round 1）
    submitMessage(fixture, fixture.windowId, "早上好，先更新一下心情吧。");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 2);
    const turn1Round0 = model.requests[0]!;
    const turn1Round1 = model.requests[1]!;
    assert.ok(turn1Round0.system.includes(tailMarker), "长卡尾部必须常驻稳定前缀");
    assert.equal(turn1Round0.system, turn1Round1.system, "工具续轮内稳定系统前缀逐字节一致");
    assert.equal(turn1Round0.maxOutputTokens, 10_000);
    // 校验工具续轮 wire 中 turnContext 没有插在 tool_calls 与 tool 结果之间
    const round1Wire = JSON.parse(
      serializeModelRequest("openai-chat", "https://offline.invalid/v1", turn1Round1),
    ) as { messages: Array<{ role: string; tool_calls?: unknown[]; tool_call_id?: string }> };
    const assistantToolIdx = round1Wire.messages.findIndex((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    assert.ok(assistantToolIdx >= 0);
    assert.equal(round1Wire.messages[assistantToolIdx + 1]?.role, "tool", "tool 结果必须紧邻 assistant tool_calls");

    // Turn 2：跨到第二天，状态已变为 mood=calm，且用户请求查看开场白
    currentNow = new Date("2026-11-29T11:30:00.000Z");
    submitMessage(fixture, fixture.windowId, "请给我看看开场白");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 3);
    const turn2 = model.requests[2]!;
    // 长期稳定系统前缀不受跨日、状态变更、按需查开场白影响！
    assert.equal(turn2.system, turn1Round0.system, "跨日、状态变更与按需查开场白不得破坏 Layer 1 稳定前缀");
    assert.ok(turn2.turnContext?.includes("OPENING_ONLY_WHEN_ASKED_771"), "按需开场白应放入本轮可变材料");
    assert.ok(turn2.turnContext?.includes('"mood":"calm"'), "最新状态应在本轮可变材料生效");
    assert.ok(turn2.turnContext?.includes("本轮当地日期 2026-11-29"), "跨日说明应在本轮可变材料生效");
    // 离线对比相邻轮次最长共同前缀（OpenAI Chat）
    const wire1 = serializeModelRequest("openai-chat", "https://offline.invalid/v1", turn1Round0);
    const wire2 = serializeModelRequest("openai-chat", "https://offline.invalid/v1", turn2);
    const diff = compareWirePrefixes(wire1, wire2);
    assert.ok(
      diff.commonPrefixLength > wire1.indexOf(tailMarker) + tailMarker.length,
      `共同前缀(${diff.commonPrefixLength})必须完整覆盖到长卡尾部之后`,
    );

    // Turn 3：切换新窗口，不携带原窗口历史
    const secondWindow = fixture.app.services.roles.createWindow(fixture.roleId, {
      kind: "custom",
      source: "nowadays",
    });
    submitMessage(fixture, secondWindow.windowId, "新窗口你好");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 4);
    const turn3 = model.requests[3]!;
    assert.equal(turn3.system, turn1Round0.system, "换窗复用相同长期稳定前缀");
    assert.equal(turn3.messages.length, 1, "新窗口不混入旧窗口已提交历史");

    // Turn 4：停机修订角色卡后，新设定立即进入下一轮稳定前缀
    assert.equal(fixture.app.services.activity.requestStop(fixture.roleId).confirmed, true);
    const detail = fixture.app.services.roles.getRole(fixture.roleId);
    fixture.app.services.roles.updateDefinition(fixture.roleId, {
      expectedRevision: detail.definitionRevision,
      definition: { text: `${card}\n## 后续修订\n新增修订标记：REVISED_CARD_V2` },
    });
    fixture.app.services.activity.resume(fixture.roleId);
    submitMessage(fixture, secondWindow.windowId, "修卡后测试");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 5);
    assert.ok(model.requests[4]!.system.includes("REVISED_CARD_V2"));
  } finally {
    await fixture.close();
  }
});

test("DL-202 30+n 历史周期：延迟/失败/覆盖不足保持旧窗口，达标后原子切换且零缺口零重复", async () => {
  // 用小参数（baseMessages=4, triggerNewMessages=2）完整覆盖 30+n 全生命周期
  let compactorMode: "fail" | "insufficient" | "delay_then_ok" = "fail";
  let releaseDelayed: (() => void) | null = null;
  let compactionCalls = 0;

  const compactor: WindowSummaryCompactor = async (input) => {
    compactionCalls += 1;
    if (compactorMode === "fail") {
      throw new Error("SIMULATED_COMPACTOR_FAILURE");
    }
    if (compactorMode === "insufficient") {
      return {
        summaryText: "未覆盖完整区间的摘要",
        coveredUntilSequence: input.targetCoveredUntilSequence - 1,
      };
    }
    await new Promise<void>((resolve, reject) => {
      releaseDelayed = resolve;
      input.signal.addEventListener("abort", () => reject(new Error("ABORTED")), { once: true });
    });
    return {
      summaryText: `已整理序号至 #${input.targetCoveredUntilSequence}：用户与角色按序完成了前几轮对话。`,
      coveredUntilSequence: input.targetCoveredUntilSequence,
    };
  };

  let replyIndex = 0;
  const model = new ScriptedChatModel(
    Array.from({ length: 12 }, () => () => {
      replyIndex += 1;
      return [
        { type: "text_delta", text: `第 ${replyIndex} 轮答复。` },
        { type: "completed", stopReason: "stop" },
      ];
    }),
  );

  const fixture = createCustomFixture(model, {
    windowCycle: { baseMessages: 4, triggerNewMessages: 2 },
    windowSummaryCompactor: compactor,
  });

  try {
    // 第 1、2 轮：共产生 4 条已提交消息（达 baseMessages=4，尚未超阈值）
    submitMessage(fixture, fixture.windowId, "春季樱花赏花路线");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    submitMessage(fixture, fixture.windowId, "夏日海风露营清单");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    await fixture.app.conversation.waitForWindowCompactions(fixture.roleId);
    assert.equal(compactionCalls, 0);

    // 第 3 轮：提交后共 6 条消息（n=2 达阈值 T=2），触发整理但失败 -> 保留旧左边界=1、v0
    submitMessage(fixture, fixture.windowId, "秋日红叶登山装备");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    await fixture.app.conversation.waitForWindowCompactions(fixture.roleId);
    assert.equal(compactionCalls, 1);
    withStorage(fixture, ({ business }) => {
      const state = getWindowContextState(business.db, fixture.windowId);
      assert.equal(state?.summaryVersion, 0);
      assert.equal(state?.historyLeftSequence, 1);
    });

    // 第 4 轮：整理器返回覆盖不足 -> 拒绝切换，仍保留旧左边界=1、v0
    compactorMode = "insufficient";
    submitMessage(fixture, fixture.windowId, "冬日壁炉热红酒配方");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    await fixture.app.conversation.waitForWindowCompactions(fixture.roleId);
    assert.equal(compactionCalls, 2);
    withStorage(fixture, ({ business }) => {
      const state = getWindowContextState(business.db, fixture.windowId);
      assert.equal(state?.summaryVersion, 0);
      assert.equal(state?.historyLeftSequence, 1);
    });

    // 对比第 3、4 轮：旧周期内历史严格向右追加，前缀保持一致！
    const wire3 = serializeModelRequest("openai-chat", "https://offline.invalid/v1", model.requests[2]!);
    const wire4 = serializeModelRequest("openai-chat", "https://offline.invalid/v1", model.requests[3]!);
    const inCycleDiff = compareWirePrefixes(wire3, wire4);
    const u2Pos = wire3.indexOf("夏日海风露营清单");
    assert.ok(u2Pos > 0 && inCycleDiff.commonPrefixLength > u2Pos, "周期内相邻请求应完整复用已提交历史前缀");

    // 第 5 轮：启动延迟整理；等待期间第 6 轮进来仍沿用旧窗口，允许 n 暂时超过 T
    compactorMode = "delay_then_ok";
    submitMessage(fixture, fixture.windowId, "旧书店装帧工具清单");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(compactionCalls, 3);
    assert.ok(releaseDelayed !== null, "延迟整理应已挂起");

    // 等待期间发起合批（连续两条未处理消息）进入第 6 轮：仍沿用旧左边界=1，且合批两条消息均保留真实身份
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "港口灯塔写生选址",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "顺便带上水彩速写本",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const turn6 = model.requests[5]!;
    assert.ok(turn6.messages.some((m) => m.content === "春季樱花赏花路线"), "等待整理期间沿用旧窗口");
    assert.ok(turn6.messages.some((m) => m.content === "港口灯塔写生选址" && m.source?.currentUserRequest));
    assert.ok(turn6.messages.some((m) => m.content === "顺便带上水彩速写本" && m.source?.currentUserRequest));

    // 放行延迟整理 -> 原子切换到 v1 与对齐到 user 消息的新左边界
    const release = releaseDelayed as (() => void) | null;
    assert.ok(release !== null);
    release();
    await fixture.app.conversation.waitForWindowCompactions(fixture.roleId);
    const switchedState = withStorage(fixture, ({ business }) =>
      getWindowContextState(business.db, fixture.windowId),
    );
    assert.ok(switchedState !== null);
    assert.equal(switchedState.summaryVersion, 1);
    assert.ok(switchedState.historyLeftSequence > 1);
    assert.equal(switchedState.coveredUntilSequence, switchedState.historyLeftSequence - 1);

    // 第 7 轮：携带 v1 滚动摘要，历史从新左边界开始（零缺口、零重复、且左边界对齐 user 消息）
    submitMessage(fixture, fixture.windowId, "天文馆观测流星雨");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const turn7 = model.requests[6]!;
    assert.ok(turn7.system.includes("当前窗口早期历史滚动摘要（版本 v1"));
    assert.equal(turn7.messages[0]?.role, "user", "切换后的历史左边界必须对齐完整交互起点（user）");
    assert.ok(!turn7.messages.some((m) => m.content === "春季樱花赏花路线"), "已被摘要覆盖的早期消息已移出");
    assert.ok(turn7.messages.some((m) => m.content === "顺便带上水彩速写本"), "未被移出的近期消息必须完整保留");
    assert.equal(
      turn7.messages.filter((m) => m.content === "天文馆观测流星雨").length,
      1,
      "当前输入不得重复出现",
    );

    // 验证 tryCommitWindowSummary 幂等与单调保护（旧版本或覆盖不足均拒）
    withStorage(fixture, ({ business }) => {
      const stale = tryCommitWindowSummary(business.db, {
        windowId: fixture.windowId,
        roleId: fixture.roleId,
        expectedSummaryVersion: 0,
        summaryText: "过期摘要",
        coveredUntilSequence: 99,
        proposedLeftSequence: 100,
        latestCommittedSequence: 100,
        now: "2026-11-28T12:00:00.000Z",
      });
      assert.equal(stale.committed, false);
      const selected = selectCycleHistory(
        business.db,
        fixture.roleId,
        fixture.windowId,
        new Set(),
        "2026-11-28T12:00:00.000Z",
        { baseMessages: 4, triggerNewMessages: 2 },
      );
      assert.equal(selected.state.summaryVersion, 1);
    });
  } finally {
    await fixture.close();
  }
});
