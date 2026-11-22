import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { listen, type BackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelRequest, ModelPort } from "../src/domain/model.js";
import type { MemoryModelPort } from "../src/domain/memory.js";
import type {
  SceneImageGenerationInput,
  SceneImageGeneratorPort,
  SceneImageTaskRecord,
} from "../src/domain/scene-image.js";
import { FakeSceneImageGenerator } from "../src/scene/fake-generator.js";
import { FixedSceneImagePlanner } from "../src/scene/fixed-planner.js";
import { SceneImageStore } from "../src/storage/scene-image-store.js";
import { ConversationStore } from "../src/storage/conversation-store.js";
import {
  addBinding,
  createFixtureWithModel,
  deferred,
  ScriptedChatModel,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

const REPLY_CONTENT =
  "风把河面吹皱了。\n（她把外套拢紧，指向那排旧长椅）\n坐一会儿吧，天还没黑透。";

class RecordingGenerator implements SceneImageGeneratorPort {
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
      throw new Error("上游拒绝了这次生成");
    }
    return this.inner.generate(input);
  }
}

class HangingGenerator implements SceneImageGeneratorPort {
  generate(input: SceneImageGenerationInput): Promise<never> {
    return new Promise((_resolve, reject) => {
      input.signal?.addEventListener("abort", () =>
        reject(new Error("aborted by timeout")),
      );
    });
  }
}

/** 完全忽略取消信号，用于验证服务侧超时与关闭不依赖生成器配合。 */
class IgnoringGenerator implements SceneImageGeneratorPort {
  calls = 0;

  generate(): Promise<never> {
    this.calls += 1;
    return new Promise<never>(() => undefined);
  }
}

function replyScript(text = REPLY_CONTENT): ModelEvent[] {
  return [
    { type: "text_delta", text },
    { type: "completed", stopReason: "stop" },
  ];
}

function planScript(
  build: (payload: {
    segments: Array<{ segmentId: string; ordinal: number }>;
    outfit: { name: string | null };
  }) => Record<string, unknown>,
): (request: ModelRequest) => ModelEvent[] {
  return (request) => {
    const payload = JSON.parse(request.messages[0]?.content ?? "{}") as {
      segments: Array<{ segmentId: string; ordinal: number }>;
      outfit: { name: string | null };
    };
    return [
      {
        type: "text_delta",
        text: JSON.stringify(build(payload)),
      },
      { type: "completed", stopReason: "stop" },
    ];
  };
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

async function send(
  fixture: Fixture,
  content: string,
): Promise<{ messageId: string; segmentIds: string[]; content: string }> {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
  await fixture.app.conversation.waitForIdle(fixture.roleId);
  const page = fixture.app.services.messages.list(
    fixture.roleId,
    fixture.windowId,
    null,
    50,
  );
  const reply = page.items.filter((message) => message.sender === "assistant").at(-1);
  assert.ok(reply);
  const segments = page.segments.filter(
    (segment) => segment.messageId === reply.messageId,
  );
  assert.ok(segments.length >= 1);
  return {
    messageId: reply.messageId,
    segmentIds: segments.map((segment) => segment.segmentId),
    content: reply.content,
  };
}

function modelCalls(fixture: Fixture): Array<{ purpose: string; status: string }> {
  return withStorage(fixture, (storage) =>
    storage.business.db
      .prepare(
        "SELECT purpose, status FROM model_calls ORDER BY started_at ASC, rowid ASC",
      )
      .all() as Array<{ purpose: string; status: string }>,
  );
}

async function magentaReference(): Promise<Buffer> {
  return sharp({
    create: {
      width: 40,
      height: 80,
      channels: 3,
      background: { r: 255, g: 0, b: 255 },
    },
  })
    .png()
    .toBuffer();
}

async function attachOutfit(fixture: Fixture, name: string): Promise<string> {
  const outfit = await fixture.app.services.appearance.importOutfit(
    fixture.roleId,
    {
      name,
      description: "深色长外套与围巾",
      home: { fileName: "home.png", data: await magentaReference() },
    },
  );
  const current = fixture.app.services.roles.getState(fixture.roleId);
  fixture.app.services.roles.setState(fixture.roleId, {
    state: { ...current.state, outfitId: outfit.outfitId },
  });
  return outfit.outfitId;
}

test("the model planner reads the saved reply, outfit and nearby context", { timeout: 60_000 }, async () => {
  const model = new ScriptedChatModel([
    replyScript("早上好，今天风很轻。"),
    replyScript(),
    planScript((payload) => ({
      description: "傍晚的河边，旧长椅沿着石岸排开，暖色路灯刚刚亮起。",
      layerMode: "full_scene",
      startSegmentId: payload.segments[1]?.segmentId,
      endSegmentId: payload.segments[2]?.segmentId,
    })),
  ]);
  const fixture = createFixtureWithModel(model, {
    sceneImageGenerator: new RecordingGenerator(),
  });
  try {
    await attachOutfit(fixture, "深色长外套");
    await send(fixture, "早上好");
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "plan-1",
      layerMode: "full_scene",
    });
    assert.equal(created.status, 201);
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);

    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "succeeded", task.errorSummary ?? "");
    assert.ok(task.plan);
    assert.equal(
      task.plan.description,
      "傍晚的河边，旧长椅沿着石岸排开，暖色路灯刚刚亮起。",
    );
    assert.equal(task.plan.layerMode, "full_scene");
    assert.equal(task.plan.startSegmentId, reply.segmentIds[1]);
    assert.equal(task.plan.endSegmentId, reply.segmentIds[2]);

    const plannerRequest = model.requests[2];
    assert.ok(plannerRequest);
    assert.match(plannerRequest.system, /过场图规划器/);
    assert.match(plannerRequest.system, /深色长外套/);
    assert.match(plannerRequest.system, /深色长外套与围巾/);
    const payload = JSON.parse(plannerRequest.messages[0]?.content ?? "{}") as {
      reply: string;
      context: Array<{ sender: string; content: string }>;
      segments: Array<{ segmentId: string }>;
    };
    assert.equal(payload.reply, REPLY_CONTENT);
    assert.equal(payload.segments.length, reply.segmentIds.length);
    assert.deepEqual(
      payload.context.map((message) => message.sender),
      ["user", "assistant", "user"],
    );
    assert.match(payload.context[1]?.content ?? "", /早上好，今天风很轻/);

    const calls = modelCalls(fixture);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.at(-1), { purpose: "user_chat", status: "succeeded" });
  } finally {
    await fixture.close();
  }
});

test("manual layer mode wins and only full scene carries the outfit reference", { timeout: 60_000 }, async () => {
  const generator = new RecordingGenerator();
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([
      replyScript(),
      planScript((payload) => ({
        description: "河岸的傍晚。",
        layerMode: "background",
        startSegmentId: payload.segments[0]?.segmentId,
        endSegmentId: payload.segments.at(-1)?.segmentId,
      })),
      planScript((payload) => ({
        description: "她站在河岸的旧长椅旁。",
        layerMode: "full_scene",
        startSegmentId: payload.segments[0]?.segmentId,
        endSegmentId: payload.segments.at(-1)?.segmentId,
      })),
    ]),
    { sceneImageGenerator: generator },
  );
  try {
    await attachOutfit(fixture, "深色长外套");
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);

    const background = await createTask(http, reply.messageId, {
      idempotencyKey: "layer-background",
      layerMode: "background",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const backgroundTask = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      background.task.taskId,
    );
    assert.equal(backgroundTask.status, "succeeded", backgroundTask.errorSummary ?? "");
    assert.equal(backgroundTask.plan?.layerMode, "background");
    assert.equal(backgroundTask.result?.width, 1024);
    assert.equal(backgroundTask.result?.height, 576);
    assert.equal(generator.calls[0]?.references, undefined);

    const full = await createTask(http, reply.messageId, {
      idempotencyKey: "layer-full",
      layerMode: "full_scene",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const fullTask = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      full.task.taskId,
    );
    assert.equal(fullTask.status, "succeeded", fullTask.errorSummary ?? "");
    assert.equal(fullTask.plan?.layerMode, "full_scene");
    assert.equal(fullTask.result?.width, 832);
    assert.equal(fullTask.result?.height, 1216);
    const fullInput = generator.calls[1];
    assert.equal(fullInput?.references?.length, 1);
    assert.equal(fullInput?.references?.[0]?.role, "character");

    // 参考图确实合成进了画面：底部中央应接近素材的品红色。
    const image = fixture.app.services.sceneImages.readAsset(
      fixture.roleId,
      fullTask.result!.assetId,
    );
    const pixel = await sharp(image.data)
      .extract({ left: 416, top: 1200, width: 1, height: 1 })
      .raw()
      .toBuffer();
    assert.ok(pixel[0]! > 200, `red channel ${pixel[0]}`);
    assert.ok(pixel[1]! < 60, `green channel ${pixel[1]}`);
    assert.ok(pixel[2]! > 200, `blue channel ${pixel[2]}`);
  } finally {
    await fixture.close();
  }
});

test("an invalid plan range fails the task while the reply stays readable", { timeout: 60_000 }, async () => {
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([
      replyScript(),
      planScript(() => ({
        description: "不存在的区间。",
        layerMode: "background",
        startSegmentId: "segment-from-another-message",
        endSegmentId: "segment-from-another-message",
      })),
    ]),
  );
  try {
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "bad-range",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "failed");
    assert.equal(task.errorCode, "SCENE_IMAGE_PLAN_INVALID");
    assert.equal(task.result, null);

    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      reply.messageId,
    );
    assert.equal(detail.message.content, REPLY_CONTENT);
    assert.equal(detail.segments.length, reply.segmentIds.length);
  } finally {
    await fixture.close();
  }
});

test("without a chat binding the fixed planner keeps manual generation working", { timeout: 60_000 }, async () => {
  const generator = new RecordingGenerator();
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([replyScript()]),
    { sceneImageGenerator: generator },
  );
  try {
    const reply = await send(fixture, "去河边走走吧");
    fixture.app.services.resources.replaceBindings(fixture.roleId, []);
    const http = await httpContext(fixture);
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "fallback",
      layerMode: "background",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "succeeded", task.errorSummary ?? "");
    assert.equal(task.plan?.layerMode, "background");
    assert.match(task.plan?.description ?? "", /环境背景/);
    assert.equal(generator.calls.length, 1);
  } finally {
    await fixture.close();
  }
});

test("a failed result is reused for the same key and retried as a new attempt", { timeout: 60_000 }, async () => {
  const generator = new FlakyGenerator();
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([replyScript()]),
    {
      sceneImageGenerator: generator,
      sceneImagePlanner: new FixedSceneImagePlanner(),
    },
  );
  try {
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);
    const first = await createTask(http, reply.messageId, {
      idempotencyKey: "retry-key",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const failed = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      first.task.taskId,
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempt, 1);

    const replay = await createTask(http, reply.messageId, {
      idempotencyKey: "retry-key",
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.task.taskId, first.task.taskId);
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    assert.equal(generator.calls, 1, "同一幂等键不应重新生成");

    const retry = await createTask(http, reply.messageId, {
      idempotencyKey: "retry-key-2",
    });
    assert.equal(retry.status, 201);
    assert.equal(retry.task.attempt, 2);
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const succeeded = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      retry.task.taskId,
    );
    assert.equal(succeeded.status, "succeeded", succeeded.errorSummary ?? "");
    assert.ok(succeeded.result);
    assert.equal(generator.calls, 2);
  } finally {
    await fixture.close();
  }
});

test("a generation timeout is recorded without blocking the reply", { timeout: 60_000 }, async () => {
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([replyScript()]),
    {
      sceneImageGenerator: new HangingGenerator(),
      sceneImagePlanner: new FixedSceneImagePlanner(),
      sceneImageGenerationTimeoutMs: 60,
    },
  );
  try {
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "timeout",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "failed");
    assert.equal(task.errorCode, "SCENE_IMAGE_GENERATION_TIMEOUT");
    assert.equal(task.result, null);
    assert.match(task.errorSummary ?? "", /超时/);

    const detail = fixture.app.services.messages.get(
      fixture.roleId,
      fixture.windowId,
      reply.messageId,
    );
    assert.equal(detail.message.content, REPLY_CONTENT);
  } finally {
    await fixture.close();
  }
});

test("timeout and close settle even when the generator ignores the abort signal", { timeout: 30_000 }, async () => {
  const generator = new IgnoringGenerator();
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([replyScript()]),
    {
      sceneImageGenerator: generator,
      sceneImagePlanner: new FixedSceneImagePlanner(),
      sceneImageGenerationTimeoutMs: 40,
    },
  );
  try {
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "ignoring-abort",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "failed");
    assert.equal(task.errorCode, "SCENE_IMAGE_GENERATION_TIMEOUT");
    assert.equal(generator.calls, 1);

    // 生成器仍挂起，关闭不能被它拖住。
    const started = Date.now();
    await fixture.app.close();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `close took ${elapsed}ms`);
  } finally {
    await fixture.close();
  }
});

test("the planner registers the model call before it is sent", { timeout: 30_000 }, async () => {
  const generator = new RecordingGenerator();
  const model = new ScriptedChatModel([replyScript()]);
  const fixture = createFixtureWithModel(model, {
    sceneImageGenerator: generator,
  });
  try {
    const reply = await send(fixture, "去河边走走吧");
    withStorage(fixture, (storage) => {
      storage.business.db.exec(
        "CREATE TRIGGER block_model_calls BEFORE INSERT ON model_calls BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
      );
    });
    const http = await httpContext(fixture);
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "blocked-registration",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "failed");
    assert.equal(task.errorCode, "SCENE_IMAGE_PLAN_UNAVAILABLE");
    assert.equal(model.requests.length, 1, "登记失败时不应发出规划请求");
    assert.equal(generator.calls.length, 0);
  } finally {
    await fixture.close();
  }
});

test("a plan that contradicts the requested layer is rejected before generation", { timeout: 30_000 }, async () => {
  const generator = new RecordingGenerator();
  const model = new ScriptedChatModel([
    replyScript(),
    planScript((payload) => ({
      description: "夏澄站在窗边向镜头挥手。",
      layerMode: "full_scene",
      startSegmentId: payload.segments[0]?.segmentId,
      endSegmentId: payload.segments.at(-1)?.segmentId,
    })),
  ]);
  const fixture = createFixtureWithModel(model, {
    sceneImageGenerator: generator,
  });
  try {
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "layer-conflict",
      layerMode: "background",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "failed");
    assert.equal(task.errorCode, "SCENE_IMAGE_PLAN_INVALID");
    assert.equal(generator.calls.length, 0, "冲突方案不应送到生成端");

    const plannerRequest = model.requests[1];
    assert.ok(plannerRequest);
    assert.match(plannerRequest.system, /layerMode="background"/);
    assert.match(plannerRequest.system, /不要描述人物/);
    const payload = JSON.parse(plannerRequest.messages[0]?.content ?? "{}") as {
      requestedLayerMode: string | null;
    };
    assert.equal(payload.requestedLayerMode, "background");
  } finally {
    await fixture.close();
  }
});

test("a historical reply without a saved outfit does not inherit the current outfit", { timeout: 30_000 }, async () => {
  const generator = new RecordingGenerator();
  const model = new ScriptedChatModel([
    replyScript(),
    planScript((payload) => ({
      description: "傍晚的河岸，旧长椅空着。",
      layerMode: "full_scene",
      startSegmentId: payload.segments[0]?.segmentId,
      endSegmentId: payload.segments.at(-1)?.segmentId,
    })),
  ]);
  const fixture = createFixtureWithModel(model, {
    sceneImageGenerator: generator,
  });
  try {
    const reply = await send(fixture, "去河边走走吧");
    // 回复保存时没有服饰；之后换装不应回填到旧场景。
    await attachOutfit(fixture, "深色长外套");
    const http = await httpContext(fixture);
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "historical-outfit",
      layerMode: "full_scene",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "succeeded", task.errorSummary ?? "");
    assert.equal(task.plan?.layerMode, "full_scene");

    const payload = JSON.parse(
      model.requests[1]?.messages[0]?.content ?? "{}",
    ) as { outfit: { name: string | null } };
    assert.equal(payload.outfit.name, null);
    assert.equal(generator.calls[0]?.references, undefined);
  } finally {
    await fixture.close();
  }
});

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test("close settles while the image is still decoding", { timeout: 30_000 }, async () => {
  const decoding = gate();
  const release = gate();
  const inspector = async () => {
    decoding.open();
    await release.promise;
    return { mediaType: "image/png", extension: ".png", width: 10, height: 10 };
  };
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([replyScript()]),
    {
      sceneImageGenerator: new FakeSceneImageGenerator(),
      sceneImagePlanner: new FixedSceneImagePlanner(),
      sceneImageInspector: inspector,
    },
  );
  try {
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "decode-close",
    });
    await decoding.promise;

    const started = Date.now();
    await fixture.app.close();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `close took ${elapsed}ms`);

    const task = withStorage(fixture, (storage) =>
      new SceneImageStore(storage.business.db, fixture.roleId).getTask(
        fixture.windowId,
        created.task.taskId,
      ),
    );
    assert.equal(task?.status, "failed");
    assert.equal(task?.errorCode, "SCENE_IMAGE_INTERRUPTED");
    assert.equal(task?.result, null);
    const dir = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).sceneImageDir;
    assert.deepEqual(fs.readdirSync(dir), []);
    release.open();
  } finally {
    release.open();
    await fixture.close();
  }
});

test("a plan without a valid layer is rejected when a layer was requested", { timeout: 30_000 }, async () => {
  const generator = new RecordingGenerator();
  const model = new ScriptedChatModel([
    replyScript(),
    planScript((payload) => ({
      description: "夏澄站在窗边，向镜头挥手。",
      startSegmentId: payload.segments[0]?.segmentId,
      endSegmentId: payload.segments.at(-1)?.segmentId,
    })),
    planScript((payload) => ({
      description: "夏澄站在窗边，向镜头挥手。",
      layerMode: "portrait",
      startSegmentId: payload.segments[0]?.segmentId,
      endSegmentId: payload.segments.at(-1)?.segmentId,
    })),
  ]);
  const fixture = createFixtureWithModel(model, {
    sceneImageGenerator: generator,
  });
  try {
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);
    for (const [key, expected] of [
      ["missing-layer", "SCENE_IMAGE_PLAN_INVALID"],
      ["invalid-layer", "SCENE_IMAGE_PLAN_INVALID"],
    ] as const) {
      const created = await createTask(http, reply.messageId, {
        idempotencyKey: key,
        layerMode: "background",
      });
      await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
      const task = fixture.app.services.sceneImages.getTask(
        fixture.roleId,
        fixture.windowId,
        created.task.taskId,
      );
      assert.equal(task.status, "failed", `${key} should fail`);
      assert.equal(task.errorCode, expected);
    }
    assert.equal(generator.calls.length, 0);
  } finally {
    await fixture.close();
  }
});

test("the fixed fallback keeps a background prompt free of the character", { timeout: 30_000 }, async () => {
  const generator = new RecordingGenerator();
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([replyScript()]),
    { sceneImageGenerator: generator },
  );
  try {
    await attachOutfit(fixture, "深色长外套");
    const reply = await send(fixture, "去河边走走吧");
    fixture.app.services.resources.replaceBindings(fixture.roleId, []);
    const http = await httpContext(fixture);
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "fallback-background",
      layerMode: "background",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "succeeded", task.errorSummary ?? "");
    const prompt = generator.calls[0]?.prompt ?? "";
    assert.match(prompt, /环境背景/);
    assert.doesNotMatch(prompt, /深色长外套/);
    assert.doesNotMatch(prompt, /外套拢紧|挥手/);
    assert.equal(generator.calls[0]?.references, undefined);
  } finally {
    await fixture.close();
  }
});

test("a partial write failure leaves no orphan scene image", { timeout: 30_000 }, async () => {
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([replyScript()]),
    {
      sceneImageGenerator: new FakeSceneImageGenerator(),
      sceneImagePlanner: new FixedSceneImagePlanner(),
    },
  );
  const originalWrite = fs.writeFileSync;
  const patched = fs as unknown as { writeFileSync: typeof fs.writeFileSync };
  try {
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);
    let injected = false;
    patched.writeFileSync = ((target: unknown, data: unknown, options?: unknown) => {
      const isSceneWrite =
        typeof target === "number" || String(target).includes("scene-images");
      if (!injected && isSceneWrite) {
        injected = true;
        // 模拟排他写入先落盘一部分，再因磁盘空间不足失败。
        const partial = Buffer.from(data as Buffer).subarray(0, 12);
        if (typeof target === "number") {
          originalWrite.call(fs, target, partial);
        } else {
          originalWrite.call(fs, target as never, partial, {
            flag: "wx",
          } as never);
        }
        const error = Object.assign(
          new Error("ENOSPC: no space left on device"),
          { code: "ENOSPC" },
        );
        throw error;
      }
      return originalWrite.call(
        fs,
        target as never,
        data as never,
        options as never,
      );
    }) as typeof fs.writeFileSync;

    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "partial-write",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    patched.writeFileSync = originalWrite;

    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "failed");
    assert.equal(task.errorCode, "SCENE_IMAGE_GENERATION_FAILED");
    assert.equal(task.result, null);
    const dir = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).sceneImageDir;
    assert.deepEqual(fs.readdirSync(dir), []);
    const assets = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT COUNT(*) AS total FROM scene_image_assets")
        .get() as { total: number },
    );
    assert.equal(assets.total, 0);
  } finally {
    patched.writeFileSync = originalWrite;
    await fixture.close();
  }
});

test("an existing target is not deleted when exclusive open fails", { timeout: 30_000 }, async () => {
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([replyScript()]),
    {
      sceneImageGenerator: new FakeSceneImageGenerator(),
      sceneImagePlanner: new FixedSceneImagePlanner(),
    },
  );
  const originalOpen = fs.openSync;
  const patched = fs as unknown as { openSync: typeof fs.openSync };
  try {
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);
    let injected = false;
    patched.openSync = ((target: unknown, flags?: unknown, mode?: unknown) => {
      const filePath = String(target);
      if (!injected && filePath.includes("scene-images")) {
        injected = true;
        // 目标已存在：先放入一张已有素材，再让排他打开失败。
        fs.writeFileSync(filePath, Buffer.from("existing-asset"));
        const error = Object.assign(
          new Error("EEXIST: file already exists"),
          { code: "EEXIST" },
        );
        throw error;
      }
      return originalOpen(
        target as fs.PathLike,
        flags as string,
        mode as fs.Mode,
      );
    }) as typeof fs.openSync;

    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "existing-target",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    patched.openSync = originalOpen;

    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "failed");
    const dir = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).sceneImageDir;
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1, "已有素材不应被删除");
    assert.equal(
      fs.readFileSync(path.join(dir, files[0]!), "utf8"),
      "existing-asset",
    );
    const assets = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT COUNT(*) AS total FROM scene_image_assets")
        .get() as { total: number },
    );
    assert.equal(assets.total, 0);
  } finally {
    patched.openSync = originalOpen;
    await fixture.close();
  }
});

test("a rejected cleanup still settles the task and keeps the original failure", { timeout: 30_000 }, async () => {
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([replyScript()]),
    {
      sceneImageGenerator: new FakeSceneImageGenerator(),
      sceneImagePlanner: new FixedSceneImagePlanner(),
    },
  );
  const originalWrite = fs.writeFileSync;
  const originalRemove = fs.rmSync;
  const patchedWrite = fs as unknown as { writeFileSync: typeof fs.writeFileSync };
  const patchedRemove = fs as unknown as { rmSync: typeof fs.rmSync };
  try {
    const reply = await send(fixture, "去河边走走吧");
    const http = await httpContext(fixture);
    let wrote = false;
    patchedWrite.writeFileSync = ((target: unknown, data: unknown, options?: unknown) => {
      const isSceneWrite =
        typeof target === "number" || String(target).includes("scene-images");
      if (!wrote && isSceneWrite) {
        wrote = true;
        const partial = Buffer.from(data as Buffer).subarray(0, 12);
        if (typeof target === "number") {
          originalWrite.call(fs, target, partial);
        } else {
          originalWrite.call(fs, target as never, partial, {
            flag: "wx",
          } as never);
        }
        const error = Object.assign(
          new Error("ENOSPC: no space left on device"),
          { code: "ENOSPC" },
        );
        throw error;
      }
      return originalWrite.call(
        fs,
        target as never,
        data as never,
        options as never,
      );
    }) as typeof fs.writeFileSync;
    patchedRemove.rmSync = ((target: unknown, options?: unknown) => {
      if (String(target).includes("scene-images")) {
        const error = Object.assign(
          new Error("EPERM: operation not permitted"),
          { code: "EPERM" },
        );
        throw error;
      }
      return originalRemove.call(fs, target as never, options as never);
    }) as typeof fs.rmSync;

    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "cleanup-rejected",
    });
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    patchedWrite.writeFileSync = originalWrite;
    patchedRemove.rmSync = originalRemove;

    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "failed", "清理失败也必须留下终态");
    assert.equal(task.errorCode, "SCENE_IMAGE_GENERATION_FAILED");
    assert.match(task.errorSummary ?? "", /ENOSPC/);
    assert.match(task.errorSummary ?? "", /未提交文件未能清理/);
    assert.equal(task.result, null);

    const dir = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).sceneImageDir;
    const leftovers = fs.readdirSync(dir);
    assert.equal(leftovers.length, 1, "清理被拒绝时保留残留文件以便追溯");
    assert.equal(fs.statSync(path.join(dir, leftovers[0]!)).size, 12);

    const events = withStorage(fixture, (storage) =>
      new ConversationStore(
        storage.business.db,
        fixture.roleId,
      ).listStreamEventsAfter(fixture.windowId, 0),
    ).filter((event) => event.type === "scene_image_task");
    assert.equal(events.at(-1)?.payload.status, "failed");

    const replay = await createTask(http, reply.messageId, {
      idempotencyKey: "cleanup-rejected",
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.task.status, "failed");
  } finally {
    patchedWrite.writeFileSync = originalWrite;
    patchedRemove.rmSync = originalRemove;
    await fixture.close();
  }
});

test("scene planning waits for the model service maintenance window", { timeout: 60_000 }, async () => {
  const memoryStarted = deferred<void>();
  const memoryRelease = deferred<void>();
  const memoryModel: MemoryModelPort = {
    async form() {
      memoryStarted.resolve();
      await memoryRelease.promise;
      return {};
    },
  };
  const model = new ScriptedChatModel([
    replyScript(),
    planScript((payload) => ({
      description: "维护结束后的河边，路灯已经亮起。",
      layerMode: "full_scene",
      startSegmentId: payload.segments[0]?.segmentId,
      endSegmentId: payload.segments[payload.segments.length - 1]?.segmentId,
    })),
  ]);
  const fixture = createFixtureWithModel(model, {
    disableMemoryRuntime: false,
    memoryModelFactory: () => memoryModel,
    sceneImageGenerator: new RecordingGenerator(),
  });
  let patch: Promise<Response> | null = null;
  try {
    await attachOutfit(fixture, "深色长外套");
    const reply = await send(fixture, "去河边走走吧");
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    // 让目标服务上有一个挂起的后台记忆调用，模型维护进入等待。
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    addBinding(fixture, "memory_model", resource.resourceId);
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const memory = await fetch(
      `${base}/v1/roles/${fixture.roleId}/memory/batches`,
      { method: "POST" },
    );
    assert.equal(memory.status, 202);
    await memoryStarted.promise;

    const originalUrl = String(resource.config.baseUrl);
    patch = fetch(`${base}/v1/resources/${resource.resourceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: { ...resource.config, baseUrl: `${originalUrl}-v2` },
      }),
    });
    await waitFor(() =>
      fixture.app.services.resources.isUnderMaintenance(resource.resourceId),
    );

    const http: HttpContext = {
      port,
      base: `${base}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}`,
    };
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "maintenance-plan",
      layerMode: "full_scene",
    });
    assert.equal(created.status, 201);
    // 维护期间不领取规划调用：只有回复那一轮用过对话模型。
    await delayMs(400);
    assert.equal(model.requests.length, 1);
    const waiting = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.notEqual(waiting.status, "succeeded");

    memoryRelease.resolve();
    const patched = await patch;
    assert.equal(patched.status, 200);
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "succeeded", task.errorSummary ?? "");
    assert.match(task.plan?.description ?? "", /维护结束后的河边/);
    assert.ok(model.requests.length >= 2, "维护结束后重新领取规划调用");
  } finally {
    memoryRelease.resolve();
    if (patch !== null) {
      await patch.catch(() => undefined);
    }
    await fixture.close();
  }
});

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delayMs(20);
  }
  throw new Error("WAIT_TIMEOUT");
}

/** 第一轮回复，第二轮规划挂起；用于观察规划在途占用。 */
class HangingPlanModel implements ModelPort {
  readonly planStarted = deferred<void>();
  readonly planRelease = deferred<void>();
  private calls = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "text_delta", text: REPLY_CONTENT };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    this.planStarted.resolve();
    await this.planRelease.promise;
    const payload = JSON.parse(request.messages[0]?.content ?? "{}") as {
      segments: Array<{ segmentId: string }>;
    };
    yield {
      type: "text_delta",
      text: JSON.stringify({
        description: "在途规划完成的画面。",
        layerMode: "full_scene",
        startSegmentId: payload.segments[0]?.segmentId,
        endSegmentId: payload.segments.at(-1)?.segmentId,
      }),
    };
    yield { type: "completed", stopReason: "stop" };
  }
}

/** 第一轮回复，第二轮句段标注挂起；用于观察标注在途占用。 */
class HangingAnnotationModel implements ModelPort {
  readonly annotationStarted = deferred<void>();
  readonly annotationRelease = deferred<void>();
  private calls = 0;

  async *stream(): AsyncIterable<ModelEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "text_delta", text: REPLY_CONTENT };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    this.annotationStarted.resolve();
    await this.annotationRelease.promise;
    yield { type: "text_delta", text: '{"segments":[]}' };
    yield { type: "completed", stopReason: "stop" };
  }
}

async function attachOutfitWithSprite(fixture: Fixture, name: string): Promise<string> {
  const png = await sharp({
    create: {
      width: 40,
      height: 80,
      channels: 3,
      background: { r: 120, g: 130, b: 220 },
    },
  })
    .png()
    .toBuffer();
  const outfit = await fixture.app.services.appearance.importOutfit(
    fixture.roleId,
    {
      name,
      description: "用于标注在途检查",
      home: { fileName: "home.png", data: png },
      sprites: [{ fileName: "微笑.png", data: png }],
    },
  );
  const current = fixture.app.services.roles.getState(fixture.roleId);
  fixture.app.services.roles.setState(fixture.roleId, {
    state: { ...current.state, outfitId: outfit.outfitId },
  });
  return outfit.outfitId;
}

test("删除收尾期间拒绝该角色的新过场图任务", { timeout: 60_000 }, async () => {
  const model = new HangingAnnotationModel();
  const fixture = createFixtureWithModel(model);
  try {
    await attachOutfitWithSprite(fixture, "删除期服饰");
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = resourceBase(port);
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "删除前的一句话",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await model.annotationStarted.promise;
    const page = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      null,
      50,
    );
    const reply = page.items.filter((item) => item.sender === "assistant").at(-1);
    assert.ok(reply);
    const kept = fixture.app.services.roles.createRole({
      displayName: "留下的角色",
      definition: { text: "用于删除时保留一个角色" },
    });
    fixture.app.services.activity.requestStop(fixture.roleId);
    await waitFor(
      () =>
        fixture.app.services.activity.view(fixture.roleId).state === "stopped",
    );

    const deletion = fetch(
      `${base}/v1/roles/${fixture.roleId}?keepHistory=1`,
      { method: "DELETE" },
    );
    await waitFor(() =>
      fixture.app.services.roleDeletion.isDeleting(fixture.roleId),
    );
    assert.equal(
      fixture.app.services.roleDeletion.isDeleting(kept.roleId),
      false,
      "其他角色不受影响",
    );

    const blocked = await fetch(
      `${base}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}/messages/${reply.messageId}/scene-images`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "during-delete" }),
      },
    );
    assert.equal(blocked.status, 409);
    const body = (await blocked.json()) as {
      error?: { code?: string };
    };
    assert.equal(body.error?.code, "ROLE_DELETING");

    const blockedMemory = await fetch(
      `${base}/v1/roles/${fixture.roleId}/memory/batches`,
      { method: "POST" },
    );
    assert.equal(blockedMemory.status, 409);
    assert.equal(
      ((await blockedMemory.json()) as { error?: { code?: string } }).error
        ?.code,
      "ROLE_DELETING",
    );
    const otherMemory = await fetch(
      `${base}/v1/roles/${kept.roleId}/memory/batches`,
      { method: "POST" },
    );
    assert.equal(otherMemory.status, 202, "其他角色的整理不受影响");

    model.annotationRelease.resolve();
    const removed = await deletion;
    assert.equal(removed.status, 200);
  } finally {
    model.annotationRelease.resolve();
    await fixture.close();
  }
});

test("删除失败后角色仍可创建过场图任务", { timeout: 60_000 }, async () => {
  const model = new ScriptedChatModel([
    replyScript(),
    planScript((payload) => ({
      description: "删除失败后的画面。",
      layerMode: "full_scene",
      startSegmentId: payload.segments[0]?.segmentId,
      endSegmentId: payload.segments[payload.segments.length - 1]?.segmentId,
    })),
  ]);
  const fixture = createFixtureWithModel(model, {
    sceneImageGenerator: new RecordingGenerator(),
  });
  const conversation = fixture.app.conversation;
  const originalQuiescent = conversation.waitForQuiescent;
  try {
    await attachOutfit(fixture, "删除失败服饰");
    const reply = await send(fixture, "删除失败前的回复");
    fixture.app.services.roles.createRole({
      displayName: "留下的角色",
      definition: { text: "用于删除时保留一个角色" },
    });
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = resourceBase(port);

    conversation.waitForQuiescent = async () => {
      throw new Error("BUSY");
    };
    const failed = await fetch(
      `${base}/v1/roles/${fixture.roleId}?keepHistory=1`,
      { method: "DELETE" },
    );
    assert.equal(failed.status, 409);
    conversation.waitForQuiescent = originalQuiescent;
    assert.equal(
      fixture.app.services.roleDeletion.isDeleting(fixture.roleId),
      false,
      "删除失败后不应继续保持删除保护",
    );
    const memoryAfterFailure = await fetch(
      `${base}/v1/roles/${fixture.roleId}/memory/batches`,
      { method: "POST" },
    );
    assert.equal(memoryAfterFailure.status, 202, "删除失败后整理恢复可用");

    const http: HttpContext = {
      port,
      base: `${base}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}`,
    };
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "after-failed-delete",
      layerMode: "full_scene",
    });
    assert.equal(created.status, 201);
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "succeeded", task.errorSummary ?? "");
  } finally {
    conversation.waitForQuiescent = originalQuiescent;
    await fixture.close();
  }
});

/** 收到取消后仍要一段时间才结算的规划模型，用于删除等待。 */
class SlowCancelPlanModel implements ModelPort {
  readonly planStarted = deferred<void>();
  readonly cancelReceived = deferred<void>();
  readonly settle = deferred<void>();
  private calls = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "text_delta", text: REPLY_CONTENT };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    this.planStarted.resolve();
    await new Promise<void>((resolve) => {
      const done = () => {
        this.cancelReceived.resolve();
        void this.settle.promise.then(() => resolve());
      };
      if (request.signal?.aborted === true) {
        done();
      } else {
        request.signal?.addEventListener("abort", done, { once: true });
      }
    });
    if (request.signal?.aborted === true) {
      throw new Error("canceled after settle");
    }
    yield {
      type: "text_delta",
      text: JSON.stringify({
        description: "取消前完成的规划。",
        layerMode: "full_scene",
        startSegmentId: "",
        endSegmentId: "",
      }),
    };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("删除等待已领取的规划真正结算后才移除角色", { timeout: 60_000 }, async () => {
  const model = new SlowCancelPlanModel();
  const fixture = createFixtureWithModel(model, {
    sceneImageGenerator: new RecordingGenerator(),
  });
  try {
    await attachOutfit(fixture, "取消等待服饰");
    const reply = await send(fixture, "删除前完成规划");
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = resourceBase(port);
    const http: HttpContext = {
      port,
      base: `${base}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}`,
    };
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "slow-cancel-plan",
      layerMode: "full_scene",
    });
    assert.equal(created.status, 201);
    await model.planStarted.promise;
    fixture.app.services.roles.createRole({
      displayName: "留下角色",
      definition: { text: "用于删除时保留一个角色" },
    });
    assert.equal(
      fixture.app.services.activity.requestStop(fixture.roleId).confirmed,
      true,
    );

    const deletion = fetch(
      `${base}/v1/roles/${fixture.roleId}?keepHistory=1`,
      { method: "DELETE" },
    );
    await model.cancelReceived.promise;
    // 外层取消已经结束，但模型仍在收尾：删除必须继续等领取释放。
    const early = await Promise.race([
      deletion.then(() => "done"),
      delayMs(400).then(() => "waiting"),
    ]);
    assert.equal(early, "waiting", "规划结算前不得移除角色");
    assert.equal(
      fixture.app.services.resources.inflightRoleIds(
        fixture.app.services.resources.list("model")[0]!.resourceId,
      ).includes(fixture.roleId),
      true,
      "结算前仍保持 INFLIGHT_CALL",
    );

    model.settle.resolve();
    const removed = await deletion;
    assert.equal(removed.status, 200);
    assert.equal(
      fixture.app.services.roles.listRoles().some(
        (role) => role.roleId === fixture.roleId,
      ),
      false,
    );
  } finally {
    model.settle.resolve();
    await fixture.close();
  }
});

function resourceBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

test("规划模型调用在途时计入占用并阻挡服务修改", { timeout: 60_000 }, async () => {
  const model = new HangingPlanModel();
  const fixture = createFixtureWithModel(model, {
    sceneImageGenerator: new RecordingGenerator(),
  });
  let patch: Promise<Response> | null = null;
  try {
    await attachOutfit(fixture, "深色长外套");
    const reply = await send(fixture, "去河边走走吧");
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const http: HttpContext = {
      port,
      base: `${resourceBase(port)}/v1/roles/${fixture.roleId}/windows/${fixture.windowId}`,
    };
    const created = await createTask(http, reply.messageId, {
      idempotencyKey: "inflight-plan",
      layerMode: "full_scene",
    });
    assert.equal(created.status, 201);
    await model.planStarted.promise;

    const busy = fixture.app.services.resources.references(resource.resourceId);
    assert.ok(
      busy.references.some((item) => item.reason === "INFLIGHT_CALL"),
      "在途规划应出现在引用报告里",
    );
    assert.equal(busy.canDelete, false);

    const originalUrl = String(resource.config.baseUrl);
    patch = fetch(
      `${resourceBase(port)}/v1/resources/${resource.resourceId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: { ...resource.config, baseUrl: `${originalUrl}-v2` },
        }),
      },
    );
    await waitFor(() =>
      fixture.app.services.resources.isUnderMaintenance(resource.resourceId),
    );
    await delayMs(300);
    assert.equal(
      String(
        fixture.app.services.resources.get(resource.resourceId).config.baseUrl,
      ),
      originalUrl,
      "规划结算前不得写入新地址",
    );

    model.planRelease.resolve();
    const patched = await patch;
    assert.equal(patched.status, 200);
    await fixture.app.services.sceneImages.waitForIdle(fixture.roleId);
    const task = fixture.app.services.sceneImages.getTask(
      fixture.roleId,
      fixture.windowId,
      created.task.taskId,
    );
    assert.equal(task.status, "succeeded", task.errorSummary ?? "");
    assert.equal(
      fixture.app.services.resources
        .references(resource.resourceId)
        .references.some((item) => item.reason === "INFLIGHT_CALL"),
      false,
    );
  } finally {
    model.planRelease.resolve();
    if (patch !== null) await patch.catch(() => undefined);
    await fixture.close();
  }
});

test("句段标注在途时计入占用并阻挡服务修改", { timeout: 60_000 }, async () => {
  const model = new HangingAnnotationModel();
  const fixture = createFixtureWithModel(model);
  let patch: Promise<Response> | null = null;
  try {
    await attachOutfitWithSprite(fixture, "标注在途");
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource);
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "今天风很轻",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await model.annotationStarted.promise;

    const busy = fixture.app.services.resources.references(resource.resourceId);
    assert.ok(
      busy.references.some((item) => item.reason === "INFLIGHT_CALL"),
      "在途标注应出现在引用报告里",
    );
    assert.equal(busy.canDelete, false);

    const originalUrl = String(resource.config.baseUrl);
    patch = fetch(
      `${resourceBase(port)}/v1/resources/${resource.resourceId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: { ...resource.config, baseUrl: `${originalUrl}-v2` },
        }),
      },
    );
    await waitFor(() =>
      fixture.app.services.resources.isUnderMaintenance(resource.resourceId),
    );
    await delayMs(300);
    assert.equal(
      String(
        fixture.app.services.resources.get(resource.resourceId).config.baseUrl,
      ),
      originalUrl,
      "标注结算前不得写入新地址",
    );

    model.annotationRelease.resolve();
    const patched = await patch;
    assert.equal(patched.status, 200);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(
      fixture.app.services.resources
        .references(resource.resourceId)
        .references.some((item) => item.reason === "INFLIGHT_CALL"),
      false,
    );
  } finally {
    model.annotationRelease.resolve();
    if (patch !== null) await patch.catch(() => undefined);
    await fixture.close();
  }
});
