import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";
import sharp from "sharp";
import { createBackendApp, listen, type BackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import { ConversationStore } from "../src/storage/conversation-store.js";
import { RoleStorage } from "../src/storage/role-storage.js";
import { SceneImageGenerationFailedError } from "../src/domain/errors.js";
import type {
  SceneImageGenerationInput,
  SceneImageGeneratorPort,
  SceneImageTaskRecord,
} from "../src/domain/scene-image.js";
import { FakeSceneImageGenerator } from "../src/scene/fake-generator.js";
import { FixedSceneImagePlanner } from "../src/scene/fixed-planner.js";
import {
  createFixture as baseCreateFixture,
  createFixtureWithModel as baseCreateFixtureWithModel,
  ScriptedChatModel,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

/**
 * CG-01 契约测试只验证任务与读取链路，固定使用固定规划器，
 * 避免脚本化对话模型被规划调用消耗。
 */
function createFixture(
  scripts: Parameters<typeof baseCreateFixture>[0],
  options: Parameters<typeof baseCreateFixture>[1] = {},
): Fixture {
  return baseCreateFixture(scripts, {
    sceneImagePlanner: new FixedSceneImagePlanner(),
    ...options,
  });
}

function createFixtureWithModel(
  model: Parameters<typeof baseCreateFixtureWithModel>[0],
  options: Parameters<typeof baseCreateFixtureWithModel>[1] = {},
): Fixture {
  return baseCreateFixtureWithModel(model, {
    sceneImagePlanner: new FixedSceneImagePlanner(),
    ...options,
  });
}

const REPLY_CONTENT =
  "今天风不大，适合出门走走。\n（她合上书，抬眼看向你）\n那就去河边吧，我记得那里有一排旧长椅。";

class CountingGenerator implements SceneImageGeneratorPort {
  readonly calls: SceneImageGenerationInput[] = [];
  private readonly inner = new FakeSceneImageGenerator();

  async generate(input: SceneImageGenerationInput) {
    this.calls.push(input);
    return this.inner.generate(input);
  }
}

class FlakyGenerator implements SceneImageGeneratorPort {
  calls = 0;
  private readonly inner = new FakeSceneImageGenerator();

  async generate(input: SceneImageGenerationInput) {
    this.calls += 1;
    if (this.calls === 1) {
      throw new SceneImageGenerationFailedError("上游拒绝了这次生成");
    }
    return this.inner.generate(input);
  }
}

function replyScript(): Array<{ type: "text_delta"; text: string } | { type: "completed"; stopReason: "stop" }> {
  return [
    { type: "text_delta", text: REPLY_CONTENT },
    { type: "completed", stopReason: "stop" },
  ];
}

function submit(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}

async function completedReply(
  fixture: Fixture,
): Promise<{ messageId: string; segmentIds: string[] }> {
  submit(fixture, "今天做什么？");
  await fixture.app.conversation.waitForIdle(fixture.roleId);
  const page = fixture.app.services.messages.list(
    fixture.roleId,
    fixture.windowId,
    null,
    50,
  );
  const reply = page.items.find((message) => message.sender === "assistant");
  assert.ok(reply);
  const segmentIds = page.segments
    .filter((segment) => segment.messageId === reply.messageId)
    .map((segment) => segment.segmentId);
  assert.ok(segmentIds.length >= 3);
  return { messageId: reply.messageId, segmentIds };
}

interface HttpContext {
  port: number;
  base: string;
}

async function httpContext(fixture: Fixture): Promise<HttpContext> {
  const port = await listen(fixture.app.server, 0, "127.0.0.1");
  return {
    port,
    base: `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}`,
  };
}

async function createTask(
  fixture: Fixture,
  http: HttpContext,
  messageId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; task: SceneImageTaskRecord; duplicate: boolean }> {
  const response = await fetch(
    `${http.base}/messages/${messageId}/scene-images`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const payload = (await response.json()) as {
    task: SceneImageTaskRecord;
    duplicate: boolean;
  };
  return { status: response.status, ...payload };
}

async function createTaskError(
  http: HttpContext,
  messageId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; code: string }> {
  const response = await fetch(
    `${http.base}/messages/${messageId}/scene-images`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const payload = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: payload.error.code };
}

function sceneEvents(fixture: Fixture, windowId: string, after = 0) {
  return withStorage(fixture, (storage) =>
    new ConversationStore(
      storage.business.db,
      fixture.roleId,
    ).listStreamEventsAfter(windowId, after),
  );
}

test("manual scene image is queryable from the original window and segment", { timeout: 30_000 }, async () => {
  const fixture = createFixture([replyScript()]);
  try {
    const reply = await completedReply(fixture);
    const http = await httpContext(fixture);
    const created = await createTask(fixture, http, reply.messageId, {
      idempotencyKey: "manual-first",
      layerMode: "background",
    });
    assert.equal(created.status, 201);
    assert.equal(created.duplicate, false);
    assert.equal(created.task.status, "queued");
    assert.equal(created.task.trigger, "manual");
    assert.equal(created.task.layerMode, "background");
    assert.equal(created.task.messageId, reply.messageId);
    assert.equal(created.task.windowId, fixture.windowId);
    assert.equal(created.task.startSegmentId, reply.segmentIds[0]);
    assert.equal(created.task.endSegmentId, reply.segmentIds.at(-1));
    assert.equal(created.task.result, null);

    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);

    const read = await fetch(`${http.base}/scene-images/${created.task.taskId}`);
    assert.equal(read.status, 200);
    const { task } = (await read.json()) as { task: SceneImageTaskRecord };
    assert.equal(task.status, "succeeded");
    assert.equal(task.errorCode, null);
    assert.ok(task.plan);
    assert.equal(task.plan.layerMode, "background");
    assert.ok(task.result);
    assert.equal(task.result.mediaType, "image/png");
    assert.equal(task.result.width, 1024);
    assert.equal(task.result.height, 576);
    assert.equal(task.result.byteSize > 0, true);

    const imageResponse = await fetch(
      `http://127.0.0.1:${http.port}/v1/roles/${fixture.roleId}/scene-images/assets/${task.result.assetId}`,
    );
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 1024);
    assert.equal(metadata.height, 576);

    const snapshot = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      null,
      50,
    );
    assert.equal(snapshot.sceneImages.length, 1);
    assert.equal(snapshot.sceneImages[0]?.taskId, task.taskId);
    assert.equal(
      snapshot.sceneImages[0]?.result?.assetId,
      task.result.assetId,
    );
    assert.deepEqual(
      snapshot.segments.map((segment) => segment.segmentId),
      reply.segmentIds,
    );

    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      reply.messageId,
    );
    assert.equal(detail.sceneImages[0]?.taskId, task.taskId);
    assert.equal(detail.message.content, REPLY_CONTENT);

    const events = sceneEvents(fixture, fixture.windowId).filter(
      (event) => event.type === "scene_image_task",
    );
    assert.deepEqual(
      events.map((event) => event.payload.status),
      ["queued", "planning", "generating", "succeeded"],
    );
    assert.equal(events.at(-1)?.payload.taskId, task.taskId);
  } finally {
    await fixture.close();
  }
});

test("the same idempotency key reuses the task and generates once", { timeout: 30_000 }, async () => {
  const generator = new CountingGenerator();
  const fixture = createFixtureWithModel(new ScriptedChatModel([replyScript()]), {
    sceneImageGenerator: generator,
    sceneImagePlanner: new FixedSceneImagePlanner(),
  });
  try {
    const reply = await completedReply(fixture);
    const http = await httpContext(fixture);
    const [first, second] = await Promise.all([
      createTask(fixture, http, reply.messageId, {
        idempotencyKey: "same-key",
        layerMode: "background",
      }),
      createTask(fixture, http, reply.messageId, {
        idempotencyKey: "same-key",
        layerMode: "background",
      }),
    ]);
    assert.equal(first.task.taskId, second.task.taskId);
    assert.deepEqual(
      [first.status, second.status].sort((left, right) => left - right),
      [200, 201],
    );
    assert.equal(
      [first.duplicate, second.duplicate].filter(Boolean).length,
      1,
    );

    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    assert.equal(generator.calls.length, 1);

    const third = await createTask(fixture, http, reply.messageId, {
      idempotencyKey: "same-key",
      layerMode: "full_scene",
    });
    assert.equal(third.status, 200);
    assert.equal(third.task.taskId, first.task.taskId);
    assert.equal(third.task.layerMode, "background");
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    assert.equal(generator.calls.length, 1);
  } finally {
    await fixture.close();
  }
});

test("scene image tasks reject cross-window, cross-role and non-assistant anchors", { timeout: 30_000 }, async () => {
  const fixture = createFixture([replyScript()]);
  try {
    const reply = await completedReply(fixture);
    const http = await httpContext(fixture);
    const created = await createTask(fixture, http, reply.messageId, {
      idempotencyKey: "ownership",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);

    const otherWindow = fixture.app.services.roles.createWindow(fixture.roleId, {
      kind: "custom",
      source: "nowadays",
    });
    const wrongWindow = await fetch(
      `http://127.0.0.1:${http.port}/v1/roles/${fixture.roleId}/windows/${otherWindow.windowId}/scene-images/${created.task.taskId}`,
    );
    assert.equal(wrongWindow.status, 404);
    assert.equal(
      ((await wrongWindow.json()) as { error: { code: string } }).error.code,
      "SCENE_IMAGE_TASK_NOT_FOUND",
    );

    const otherRole = fixture.app.services.roles.createRole({
      displayName: "另一个角色",
      definition: { text: "你是另一个角色。" },
    });
    const wrongRole = await fetch(
      `http://127.0.0.1:${http.port}/v1/roles/${otherRole.roleId}/windows/${otherRole.defaultWindowId}/scene-images/${created.task.taskId}`,
    );
    assert.equal(wrongRole.status, 404);

    const page = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      null,
      50,
    );
    const userMessage = page.items.find((message) => message.sender === "user");
    assert.ok(userMessage);
    const userAnchor = await createTaskError(http, userMessage.messageId, {
      idempotencyKey: "user-anchor",
    });
    assert.equal(userAnchor.status, 409);
    assert.equal(userAnchor.code, "SCENE_IMAGE_ANCHOR_INVALID");

    const missing = await createTaskError(http, randomUUID(), {
      idempotencyKey: "missing",
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.code, "MESSAGE_NOT_FOUND");
  } finally {
    await fixture.close();
  }
});

test("both layer modes keep their own mode and canvas size", { timeout: 30_000 }, async () => {
  const fixture = createFixture([replyScript()]);
  try {
    const reply = await completedReply(fixture);
    const http = await httpContext(fixture);
    const background = await createTask(fixture, http, reply.messageId, {
      idempotencyKey: "layer-background",
      layerMode: "background",
    });
    const fullScene = await createTask(fixture, http, reply.messageId, {
      idempotencyKey: "layer-full-scene",
      layerMode: "full_scene",
    });
    assert.equal(background.status, 201);
    assert.equal(fullScene.status, 201);
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);

    const tasks = [background.task.taskId, fullScene.task.taskId].map((taskId) =>
      fixture.app.services.sceneImages.getTask(
        fixture.roleId,
        fixture.windowId,
        taskId,
      ),
    );
    assert.deepEqual(
      tasks.map((task) => [task.layerMode, task.result?.width, task.result?.height]),
      [
        ["background", 1024, 576],
        ["full_scene", 832, 1216],
      ],
    );
    assert.equal(tasks[0]?.startSegmentId, reply.segmentIds[0]);
    assert.equal(tasks[1]?.endSegmentId, reply.segmentIds.at(-1));
  } finally {
    await fixture.close();
  }
});

test("generation failure keeps the reply readable and a retry creates a new attempt", { timeout: 30_000 }, async () => {
  const generator = new FlakyGenerator();
  const fixture = createFixtureWithModel(new ScriptedChatModel([replyScript()]), {
    sceneImageGenerator: generator,
    sceneImagePlanner: new FixedSceneImagePlanner(),
  });
  try {
    const reply = await completedReply(fixture);
    const http = await httpContext(fixture);
    const failed = await createTask(fixture, http, reply.messageId, {
      idempotencyKey: "attempt-1",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const failedTask = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      failed.task.taskId,
    );
    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.errorCode, "SCENE_IMAGE_GENERATION_FAILED");
    assert.equal(failedTask.result, null);
    assert.equal(failedTask.attempt, 1);
    assert.equal(generator.calls, 1);

    const assets = withStorage(
      fixture,
      (storage) =>
        (
          storage.business.db
            .prepare("SELECT COUNT(*) AS count FROM scene_image_assets")
            .get() as { count: number }
        ).count,
    );
    assert.equal(assets, 0);
    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      reply.messageId,
    );
    assert.equal(detail.message.content, REPLY_CONTENT);
    assert.equal(detail.segments.length, reply.segmentIds.length);

    const retried = await createTask(fixture, http, reply.messageId, {
      idempotencyKey: "attempt-2",
    });
    assert.notEqual(retried.task.taskId, failed.task.taskId);
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const retriedTask = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      retried.task.taskId,
    );
    assert.equal(retriedTask.status, "succeeded");
    assert.equal(retriedTask.attempt, 2);
    assert.equal(generator.calls, 2);
  } finally {
    await fixture.close();
  }
});

test("a v12 role database migrates to v13 and keeps messages, segments and events", { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-scene-migrate-"));
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const model = new ScriptedChatModel([replyScript()]);
  let app: BackendApp | undefined;
  try {
    app = createBackendApp(config, {
      typingMs: 1000,
      timeZone: "Asia/Shanghai",
      modelPortFactory: () => model,
      disableMemoryRuntime: true,
      sceneImagePlanner: new FixedSceneImagePlanner(),
    });
    const role = app.services.roles.createRole({
      displayName: "阿澄",
      definition: { text: "你是阿澄。" },
    });
    const resource = app.services.resources.create({
      kind: "model",
      name: "离线对话模型",
      config: { protocol: "openai-chat", baseUrl: "http://offline.invalid/v1" },
    });
    app.services.resources.replaceBindings(role.roleId, [
      {
        capability: "chat_model",
        resourceId: resource.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
    ]);
    app.conversation.submitMessage(role.roleId, role.defaultWindowId, {
      content: "今天做什么？",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await app.conversation.waitForIdle(role.roleId);
    const before = app.services.messages.list(
      role.roleId,
      role.defaultWindowId,
      null,
      50,
    );
    const reply = before.items.find((message) => message.sender === "assistant");
    assert.ok(reply);
    const beforeEvents = before.cursor;
    await app.close();
    app = undefined;

    const paths = rolePaths(config.dataRoot, role.roleId);
    const raw = new Database(paths.businessDatabasePath);
    try {
      raw.exec("DROP TABLE scene_image_assets");
      raw.exec("DROP TABLE scene_image_tasks");
      // v12 的库里没有后加的语音启用标记，模拟旧库时一并去掉。
      raw.exec("ALTER TABLE role_voice_settings DROP COLUMN enabled");
      // v12 的库里没有 V17 的外观软删除与句段立绘快照。
      stripAppearanceV17(raw);
      raw.pragma("user_version = 12");
    } finally {
      raw.close();
    }

    app = createBackendApp(config, {
      typingMs: 1000,
      timeZone: "Asia/Shanghai",
      modelPortFactory: () => model,
      disableMemoryRuntime: true,
      sceneImagePlanner: new FixedSceneImagePlanner(),
    });
    const migrated = app.services.messages.list(
      role.roleId,
      role.defaultWindowId,
      null,
      50,
    );
    assert.equal(migrated.items.length, before.items.length);
    assert.equal(migrated.segments.length, before.segments.length);
    assert.equal(migrated.cursor, beforeEvents);
    assert.equal(
      withStorageFor(config, role.roleId, (storage) => storage.business.schemaVersion),
      17,
    );
    const tables = withStorageFor(config, role.roleId, (storage) =>
      (
        storage.business.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    assert.ok(tables.includes("scene_image_tasks"));
    assert.ok(tables.includes("scene_image_assets"));

    const created = app.services.sceneImages.requestManual(
      role.roleId,
      role.defaultWindowId,
      reply.messageId,
      { idempotencyKey: "after-migration" },
    );
    await app.services.sceneImages.waitForIdle(role.roleId);
    const task = app.services.sceneImages.getTask(
      role.roleId,
      role.defaultWindowId,
      created.task.taskId,
    );
    assert.equal(task.status, "succeeded");
    assert.ok(task.result);
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("restart settles unfinished tasks as interrupted and keeps the result readable", { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-scene-restart-"));
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const model = new ScriptedChatModel([replyScript()]);
  let app: BackendApp | undefined;
  try {
    app = createBackendApp(config, {
      typingMs: 1000,
      timeZone: "Asia/Shanghai",
      modelPortFactory: () => model,
      disableMemoryRuntime: true,
      sceneImagePlanner: new FixedSceneImagePlanner(),
    });
    const role = app.services.roles.createRole({
      displayName: "阿澄",
      definition: { text: "你是阿澄。" },
    });
    const resource = app.services.resources.create({
      kind: "model",
      name: "离线对话模型",
      config: { protocol: "openai-chat", baseUrl: "http://offline.invalid/v1" },
    });
    app.services.resources.replaceBindings(role.roleId, [
      {
        capability: "chat_model",
        resourceId: resource.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
    ]);
    app.conversation.submitMessage(role.roleId, role.defaultWindowId, {
      content: "今天做什么？",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await app.conversation.waitForIdle(role.roleId);
    const page = app.services.messages.list(
      role.roleId,
      role.defaultWindowId,
      null,
      50,
    );
    const reply = page.items.find((message) => message.sender === "assistant");
    assert.ok(reply);
    const succeeded = app.services.sceneImages.requestManual(
      role.roleId,
      role.defaultWindowId,
      reply.messageId,
      { idempotencyKey: "before-restart" },
    );
    await app.services.sceneImages.waitForIdle(role.roleId);
    const result = app.services.sceneImages.getTask(
      role.roleId,
      role.defaultWindowId,
      succeeded.task.taskId,
    ).result;
    assert.ok(result);
    await app.close();
    app = undefined;

    const paths = rolePaths(config.dataRoot, role.roleId);
    const raw = new Database(paths.businessDatabasePath);
    const stuckTaskId = randomUUID();
    try {
      const segment = raw
        .prepare(
          "SELECT segment_id, window_id, message_id FROM message_segments WHERE message_id = ? ORDER BY ordinal ASC LIMIT 1",
        )
        .get(reply.messageId) as {
        segment_id: string;
        window_id: string;
        message_id: string;
      };
      const execution = raw
        .prepare("SELECT execution_id FROM messages WHERE message_id = ?")
        .get(reply.messageId) as { execution_id: string };
      raw
        .prepare(
          `INSERT INTO scene_image_tasks
             (task_id, role_id, window_id, message_id, execution_id,
              trigger_source, layer_mode, start_segment_id, end_segment_id,
              status, idempotency_key, attempt_no, plan_json, error_code,
              error_summary, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'manual', 'background', ?, ?, 'generating',
                   'stuck', 1, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          stuckTaskId,
          role.roleId,
          segment.window_id,
          segment.message_id,
          execution.execution_id,
          segment.segment_id,
          segment.segment_id,
          "2026-11-09T00:00:00.000Z",
          "2026-11-09T00:00:00.000Z",
        );
    } finally {
      raw.close();
    }

    app = createBackendApp(config, {
      typingMs: 1000,
      timeZone: "Asia/Shanghai",
      modelPortFactory: () => model,
      disableMemoryRuntime: true,
      sceneImagePlanner: new FixedSceneImagePlanner(),
    });
    const settled = app.services.sceneImages.getTask(
      role.roleId,
      role.defaultWindowId,
      stuckTaskId,
    );
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, "SCENE_IMAGE_INTERRUPTED");

    const kept = app.services.sceneImages.getTask(
      role.roleId,
      role.defaultWindowId,
      succeeded.task.taskId,
    );
    assert.equal(kept.status, "succeeded");
    assert.equal(kept.result?.assetId, result.assetId);
    const image = app.services.sceneImages.readAsset(role.roleId, result.assetId);
    assert.equal(image.mediaType, "image/png");
    const metadata = await sharp(image.data).metadata();
    assert.equal(metadata.width, result.width);
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("SSE reconnect from an earlier cursor replays task state without duplicates", { timeout: 30_000 }, async () => {
  const fixture = createFixture([replyScript()]);
  try {
    const reply = await completedReply(fixture);
    const http = await httpContext(fixture);
    const created = await createTask(fixture, http, reply.messageId, {
      idempotencyKey: "sse-replay",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);

    const events = sceneEvents(fixture, fixture.windowId).filter(
      (event) => event.type === "scene_image_task",
    );
    assert.equal(events.length, 4);
    const ids = events.map((event) => event.streamEventId);
    assert.deepEqual(ids, [...ids].sort((left, right) => left - right));

    const cursor = ids[0]!;
    const response = await fetch(
      `http://127.0.0.1:${http.port}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}/events?after=${cursor}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (!text.includes('"status":"succeeded"')) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const frames = text
      .split("\n\n")
      .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
      .filter((line): line is string => line !== undefined)
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
      .filter((frame) => frame.type === "scene_image_task");
    assert.deepEqual(
      frames.map((frame) => frame.status),
      ["planning", "generating", "succeeded"],
    );
    assert.equal(frames.at(-1)?.taskId, created.task.taskId);

    const replay = sceneEvents(fixture, fixture.windowId, ids.at(-1));
    assert.deepEqual(
      replay.filter((event) => event.type === "scene_image_task"),
      [],
    );
  } finally {
    await fixture.close();
  }
});

function withStorageFor<T>(
  config: ReturnType<typeof parseBackendConfig>,
  roleId: string,
  action: (storage: RoleStorage) => T,
): T {
  const storage = new RoleStorage(rolePaths(config.dataRoot, roleId), "open");
  try {
    return action(storage);
  } finally {
    storage.close();
  }
}

/** 把业务库还原到 V16（去掉 V17 的外观软删除与句段立绘快照），用于复现旧库迁移。 */
function stripAppearanceV17(db: Database.Database): void {
  db.exec("DROP INDEX IF EXISTS idx_outfits_role_name");
  db.exec("DROP INDEX IF EXISTS idx_outfit_assets_single_home");
  db.exec("ALTER TABLE outfits DROP COLUMN deleted_at");
  db.exec("ALTER TABLE outfit_assets DROP COLUMN deleted_at");
  db.exec("ALTER TABLE message_segments DROP COLUMN home_asset_id");
}
