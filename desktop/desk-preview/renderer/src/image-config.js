/**
 * 生图配置的纯逻辑：表单默认值、请求载荷、校验与文案。
 * 与 voice-config.js 同一约定——不依赖 React，可直接用 node --test 验证。
 */

/** 后端首版只支持文生图，图生图要等锚点图上传。 */
export const IMAGE_MODEL_TYPE_LABEL = "文生图";

const MIN_SIZE = 256;
const MAX_SIZE = 2048;
const SIZE_STEP = 16;

export function createImageForm(settings) {
  const source = settings ?? {};
  return {
    serviceId: source.serviceId ?? "",
    modelType: "text2img",
    modelPath: source.modelPath ?? "",
    basePrompt: source.basePrompt ?? "",
    negativePrompt: source.negativePrompt ?? "",
    outfitPrompts: { ...(source.outfitPrompts ?? {}) },
    width: source.width ?? 1024,
    height: source.height ?? 1024,
    steps: source.steps ?? 50,
    cfg: source.cfg ?? 3,
    sampler: source.sampler ?? "euler",
    scheduler: source.scheduler ?? "sgm_uniform",
    seed: source.seed ?? null,
    workflow: source.workflow ?? null,
    outputNodeId: source.outputNodeId ?? null,
  };
}

/** 空字符串的服饰提示词不提交，避免把「清空」当成一条空配置存下来。 */
export function toImagePayload(form) {
  const outfitPrompts = {};
  for (const [outfitId, text] of Object.entries(form.outfitPrompts ?? {})) {
    const trimmed = String(text ?? "").trim();
    if (trimmed.length > 0) outfitPrompts[outfitId] = trimmed;
  }
  return {
    serviceId: form.serviceId,
    modelType: form.modelType,
    modelPath: String(form.modelPath ?? "").trim(),
    basePrompt: String(form.basePrompt ?? "").trim(),
    negativePrompt: String(form.negativePrompt ?? "").trim(),
    outfitPrompts,
    width: form.width,
    height: form.height,
    steps: form.steps,
    cfg: form.cfg,
    sampler: String(form.sampler ?? "").trim(),
    scheduler: String(form.scheduler ?? "").trim(),
    seed: form.seed,
    workflow: form.workflow ?? null,
    outputNodeId: form.outputNodeId ?? null,
  };
}

export function withOutfitPrompt(form, outfitId, text) {
  return {
    ...form,
    outfitPrompts: { ...form.outfitPrompts, [outfitId]: text },
  };
}

export function validateImageForm(form) {
  const issues = [];
  const push = (field, code, message) => issues.push({ field, code, message });

  if (!form.serviceId) {
    push("serviceId", "SERVICE_REQUIRED", "先选择或新建一个生图服务");
  }
  const modelPath = String(form.modelPath ?? "").trim();
  if (modelPath.length === 0) {
    push("modelPath", "MODEL_PATH_REQUIRED", "填写 MOSS-Image 的模型目录");
  } else if (modelPath.length > 2000) {
    push("modelPath", "MODEL_PATH_TOO_LONG", "模型目录过长");
  }
  for (const [field, label] of [
    ["basePrompt", "基础锚点提示词"],
    ["negativePrompt", "负向提示词"],
  ]) {
    if (String(form[field] ?? "").length > 2000) {
      push(field, "PROMPT_TOO_LONG", `${label}不能超过 2000 字`);
    }
  }
  for (const [field, label] of [
    ["width", "宽度"],
    ["height", "高度"],
  ]) {
    const value = form[field];
    if (!Number.isInteger(value)) {
      push(field, "SIZE_NOT_INTEGER", `${label}必须是整数`);
    } else if (value < MIN_SIZE || value > MAX_SIZE) {
      push(field, "SIZE_OUT_OF_RANGE", `${label}需在 ${MIN_SIZE}～${MAX_SIZE} 之间`);
    } else if (value % SIZE_STEP !== 0) {
      push(field, "SIZE_NOT_ALIGNED", `${label}必须是 ${SIZE_STEP} 的倍数`);
    }
  }
  if (!Number.isInteger(form.steps) || form.steps < 1 || form.steps > 150) {
    push("steps", "STEPS_OUT_OF_RANGE", "步数需为 1～150 的整数");
  }
  if (typeof form.cfg !== "number" || !Number.isFinite(form.cfg) || form.cfg < 0 || form.cfg > 30) {
    push("cfg", "CFG_OUT_OF_RANGE", "CFG 需在 0～30 之间");
  }
  if (String(form.sampler ?? "").trim().length === 0) {
    push("sampler", "SAMPLER_REQUIRED", "填写采样器名称");
  }
  if (String(form.scheduler ?? "").trim().length === 0) {
    push("scheduler", "SCHEDULER_REQUIRED", "填写调度器名称");
  }
  if (form.seed !== null && form.seed !== undefined) {
    if (!Number.isInteger(form.seed) || form.seed < 0 || form.seed > 2147483647) {
      push("seed", "SEED_OUT_OF_RANGE", "种子需为 0～2147483647 的整数");
    }
  }
  return issues;
}

export function describeImageSummary(view) {
  if (view === null || view === undefined || view.settings === null) {
    return "这个角色还没有配置生图服务。";
  }
  const settings = view.settings;
  const serviceName = view.service === null ? "服务已被删除" : view.service.name;
  const state = view.configured ? "" : "不可用 · ";
  return `${state}${serviceName} · ${IMAGE_MODEL_TYPE_LABEL} · ${settings.width}×${settings.height} · ${settings.steps} steps`;
}

export function summarizeImageProbe(probe) {
  if (probe === null || probe === undefined) return "";
  if (!probe.reachable) return "连不上服务。";
  if (!probe.workflowReady) {
    const missing = (probe.missingNodes ?? []).join("、");
    return `工作流还缺节点：${missing}`;
  }
  const version = probe.comfyuiVersion ? `ComfyUI ${probe.comfyuiVersion}` : "ComfyUI";
  const models = (probe.models ?? []).length;
  return `工作流就绪 · ${version} · 探测到 ${models} 个可用模型`;
}

const FAILURE_TEXT = {
  IMAGE_SERVICE_NOT_FOUND: "生图服务不存在，请重新选择。",
  IMAGE_SERVICE_DISABLED: "生图服务已停用，启用后再试。",
  IMAGE_SERVICE_UNAVAILABLE: "连不上 ComfyUI，确认地址和端口。",
  IMAGE_SERVICE_AUTH_FAILED: "服务拒绝了当前凭据。",
  IMAGE_WORKFLOW_INVALID: "工作流或参数不被接受，检查节点是否齐全、参数是否越界。",
  IMAGE_GENERATION_TIMEOUT: "出图超时。首次加载模型可能较慢，可以调大等待上限。",
  IMAGE_GENERATION_FAILED: "出图失败，详情见服务端日志。",
  SCENE_IMAGE_NOT_CONFIGURED: "还没有配置生图服务。",
  INVALID_IMAGE_SERVICE_CONFIG: "生图服务配置不完整，检查地址。",
  RESOURCE_CREDENTIAL_STALE: "换了服务地址，需要重新填写密钥。",
  RESOURCE_CREDENTIAL_CONFLICT: "直填密钥与引用只能二选一。",
};

export function describeImageFailure(code, message) {
  const known = code === null || code === undefined ? null : FAILURE_TEXT[code];
  if (known !== undefined && known !== null) return known;
  return message || "操作失败，请重试。";
}
