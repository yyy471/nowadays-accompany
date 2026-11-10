import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { listen, type BackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelRequest } from "../src/domain/model.js";
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
  createFixtureWithModel,
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
