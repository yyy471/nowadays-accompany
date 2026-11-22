/**
 * 角色声音配置的表单映射、校验与错误文案。
 *
 * 只处理普通对象，不发请求、不碰 DOM，便于在 node:test 里覆盖。
 * 后端接口契约见 apps/backend/src/http/voice-routes.ts。
 */

export type VoiceProtocol = "nowadays-tts-v1" | "indextts";

export interface VoiceReferenceMode {
  id: string;
  label: string;
  requiresReferenceText: boolean;
}

export interface VoiceSpeedRange {
  min: number;
  max: number;
}

export interface VoiceCapabilities {
  referenceModes: VoiceReferenceMode[];
  presetVoices: boolean;
  languages: string[];
  speed: VoiceSpeedRange | null;
}

export interface VoicePresetVoice {
  id: string;
  label: string;
}

export interface VoiceReferenceRecord {
  assetId: string;
  roleId?: string;
  fileName: string;
  mediaType: string;
  createdAt: string;
}

export interface VoiceSourceReference {
  kind: "reference";
  referenceAssetId: string | null;
  referenceMode: string | null;
  referenceText: string | null;
}

export interface VoiceSourcePreset {
  kind: "preset";
  voiceId: string;
}

export type VoiceSource = VoiceSourceReference | VoiceSourcePreset;

export interface VoiceEngineStatus {
  ready: boolean;
  active: boolean;
  onDemand?: boolean;
}

export interface VoiceServiceItem {
  serviceId: string;
  name: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  config: {
    protocol: VoiceProtocol;
    baseUrl: string;
    defaultEngine?: string;
  };
}

export interface VoiceConfigView {
  serviceId?: string | null;
  service?: {
    serviceId: string;
    name: string;
    enabled: boolean;
    protocol: VoiceProtocol;
    baseUrl: string;
    defaultEngine?: string;
  } | null;
  engine: VoiceProtocol;
  protocol: VoiceProtocol;
  ttsEngine?: string | null;
  engines?: Record<string, VoiceEngineStatus>;
  defaultEngine?: string;
  baseUrl: string;
  voiceSource: VoiceSource;
  reference: VoiceReferenceRecord | null;
  capabilities: VoiceCapabilities | null;
  /** 停用只阻止新的对话语音合成，配置本身保留。 */
  enabled: boolean;
  language: string;
  speed: number;
  emoAlpha: number;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceProbeResult {
  protocol: "nowadays-tts-v1";
  service: string;
  model: string;
  ready: boolean;
  capabilities: VoiceCapabilities;
  voices: VoicePresetVoice[] | null;
  engines?: Record<string, VoiceEngineStatus>;
  defaultEngine?: string;
}

export interface VoiceReferenceItem {
  assetId: string;
  fileName: string;
  mediaType: string;
  createdAt: string;
  inUse: boolean;
}

export interface VoiceForm {
  serviceId: string;
  baseUrl: string;
  protocol: VoiceProtocol;
  ttsEngine: string;
  sourceKind: "reference" | "preset";
  voiceId: string;
  referenceAssetId: string;
  referenceMode: string;
  referenceText: string;
  language: string;
  speed: number;
  emoAlpha: number;
  configured: boolean;
  capabilities: VoiceCapabilities | null;
}

export interface VoiceFormIssue {
  field: string;
  code: string;
  message: string;
}

export interface VoiceProbeSummary {
  ready: boolean;
  service: string;
  model: string;
  presetVoiceCount: number;
  supportsPreset: boolean;
  referenceModes: VoiceReferenceMode[];
  languages: string[];
  speed: VoiceSpeedRange | null;
  engines: Record<string, VoiceEngineStatus> | null;
  defaultEngine: string | null;
}

export const VOICE_PROTOCOLS: readonly VoiceProtocol[] = ["nowadays-tts-v1", "indextts"];

const PROTOCOL_LABELS: Record<string, string> = {
  "nowadays-tts-v1": "统一语音协议",
  indextts: "旧 IndexTTS 协议"
};

const DEFAULT_FORM: Omit<VoiceForm, "configured" | "capabilities"> = {
  serviceId: "",
  baseUrl: "",
  protocol: "nowadays-tts-v1",
  ttsEngine: "",
  sourceKind: "reference",
  voiceId: "",
  referenceAssetId: "",
  referenceMode: "",
  referenceText: "",
  language: "zh",
  speed: 1,
  emoAlpha: 1
};

const ENGINE_PREFIXES: Record<string, string> = {
  cosyvoice: "cosy:",
  indextts: "index:"
};

export function createVoiceForm(config?: VoiceConfigView | null): VoiceForm {
  if (config === null || config === undefined) {
    return { ...DEFAULT_FORM, configured: false, capabilities: null };
  }
  const source: VoiceSource = config.voiceSource ?? { kind: "reference", referenceAssetId: null, referenceMode: null, referenceText: null };
  const isPreset = source.kind === "preset";
  return {
    serviceId: config.serviceId ?? config.service?.serviceId ?? "",
    baseUrl: config.baseUrl ?? config.service?.baseUrl ?? "",
    protocol: config.protocol ?? config.service?.protocol ?? "nowadays-tts-v1",
    ttsEngine: config.ttsEngine ?? "",
    sourceKind: isPreset ? "preset" : "reference",
    voiceId: isPreset ? source.voiceId ?? "" : "",
    referenceAssetId: isPreset ? "" : source.referenceAssetId ?? "",
    referenceMode: isPreset ? "" : source.referenceMode ?? "",
    referenceText: isPreset ? "" : source.referenceText ?? "",
    language: config.language ?? "zh",
    speed: config.speed ?? 1,
    emoAlpha: config.emoAlpha ?? 1,
    configured: true,
    capabilities: config.capabilities ?? null
  };
}

/**
 * 保存与试听共用的请求体。后端 saveVoiceSchema 是 strict，只允许约定字段。
 */
export function toVoicePayload(
  form: VoiceForm,
  options: {
    capabilities?: VoiceCapabilities | null;
    engines?: Record<string, VoiceEngineStatus> | null;
    defaultEngine?: string | null;
    hasPendingReference?: boolean;
    clearEngine?: boolean;
  } = {}
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    language: form.language,
    speed: Number(form.speed),
    emoAlpha: Number(form.emoAlpha)
  };
  const serviceId = String(form.serviceId ?? "").trim();
  if (serviceId.length > 0) {
    payload.serviceId = serviceId;
  } else {
    payload.baseUrl = form.baseUrl.trim();
    payload.protocol = form.protocol;
  }
  // 探测到的能力声明随请求提交：后端据此拒绝服务不支持的音色来源与参数，
  // 也会把它随配置保存下来，重新打开页面时不必再探测一次。
  // 能力未知时不带该字段，让后端沿用同地址已保存的声明。
  const capabilities =
    options.capabilities !== undefined ? options.capabilities : form.capabilities;
  if (capabilities !== null && capabilities !== undefined) {
    payload.capabilities = capabilities;
  }
  const ttsEngine = form.protocol === "indextts" ? "" : String(form.ttsEngine ?? "").trim();
  if (ttsEngine.length > 0) {
    payload.ttsEngine = ttsEngine;
  } else if (options.clearEngine && form.protocol !== "indextts") {
    payload.ttsEngine = null;
  }
  if (options.engines !== null && options.engines !== undefined) {
    payload.engines = options.engines;
  }
  if (typeof options.defaultEngine === "string" && options.defaultEngine.trim().length > 0) {
    payload.defaultEngine = options.defaultEngine.trim();
  }
  // 旧 IndexTTS 只有参考音频一种音色来源，不发送参考模式与参考文本。
  if (form.protocol === "indextts" || form.sourceKind === "reference") {
    const hasPending = Boolean(options.hasPendingReference);
    const referenceAssetId = hasPending ? null : form.referenceAssetId || null;
    payload.voiceSource = {
      kind: "reference",
      referenceAssetId,
      referenceMode:
        form.protocol === "indextts" ? null : form.referenceMode || null,
      // 没有录音（含待上传临时录音时除外）不能留下孤立文本。
      referenceText:
        form.protocol === "indextts" || (!hasPending && referenceAssetId === null)
          ? null
          : form.referenceText.trim() || null
    };
    return payload;
  }
  payload.voiceSource = { kind: "preset", voiceId: form.voiceId.trim() };
  return payload;
}

/**
 * 切换参考录音（包括暂存新本地音频）时清空参考文本：
 * 旧文本对应的是上一段录音，继续提交会让新录音配上旧原文。
 */
export function withReferenceAudio(
  form: VoiceForm,
  assetId: string | null | undefined
): VoiceForm {
  const next = String(assetId ?? "");
  if (next === form.referenceAssetId) {
    return form;
  }
  return { ...form, referenceAssetId: next, referenceText: "" };
}

/** 暂存待上传的本地参考音频时切换为参考音频模式、清掉旧引用并清空旧参考文本。 */
export function withPendingReferenceAudio(form: VoiceForm): VoiceForm {
  return {
    ...form,
    sourceKind: "reference",
    referenceAssetId: "",
    referenceText: ""
  };
}

/** 按后端与探测声明的能力校验表单，返回全部问题而不是第一条。 */
export function validateVoiceForm(
  form: VoiceForm,
  options: {
    capabilities?: VoiceCapabilities | null;
    engines?: Record<string, VoiceEngineStatus> | null;
    hasPendingReference?: boolean;
    requireService?: boolean;
  } = {}
): VoiceFormIssue[] {
  const issues: VoiceFormIssue[] = [];
  if (options.requireService) {
    if (String(form.serviceId ?? "").trim().length === 0) {
      issues.push(issue("serviceId", "VOICE_SERVICE_REQUIRED", "请先选择或添加语音服务"));
    }
  } else {
    const baseUrl = form.baseUrl.trim();
    if (baseUrl.length === 0) {
      issues.push(issue("baseUrl", "BASE_URL_REQUIRED", "音色服务地址不能为空"));
    } else {
      const invalid = describeBaseUrlProblem(baseUrl);
      if (invalid !== null) {
        issues.push(issue("baseUrl", "BASE_URL_INVALID", invalid));
      }
    }
  }

  const isLegacy = form.protocol === "indextts";
  if (!isLegacy && form.sourceKind === "preset") {
    if (form.voiceId.trim().length === 0) {
      issues.push(issue("voiceId", "VOICE_ID_REQUIRED", "预置音色需要选择或填写音色 ID"));
    }
  } else if (!options.hasPendingReference && form.referenceAssetId.length === 0) {
    issues.push(
      issue("referenceAssetId", "REFERENCE_REQUIRED", "参考音频音色需要先选择或上传一段参考音频")
    );
  }

  const capabilities =
    options.capabilities !== undefined
      ? options.capabilities
      : form.capabilities ?? null;
  if (capabilities === null || capabilities === undefined) {
    return issues;
  }

  const speed = Number(form.speed);
  const range = capabilities.speed ?? null;
  if (range !== null) {
    if (!Number.isFinite(speed) || speed < range.min || speed > range.max) {
      issues.push(
        issue("speed", "SPEED_OUT_OF_RANGE", `语速需要在 ${range.min}～${range.max} 之间`)
      );
    }
  }

  const languages = capabilities.languages ?? [];
  if (languages.length > 0 && !languages.includes(form.language)) {
    issues.push(
      issue("language", "LANGUAGE_UNSUPPORTED", `服务不支持语言「${form.language}」`)
    );
  }

  if (!isLegacy && form.sourceKind === "preset" && capabilities.presetVoices === false) {
    issues.push(
      issue("sourceKind", "PRESET_UNSUPPORTED", "当前服务未声明预置音色，不能使用预置音色")
    );
  }

  if (!isLegacy && form.sourceKind === "reference") {
    const modes = capabilities.referenceModes ?? [];
    if (modes.length === 0) {
      // 服务明确不支持参考音频：这与「还没探测、能力未知」不同，不能放行保存。
      issues.push(
        issue("sourceKind", "REFERENCE_UNSUPPORTED", "当前服务未声明参考音频模式，不能使用参考音频音色")
      );
    } else {
      const selected = modes.find((mode) => mode.id === form.referenceMode);
      if (selected === undefined) {
        issues.push(
          issue("referenceMode", "REFERENCE_MODE_REQUIRED", "需要选择服务声明的参考模式")
        );
      } else if (selected.requiresReferenceText && form.referenceText.trim().length === 0) {
        issues.push(
          issue("referenceText", "REFERENCE_TEXT_REQUIRED", `参考模式「${selected.label}」需要参考文本`)
        );
      }
    }
  }

  const ttsEngine = String(form.ttsEngine ?? "").trim();
  if (
    !isLegacy &&
    options.engines !== null &&
    options.engines !== undefined &&
    ttsEngine.length > 0 &&
    !Object.prototype.hasOwnProperty.call(options.engines, ttsEngine)
  ) {
    issues.push(
      issue("ttsEngine", "ENGINE_UNSUPPORTED", "所选语音引擎不在当前服务声明的列表中")
    );
  }

  return issues;
}

export function summarizeProbe(probe?: VoiceProbeResult | null): VoiceProbeSummary | null {
  if (probe === null || probe === undefined) return null;
  const capabilities: Partial<VoiceCapabilities> = probe.capabilities ?? {};
  return {
    ready: Boolean(probe.ready),
    service: probe.service ?? "",
    model: probe.model ?? "",
    presetVoiceCount: Array.isArray(probe.voices) ? probe.voices.length : 0,
    supportsPreset: Boolean(capabilities.presetVoices),
    referenceModes: capabilities.referenceModes ?? [],
    languages: capabilities.languages ?? [],
    speed: capabilities.speed ?? null,
    engines: probe.engines ?? null,
    defaultEngine: probe.defaultEngine ?? null
  };
}

/** 预置音色是否仍在服务端声明的列表里。未探测时返回 null 表示未知。 */
export function isPresetVoiceAvailable(
  voices: Array<{ id: string }> | null | undefined,
  voiceId: string
): boolean | null {
  if (!Array.isArray(voices)) return null;
  const id = String(voiceId ?? "").trim();
  if (id.length === 0) return null;
  return voices.some((voice) => voice?.id === id);
}

/** 地址比较只忽略首尾空白与末尾斜杠，与后端规范化保持一致。 */
export function normalizeBaseUrl(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

/**
 * 探测结果只在发起探测的地址与协议仍是当前表单值时有效。
 * 地址或协议一改，旧结果连同它声明的能力和音色列表都必须失效。
 */
export function isProbeCurrent(
  source: { baseUrl: string; protocol: string } | null | undefined,
  form: VoiceForm
): boolean {
  if (source === null || source === undefined) return false;
  return (
    source.baseUrl === normalizeBaseUrl(form.baseUrl) &&
    source.protocol === form.protocol
  );
}

/**
 * 地址或协议变化时，服务专属的选择必须失效：
 * 预置音色 ID 与参考模式都是服务方分配的标识，换服务后未经重新选择不能随新地址提交，
 * 否则新服务会收到旧服务的模式（可能根本不支持）。
 * 参考音频与参考文本属于角色本地素材，不随服务变化，因此保留。
 */
export function withVoiceService(form: VoiceForm, patch: Partial<VoiceForm>): VoiceForm {
  const updated = { ...form, ...patch };
  const switched =
    (patch.serviceId !== undefined && patch.serviceId !== form.serviceId) ||
    normalizeBaseUrl(updated.baseUrl) !== normalizeBaseUrl(form.baseUrl) ||
    updated.protocol !== form.protocol;
  if (!switched) {
    return updated;
  }
  return { ...updated, ttsEngine: "", voiceId: "", referenceMode: "", capabilities: null };
}

/**
 * 根据最新的全局语音服务列表同步角色表单：
 * 未配置且未选服务时自动选中首个可用（优先启用）服务；已选服务存在且协议或地址变化时同步连接信息；
 * 无变化时返回原对象引用，保留用户草稿。
 */
export function syncVoiceFormServices(form: VoiceForm, services: VoiceServiceItem[]): VoiceForm {
  if (!Array.isArray(services) || services.length === 0) {
    return form;
  }
  if (form.serviceId === "" && !form.configured) {
    const first = services.find((item) => item.enabled) ?? services[0];
    return {
      ...form,
      serviceId: first.serviceId,
      protocol: first.config.protocol,
      baseUrl: first.config.baseUrl
    };
  }
  const matched = services.find((item) => item.serviceId === form.serviceId);
  if (
    matched &&
    (form.protocol !== matched.config.protocol || form.baseUrl !== matched.config.baseUrl)
  ) {
    return {
      ...form,
      protocol: matched.config.protocol,
      baseUrl: matched.config.baseUrl
    };
  }
  return form;
}

function matchesSavedService(config: VoiceConfigView | null | undefined, form: VoiceForm): config is VoiceConfigView {
  if (config === null || config === undefined) return false;
  if (form.serviceId && config.serviceId) {
    return (
      config.serviceId === form.serviceId &&
      normalizeBaseUrl(config.baseUrl) === normalizeBaseUrl(form.baseUrl) &&
      config.protocol === form.protocol
    );
  }
  return (
    normalizeBaseUrl(config.baseUrl) === normalizeBaseUrl(form.baseUrl) &&
    config.protocol === form.protocol
  );
}

/**
 * 能力声明的来源：优先当前地址的探测结果，其次已保存配置。
 * 已保存配置的声明可能缺失（旧配置或换服务后保存）或过期，因此不能挡住刚探测到的结果；
 * 两者都不匹配时返回 null，调用方应跳过能力校验。
 */
export function resolveCapabilities(input: {
  config?: VoiceConfigView | null;
  form: VoiceForm;
  probe?: VoiceProbeResult | null;
  probeSource?: { baseUrl: string; protocol: string } | null;
}): VoiceCapabilities | null {
  const { config, form, probe, probeSource } = input;
  if (probe !== null && probe !== undefined && isProbeCurrent(probeSource, form)) {
    const probed = probe.capabilities;
    if (probed !== null && probed !== undefined) {
      return probed;
    }
  }
  if (matchesSavedService(config, form)) {
    return config.capabilities ?? null;
  }
  return null;
}

/** 解析当前生效的多引擎声明与默认引擎，来源优先级与 resolveCapabilities 一致。 */
export function resolveEngines(input: {
  config?: VoiceConfigView | null;
  form: VoiceForm;
  probe?: VoiceProbeResult | null;
  probeSource?: { baseUrl: string; protocol: string } | null;
}): {
  engines: Record<string, VoiceEngineStatus> | null;
  defaultEngine: string | null;
} {
  const { config, form, probe, probeSource } = input;
  if (form.protocol === "indextts") {
    return { engines: null, defaultEngine: null };
  }
  if (probe !== null && probe !== undefined && isProbeCurrent(probeSource, form)) {
    if (probe.engines !== undefined && probe.engines !== null) {
      return { engines: probe.engines, defaultEngine: probe.defaultEngine ?? null };
    }
  }
  if (matchesSavedService(config, form)) {
    return {
      engines: config.engines ?? null,
      defaultEngine: config.defaultEngine ?? null
    };
  }
  return { engines: null, defaultEngine: null };
}

/** 切换引擎时尽量同步映射同音色（例如 cosy:xxx <-> index:xxx），避免旧前缀误路由到原引擎。 */
export function pickPresetVoiceForEngine(
  voices: VoicePresetVoice[] | null | undefined,
  voiceId: string,
  ttsEngine: string
): string {
  const current = String(voiceId ?? "").trim();
  const targetPrefix = ENGINE_PREFIXES[String(ttsEngine ?? "").trim()];
  if (!targetPrefix || !current || !Array.isArray(voices)) {
    return voiceId;
  }
  const colon = current.indexOf(":");
  if (colon <= 0) {
    return voiceId;
  }
  const suffix = current.slice(colon + 1);
  const candidate = `${targetPrefix}${suffix}`;
  return voices.some((voice) => voice?.id === candidate) ? candidate : voiceId;
}

/** 把接口错误码翻译成配置页能直接展示的提示。 */
export function describeVoiceFailure(error?: {
  code?: string | null;
  message?: string;
}): string {
  const code = error?.code ?? null;
  const fallback = error?.message?.trim() || "请求失败，请稍后重试。";
  switch (code) {
    case "TTS_VOICE_UNAVAILABLE":
      return "这个预置音色已在服务端下架，请重新选择音色后再试听或保存。";
    case "VOICE_REFERENCE_IN_USE":
      return "这段参考音频正在使用，先切换到其他音色再删除。";
    case "VOICE_REFERENCE_NOT_FOUND":
    case "VOICE_REFERENCE_FILE_MISSING":
      return "参考音频已不存在，请重新上传。";
    case "VOICE_REFERENCE_MODE_UNSUPPORTED":
      return "当前服务未声明参考音频模式，不能使用参考音频音色，请改用预置音色。";
    case "VOICE_PRESET_UNSUPPORTED":
      return "当前服务未声明预置音色，请改用参考音频音色。";
    case "VOICE_ENGINE_UNSUPPORTED":
      return "所选语音引擎不在当前服务支持的列表中。";
    case "VOICE_SERVICE_NOT_FOUND":
      return "当前所选语音服务已不存在，请重新选择或前往设置新建。";
    case "VOICE_SERVICE_DISABLED":
      return "当前语音服务已停用，请先启用或更换服务。";
    case "VOICE_PROBE_UNSUPPORTED":
      return "旧 IndexTTS 协议没有能力探测接口，请在角色语音配置中用试听验证连接。";
    case "INVALID_VOICE_SERVICE_CONFIG":
      return "语音服务配置格式不正确，请检查名称、协议与地址。";
    case "VOICE_BASE_URL_REQUIRED":
    case "VOICE_BASE_URL_INVALID":
      return fallback;
    case "TTS_SYNTHESIS_FAILED":
      return `语音服务合成失败：${fallback}`;
    case "MODEL_REQUEST_TIMEOUT":
      return "语音服务响应超时，请确认地址与服务状态。";
    default:
      return fallback;
  }
}

/** 全局语音服务配置草稿校验（设置 -> 模型 -> 语音 创建与详情共用）。 */
export function validateVoiceServiceDraft(draft: {
  name?: string;
  protocol?: VoiceProtocol | string;
  baseUrl?: string;
}): string | null {
  if (!String(draft?.name ?? "").trim()) {
    return "语音服务名称不能为空。";
  }
  const baseUrl = String(draft?.baseUrl ?? "").trim();
  if (!baseUrl) {
    return "音色服务地址不能为空。";
  }
  const problem = describeBaseUrlProblem(baseUrl);
  if (problem !== null) {
    return problem;
  }
  if (draft?.protocol !== "nowadays-tts-v1" && draft?.protocol !== "indextts") {
    return "不支持的语音服务协议。";
  }
  return null;
}

/** 构造全局语音服务的 config 请求体。 */
export function toVoiceServiceConfig(draft: {
  protocol: VoiceProtocol;
  baseUrl: string;
  defaultEngine?: string | null;
}): {
  protocol: VoiceProtocol;
  baseUrl: string;
  defaultEngine?: string;
} {
  const protocol: VoiceProtocol = draft.protocol === "indextts" ? "indextts" : "nowadays-tts-v1";
  const defaultEngine =
    protocol === "indextts" ? "" : String(draft.defaultEngine ?? "").trim();
  return {
    protocol,
    baseUrl: normalizeBaseUrl(draft.baseUrl),
    ...(defaultEngine ? { defaultEngine } : {})
  };
}

/** 面板顶部的一行状态说明。 */
export function describeVoiceSummary(config?: VoiceConfigView | null): string {
  if (config === null || config === undefined) {
    return "这个角色还没有保存声音配置。";
  }
  const protocol = PROTOCOL_LABELS[config.protocol] ?? config.protocol;
  const serviceName = config.service?.name?.trim();
  const prefix = serviceName ? `${serviceName} · ${protocol}` : protocol;
  const state = config.enabled === false ? "已停用 · " : "";
  if (config.voiceSource?.kind === "preset") {
    return `${state}${prefix} · 预置音色 ${config.voiceSource.voiceId}`;
  }
  const name = config.reference?.fileName ?? "参考音频缺失";
  return `${state}${prefix} · 参考音频 ${name}`;
}

export function describeProtocolHint(form: VoiceForm): string {
  return form.protocol === "indextts"
    ? "旧 IndexTTS 只提供合成接口，没有能力探测。连接是否可用由试听验证。"
    : "统一协议可以先探测服务能力，再选择参考音频或预置音色。";
}

function describeBaseUrlProblem(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "音色服务地址格式不正确";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "音色服务地址需为 HTTP 或 HTTPS";
  }
  if (url.username !== "" || url.password !== "") {
    return "音色服务地址不能包含账号信息";
  }
  if (baseUrl.includes("?") || baseUrl.includes("#")) {
    return "音色服务地址不能包含查询串或片段";
  }
  return null;
}

function issue(field: string, code: string, message: string): VoiceFormIssue {
  return { field, code, message };
}
