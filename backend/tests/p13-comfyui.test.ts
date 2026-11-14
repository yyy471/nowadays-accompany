import assert from "node:assert/strict";
import { configFetch } from "./config-write.js";
import { randomUUID } from "node:crypto";
import http from "node:http";
import test from "node:test";
import sharp from "sharp";
import { listen } from "../src/bootstrap/app.js";
import { ImageGenerationFailedError } from "../src/domain/errors.js";
import type {
  SceneImagePlanRecord,
  SceneImagePlannerInput,
  SceneImagePlannerPort,
  SceneImageTaskRecord,
} from "../src/domain/scene-image.js";
import { FixedSceneImagePlanner } from "../src/scene/fixed-planner.js";
import { ComfyUiClient } from "../src/scene/comfyui-client.js";
import {
  defaultComfyWorkflow,
  applyWorkflowParams,
  requiredNodeTypes,
} from "../src/scene/comfyui-workflow.js";
import {
  createFixture,
  createFixtureWithModel,
  deferred,
  ScriptedChatModel,
  type Deferred,
  type Fixture,
} from "./p2-05-fixture.js";

const REPLY_CONTENT =
  "风从窗缝里钻进来，带着一点凉。\n（她把外套的领子拢了拢）\n那就早点回来。";

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

interface FakeComfy {
  baseUrl: string;
  requests: RecordedRequest[];
  /** 提交过的工作流，按提交顺序。 */
  workflows: Record<string, unknown>[];
  missingNode: string | null;
  promptStatus: number;
  statsStatus: number;
  historyStatus: "success" | "error";
  viewStatus: number;
  historyPollsBeforeReady: number;
  /** 模拟卡住的 /history 请求，用于验证中止时的远端清理。 */
  historyDelayMs: number;
  close(): Promise<void>;
}

/**
 * 假 ComfyUI：只实现本适配器用到的五个公开接口。
 * 出图用 sharp 现造一张 64×64 PNG，保证解码校验也能通过。
 */
async function startFakeComfy(): Promise<FakeComfy> {
  const png = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 24, g: 48, b: 72 },
    },
  })
    .png()
    .toBuffer();
  const state: FakeComfy = {
    baseUrl: "",
    requests: [],
    workflows: [],
    missingNode: null,
    promptStatus: 200,
    statsStatus: 200,
    historyStatus: "success",
    viewStatus: 200,
    historyPollsBeforeReady: 1,
    historyDelayMs: 0,
    close: async () => undefined,
  };
  let polls = 0;

  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw.length === 0 ? null : (JSON.parse(raw) as unknown);
    state.requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      body,
      authorization: request.headers.authorization ?? null,
    });
    const rawUrl = request.url ?? "";
    const url = rawUrl.replace(/^\/custom(?=\/|$)/, "") || "/";

    if (request.method === "GET" && url === "/system_stats") {
      if (state.statsStatus !== 200) {
        respondJson(response, state.statsStatus, { error: "unauthorized" });
        return;
      }
      respondJson(response, 200, {
        system: { comfyui_version: "0.3.60", python_version: "3.12" },
        devices: [{ name: "cuda:0 NVIDIA RTX 4090" }],
      });
      return;
    }
    if (request.method === "GET" && url === "/object_info") {
      const nodes: Record<string, unknown> = {
        UNETLoader: {
          input: {
            required: {
              unet_name: [
                [
                  "moss_image_sft_int8_convrot.safetensors",
                  "moss-image-base.safetensors",
                ],
              ],
            },
          },
        },
        CLIPLoader: {
          input: {
            required: {
              clip_name: [["qwen3.5_9b_w4a8_gptq.safetensors"]],
              type: [["moss_image"]],
            },
          },
        },
        VAELoader: {
          input: { required: { vae_name: [["flux2-vae_small.safetensors"]] } },
        },
        CLIPTextEncode: { input: { required: { text: ["STRING"] } } },
        EmptyFlux2LatentImage: { input: { required: {} } },
        SpectrumMOSSImageManual: { input: { required: {} } },
        SkipLayerGuidanceDiTSimple: { input: { required: {} } },
        KSampler: { input: { required: {} } },
        VAEDecode: { input: { required: {} } },
        SaveImage: { input: { required: {} } },
        MOSSImageHFLoader: { input: { required: {} } },
        ModelSamplingSD3: { input: { required: {} } },
        CheckpointLoaderSimple: {
          input: { required: { ckpt_name: [["sd_xl_base_1.0.safetensors"]] } },
        },
        MOSSImageUNETLoader: {
          input: { required: { unet_name: [["moss-image-base.safetensors"]] } },
        },
      };
      if (state.missingNode !== null) {
        delete nodes[state.missingNode];
      }
      respondJson(response, 200, nodes);
      return;
    }
    if (request.method === "POST" && url === "/prompt") {
      if (state.promptStatus !== 200) {
        respondJson(response, state.promptStatus, {
          error: { type: "prompt_outputs_failed_validation" },
          node_errors: { "7": { errors: [{ message: "steps 必须为正整数" }] } },
        });
        return;
      }
      const workflow = (body as { prompt?: Record<string, unknown> } | null)?.prompt;
      if (workflow !== undefined) {
        state.workflows.push(workflow);
      }
      polls = 0;
      respondJson(response, 200, { prompt_id: "prompt-1", number: 1, node_errors: {} });
      return;
    }
    if (request.method === "GET" && url.startsWith("/history/")) {
      if (state.historyDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.historyDelayMs));
      }
      polls += 1;
      if (polls < state.historyPollsBeforeReady) {
        respondJson(response, 200, {});
        return;
      }
      if (state.historyStatus === "error") {
        respondJson(response, 200, {
          "prompt-1": {
            status: {
              status_str: "error",
              messages: [["execution_error", { exception_message: "CUDA out of memory" }]],
            },
            outputs: {},
          },
        });
        return;
      }
      respondJson(response, 200, {
        "prompt-1": {
          status: { status_str: "success", completed: true, messages: [] },
          outputs: {
            "11": { images: [{ filename: "out-1.png", subfolder: "", type: "output" }] },
          },
        },
      });
      return;
    }
    if (request.method === "GET" && url.startsWith("/view?")) {
      if (state.viewStatus !== 200) {
        response.writeHead(state.viewStatus, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "image/png" });
      response.end(png);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  state.close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  return state;
}

function respondJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<ApiResponse> {
  const response = await configFetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
  };
}

interface Context {
  comfy: FakeComfy;
  fixture: Fixture;
  base: string;
  serviceId: string;
  close(): Promise<void>;
}

async function setup(
  options: Parameters<typeof createFixture>[1] = {},
  serviceOptions: { comfy?: FakeComfy; baseUrl?: string; secret?: string } = {},
): Promise<Context> {
  const comfy = serviceOptions.comfy ?? (await startFakeComfy());
  const fixture = createFixture(
    [[{ type: "text_delta", text: REPLY_CONTENT }, { type: "completed", stopReason: "stop" }]],
    { sceneImagePlanner: new FixedSceneImagePlanner(), ...options },
  );
  const port = await listen(fixture.app.server, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const created = await api(base, "POST", "/v1/image-services", {
    name: "本机 ComfyUI",
    ...(serviceOptions.secret === undefined
      ? {}
      : { secret: serviceOptions.secret }),
    config: {
      protocol: "comfyui",
      baseUrl: serviceOptions.baseUrl ?? comfy.baseUrl,
    },
  });
  assert.equal(created.status, 201);
  const service = created.body.service as { serviceId: string };
  return {
    comfy,
    fixture,
    base,
    serviceId: service.serviceId,
    async close() {
      await fixture.close();
      await comfy.close();
    },
  };
}

function settingsBody(context: Context, overrides: Record<string, unknown> = {}) {
  return {
    serviceId: context.serviceId,
    modelType: "text2img",
    modelPath: "/models/MOSS-Image-Base",
    basePrompt: "银灰长发，琥珀色眼睛",
    negativePrompt: "模糊",
    outfitPrompts: { "outfit-1": "米色风衣" },
    width: 768,
    height: 1024,
    steps: 40,
    cfg: 3.5,
    sampler: "euler",
    scheduler: "sgm_uniform",
    seed: 7,
    workflow: null,
    outputNodeId: null,
    ...overrides,
  };
}

async function createTestOutfit(
  context: Context,
  name: string,
  roleId = context.fixture.roleId,
): Promise<string> {
  const outfit = await context.fixture.app.services.appearance.importOutfit(
    roleId,
    { name },
  );
  return outfit.outfitId;
}

test("the built-in workflow is a MOSS-Image graph that can be patched by class type", () => {
  const workflow = defaultComfyWorkflow();
  assert.deepEqual(requiredNodeTypes(workflow), [
    "CLIPLoader",
    "CLIPTextEncode",
    "EmptyFlux2LatentImage",
    "KSampler",
    "SaveImage",
    "SkipLayerGuidanceDiTSimple",
    "SpectrumMOSSImageManual",
    "UNETLoader",
    "VAEDecode",
    "VAELoader",
  ]);
  const patched = applyWorkflowParams(workflow, {
    prompt: "场景",
    negativePrompt: "模糊",
    width: 768,
    height: 1024,
    steps: 25,
    cfg: 2.5,
    sampler: "er_sde",
    scheduler: "simple",
    seed: 11,
    modelPath: "moss_image_sft_int8_convrot.safetensors",
  });
  assert.equal(patched.outputNodeId, "11");
  assert.equal(
    patched.workflow["1"]?.inputs.unet_name,
    "moss_image_sft_int8_convrot.safetensors",
  );
  assert.equal(patched.workflow["4"]?.inputs.text, "场景");
  assert.equal(patched.workflow["5"]?.inputs.text, "模糊");
  assert.equal(patched.workflow["6"]?.inputs.width, 768);
  assert.equal(patched.workflow["6"]?.inputs.height, 1024);
  assert.equal(patched.workflow["9"]?.inputs.seed, 11);
  assert.equal(patched.workflow["9"]?.inputs.steps, 25);
  assert.equal(patched.workflow["9"]?.inputs.cfg, 2.5);
  assert.equal(patched.workflow["9"]?.inputs.sampler_name, "er_sde");
  assert.equal(patched.workflow["9"]?.inputs.scheduler, "simple");
  // 原模板不被改动，同一份配置可以重复使用。
  assert.equal(workflow["4"]?.inputs.text, "");
});

test("probing a comfyui service reports missing nodes and available models", { timeout: 30_000 }, async () => {
  const context = await setup();
  try {
    const ok = await api(
      context.base,
      "POST",
      `/v1/image-services/${context.serviceId}/probe`,
    );
    assert.equal(ok.status, 200);
    const probe = ok.body.probe as {
      workflowReady: boolean;
      missingNodes: string[];
      models: string[];
      comfyuiVersion: string | null;
    };
    assert.equal(probe.workflowReady, true);
    assert.deepEqual(probe.missingNodes, []);
    assert.equal(probe.comfyuiVersion, "0.3.60");
    assert.ok(probe.models.includes("moss-image-base.safetensors"));

    context.comfy.missingNode = "SpectrumMOSSImageManual";
    const missing = await api(
      context.base,
      "POST",
      `/v1/image-services/${context.serviceId}/probe`,
    );
    assert.equal(missing.status, 200);
    const broken = missing.body.probe as {
      workflowReady: boolean;
      missingNodes: string[];
    };
    assert.equal(broken.workflowReady, false);
    assert.deepEqual(broken.missingNodes, ["SpectrumMOSSImageManual"]);
  } finally {
    await context.close();
  }
});

test("scene image settings reject an unknown output node and a disabled service", { timeout: 30_000 }, async () => {
  const context = await setup();
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    const unconfigured = await api(context.base, "POST", `${roleBase}/preview`, {});
    assert.equal(unconfigured.status, 409);
    assert.equal(
      (unconfigured.body.error as { code: string }).code,
      "SCENE_IMAGE_NOT_CONFIGURED",
    );

    const badNode = await api(context.base, "PUT", roleBase, {
      ...settingsBody(context),
      workflow: defaultComfyWorkflow(),
      outputNodeId: "42",
    });
    assert.equal(badNode.status, 400);
    assert.equal(
      (badNode.body.error as { code: string }).code,
      "IMAGE_WORKFLOW_INVALID",
    );

    const saved = await api(context.base, "PUT", roleBase, settingsBody(context));
    assert.equal(saved.status, 200);
    const view = saved.body as {
      configured: boolean;
      settings: { modelPath: string; width: number };
    };
    assert.equal(view.configured, true);
    assert.equal(view.settings.modelPath, "/models/MOSS-Image-Base");

    await api(context.base, "PATCH", `/v1/image-services/${context.serviceId}`, {
      enabled: false,
    });
    const disabled = await api(
      context.base,
      "PUT",
      roleBase,
      settingsBody(context, { modelPath: "/models/other" }),
    );
    assert.equal(disabled.status, 409);
    assert.equal(
      (disabled.body.error as { code: string }).code,
      "IMAGE_SERVICE_DISABLED",
    );

    // 已保存的配置在服务停用后也不能继续出图。
    const preview = await api(context.base, "POST", `${roleBase}/preview`, {});
    assert.equal(preview.status, 409);
    assert.equal(
      (preview.body.error as { code: string }).code,
      "IMAGE_SERVICE_DISABLED",
    );
  } finally {
    await context.close();
  }
});

test("preview composes the anchor prompts and returns a decodable image", { timeout: 30_000 }, async () => {
  const context = await setup();
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    const outfitId = await createTestOutfit(context, "风衣");
    const saved = await api(
      context.base,
      "PUT",
      roleBase,
      settingsBody(context, { outfitPrompts: { [outfitId]: "米色风衣" } }),
    );
    assert.equal(saved.status, 200);

    const preview = await api(context.base, "POST", `${roleBase}/preview`, {
      prompt: "雨夜街头，远处有霓虹",
      outfitId,
    });
    assert.equal(preview.status, 200);
    const result = preview.body as {
      mediaType: string;
      width: number;
      height: number;
      dataBase64: string;
      prompt: string;
    };
    assert.equal(result.mediaType, "image/png");
    assert.equal(result.width, 64);
    assert.equal(result.height, 64);
    assert.equal(
      result.prompt,
      "银灰长发，琥珀色眼睛，米色风衣，雨夜街头，远处有霓虹",
    );
    const data = Buffer.from(result.dataBase64, "base64");
    assert.ok(data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

    const submitted = context.comfy.workflows.at(-1) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    assert.equal(submitted["1"]?.inputs.unet_name, "/models/MOSS-Image-Base");
    assert.equal(submitted["4"]?.inputs.text, result.prompt);
    assert.equal(submitted["5"]?.inputs.text, "模糊");
    assert.equal(submitted["6"]?.inputs.width, 768);
    assert.equal(submitted["9"]?.inputs.seed, 7);
    assert.equal(submitted["9"]?.inputs.steps, 40);
    assert.equal(submitted["9"]?.inputs.cfg, 3.5);
  } finally {
    await context.close();
  }
});

test("comfyui failures map to stable error codes", { timeout: 40_000 }, async () => {
  const context = await setup();
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    await api(context.base, "PUT", roleBase, settingsBody(context));

    context.comfy.promptStatus = 400;
    const invalid = await api(context.base, "POST", `${roleBase}/preview`, {});
    assert.equal(invalid.status, 400);
    assert.equal(
      (invalid.body.error as { code: string }).code,
      "IMAGE_WORKFLOW_INVALID",
    );

    context.comfy.promptStatus = 200;
    context.comfy.historyStatus = "error";
    const failed = await api(context.base, "POST", `${roleBase}/preview`, {});
    assert.equal(failed.status, 502);
    assert.equal(
      (failed.body.error as { code: string }).code,
      "IMAGE_GENERATION_FAILED",
    );

    context.comfy.statsStatus = 401;
    const unauthorized = await api(
      context.base,
      "POST",
      `/v1/image-services/${context.serviceId}/probe`,
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(
      (unauthorized.body.error as { code: string }).code,
      "IMAGE_SERVICE_AUTH_FAILED",
    );
  } finally {
    await context.close();
  }
});

test("a scene image task uses the configured comfyui service", { timeout: 60_000 }, async () => {
  const context = await setup();
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    await api(context.base, "PUT", roleBase, settingsBody(context));

    context.fixture.app.conversation.submitMessage(
      context.fixture.roleId,
      context.fixture.windowId,
      { content: "今天做什么？", submissionId: randomUUID(), sourcePlatform: "nowadays" },
    );
    await context.fixture.app.conversation.waitForIdle(context.fixture.roleId);

    const messages = context.fixture.app.services.messages.list(
      context.fixture.roleId,
      context.fixture.windowId,
      null,
      50,
    );
    const reply = messages.items.find((message) => message.sender === "assistant");
    assert.ok(reply, "脚本化回复应已落库");

    const created = await api(
      context.base,
      "POST",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/messages/${reply.messageId}/scene-images`,
      { idempotencyKey: "comfy-1" },
    );
    assert.equal(created.status, 201);
    const task = created.body.task as SceneImageTaskRecord;
    await context.fixture.app.services.sceneImages.waitForIdle(
      context.fixture.roleId,
    );
    const detail = await api(
      context.base,
      "GET",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/scene-images/${task.taskId}`,
    );
    assert.equal(detail.status, 200);
    const finished = detail.body.task as SceneImageTaskRecord;
    assert.equal(finished.status, "succeeded");
    assert.ok(finished.result !== null);
    assert.equal(finished.result.width, 64);

    const image = await configFetch(
      `${context.base}/v1/roles/${context.fixture.roleId}/scene-images/assets/${finished.result.assetId}`,
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.ok((await image.arrayBuffer()).byteLength > 0);
  } finally {
    await context.close();
  }
});

class GatedScenePlanner implements SceneImagePlannerPort {
  readonly started: Deferred<void> = deferred<void>();
  readonly release: Deferred<void> = deferred<void>();
  private readonly fixed = new FixedSceneImagePlanner();

  async plan(
    input: SceneImagePlannerInput,
  ): Promise<SceneImagePlanRecord> {
    this.started.resolve();
    await this.release.promise;
    return this.fixed.plan(input);
  }
}

async function waitUntil(
  check: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("WAIT_TIMEOUT");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createReply(context: Context): Promise<string> {
  context.fixture.app.conversation.submitMessage(
    context.fixture.roleId,
    context.fixture.windowId,
    {
      content: "今天做什么？",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    },
  );
  await context.fixture.app.conversation.waitForIdle(context.fixture.roleId);
  const messages = context.fixture.app.services.messages.list(
    context.fixture.roleId,
    context.fixture.windowId,
    null,
    50,
  );
  const reply = messages.items.find((message) => message.sender === "assistant");
  assert.ok(reply, "脚本化回复应已落库");
  return reply.messageId;
}

test("a background task sends only the planned environment prompt", { timeout: 60_000 }, async () => {
  const context = await setup();
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    await api(context.base, "PUT", roleBase, settingsBody(context));
    const replyId = await createReply(context);

    const created = await api(
      context.base,
      "POST",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/messages/${replyId}/scene-images`,
      { idempotencyKey: "background-1", layerMode: "background" },
    );
    assert.equal(created.status, 201);
    const task = created.body.task as SceneImageTaskRecord;
    await context.fixture.app.services.sceneImages.waitForIdle(
      context.fixture.roleId,
    );
    const detail = await api(
      context.base,
      "GET",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/scene-images/${task.taskId}`,
    );
    assert.equal((detail.body.task as SceneImageTaskRecord).status, "succeeded");

    const submitted = context.comfy.workflows.at(-1) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    const prompt = String(submitted["4"]?.inputs.text ?? "");
    assert.equal(prompt, "与对话氛围相符的环境背景，不出现人物。");
    assert.ok(!prompt.includes("银灰长发"));
    assert.ok(!prompt.includes("米色风衣"));
  } finally {
    await context.close();
  }
});

test("scene image settings stay editable while the credential reference is missing", { timeout: 40_000 }, async () => {
  const envName = "NOWADAYS_SCENE_IMAGE_TEST_TOKEN";
  delete process.env[envName];
  const context = await setup();
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    await api(context.base, "PUT", roleBase, settingsBody(context));
    const patched = await api(
      context.base,
      "PATCH",
      `/v1/image-services/${context.serviceId}`,
      {
        config: {
          protocol: "comfyui",
          baseUrl: context.comfy.baseUrl,
          credentialRef: `env:${envName}`,
        },
      },
    );
    assert.equal(patched.status, 200);

    const read = await api(context.base, "GET", roleBase);
    assert.equal(read.status, 200);
    assert.equal(
      (read.body.settings as { modelPath: string }).modelPath,
      "/models/MOSS-Image-Base",
    );

    const updated = await api(
      context.base,
      "PUT",
      roleBase,
      settingsBody(context, { basePrompt: "缺失凭据时仍可编辑" }),
    );
    assert.equal(updated.status, 200);
    assert.equal(
      (updated.body.settings as { basePrompt: string }).basePrompt,
      "缺失凭据时仍可编辑",
    );

    for (const route of [`${roleBase}/probe`, `${roleBase}/preview`]) {
      const failed = await api(context.base, "POST", route, {});
      assert.equal(failed.status, 500);
      assert.equal(
        (failed.body.error as { code: string }).code,
        "MODEL_CREDENTIAL_UNAVAILABLE",
      );
    }

    process.env[envName] = "review-token";
    const restored = await api(context.base, "GET", roleBase);
    assert.equal(restored.status, 200);
    assert.equal(
      (restored.body.settings as { modelPath: string }).modelPath,
      "/models/MOSS-Image-Base",
    );
    const preview = await api(context.base, "POST", `${roleBase}/preview`, {});
    assert.equal(preview.status, 200);
  } finally {
    delete process.env[envName];
    await context.close();
  }
});

test("a task keeps the settings captured when it was accepted", { timeout: 60_000 }, async () => {
  const planner = new GatedScenePlanner();
  const context = await setup({ sceneImagePlanner: planner });
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    await api(
      context.base,
      "PUT",
      roleBase,
      settingsBody(context, {
        modelPath: "/models/accepted.safetensors",
        basePrompt: "接收时的锚点",
      }),
    );
    const replyId = await createReply(context);

    const created = await api(
      context.base,
      "POST",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/messages/${replyId}/scene-images`,
      { idempotencyKey: "pinned-1", layerMode: "full_scene" },
    );
    assert.equal(created.status, 201);
    const task = created.body.task as SceneImageTaskRecord;
    await planner.started.promise;

    const updated = await api(
      context.base,
      "PUT",
      roleBase,
      settingsBody(context, {
        modelPath: "/models/later.safetensors",
        basePrompt: "规划期间的新锚点",
      }),
    );
    assert.equal(updated.status, 200);

    planner.release.resolve();
    await context.fixture.app.services.sceneImages.waitForIdle(
      context.fixture.roleId,
    );
    const detail = await api(
      context.base,
      "GET",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/scene-images/${task.taskId}`,
    );
    assert.equal((detail.body.task as SceneImageTaskRecord).status, "succeeded");

    const submitted = context.comfy.workflows.at(-1) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    assert.equal(
      submitted["1"]?.inputs.unet_name,
      "/models/accepted.safetensors",
    );
    const prompt = String(submitted["4"]?.inputs.text ?? "");
    assert.ok(prompt.includes("接收时的锚点"));
    assert.ok(!prompt.includes("规划期间的新锚点"));
  } finally {
    await context.close();
  }
});

test("a task fails clearly when its pinned service is disabled while planning", { timeout: 60_000 }, async () => {
  const planner = new GatedScenePlanner();
  const context = await setup({ sceneImagePlanner: planner });
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    await api(context.base, "PUT", roleBase, settingsBody(context));
    const replyId = await createReply(context);

    const created = await api(
      context.base,
      "POST",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/messages/${replyId}/scene-images`,
      { idempotencyKey: "disabled-1", layerMode: "full_scene" },
    );
    assert.equal(created.status, 201);
    const task = created.body.task as SceneImageTaskRecord;
    await planner.started.promise;
    const disabled = await api(
      context.base,
      "PATCH",
      `/v1/image-services/${context.serviceId}`,
      { enabled: false },
    );
    assert.equal(disabled.status, 200);

    planner.release.resolve();
    await context.fixture.app.services.sceneImages.waitForIdle(
      context.fixture.roleId,
    );
    const detail = await api(
      context.base,
      "GET",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/scene-images/${task.taskId}`,
    );
    const finished = detail.body.task as SceneImageTaskRecord;
    assert.equal(finished.status, "failed");
    assert.equal(finished.errorCode, "IMAGE_SERVICE_DISABLED");
    assert.equal(context.comfy.workflows.length, 0);
  } finally {
    await context.close();
  }
});

test("aborting a poll cancels the queued prompt remotely", { timeout: 30_000 }, async () => {
  const comfy = await startFakeComfy();
  try {
    comfy.historyDelayMs = 1_500;
    const controller = new AbortController();
    const client = new ComfyUiClient({
      baseUrl: comfy.baseUrl,
      generationTimeoutMs: 30_000,
      pollIntervalMs: 10,
    });
    const result = client
      .run(defaultComfyWorkflow(), { signal: controller.signal })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await waitUntil(() =>
      comfy.requests.some((request) => request.url.startsWith("/history/")),
    );
    controller.abort();
    const error = await result;
    assert.ok(error instanceof ImageGenerationFailedError);
    const cancel = comfy.requests.find(
      (request) => request.method === "POST" && request.url === "/queue",
    );
    assert.ok(cancel, "中止后应尝试清理远端任务");
    assert.deepEqual(cancel.body, { delete: ["prompt-1"] });
  } finally {
    await comfy.close();
  }
});

test("a configured service timeout ends the task and clears the remote prompt", { timeout: 40_000 }, async () => {
  const context = await setup();
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    const patched = await api(
      context.base,
      "PATCH",
      `/v1/image-services/${context.serviceId}`,
      {
        config: {
          protocol: "comfyui",
          baseUrl: context.comfy.baseUrl,
          timeoutMs: 5_000,
        },
      },
    );
    assert.equal(patched.status, 200);
    await api(context.base, "PUT", roleBase, settingsBody(context));
    const replyId = await createReply(context);
    context.comfy.historyDelayMs = 8_000;

    const startedAt = Date.now();
    const created = await api(
      context.base,
      "POST",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/messages/${replyId}/scene-images`,
      { idempotencyKey: "timeout-1", layerMode: "background" },
    );
    assert.equal(created.status, 201);
    const task = created.body.task as SceneImageTaskRecord;
    await context.fixture.app.services.sceneImages.waitForIdle(
      context.fixture.roleId,
      20_000,
    );
    assert.ok(Date.now() - startedAt >= 4_500, "外层超时应采用服务配置的 5 秒");

    const detail = await api(
      context.base,
      "GET",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/scene-images/${task.taskId}`,
    );
    const finished = detail.body.task as SceneImageTaskRecord;
    assert.equal(finished.status, "failed");
    assert.equal(finished.errorCode, "SCENE_IMAGE_GENERATION_TIMEOUT");
    await waitUntil(() =>
      context.comfy.requests.some(
        (request) => request.method === "POST" && request.url === "/queue",
      ),
    );
  } finally {
    await context.close();
  }
});

test("a task accepted before configuration keeps the fallback generator", { timeout: 60_000 }, async () => {
  const planner = new GatedScenePlanner();
  const context = await setup({ sceneImagePlanner: planner });
  try {
    const replyId = await createReply(context);
    const created = await api(
      context.base,
      "POST",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/messages/${replyId}/scene-images`,
      { idempotencyKey: "fallback-1", layerMode: "full_scene" },
    );
    assert.equal(created.status, 201);
    const task = created.body.task as SceneImageTaskRecord;
    await planner.started.promise;

    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    const saved = await api(context.base, "PUT", roleBase, settingsBody(context));
    assert.equal(saved.status, 200);

    planner.release.resolve();
    await context.fixture.app.services.sceneImages.waitForIdle(
      context.fixture.roleId,
    );
    const detail = await api(
      context.base,
      "GET",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/scene-images/${task.taskId}`,
    );
    assert.equal((detail.body.task as SceneImageTaskRecord).status, "succeeded");
    assert.equal(context.comfy.workflows.length, 0);
  } finally {
    await context.close();
  }
});

test("a pinned task does not send new-site credentials to the old address", { timeout: 60_000 }, async () => {
  const siteA = await startFakeComfy();
  const siteB = await startFakeComfy();
  const planner = new GatedScenePlanner();
  const context = await setup(
    { sceneImagePlanner: planner },
    { comfy: siteA, baseUrl: siteA.baseUrl, secret: "token-a" },
  );
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    await api(context.base, "PUT", roleBase, settingsBody(context));
    const replyId = await createReply(context);

    const created = await api(
      context.base,
      "POST",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/messages/${replyId}/scene-images`,
      { idempotencyKey: "cross-site-1", layerMode: "full_scene" },
    );
    assert.equal(created.status, 201);
    const task = created.body.task as SceneImageTaskRecord;
    await planner.started.promise;

    const moved = await api(
      context.base,
      "PATCH",
      `/v1/image-services/${context.serviceId}`,
      {
        config: { protocol: "comfyui", baseUrl: siteB.baseUrl },
        secret: "token-b",
      },
    );
    assert.equal(moved.status, 200);

    planner.release.resolve();
    await context.fixture.app.services.sceneImages.waitForIdle(
      context.fixture.roleId,
    );
    const detail = await api(
      context.base,
      "GET",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/scene-images/${task.taskId}`,
    );
    const finished = detail.body.task as SceneImageTaskRecord;
    assert.equal(finished.status, "failed");
    assert.equal(finished.errorCode, "SCENE_IMAGE_SERVICE_CHANGED");
    assert.equal(siteA.requests.length, 0);
    assert.equal(siteB.requests.length, 0);
  } finally {
    await context.close();
    await siteB.close();
  }
});

test("rotating the token on the same site keeps generation working", { timeout: 60_000 }, async () => {
  const context = await setup({}, { secret: "token-a" });
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    await api(context.base, "PUT", roleBase, settingsBody(context));
    const replyId = await createReply(context);
    const route = `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/messages/${replyId}/scene-images`;

    const first = await api(context.base, "POST", route, {
      idempotencyKey: "rotate-1",
      layerMode: "full_scene",
    });
    assert.equal(first.status, 201);
    await context.fixture.app.services.sceneImages.waitForIdle(
      context.fixture.roleId,
    );
    const firstPrompts = context.comfy.requests.filter(
      (request) => request.url === "/prompt",
    );
    assert.equal(firstPrompts.at(-1)?.authorization, "Bearer token-a");

    const rotated = await api(
      context.base,
      "PATCH",
      `/v1/image-services/${context.serviceId}`,
      { secret: "token-b" },
    );
    assert.equal(rotated.status, 200);

    const second = await api(context.base, "POST", route, {
      idempotencyKey: "rotate-2",
      layerMode: "full_scene",
    });
    assert.equal(second.status, 201);
    const task = second.body.task as SceneImageTaskRecord;
    await context.fixture.app.services.sceneImages.waitForIdle(
      context.fixture.roleId,
    );
    const detail = await api(
      context.base,
      "GET",
      `/v1/roles/${context.fixture.roleId}/windows/${context.fixture.windowId}/scene-images/${task.taskId}`,
    );
    assert.equal((detail.body.task as SceneImageTaskRecord).status, "succeeded");
    const prompts = context.comfy.requests.filter(
      (request) => request.url === "/prompt",
    );
    assert.equal(prompts.at(-1)?.authorization, "Bearer token-b");
  } finally {
    await context.close();
  }
});

test("draft image service probe checks origin credentials and supports delete", { timeout: 30_000 }, async () => {
  const siteB = await startFakeComfy();
  const context = await setup({}, { secret: "token-a" });
  try {
    const draftNew = await api(context.base, "POST", "/v1/image-services/probe", {
      config: { protocol: "comfyui", baseUrl: siteB.baseUrl },
      secret: "draft-token",
    });
    assert.equal(draftNew.status, 200);
    assert.equal((draftNew.body.probe as { workflowReady: boolean }).workflowReady, true);
    assert.equal(siteB.requests.at(-1)?.authorization, "Bearer draft-token");

    // 冲突凭据（secret + credentialRef）在探针入口即拒绝。
    const conflict = await api(context.base, "POST", "/v1/image-services/probe", {
      config: {
        protocol: "comfyui",
        baseUrl: siteB.baseUrl,
        credentialRef: "env:TEST_COMFY_KEY",
      },
      secret: "draft-token",
    });
    assert.equal(conflict.status, 400);
    assert.equal(
      (conflict.body.error as { code: string }).code,
      "RESOURCE_CREDENTIAL_CONFLICT",
    );

    // 同站点改路径时允许复用已保存密钥，不会泄露明文。
    const sameOrigin = await api(context.base, "POST", "/v1/image-services/probe", {
      serviceId: context.serviceId,
      config: { protocol: "comfyui", baseUrl: `${context.comfy.baseUrl}/custom` },
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(context.comfy.requests.at(-1)?.authorization, "Bearer token-a");

    // 换站点但仍尝试复用旧服务凭据时必须拒绝（RESOURCE_CREDENTIAL_STALE）。
    const stale = await api(context.base, "POST", "/v1/image-services/probe", {
      serviceId: context.serviceId,
      config: { protocol: "comfyui", baseUrl: siteB.baseUrl },
    });
    assert.equal(stale.status, 400);
    assert.equal(
      (stale.body.error as { code: string }).code,
      "RESOURCE_CREDENTIAL_STALE",
    );

    // 删除生图服务要求停止态并清掉记录（由 configFetch 走停止-操作-恢复流程）。
    const deleted = await api(
      context.base,
      "DELETE",
      `/v1/image-services/${context.serviceId}`,
    );
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    const listed = await api(context.base, "GET", "/v1/image-services");
    assert.deepEqual(listed.body.items, []);
  } finally {
    await context.close();
    await siteB.close();
  }
});

test("draft scene image probe and preview use draft settings without overwriting saved config", { timeout: 40_000 }, async () => {
  const siteB = await startFakeComfy();
  const context = await setup({}, { secret: "token-a" });
  try {
    const roleBase = `/v1/roles/${context.fixture.roleId}/scene-image`;
    const customWorkflow = defaultComfyWorkflow();
    customWorkflow["4"]!.inputs.width = 512;

    // 未保存角色配置时即可用草稿探测与测试生图，且不写入正式库表。
    const probeRes = await api(context.base, "POST", `${roleBase}/probe`, {
      serviceDraft: {
        config: { protocol: "comfyui", baseUrl: siteB.baseUrl },
        secret: "draft-b",
      },
      workflow: customWorkflow,
    });
    assert.equal(probeRes.status, 200);
    assert.equal(siteB.requests.at(-1)?.authorization, "Bearer draft-b");

    const draftOutfitId = await createTestOutfit(context, "学院外套");
    const savedOutfitId = await createTestOutfit(context, "风衣");

    const draftOnlyPreview = await api(context.base, "POST", `${roleBase}/preview`, {
      serviceDraft: {
        serviceId: context.serviceId,
        config: { protocol: "comfyui", baseUrl: `${context.comfy.baseUrl}` },
      },
      modelPath: "/models/MOSS-Draft-V1",
      basePrompt: "银发草稿",
      negativePrompt: "水印",
      outfitPrompts: { [draftOutfitId]: "学院外套" },
      width: 512,
      height: 512,
      steps: 12,
      cfg: 4,
      sampler: "euler",
      scheduler: "sgm_uniform",
      seed: 99,
      prompt: "图书馆夕阳",
      outfitId: draftOutfitId,
    });
    assert.equal(draftOnlyPreview.status, 200);
    assert.equal(
      draftOnlyPreview.body.prompt,
      "银发草稿，学院外套，图书馆夕阳",
    );
    const draftSubmitted = context.comfy.workflows.at(-1) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    assert.equal(draftSubmitted["1"]?.inputs.unet_name, "/models/MOSS-Draft-V1");
    assert.equal(draftSubmitted["5"]?.inputs.text, "水印");
    assert.equal(draftSubmitted["6"]?.inputs.width, 512);
    assert.equal(draftSubmitted["9"]?.inputs.steps, 12);
    assert.equal(draftSubmitted["9"]?.inputs.seed, 99);

    // 确认草稿预览从未写入角色生图配置。
    const afterDraft = await api(context.base, "GET", roleBase);
    assert.equal(afterDraft.body.configured, false);
    assert.equal(afterDraft.body.settings, null);

    // 写入正式配置 A，再用草稿 B 覆盖预览：预览走 B，正式保存与后台任务仍走 A。
    const saved = await api(
      context.base,
      "PUT",
      roleBase,
      settingsBody(context, { outfitPrompts: { [savedOutfitId]: "米色风衣" } }),
    );
    assert.equal(saved.status, 200);

    const overridePreview = await api(context.base, "POST", `${roleBase}/preview`, {
      settings: {
        modelPath: "/models/MOSS-Draft-Override",
        basePrompt: "临时短发",
        width: 512,
      },
      prompt: "夜间散步",
      outfitId: savedOutfitId,
    });
    assert.equal(overridePreview.status, 200);
    assert.equal(
      overridePreview.body.prompt,
      "临时短发，米色风衣，夜间散步",
    );
    const overrideSubmitted = context.comfy.workflows.at(-1) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    assert.equal(
      overrideSubmitted["1"]?.inputs.unet_name,
      "/models/MOSS-Draft-Override",
    );
    assert.equal(overrideSubmitted["6"]?.inputs.width, 512);
    assert.equal(overrideSubmitted["6"]?.inputs.height, 1024);

    // 确认已保存配置 A 纹丝未动，且跨站点凭据复用被拦下。
    const savedCheck = await api(context.base, "GET", roleBase);
    assert.equal(
      (savedCheck.body.settings as { modelPath: string; basePrompt: string }).modelPath,
      "/models/MOSS-Image-Base",
    );
    assert.equal(
      (savedCheck.body.settings as { basePrompt: string }).basePrompt,
      "银灰长发，琥珀色眼睛",
    );

    const stalePreview = await api(context.base, "POST", `${roleBase}/preview`, {
      serviceDraft: {
        serviceId: context.serviceId,
        config: { protocol: "comfyui", baseUrl: siteB.baseUrl },
      },
      prompt: "跨站点拒绝",
    });
    assert.equal(stalePreview.status, 400);
    assert.equal(
      (stalePreview.body.error as { code: string }).code,
      "RESOURCE_CREDENTIAL_STALE",
    );

    const badWorkflow = await api(context.base, "POST", `${roleBase}/preview`, {
      workflow: customWorkflow,
      outputNodeId: "999",
    });
    assert.equal(badWorkflow.status, 400);
    assert.equal(
      (badWorkflow.body.error as { code: string }).code,
      "IMAGE_WORKFLOW_INVALID",
    );
  } finally {
    await context.close();
    await siteB.close();
  }
});

test("preview validates outfitId ownership and active status before calling ComfyUI", { timeout: 30_000 }, async () => {
  const context = await setup();
  try {
    const roleId = context.fixture.roleId;
    const roleBase = `/v1/roles/${roleId}/scene-image`;
    const ownOutfitId = await createTestOutfit(context, "常服");
    const deletableOutfitId = await createTestOutfit(context, "旧裙");
    const otherRole = context.fixture.app.services.roles.createRole({
      displayName: "他人",
      definition: { text: "另一个角色。" },
    });
    const otherOutfitId = await createTestOutfit(
      context,
      "他人服饰",
      otherRole.roleId,
    );

    const saved = await api(
      context.base,
      "PUT",
      roleBase,
      settingsBody(context, {
        outfitPrompts: {
          [ownOutfitId]: "白色衬衫",
          [deletableOutfitId]: "格子裙",
          [otherOutfitId]: "越权服饰",
          "nonexistent-outfit-id": "虚构提示词",
        },
      }),
    );
    assert.equal(saved.status, 200);
    assert.equal(context.comfy.workflows.length, 0);

    // 1. 当前角色有效服饰 / 未指定 / null / 空串均放行。
    const ownRes = await api(context.base, "POST", `${roleBase}/preview`, {
      prompt: "午后书房",
      outfitId: ownOutfitId,
    });
    assert.equal(ownRes.status, 200);
    assert.equal(ownRes.body.prompt, "银灰长发，琥珀色眼睛，白色衬衫，午后书房");

    const omittedRes = await api(context.base, "POST", `${roleBase}/preview`, {
      prompt: "无服饰键",
    });
    assert.equal(omittedRes.status, 200);

    const nullRes = await api(context.base, "POST", `${roleBase}/preview`, {
      prompt: "空值服饰",
      outfitId: null,
    });
    assert.equal(nullRes.status, 200);

    const emptyRes = await api(context.base, "POST", `${roleBase}/preview`, {
      prompt: "空串服饰",
      outfitId: "",
    });
    assert.equal(emptyRes.status, 200);
    assert.equal(context.comfy.workflows.length, 4);

    // 2. 他人角色服饰 ID（包括草稿覆盖 outfitPrompts）在生图前被拒绝，ComfyUI 收到 0 次新请求。
    const foreignRes = await api(context.base, "POST", `${roleBase}/preview`, {
      prompt: "越权测试",
      outfitId: otherOutfitId,
      draft: undefined,
      settings: { outfitPrompts: { [otherOutfitId]: "恶意草稿服饰" } },
    });
    assert.equal(foreignRes.status, 404);
    assert.equal((foreignRes.body.error as { code: string }).code, "OUTFIT_NOT_FOUND");
    assert.equal(context.comfy.workflows.length, 4);

    // 3. 当前角色已删除服饰在生图前被拒绝。
    context.fixture.app.services.appearance.deleteOutfit(roleId, deletableOutfitId);
    const deletedRes = await api(context.base, "POST", `${roleBase}/preview`, {
      prompt: "已删服饰测试",
      outfitId: deletableOutfitId,
    });
    assert.equal(deletedRes.status, 404);
    assert.equal((deletedRes.body.error as { code: string }).code, "OUTFIT_NOT_FOUND");
    assert.equal(context.comfy.workflows.length, 4);

    // 4. 不存在服饰 ID 在生图前被拒绝。
    const missingRes = await api(context.base, "POST", `${roleBase}/preview`, {
      prompt: "不存在服饰测试",
      outfitId: "nonexistent-outfit-id",
    });
    assert.equal(missingRes.status, 404);
    assert.equal((missingRes.body.error as { code: string }).code, "OUTFIT_NOT_FOUND");
    assert.equal(context.comfy.workflows.length, 4);
  } finally {
    await context.close();
  }
});

test("image service saves optional default modelName without disturbing stored credentials", async () => {
  const context = await setup({}, { secret: "comfy-token-1" });
  try {
    const created = await api(context.base, "POST", "/v1/image-services", {
      name: "双模型 ComfyUI",
      config: {
        protocol: "comfyui",
        baseUrl: context.comfy.baseUrl,
        modelName: "moss_image_sft_int8_convrot.safetensors",
      },
      secret: "comfy-token-2",
    });
    assert.equal(created.status, 201);
    const service = created.body.service as {
      serviceId: string;
      config: { baseUrl: string; modelName?: string };
      credential: { status: string };
    };
    assert.equal(
      service.config.modelName,
      "moss_image_sft_int8_convrot.safetensors",
    );

    const updated = await api(
      context.base,
      "PATCH",
      `/v1/image-services/${service.serviceId}`,
      {
        config: {
          protocol: "comfyui",
          baseUrl: context.comfy.baseUrl,
          modelName: "miaomiaoRealskin_anima11.safetensors",
        },
      },
    );
    assert.equal(updated.status, 200);
    const updatedService = updated.body.service as typeof service;
    assert.equal(
      updatedService.config.modelName,
      "miaomiaoRealskin_anima11.safetensors",
    );
    assert.equal(updatedService.credential.status, "stored");
  } finally {
    await context.close();
  }
});

test("anchor-prompts invokes bound chat model with outfit or uploaded image and supports repeated regeneration", async () => {
  const pngA = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 220, g: 80, b: 80 } },
  })
    .png()
    .toBuffer();
  const pngB = await sharp({
    create: { width: 24, height: 24, channels: 3, background: { r: 60, g: 120, b: 220 } },
  })
    .png()
    .toBuffer();
  const pngUpload = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 40, g: 180, b: 90 } },
  })
    .png()
    .toBuffer();

  const chatModel = new ScriptedChatModel([
    [
      { type: "text_delta", text: "基础锚点提示词：银灰长发，琥珀色眼瞳，二次元厚涂" },
      { type: "completed", stopReason: "stop" },
    ],
    [
      { type: "text_delta", text: "```text\n银灰高马尾长发，温暖琥珀瞳色，细腻二次元厚涂\n```" },
      { type: "completed", stopReason: "stop" },
    ],
    [
      { type: "text_delta", text: "米色长款风衣，深色直筒长裤，棕色短靴" },
      { type: "completed", stopReason: "stop" },
    ],
    [
      { type: "text_delta", text: "红色羊绒披肩，白色荷叶领衬衫，黑色百褶长裙" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);

  const fixture = createFixtureWithModel(chatModel, {
    sceneImagePlanner: new FixedSceneImagePlanner(),
  });
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const roleId = fixture.roleId;
    const endpoint = `/v1/roles/${roleId}/scene-image/anchor-prompts`;

    // 1. 尚无可用锚点图时明确返回 SCENE_IMAGE_ANCHOR_IMAGE_REQUIRED。
    const noImg = await api(base, "POST", endpoint, { target: "base" });
    assert.equal(noImg.status, 400);
    assert.equal(
      (noImg.body.error as { code: string }).code,
      "SCENE_IMAGE_ANCHOR_IMAGE_REQUIRED",
    );

    // 2. 导入两套服饰，并把第二套设为当前穿搭，验证基础锚点优先使用当前服饰立绘。
    const outfitDaily = await fixture.app.services.appearance.importOutfit(roleId, {
      name: "日常",
      home: { fileName: "daily.png", data: pngA },
    });
    const outfitCoat = await fixture.app.services.appearance.importOutfit(roleId, {
      name: "秋日风衣",
      description: "外出用长风衣",
      sprites: [{ fileName: "coat-sprite.png", data: pngB }],
    });
    fixture.app.services.roles.setState(roleId, {
      state: { outfitId: outfitCoat.outfitId },
    });
    // outfitDaily 有 home 而 outfitCoat 只有 sprite，因此基础锚点优先取有 home 立绘的服饰。
    // 再给当前服饰补一张 home 立绘后应切到当前服饰。
    await fixture.app.services.appearance.replaceHome(roleId, outfitCoat.outfitId, {
      fileName: "coat-home.png",
      data: pngB,
    });

    const firstBase = await api(base, "POST", endpoint, { target: "base" });
    assert.equal(firstBase.status, 200);
    assert.equal(firstBase.body.target, "base");
    assert.equal(firstBase.body.prompt, "银灰长发，琥珀色眼瞳，二次元厚涂");
    assert.deepEqual(firstBase.body.source, {
      kind: "outfit_asset",
      fileName: "coat-home.png",
      outfitId: outfitCoat.outfitId,
      outfitName: "秋日风衣",
    });
    assert.equal(
      chatModel.requests[0]?.messages[0]?.role === "user"
        ? chatModel.requests[0].messages[0].images?.[0]?.dataBase64
        : undefined,
      pngB.toString("base64"),
    );

    // 3. 再次调用传入 previousPrompt 触发重新生成，不写入持久配置。
    const regenBase = await api(base, "POST", endpoint, {
      target: "base",
      previousPrompt: String(firstBase.body.prompt),
    });
    assert.equal(regenBase.status, 200);
    assert.equal(
      regenBase.body.prompt,
      "银灰高马尾长发，温暖琥珀瞳色，细腻二次元厚涂",
    );
    assert.ok(
      chatModel.requests[1]?.messages[0]?.role === "user" &&
        chatModel.requests[1].messages[0].content.includes("银灰长发，琥珀色眼瞳"),
    );

    // 4. 指定服饰生成服饰锚点提示词，支持仅包含立绘（回退 sprite）的服饰；不存在服饰返回 404。
    const missingOutfit = await api(base, "POST", endpoint, {
      target: "outfit",
      outfitId: "nonexistent-outfit-id",
    });
    assert.equal(missingOutfit.status, 404);
    assert.equal(
      (missingOutfit.body.error as { code: string }).code,
      "OUTFIT_NOT_FOUND",
    );

    const outfitOnlySprite = await fixture.app.services.appearance.importOutfit(
      roleId,
      {
        name: "备用立绘",
        sprites: [{ fileName: "alt.png", data: pngA }],
      },
    );
    const outfitPrompt = await api(base, "POST", endpoint, {
      target: "outfit",
      outfitId: outfitOnlySprite.outfitId,
    });
    assert.equal(outfitPrompt.status, 200);
    assert.equal(outfitPrompt.body.outfitId, outfitOnlySprite.outfitId);
    assert.equal(outfitPrompt.body.prompt, "米色长款风衣，深色直筒长裤，棕色短靴");
    assert.equal(
      (outfitPrompt.body.source as { fileName: string }).fileName,
      "alt.png",
    );

    // 5. 手动上传一张临时参考图生成，不改衣柜内容也不改已保存的生图配置。
    const form = new FormData();
    form.append(
      "payload",
      JSON.stringify({ target: "outfit", outfitId: outfitDaily.outfitId }),
    );
    form.append(
      "image",
      new Blob([new Uint8Array(pngUpload)], { type: "image/png" }),
      "manual-ref.png",
    );
    const uploadRes = await fetch(`${base}${endpoint}`, {
      method: "POST",
      body: form,
    });
    assert.equal(uploadRes.status, 200);
    const uploadBody = (await uploadRes.json()) as {
      prompt: string;
      source: { kind: string; fileName: string; outfitId: string | null };
    };
    assert.equal(uploadBody.prompt, "红色羊绒披肩，白色荷叶领衬衫，黑色百褶长裙");
    assert.equal(uploadBody.source.kind, "uploaded");
    assert.equal(uploadBody.source.fileName, "manual-ref.png");
    assert.equal(
      chatModel.requests[3]?.messages[0]?.role === "user"
        ? chatModel.requests[3].messages[0].images?.[0]?.dataBase64
        : undefined,
      pngUpload.toString("base64"),
    );

    // 6. 校验未配置对话模型时明确提示 SCENE_IMAGE_CHAT_MODEL_REQUIRED。
    await api(base, "PUT", `/v1/roles/${roleId}/bindings`, { bindings: [] });
    const missingChat = await api(base, "POST", endpoint, { target: "base" });
    assert.equal(missingChat.status, 409);
    assert.equal(
      (missingChat.body.error as { code: string }).code,
      "SCENE_IMAGE_CHAT_MODEL_REQUIRED",
    );

    // 7. 读取角色生图配置仍为空：生成锚点提示词仅更新前端草稿，不直接落库。
    const savedAfter = await api(base, "GET", `/v1/roles/${roleId}/scene-image`);
    assert.equal(savedAfter.status, 200);
    assert.equal(savedAfter.body.configured, false);
    assert.equal(savedAfter.body.settings, null);
  } finally {
    await fixture.close();
  }
});
