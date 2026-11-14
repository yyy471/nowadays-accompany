"use strict";

// 生图配置表单映射、校验与文案的纯逻辑测试。运行：在 desktop/desk-preview 下执行 `npm test`。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(pathToFileURL(path.join(__dirname, "../renderer/src/image-config.js")).href);

const saved = {
  serviceId: "svc-1",
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
  outputNodeId: null
};

test("createImageForm 用默认值填补未配置的角色", async () => {
  const { createImageForm } = await load();
  const form = createImageForm(null);
  assert.equal(form.serviceId, "");
  assert.equal(form.modelType, "text2img");
  assert.equal(form.width, 1024);
  assert.equal(form.height, 1024);
  assert.equal(form.steps, 50);
  assert.equal(form.cfg, 3);
  assert.equal(form.sampler, "euler");
  assert.equal(form.scheduler, "sgm_uniform");
  assert.equal(form.seed, null);
  assert.deepEqual(form.outfitPrompts, {});
  assert.equal(form.workflow, null);
});

test("createImageForm 复制已保存配置，不共享 outfitPrompts 引用", async () => {
  const { createImageForm } = await load();
  const form = createImageForm(saved);
  assert.equal(form.modelPath, "/models/MOSS-Image-Base");
  assert.equal(form.outfitPrompts["outfit-1"], "米色风衣");
  form.outfitPrompts["outfit-1"] = "改过的";
  assert.equal(saved.outfitPrompts["outfit-1"], "米色风衣");
});

test("toImagePayload 去空白并丢掉空的服饰提示词", async () => {
  const { createImageForm, toImagePayload, withOutfitPrompt } = await load();
  let form = createImageForm(saved);
  form = withOutfitPrompt(form, "outfit-2", "   ");
  form = withOutfitPrompt(form, "outfit-3", " 深色长裤 ");
  form.modelPath = "  /models/MOSS-Image-SFT  ";
  const payload = toImagePayload(form);
  assert.equal(payload.modelPath, "/models/MOSS-Image-SFT");
  assert.deepEqual(payload.outfitPrompts, {
    "outfit-1": "米色风衣",
    "outfit-3": "深色长裤"
  });
  assert.equal(payload.modelType, "text2img");
  assert.equal(payload.seed, 7);
});

test("validateImageForm 拦住缺服务、缺模型目录与越界参数", async () => {
  const { createImageForm, validateImageForm } = await load();
  const empty = validateImageForm(createImageForm(null));
  assert.deepEqual(
    empty.map(issue => issue.code),
    ["SERVICE_REQUIRED", "MODEL_PATH_REQUIRED"]
  );

  const form = {
    ...createImageForm(saved),
    width: 1000,
    height: 4096,
    steps: 0,
    cfg: 31,
    seed: -1
  };
  const codes = validateImageForm(form).map(issue => issue.code);
  assert.ok(codes.includes("SIZE_NOT_ALIGNED"));
  assert.ok(codes.includes("SIZE_OUT_OF_RANGE"));
  assert.ok(codes.includes("STEPS_OUT_OF_RANGE"));
  assert.ok(codes.includes("CFG_OUT_OF_RANGE"));
  assert.ok(codes.includes("SEED_OUT_OF_RANGE"));
});

test("validateImageForm 接受符合 MOSS-Image 约束的配置", async () => {
  const { createImageForm, validateImageForm } = await load();
  assert.deepEqual(validateImageForm(createImageForm(saved)), []);
  assert.deepEqual(
    validateImageForm({ ...createImageForm(saved), seed: null }),
    []
  );
});

test("describeImageSummary 标出未配置与不可用", async () => {
  const { describeImageSummary } = await load();
  assert.equal(
    describeImageSummary({ settings: null, service: null, configured: false }),
    "这个角色还没有配置生图服务。"
  );
  const unavailable = describeImageSummary({
    settings: saved,
    service: null,
    configured: false
  });
  assert.ok(unavailable.startsWith("不可用 · 服务已被删除"));
  const ready = describeImageSummary({
    settings: saved,
    service: { serviceId: "svc-1", name: "本机 ComfyUI", enabled: true, baseUrl: "http://127.0.0.1:8188" },
    configured: true
  });
  assert.equal(ready, "本机 ComfyUI · 文生图 · 768×1024 · 40 steps");
});

test("summarizeImageProbe 区分就绪、缺节点与连不上", async () => {
  const { summarizeImageProbe } = await load();
  assert.equal(
    summarizeImageProbe({
      reachable: true,
      comfyuiVersion: "0.3.60",
      devices: ["cuda:0"],
      workflowReady: true,
      missingNodes: [],
      models: ["a", "b"]
    }),
    "工作流就绪 · ComfyUI 0.3.60 · 探测到 2 个可用模型"
  );
  assert.equal(
    summarizeImageProbe({
      reachable: true,
      comfyuiVersion: null,
      devices: [],
      workflowReady: false,
      missingNodes: ["MOSSImageHFLoader", "EmptyFlux2LatentImage"],
      models: []
    }),
    "工作流还缺节点：MOSSImageHFLoader、EmptyFlux2LatentImage"
  );
  assert.equal(
    summarizeImageProbe({
      reachable: false,
      comfyuiVersion: null,
      devices: [],
      workflowReady: false,
      missingNodes: [],
      models: []
    }),
    "连不上服务。"
  );
});

test("describeImageFailure 优先用已知错误码的说明", async () => {
  const { describeImageFailure } = await load();
  assert.equal(
    describeImageFailure("IMAGE_GENERATION_TIMEOUT", "raw"),
    "出图超时。首次加载模型可能较慢，可以调大等待上限。"
  );
  assert.equal(
    describeImageFailure("ROLES_NOT_STOPPED", "raw"),
    "还有角色处于活动状态，请先暂停相关角色后再修改全局生图服务。"
  );
  assert.equal(describeImageFailure("SOMETHING_NEW", "服务返回 500"), "服务返回 500");
  assert.equal(describeImageFailure(null, ""), "操作失败，请重试。");
});

test("toSceneImagePreviewPayload 与 toImageServiceProbePayload 构造草稿请求载荷", async () => {
  const {
    createImageForm,
    toSceneImagePreviewPayload,
    toImageServiceProbePayload,
  } = await load();
  const form = createImageForm(saved);
  form.modelPath = "  /models/MOSS-Draft  ";
  form.width = 512;
  const preview = toSceneImagePreviewPayload(form, {
    prompt: "  雨夜咖啡馆  ",
    outfitId: "  outfit-1  ",
  });
  assert.equal(preview.prompt, "雨夜咖啡馆");
  assert.equal(preview.outfitId, "outfit-1");
  assert.equal(preview.settings.modelPath, "/models/MOSS-Draft");
  assert.equal(preview.settings.width, 512);

  const probeNew = toImageServiceProbePayload({
    baseUrl: " http://127.0.0.1:8188 ",
    secret: "draft-token",
    timeoutMs: 30000,
  });
  assert.deepEqual(probeNew, {
    config: {
      protocol: "comfyui",
      baseUrl: "http://127.0.0.1:8188",
      timeoutMs: 30000,
    },
    secret: "draft-token",
  });
});

test("imageServiceSnapshotKey 随启用状态、连接参数或修改代次变化而失配", async () => {
  const { imageServiceSnapshotKey, describeImageFailure } = await load();
  const base = {
    serviceId: "svc-1",
    enabled: true,
    updatedAt: "2026-11-14T10:00:00.000Z",
    config: { protocol: "comfyui", baseUrl: "http://127.0.0.1:8188", timeoutMs: 30000 },
    credential: { status: "unset", reference: null },
  };
  const key0 = imageServiceSnapshotKey(base, 0);
  assert.equal(imageServiceSnapshotKey(null), "");
  assert.notEqual(key0, "");
  assert.equal(key0, imageServiceSnapshotKey({ ...base }, 0));
  assert.notEqual(key0, imageServiceSnapshotKey({ ...base, enabled: false }, 0));
  assert.notEqual(
    key0,
    imageServiceSnapshotKey({ ...base, config: { ...base.config, baseUrl: "http://127.0.0.1:8189" } }, 0),
  );
  assert.notEqual(
    key0,
    imageServiceSnapshotKey({ ...base, config: { ...base.config, timeoutMs: 60000 } }, 0),
  );
  assert.notEqual(
    key0,
    imageServiceSnapshotKey({ ...base, credential: { status: "inline", reference: null } }, 0),
  );
  assert.notEqual(key0, imageServiceSnapshotKey(base, 1));
  assert.equal(describeImageFailure("OUTFIT_NOT_FOUND", ""), "当前选择的服饰不存在，刷新后重试。");
});
