import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import sharp from "sharp";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import { AgentGraphRunner } from "../src/application/conversation/agent-graph.js";
import { captureRoleTransfer, resolveRoleTransferBindings, stageRoleTransfer } from "../src/application/transfer/role-transfer-package.js";
import { MemoryService } from "../src/application/memory/memory-service.js";
import { HttpMemoryModel } from "../src/application/memory/memory-runtime.js";
import { ConversationStore } from "../src/storage/conversation/conversation-store.js";
import { MemoryStore } from "../src/storage/memory/memory-store.js";
import { RoleStorage } from "../src/storage/core/role-storage.js";
import { APP_SCHEMA_VERSION } from "../src/storage/core/schema.js";
import { TokenUsageStore } from "../src/storage/core/token-usage-store.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import type { TokenUsageCallEvent, TokenUsageSummaryView } from "../src/domain/token-usage.js";

function tempRoot(prefix = "nowadays-p26-usage-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

test("全链路 7 类调用记账、缓存字段保留、删角色与删服务留存历史", { timeout: 30_000 }, async (t) => {
  const root = tempRoot();
  const now = new Date("2026-11-21T02:00:00.000Z"); // Asia/Shanghai = 2026-11-21 10:00
  let modelCallNo = 0;

  // 离线模型桩：根据请求系统提示分别回应对话、表情标注、过场图规划与锚点提炼，并带完整 4 字段 usage。
  const modelPort: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      modelCallNo += 1;
      if (request.system.includes("segmentId") && request.system.includes("spriteAssetId")) {
        const payload = JSON.parse(request.messages[0]!.content) as {
          segments: Array<{ segmentId: string; kind: string }>;
          sprites: Array<{ spriteAssetId: string }>;
        };
        yield {
          type: "text_delta",
          text: JSON.stringify({
            segments: payload.segments.map((seg) => ({
              segmentId: seg.segmentId,
              spriteAssetId: payload.sprites[0]?.spriteAssetId ?? null,
              voiceEmotion: seg.kind === "speech" ? "平静" : null,
            })),
          }),
        };
        yield {
          type: "usage",
          inputTokens: 400,
          cachedTokens: 250,
          cacheCreationTokens: 50,
          outputTokens: 60,
        };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      if (request.system.includes("过场图规划器")) {
        const payload = JSON.parse(request.messages[0]!.content) as {
          segments: Array<{ segmentId: string }>;
          requestedLayerMode: string | null;
        };
        yield {
          type: "text_delta",
          text: JSON.stringify({
            description: "窗外有细雨落在青石阶上",
            layerMode: payload.requestedLayerMode ?? "background",
            startSegmentId: payload.segments[0]!.segmentId,
            endSegmentId: payload.segments.at(-1)!.segmentId,
          }),
        };
        yield {
          type: "usage",
          inputTokens: 600,
          cachedTokens: 300,
          cacheCreationTokens: 20,
          outputTokens: 80,
        };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      if (request.system.includes("生图") || request.messages.some((m) => m.role === "user" && m.images?.length)) {
        yield { type: "text_delta", text: "short dark hair, calm amber eyes, navy coat" };
        yield {
          type: "usage",
          inputTokens: 900,
          cachedTokens: 100,
          cacheCreationTokens: 0,
          outputTokens: 45,
        };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      if (request.system.includes("你第一次开始活动")) {
        yield { type: "text_delta", text: "今天先翻翻新到的书。" };
        yield {
          type: "usage",
          inputTokens: 2_000,
          cachedTokens: 500,
          cacheCreationTokens: 0,
          outputTokens: 300,
        };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      if (request.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("会断流的提问"))) {
        throw new Error("SIMULATED_STREAM_DROPPED");
      }
      // 主对话回复
      yield { type: "text_delta", text: "今天窗外的雨下得很轻。" };
      yield {
        type: "usage",
        inputTokens: 1_200,
        cachedTokens: 800,
        cacheCreationTokens: 100,
        outputTokens: 150,
      };
      yield { type: "completed", stopReason: "stop" };
    },
  };

  // 本地假 OpenAI 端点用于连通性测试（带 cachedTokens）
  const mockLlm = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "pong" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 10 },
        },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  const mockPort = await listen(mockLlm, 0, "127.0.0.1");

  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const app = createBackendApp(config, {
    now: () => now,
    timeZone: "Asia/Shanghai",
    disablePresetAssistant: true,
    disableMemoryRuntime: true,
    modelPortFactory: () => modelPort,
  });
  const port = await listen(app.server, 0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    mockLlm.closeAllConnections();
    mockLlm.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 1) 创建模型资源并执行连通性测试（connection_test）
  const resource = app.services.resources.create({
    kind: "model",
    name: "测试主力服务",
    config: {
      protocol: "openai-chat",
      provider: "deepseek",
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      modelName: "demo-chat",
    },
  });
  const testRes = await app.services.modelServices.testForResource(resource.resourceId, "demo-chat");
  assert.equal(testRes.ok, true);

  // 2) 创建两个角色（保留一个兜底，方便删除第一个角色）
  const roleA = app.services.roles.createRole({
    displayName: "林雾",
    definition: { text: "喜欢听雨的书店店员" },
  });
  app.services.roles.createRole({
    displayName: "保底角色",
    definition: { text: "保底" },
  });
  app.services.resources.replaceBindings(roleA.roleId, [
    { capability: "chat_model", resourceId: resource.resourceId, modelName: "demo-chat", enabled: true },
  ]);

  // 3) 上传服饰 + 生成锚点提示词（anchor_prompt）
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "teal" } }).png().toBuffer();
  const outfit = await app.services.appearance.importOutfit(roleA.roleId, {
    name: "常服",
    home: { fileName: "home.png", data: png },
    sprites: [{ fileName: "calm.png", data: png }],
  });
  const stateBefore = app.services.roles.getState(roleA.roleId);
  app.services.roles.setState(roleA.roleId, {
    state: { ...stateBefore.state, outfitId: outfit.outfitId },
    expectedVersion: stateBefore.stateVersion,
  });
  const anchorRes = await app.services.sceneImageSettings.generateAnchorPrompt(roleA.roleId, {
    target: "base",
  });
  assert.ok(anchorRes.prompt.length > 0);

  // 4) 恢复活动触发首次自主思考（autonomy + annotation），再发对话（dialogue + annotation）与手动过场图（scene_plan）
  app.services.activity.resume(roleA.roleId);
  await app.conversation.waitForIdle(roleA.roleId);
  app.conversation.submitMessage(roleA.roleId, roleA.defaultWindowId, {
    content: "今天下雨了吗？",
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
  await app.conversation.waitForIdle(roleA.roleId);
  const page = app.services.messages.list(roleA.roleId, roleA.defaultWindowId, null, 20);
  const reply = page.items.find((m) => m.sender === "assistant")!;
  assert.ok(reply);
  app.services.sceneImages.requestManual(roleA.roleId, roleA.defaultWindowId, reply.messageId, {
    idempotencyKey: "usage-scene-1",
    layerMode: "background",
  });
  await app.services.sceneImages.waitForIdle(roleA.roleId);

  // 5) 直接跑一次 HttpMemoryModel + MemoryService（memory），验证 business.sqlite 与全局账本双写 usage
  const storage = RoleStorage.openExisting(rolePaths(config.dataRoot, roleA.roleId));
  try {
    const memStore = new MemoryStore(storage.business.db);
    const httpMem = new HttpMemoryModel(
      {
        async *stream() {
          yield { type: "text_delta", text: JSON.stringify({ operations: [] }) };
          yield {
            type: "usage",
            inputTokens: 1_500,
            cachedTokens: 900,
            cacheCreationTokens: 120,
            outputTokens: 200,
          };
          yield { type: "completed", stopReason: "stop" };
        },
      },
      {
        capability: "memory_model",
        resourceId: resource.resourceId,
        modelName: "demo-memory",
        config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1" },
      },
    );
    const memService = new MemoryService(memStore, httpMem, {
      modelInfo: {
        resourceId: resource.resourceId,
        modelName: "demo-memory",
        protocol: "openai-chat",
      },
      now: () => now,
      timeZone: "Asia/Shanghai",
      onModelCallFinished: (event) => app.services.tokenUsage.recordCall(event),
    });
    memService.enqueueManual(roleA.roleId);
    const batchRes = await memService.runBatch(roleA.roleId);
    assert.equal(batchRes.status, "completed");
    const memRow = storage.business.db
      .prepare("SELECT resource_id, usage_json FROM model_calls WHERE call_kind = 'memory_maintenance' LIMIT 1")
      .get() as { resource_id: string | null; usage_json: string | null };
    assert.equal(memRow.resource_id, resource.resourceId);
    assert.deepEqual(JSON.parse(memRow.usage_json!), {
      inputTokens: 1500,
      cachedTokens: 900,
      cacheCreationTokens: 120,
      outputTokens: 200,
    });
  } finally {
    storage.close();
  }

  // 6) 触发一次在返回 usage 前断流的真实失败对话调用
  app.conversation.submitMessage(roleA.roleId, roleA.defaultWindowId, {
    content: "会断流的提问",
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
  await app.conversation.waitForIdle(roleA.roleId);

  // 7) 查询全量汇总，核对 7 类用途齐备与精确数字
  const { status, body: summary } = await getJson<TokenUsageSummaryView>(
    `${baseUrl}/v1/usage/tokens?range=today`,
  );
  assert.equal(status, 200);
  assert.equal(summary.range, "today");
  assert.equal(summary.startDate, "2026-11-21");
  assert.equal(summary.endDate, "2026-11-21");
  // 总输入 = 30 + 900 + 2000 + 400 + 1200 + 400 + 600 + 1500 = 7030
  // 总缓存命中 = 10 + 100 + 500 + 250 + 800 + 250 + 300 + 900 = 3110
  // 总缓存写入 = 0 + 0 + 0 + 50 + 100 + 50 + 20 + 120 = 340
  // 总输出 = 5 + 45 + 300 + 60 + 150 + 60 + 80 + 200 = 900
  assert.equal(summary.totals.inputTokens, "7030");
  assert.equal(summary.totals.cachedTokens, "3110");
  assert.equal(summary.totals.cacheCreationTokens, "340");
  assert.equal(summary.totals.outputTokens, "900");
  assert.equal(summary.totals.totalTokens, "7930");
  assert.equal(summary.totals.callCount, "9");
  assert.equal(summary.totals.reportedCallCount, "8");
  assert.equal(summary.totals.missingUsageCount, "1");
  assert.equal(summary.totals.failedCallCount, "1");
  assert.equal(summary.byCategory.length, 7);
  assert.ok(modelCallNo >= 6);

  // 非法查询参数返回 400
  const badRange = await getJson<{ error: { code: string } }>(`${baseUrl}/v1/usage/tokens?range=year`);
  assert.equal(badRange.status, 400);
  assert.equal(badRange.body.error.code, "INVALID_QUERY");

  // 8) 停止并删除角色 A 与模型资源后，历史统计完整留存并标记 deleted: true + 保留名称快照
  app.services.activity.requestStop(roleA.roleId);
  assert.equal(app.services.activity.view(roleA.roleId).state, "stopped");
  await app.services.roleDeletion.remove(roleA.roleId, false);
  app.services.resources.remove(resource.resourceId);

  const afterDelete = (
    await getJson<TokenUsageSummaryView>(`${baseUrl}/v1/usage/tokens?range=all`)
  ).body;
  assert.equal(afterDelete.totals.totalTokens, "7930");
  const deletedRoleRow = afterDelete.byRole.find((r) => r.roleId === roleA.roleId);
  assert.ok(deletedRoleRow);
  assert.equal(deletedRoleRow.deleted, true);
  assert.equal(deletedRoleRow.roleName, "林雾");
  const deletedModelRow = afterDelete.byModel.find((m) => m.resourceId === resource.resourceId);
  assert.ok(deletedModelRow);
  assert.equal(deletedModelRow.deleted, true);
  assert.equal(deletedModelRow.resourceName, "测试主力服务");
});

test("超大 BigInt 累加不溢出 53 位与 64 位整数上限", async (t) => {
  const root = tempRoot("nowadays-p26-bigint-");
  const now = new Date("2026-11-21T02:00:00.000Z");
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const app = createBackendApp(config, {
    now: () => now,
    timeZone: "Asia/Shanghai",
    disablePresetAssistant: true,
    disableMemoryRuntime: true,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 写入两条超过 2^62 的单行记录（两行之和 12_000_000_000_000_000_000 超过 SQLite INT64 上限 9.22e18！）
  const store = new TokenUsageStore(app.appStore.db);
  for (const id of ["huge-1", "huge-2"]) {
    store.upsertRecord({
      sourceCallId: id,
      localDate: "2026-11-21",
      occurredAt: now.toISOString(),
      roleId: null,
      roleName: "",
      resourceId: null,
      resourceName: "巨量压力",
      provider: null,
      protocol: "openai-chat",
      modelName: "mega-model",
      category: "dialogue",
      status: "succeeded",
      usageReported: true,
      inputTokens: 6_000_000_000_000_000_000n,
      cachedTokens: 3_000_000_000_000_000_000n,
      cacheCreationTokens: 0n,
      outputTokens: 1_500_000_000_000_000_000n,
    });
  }

  const summary = app.services.tokenUsage.getSummary({ range: "all" });
  assert.equal(summary.totals.inputTokens, "12000000000000000000");
  assert.equal(summary.totals.cachedTokens, "6000000000000000000");
  assert.equal(summary.totals.outputTokens, "3000000000000000000");
  assert.equal(summary.totals.totalTokens, "15000000000000000000");
  assert.equal(summary.totals.cacheHitRate, 0.5);
});

test("调用结束时角色或模型服务已被删除，账本仍保留该次调用", async (t) => {
  const root = tempRoot("nowadays-p26-late-usage-");
  const now = new Date("2026-11-21T02:00:00.000Z");
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const app = createBackendApp(config, {
    now: () => now,
    timeZone: "Asia/Shanghai",
    disablePresetAssistant: true,
    disableMemoryRuntime: true,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const resource = app.services.resources.create({
    kind: "model",
    name: "即将删除的服务",
    config: {
      protocol: "openai-chat",
      provider: "deepseek",
      baseUrl: "http://127.0.0.1:1/v1",
      modelName: "late-model",
    },
  });
  const role = app.services.roles.createRole({
    displayName: "即将删除的角色",
    definition: { text: "验证晚到的消耗记账" },
  });
  app.services.roles.createRole({
    displayName: "保底角色",
    definition: { text: "至少保留一个角色" },
  });
  app.services.activity.requestStop(role.roleId);
  assert.equal(app.services.activity.view(role.roleId).state, "stopped");
  await app.services.roleDeletion.remove(role.roleId, false);
  app.services.resources.remove(resource.resourceId);

  // 模拟一次模型调用在角色与服务都已删除之后才完成结算。
  app.services.tokenUsage.recordCall({
    sourceCallId: "late-call-1",
    roleId: role.roleId,
    resourceId: resource.resourceId,
    protocol: "openai-chat",
    modelName: "late-model",
    category: "dialogue",
    status: "succeeded",
    occurredAt: now.toISOString(),
    usage: { inputTokens: 120, cachedTokens: 20, cacheCreationTokens: 5, outputTokens: 30 },
  });

  const summary = app.services.tokenUsage.getSummary({ range: "all" });
  assert.equal(summary.totals.callCount, "1");
  assert.equal(summary.totals.reportedCallCount, "1");
  assert.equal(summary.totals.inputTokens, "120");
  assert.equal(summary.totals.outputTokens, "30");
  assert.equal(summary.totals.totalTokens, "150");
  const roleRow = summary.byRole.find((item) => item.roleId === role.roleId);
  assert.ok(roleRow, "删除角色后晚到的调用仍应计入角色分项");
  assert.equal(roleRow.deleted, true);
  const modelRow = summary.byModel.find((item) => item.resourceId === resource.resourceId);
  assert.ok(modelRow, "删除模型服务后晚到的调用仍应计入模型分项");
  assert.equal(modelRow.deleted, true);
  assert.equal(modelRow.resourceName, "已删除服务");
});

test("V11 升级 V12 一次性幂等回填历史，且单角色迁移导入不叠加进本机账单", { timeout: 30_000 }, async (t) => {
  const sourceRoot = tempRoot("nowadays-p26-src-");
  const targetRoot = tempRoot("nowadays-p26-dst-");
  const now = new Date("2026-11-21T02:00:00.000Z");
  t.after(() => {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
  });

  // 1) 在源安装构造一条历史 model_calls 与一条 model_test_calls，然后把 app.sqlite 退回 V11 模拟老版本升级
  const srcConfig = parseBackendConfig(["--app-root", sourceRoot, "--port", "0"]);
  let roleId = "";
  const firstApp = createBackendApp(srcConfig, {
    now: () => now,
    timeZone: "Asia/Shanghai",
    disablePresetAssistant: true,
    disableMemoryRuntime: true,
  });
  try {
    const role = firstApp.services.roles.createRole({
      displayName: "历史角色",
      definition: { text: "测试升级回填" },
    });
    roleId = role.roleId;
    firstApp.appStore.saveModelTestCall({
      resourceId: null,
      modelName: "legacy-test",
      protocol: "openai-chat",
      status: "succeeded",
      errorCode: null,
      configFingerprint: null,
      startedAt: "2026-11-20T03:00:00.000Z",
      finishedAt: "2026-11-20T03:00:01.000Z",
      usageJson: JSON.stringify({ inputTokens: 100, outputTokens: 20 }),
    });
    const storage = RoleStorage.openExisting(rolePaths(srcConfig.dataRoot, roleId));
    try {
      storage.business.db
        .prepare(
          `INSERT INTO model_calls
             (model_call_id, role_id, execution_id, batch_id, task_id, call_kind,
              purpose, resource_id, model_name, protocol, status, error_code,
              started_at, finished_at, usage_json, raw_response_json)
           VALUES (?, ?, NULL, NULL, NULL, 'primary_decision', 'autonomous', NULL,
                   'legacy-auto', 'openai-chat', 'succeeded', NULL, ?, ?, ?, NULL)`,
        )
        .run(
          randomUUID(),
          roleId,
          "2026-11-20T04:00:00.000Z",
          "2026-11-20T04:00:02.000Z",
          JSON.stringify({ inputTokens: 500, cachedTokens: 200, outputTokens: 90 }),
        );
    } finally {
      storage.close();
    }
  } finally {
    await firstApp.close();
  }

  // 模拟老版 V11 app.sqlite
  const rawApp = new Database(srcConfig.appDatabasePath);
  rawApp.exec(`
    DROP TABLE token_usage_records;
    DROP TABLE token_usage_meta;
  `);
  rawApp.pragma("user_version = 11");
  rawApp.close();

  // 重新启动：自动升级到 V12 并一次性回填 2 条历史记录
  const upgraded = createBackendApp(srcConfig, {
    now: () => now,
    timeZone: "Asia/Shanghai",
    disablePresetAssistant: true,
    disableMemoryRuntime: true,
  });
  try {
    assert.equal(upgraded.appStore.schemaVersion, APP_SCHEMA_VERSION);
    const summary = upgraded.services.tokenUsage.getSummary({ range: "7d" });
    assert.equal(summary.totals.callCount, "2");
    assert.equal(summary.totals.inputTokens, "600");
    assert.equal(summary.totals.cachedTokens, "200");
    assert.equal(summary.totals.outputTokens, "110");
    // 再次调用 backfillOnce 幂等跳过
    assert.deepEqual(upgraded.services.tokenUsage.backfillOnce(), { backfilled: 0, skipped: true });
  } finally {
    await upgraded.close();
  }

  // 2) 导出该角色并导入到一台全新的目标安装：目标安装全局账单必须仍为 0（不叠加导入角色历史）
  const pkg = captureRoleTransfer(srcConfig, roleId);
  const dstConfig = parseBackendConfig(["--app-root", targetRoot, "--port", "0"]);
  const dstBoot = createBackendApp(dstConfig, {
    now: () => now,
    timeZone: "Asia/Shanghai",
    disablePresetAssistant: true,
    disableMemoryRuntime: true,
  });
  await dstBoot.close();

  const targetPaths = rolePaths(dstConfig.dataRoot, roleId);
  stageRoleTransfer(targetPaths, pkg, resolveRoleTransferBindings(dstConfig, pkg, {}));
  const dstAppDb = new Database(dstConfig.appDatabasePath);
  dstAppDb
    .prepare(
      `INSERT OR IGNORE INTO roles (role_id, relative_dir, init_status, init_payload_json, created_at, updated_at)
       VALUES (?, ?, 'ready', ?, ?, ?)`,
    )
    .run(roleId, `roles/${roleId}`, JSON.stringify({ displayName: "历史角色" }), now.toISOString(), now.toISOString());
  dstAppDb.close();

  const dstReopened = createBackendApp(dstConfig, {
    now: () => now,
    timeZone: "Asia/Shanghai",
    disablePresetAssistant: true,
    disableMemoryRuntime: true,
  });
  try {
    const dstSummary = dstReopened.services.tokenUsage.getSummary({ range: "all" });
    assert.equal(dstSummary.totals.callCount, "0");
    assert.equal(dstSummary.totals.totalTokens, "0");
  } finally {
    await dstReopened.close();
  }
});

test("已删除角色与服务的快照名称同步更新至筛选项，且 range=all 不截断未来本地日期", async (t) => {
  const root = tempRoot("nowadays-p26-snapshot-");
  const now = new Date("2026-11-21T02:00:00.000Z"); // Asia/Shanghai 2026-11-21
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const app = createBackendApp(config, {
    now: () => now,
    timeZone: "Asia/Shanghai",
    disablePresetAssistant: true,
    disableMemoryRuntime: true,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const store = new TokenUsageStore(app.appStore.db);
  const rows = [
    {
      sourceCallId: "snap-1",
      localDate: "2026-11-19",
      occurredAt: "2026-11-19T02:00:00.000Z",
      roleName: "",
      resourceName: "",
      provider: null,
    },
    {
      sourceCallId: "snap-2",
      localDate: "2026-11-20",
      occurredAt: "2026-11-20T02:00:00.000Z",
      roleName: "旧角色名",
      resourceName: "旧服务名",
      provider: null,
    },
    {
      sourceCallId: "snap-3",
      localDate: "2026-11-21",
      occurredAt: "2026-11-21T02:00:00.000Z",
      roleName: "新角色名",
      resourceName: "新服务名",
      provider: "deepseek",
    },
  ];
  for (const row of rows) {
    store.upsertRecord({
      sourceCallId: row.sourceCallId,
      localDate: row.localDate,
      occurredAt: row.occurredAt,
      roleId: "del-role-1",
      roleName: row.roleName,
      resourceId: "del-res-1",
      resourceName: row.resourceName,
      provider: row.provider,
      protocol: "openai-chat",
      modelName: "snap-model",
      category: "dialogue",
      status: "succeeded",
      usageReported: true,
      inputTokens: 100n,
      cachedTokens: 0n,
      cacheCreationTokens: 0n,
      outputTokens: 20n,
    });
  }
  // 模拟时区西移或本机时钟回拨后，local_date 落在“当前日期”之后的记录
  store.upsertRecord({
    sourceCallId: "future-tz-1",
    localDate: "2026-11-22",
    occurredAt: "2026-11-21T20:00:00.000Z",
    roleId: "del-role-1",
    roleName: "新角色名",
    resourceId: "del-res-1",
    resourceName: "新服务名",
    provider: "deepseek",
    protocol: "openai-chat",
    modelName: "snap-model",
    category: "dialogue",
    status: "succeeded",
    usageReported: true,
    inputTokens: 50n,
    cachedTokens: 0n,
    cacheCreationTokens: 0n,
    outputTokens: 10n,
  });

  const summary = app.services.tokenUsage.getSummary({ range: "all" });
  assert.equal(summary.totals.callCount, "4");
  assert.equal(summary.totals.totalTokens, "420");
  assert.equal(summary.byRole[0]?.roleName, "新角色名");
  assert.equal(summary.byRole[0]?.deleted, true);
  assert.equal(summary.availableFilters.roles[0]?.roleName, "新角色名");
  assert.equal(summary.availableFilters.roles[0]?.deleted, true);
  assert.equal(summary.byModel[0]?.resourceName, "新服务名");
  assert.equal(summary.byModel[0]?.provider, "deepseek");
  assert.equal(summary.byModel[0]?.deleted, true);
  assert.equal(summary.availableFilters.models[0]?.resourceName, "新服务名");
  assert.equal(summary.availableFilters.models[0]?.deleted, true);
});

test("AgentGraphRunner 与 MemoryService 隔离角色库写失败，且容量超限本地拦截不计入全局失败", async (t) => {
  const root = tempRoot("nowadays-p26-isolation-");
  const now = new Date("2026-11-21T02:00:00.000Z");
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const app = createBackendApp(config, {
    now: () => now,
    timeZone: "Asia/Shanghai",
    disablePresetAssistant: true,
    disableMemoryRuntime: true,
  });
  let saver: SqliteSaver | null = null;
  let storage: RoleStorage | null = null;
  t.after(async () => {
    saver?.db.close();
    storage?.close();
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const role = app.services.roles.createRole({
    displayName: "异常隔离测试角色",
    definition: { text: "测试写失败隔离与容量预检边界" },
  });
  storage = RoleStorage.openExisting(rolePaths(config.dataRoot, role.roleId));
  saver = SqliteSaver.fromConnString(storage.paths.executionDatabasePath);

  // 1) AgentGraphRunner.modelNode：finishModelCall 抛异常时仍仅上报 1 次 succeeded 全局用量
  const convStore = new ConversationStore(storage.business.db, role.roleId, "Asia/Shanghai");
  const execution = storage.business.createExecution({
    roleId: role.roleId,
    windowId: role.defaultWindowId,
    triggerType: "user_message",
    stateVersionLoaded: 1,
  });
  const task = storage.business.createTask({
    roleId: role.roleId,
    goal: "写库故障隔离",
    origin: "user",
    initiatorExecutionId: execution.executionId,
  });
  convStore.finishModelCall = () => {
    throw new Error("SIMULATED_ROLE_DB_WRITE_FAILED");
  };
  const agentEvents: TokenUsageCallEvent[] = [];
  const runner = new AgentGraphRunner(
    {
      store: convStore,
      roleStore: storage.business,
      resolveModel: () => ({
        resourceId: "res-1",
        modelName: "demo-chat",
        protocol: "openai-chat",
        model: {
          async *stream() {
            yield { type: "text_delta", text: "你好" };
            yield { type: "usage", inputTokens: 88, outputTokens: 12 };
            yield { type: "completed", stopReason: "stop" };
          },
        },
      }),
      tools: [],
      systemPrompt: () => "测试提示词",
      signal: new AbortController().signal,
      checkRunning: () => undefined,
      emitDelta: () => undefined,
      ensureTask: () => task.taskId,
      now: () => now,
      purpose: "user_chat",
      onModelCallFinished: (event) => agentEvents.push(event),
    },
    saver,
  );
  await assert.rejects(
    runner.modelNode({
      executionId: execution.executionId,
      roleId: role.roleId,
      windowId: role.defaultWindowId,
      round: 0,
      messages: [{ role: "user", content: "你好" }],
      text: "",
      pendingCalls: [],
      statePatch: {},
      rounds: [],
      taskAction: null,
      taskId: task.taskId,
      modelCallId: null,
      wireMapping: {},
      stopKind: null,
      successfulToolCalls: 0,
      progressNotes: 0,
      lastRoundEchoOnly: false,
    }),
    /SIMULATED_ROLE_DB_WRITE_FAILED/,
  );
  assert.equal(agentEvents.length, 1);
  assert.equal(agentEvents[0]?.status, "succeeded");
  assert.deepEqual(agentEvents[0]?.usage, { inputTokens: 88, outputTokens: 12 });

  // 2) MemoryService：容量预检与前置构造拦截（未调 model.form）不产生全局失败记录；已调 model.form 后角色库写失败仍上报全局用量
  new ConversationStore(storage.business.db, role.roleId, "Asia/Shanghai").appendProactiveMessage({
    windowId: role.defaultWindowId,
    content: "需要整理的一段经历",
    executionId: execution.executionId,
    now: now.toISOString(),
  });
  const memStore = new MemoryStore(storage.business.db);
  const memEvents: TokenUsageCallEvent[] = [];
  let formInvocations = 0;
  const blockedMem = new MemoryService(
    memStore,
    {
      async form() {
        formInvocations += 1;
        return { operations: [] };
      },
    },
    {
      modelInfo: { resourceId: "res-1", modelName: "tiny-mem", protocol: "openai-chat" },
      capacity: { maxInputChars: 50, maxOutputChars: 10, source: "declared" },
      now: () => now,
      timeZone: "Asia/Shanghai",
      onModelCallFinished: (event) => memEvents.push(event),
    },
  );
  blockedMem.enqueueManual(role.roleId);
  const blockedBatch = await blockedMem.runBatch(role.roleId);
  assert.equal(blockedBatch.batchId, null);
  assert.equal(blockedBatch.status, "failed");
  assert.equal(blockedBatch.errorCode, "MEMORY_CAPACITY_EXCEEDED");
  assert.equal(formInvocations, 0);
  assert.equal(memEvents.length, 0);

  // 已 startModelCall 但在调 model.form 前抛出前置异常：本地 model_calls 记 failed，不向全局账本上报
  const origContext = memStore.evidenceMessageContext.bind(memStore);
  memStore.evidenceMessageContext = () => {
    throw new Error("SIMULATED_PRE_CALL_CONTEXT_ERR");
  };
  let preCallBatch: Awaited<ReturnType<MemoryService["runBatch"]>>;
  try {
    const preCallMem = new MemoryService(
      memStore,
      {
        async form() {
          formInvocations += 1;
          return { operations: [] };
        },
      },
      {
        modelInfo: { resourceId: "res-1", modelName: "tiny-mem", protocol: "openai-chat" },
        retryDelaysMs: [0],
        now: () => now,
        timeZone: "Asia/Shanghai",
        onModelCallFinished: (event) => memEvents.push(event),
      },
    );
    preCallMem.enqueueManual(role.roleId);
    preCallBatch = await preCallMem.runBatch(role.roleId);
  } finally {
    memStore.evidenceMessageContext = origContext;
  }
  assert.equal(preCallBatch.status, "failed");
  assert.ok(preCallBatch.batchId !== null);
  assert.equal(formInvocations, 0);
  assert.equal(memEvents.length, 0);
  const preCallRow = storage.business.db
    .prepare("SELECT status FROM model_calls WHERE batch_id = ? LIMIT 1")
    .get(preCallBatch.batchId) as { status: string } | undefined;
  assert.equal(preCallRow?.status, "failed");

  storage.business.db.exec(`
    CREATE TEMP TRIGGER deny_model_calls_update
    BEFORE UPDATE ON model_calls
    BEGIN
      SELECT RAISE(ABORT, 'SIMULATED_MEM_CALL_UPDATE_FAILED');
    END;
  `);
  const later = new Date(now.getTime() + 120_000);
  const invokedMem = new MemoryService(
    memStore,
    new HttpMemoryModel(
      {
        async *stream() {
          yield { type: "text_delta", text: JSON.stringify({ operations: [] }) };
          yield { type: "usage", inputTokens: 320, outputTokens: 40 };
          yield { type: "completed", stopReason: "stop" };
        },
      },
      {
        capability: "memory_model",
        resourceId: "res-1",
        modelName: "demo-mem",
        config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1" },
      },
    ),
    {
      modelInfo: { resourceId: "res-1", modelName: "demo-mem", protocol: "openai-chat" },
      now: () => later,
      timeZone: "Asia/Shanghai",
      onModelCallFinished: (event) => memEvents.push(event),
    },
  );
  invokedMem.enqueueManual(role.roleId);
  const invokedBatch = await invokedMem.runBatch(role.roleId);
  assert.equal(invokedBatch.status, "failed");
  assert.equal(invokedBatch.errorCode, "MEMORY_BATCH_FAILED");
  assert.equal(memEvents.length, 1);
  assert.equal(memEvents[0]?.status, "succeeded");
  assert.deepEqual(memEvents[0]?.usage, { inputTokens: 320, outputTokens: 40 });
});
