/**
 * 生图配置的纯逻辑：表单默认值、请求载荷、校验与文案。
 * 与 voice-config.ts 同一约定——不依赖 React，可直接用 node --test 验证。
 */

export interface ImageSettingsView {
  serviceId: string;
  modelType: "text2img" | "img2img";
  autoGenerateEnabled: boolean;
  autoCooldownMinutes: number;
  modelPath: string;
  basePrompt: string;
  negativePrompt: string;
  outfitPrompts: Record<string, string>;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number | null;
  workflow: Record<string, unknown> | null;
  outputNodeId: string | null;
}

export interface ImageServiceSummary {
  serviceId: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  modelName?: string;
}

export interface ImageSettingsViewPayload {
  settings: ImageSettingsView | null;
  service: ImageServiceSummary | null;
  configured: boolean;
}

export interface ImageForm extends ImageSettingsView {}

export interface ImageFormIssue {
  field: string;
  code: string;
  message: string;
}

export interface ImageProbe {
  reachable: boolean;
  comfyuiVersion: string | null;
  devices: string[];
  workflowReady: boolean;
  missingNodes: string[];
  models: string[];
}

export interface ImageProbeResult {
  probe: ImageProbe;
  elapsedMs: number;
}

export interface ImagePreview {
  mediaType: string;
  width: number;
  height: number;
  byteSize: number;
  dataBase64: string;
  prompt: string;
}

export const IMAGE_MODEL_TYPE_LABEL = "文生图";

const MIN_SIZE = 256;
const MAX_SIZE = 2048;
const SIZE_STEP = 16;

export function createImageForm(settings: ImageSettingsView | null | undefined): ImageForm {
  const source: Partial<ImageSettingsView> = settings ?? {};
  return {
    serviceId: source.serviceId ?? "",
    modelType: source.modelType ?? "text2img",
    autoGenerateEnabled: source.autoGenerateEnabled ?? false,
    autoCooldownMinutes: source.autoCooldownMinutes ?? 30,
    modelPath: source.modelPath ?? "",
    basePrompt: source.basePrompt ?? "",
    negativePrompt: source.negativePrompt ?? "",
    outfitPrompts: { ...(source.outfitPrompts ?? {}) },
    width: source.width ?? 1024,
    height: source.height ?? 1024,
    steps: source.steps ?? 25,
    cfg: source.cfg ?? 2.5,
    sampler: source.sampler ?? "er_sde",
    scheduler: source.scheduler ?? "simple",
    seed: source.seed ?? null,
    workflow: source.workflow ?? null,
    outputNodeId: source.outputNodeId ?? null,
  };
}

/** 空字符串的服饰提示词不提交，避免把「清空」当成一条空配置存下来。 */
export function toImagePayload(form: ImageForm): ImageSettingsView {
  const outfitPrompts: Record<string, string> = {};
  for (const [outfitId, text] of Object.entries(form.outfitPrompts ?? {})) {
    const trimmed = String(text ?? "").trim();
    if (trimmed.length > 0) outfitPrompts[outfitId] = trimmed;
  }
  return {
    serviceId: form.serviceId,
    modelType: form.modelType,
    autoGenerateEnabled: form.autoGenerateEnabled,
    autoCooldownMinutes: form.autoCooldownMinutes,
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

/** 构造草稿生图预览载荷：使用未保存的表单草稿，不修改已保存角色配置。 */
export function toSceneImagePreviewPayload(
  form: ImageForm,
  options: { prompt?: string; outfitId?: string | null } = {},
): { prompt: string; outfitId?: string; settings: ImageSettingsView } {
  const prompt = String(options.prompt ?? "").trim();
  const outfitId = String(options.outfitId ?? "").trim();
  return {
    prompt,
    ...(outfitId.length > 0 ? { outfitId } : {}),
    settings: toImagePayload(form),
  };
}

/** 读取全局变量中的默认生图模型名（未配置则返回空串）。 */
export function savedImageModelOf(service: { config?: { modelName?: string } } | null | undefined): string {
  const modelName = service?.config?.modelName;
  return typeof modelName === "string" ? modelName.trim() : "";
}

/**
 * 根据最新的全局生图服务列表同步角色表单：
 * 未选服务时自动选中首个可用（优先启用）服务并补全默认模型；无变化时返回原引用。
 */
export function syncImageFormServices(
  form: ImageForm,
  services: ReadonlyArray<{ serviceId: string; enabled?: boolean; config?: { modelName?: string } }>,
): ImageForm {
  if (!Array.isArray(services) || services.length === 0) {
    return form;
  }
  if (form.serviceId === "") {
    const first = services.find((item) => item.enabled) ?? services[0];
    return {
      ...form,
      serviceId: first.serviceId,
      modelPath: form.modelPath || savedImageModelOf(first),
    };
  }
  const matched = services.find((item) => item.serviceId === form.serviceId);
  if (matched && !form.modelPath) {
    const defaultModel = savedImageModelOf(matched);
    if (defaultModel) {
      return { ...form, modelPath: defaultModel };
    }
  }
  return form;
}

/** 构造生图服务连接探测草稿载荷（Settings 或面板新建服务共用）。 */
export function toImageServiceProbePayload(
  input: {
    serviceId?: string;
    baseUrl?: string;
    modelName?: string;
    credentialRef?: string;
    secret?: string;
    timeoutMs?: number;
    workflow?: Record<string, unknown> | null;
  } = {},
): {
  serviceId?: string;
  config: { protocol: "comfyui"; baseUrl: string; modelName?: string; credentialRef?: string; timeoutMs?: number };
  secret?: string;
  workflow?: Record<string, unknown>;
} {
  const serviceId = String(input.serviceId ?? "").trim();
  const baseUrl = String(input.baseUrl ?? "").trim();
  const modelName = String(input.modelName ?? "").trim();
  const credentialRef = String(input.credentialRef ?? "").trim();
  const secret = String(input.secret ?? "");
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.round(input.timeoutMs)
      : undefined;
  return {
    ...(serviceId.length > 0 ? { serviceId } : {}),
    config: {
      protocol: "comfyui",
      baseUrl,
      ...(modelName.length > 0 ? { modelName } : {}),
      ...(credentialRef.length > 0 ? { credentialRef } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
    ...(secret.length > 0 ? { secret } : {}),
    ...(input.workflow ? { workflow: input.workflow } : {}),
  };
}

export function withOutfitPrompt(form: ImageForm, outfitId: string, text: string): ImageForm {
  return {
    ...form,
    outfitPrompts: { ...form.outfitPrompts, [outfitId]: text },
  };
}

export function validateImageForm(form: ImageForm): ImageFormIssue[] {
  const issues: ImageFormIssue[] = [];
  const push = (field: string, code: string, message: string) => issues.push({ field, code, message });
  if (!Number.isInteger(form.autoCooldownMinutes) || form.autoCooldownMinutes < 0 || form.autoCooldownMinutes > 10080) {
    push("autoCooldownMinutes", "INVALID_AUTO_COOLDOWN", "自动生成冷却时间应为 0 至 10080 分钟");
  }
  if (form.modelType === "img2img" && !form.workflow) {
    push("workflow", "SCENE_REFERENCE_WORKFLOW_REQUIRED", "图生图需要导入带 LoadImage 的 ComfyUI API 工作流");
  }

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
  ] as const) {
    if (String(form[field] ?? "").length > 2000) {
      push(field, "PROMPT_TOO_LONG", `${label}不能超过 2000 字`);
    }
  }
  for (const [field, label] of [
    ["width", "宽度"],
    ["height", "高度"],
  ] as const) {
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

export function describeImageSummary(view: ImageSettingsViewPayload | null | undefined): string {
  if (view === null || view === undefined || view.settings === null) {
    return "这个角色还没有配置生图服务。";
  }
  const settings = view.settings;
  const serviceName = view.service === null ? "服务已被删除" : view.service.name;
  const state = view.configured ? "" : "不可用 · ";
  const modeLabel = settings.modelType === "img2img" ? "图生图" : IMAGE_MODEL_TYPE_LABEL;
  return `${state}${serviceName} · ${modeLabel} · ${settings.width}×${settings.height} · ${settings.steps} steps`;
}

export function summarizeImageProbe(probe: ImageProbe | null | undefined): string {
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

/** 生图服务测试连接文案与级别；若指定了当前模型名且默认工作流可用，会校验是否出现在探测列表中。 */
export function evaluateImageConnectionTest(
  probe: ImageProbe | null | undefined,
  targetModel = "",
  elapsedMs = 0,
  hasCustomWorkflow = false,
): { role: "status" | "alert"; text: string } {
  if (probe === null || probe === undefined || !probe.reachable) {
    return { role: "alert", text: "测试失败：连不上服务。" };
  }
  if (!probe.workflowReady) {
    const missing = (probe.missingNodes ?? []).join("、");
    return { role: "alert", text: `工作流还缺节点：${missing}` };
  }
  const version = probe.comfyuiVersion ? `ComfyUI ${probe.comfyuiVersion}` : "ComfyUI";
  const models = Array.isArray(probe.models) ? probe.models : [];
  const ms = Math.max(0, Math.round(Number(elapsedMs ?? 0)));
  const model = String(targetModel ?? "").trim();
  if (model.length > 0 && models.length > 0 && !models.includes(model) && !hasCustomWorkflow) {
    return {
      role: "alert",
      text: `工作流就绪 · ${version} · ${ms} ms，但探测列表中未找到「${model}」`,
    };
  }
  if (model.length > 0 && models.includes(model)) {
    return {
      role: "status",
      text: `测试通过 · ${version} · 已确认模型「${model}」· ${ms} ms`,
    };
  }
  return {
    role: "status",
    text: `测试通过 · 工作流就绪 · ${version} · 探测到 ${models.length} 个模型 · ${ms} ms`,
  };
}

const FAILURE_TEXT: Record<string, string> = {
  IMAGE_SERVICE_NOT_FOUND: "生图服务不存在，请重新选择。",
  IMAGE_SERVICE_DISABLED: "生图服务已停用，启用后再试。",
  IMAGE_SERVICE_UNAVAILABLE: "连不上 ComfyUI，确认地址和端口。",
  IMAGE_SERVICE_AUTH_FAILED: "服务拒绝了当前凭据。",
  IMAGE_WORKFLOW_INVALID: "工作流或参数不被接受，检查节点是否齐全、参数是否越界。",
  IMAGE_GENERATION_TIMEOUT: "出图超时。首次加载模型可能较慢，可以调大等待上限。",
  IMAGE_GENERATION_FAILED: "出图失败，详情见服务端日志。",
  SCENE_IMAGE_NOT_CONFIGURED: "还没有配置生图服务。",
  SCENE_IMAGE_ANCHOR_IMAGE_REQUIRED: "还没有可用的角色锚点图片，请先在外观中导入立绘或点击旁边的参考图上传。",
  SCENE_IMAGE_CHAT_MODEL_REQUIRED: "当前角色还没有绑定并启用对话模型，请先在「模型 -> 对话」中配置并保存。",
  SCENE_IMAGE_ANCHOR_CANCELED: "已取消生成锚点提示词。",
  MULTIPLE_ANCHOR_IMAGES: "一次只能上传一张参考图片。",
  MODEL_REQUEST_FAILED: "对话模型生成提示词失败，请检查对话模型可用性后重试。",
  INVALID_SCENE_IMAGE_SETTINGS: "生图参数不合法，请检查模型目录和生成参数。",
  INVALID_IMAGE_SERVICE_CONFIG: "生图服务配置不完整，检查地址。",
  RESOURCE_CREDENTIAL_STALE: "换了服务地址，需要重新填写密钥或切换为无密钥。",
  RESOURCE_CREDENTIAL_CONFLICT: "直填密钥与引用只能二选一。",
  ROLES_NOT_STOPPED: "还有角色处于活动状态，请先暂停相关角色后再修改全局生图服务。",
  OUTFIT_NOT_FOUND: "当前选择的服饰不存在，刷新后重试。",
  SCENE_REFERENCE_WORKFLOW_REQUIRED: "图生图需要导入带 LoadImage 的 ComfyUI API 工作流。",
  SCENE_REFERENCE_MISSING: "目标服饰还没有上传图生图参考图，请先上传后再试。",
  SCENE_REFERENCE_UNAVAILABLE: "保存的服饰参考图不可读，请重新上传。",
  SCENE_REFERENCE_TOO_LARGE: "服饰参考图超过 8 MiB 上限。",
  SCENE_BACKGROUND_WORKFLOW_REQUIRED: "该模型未配置独立的纯背景输出，请在工作流中增加不读取参考图的 SaveImage 分支。",
};

/** 生成服务状态与连接配置的快照键，用于跨页返回或刷新时判定探测/预览是否已过期。 */
export function imageServiceSnapshotKey(
  service: {
    serviceId?: string;
    enabled?: boolean;
    updatedAt?: string;
    config?: {
      protocol?: string;
      baseUrl?: string;
      modelName?: string;
      credentialRef?: string;
      timeoutMs?: number;
    };
    credential?: { status?: string; reference?: string | null };
  } | null | undefined,
  epoch = 0,
): string {
  if (service === null || service === undefined) return "";
  const config = service.config ?? {};
  const credential = service.credential ?? {};
  return JSON.stringify([
    service.serviceId ?? "",
    Boolean(service.enabled),
    config.protocol ?? "comfyui",
    config.baseUrl ?? "",
    config.modelName ?? "",
    config.timeoutMs ?? null,
    config.credentialRef ?? "",
    credential.status ?? "",
    credential.reference ?? "",
    service.updatedAt ?? "",
    Number.isFinite(Number(epoch)) ? Number(epoch) : 0,
  ]);
}

export function describeImageFailure(code: string | null, message: string): string {
  const known = code === null || code === undefined ? null : FAILURE_TEXT[code];
  if (known !== undefined && known !== null) return known;
  return message || "操作失败，请重试。";
}
