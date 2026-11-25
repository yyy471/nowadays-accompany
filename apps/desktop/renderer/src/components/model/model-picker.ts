/**
 * 模型名称选择控件的纯逻辑：候选过滤与测试结果文案。
 *
 * 手填始终可用；列表只用来提供候选，不限制最终提交的模型标识。
 */

import {
  GOOGLE_AI_STUDIO_URL, GOOGLE_VERTEX_EXPRESS_URL, isModelProvider, MODEL_PROVIDERS,
  usesVertexExpressPresets, VERTEX_EXPRESS_MODELS,
} from "../../../../../backend/src/domain/model-providers";

export interface ProbeNotice {
  source: "list" | "test";
  role: "alert" | "status";
  text: string;
  model?: string;
  attempt?: number;
}

export interface SecretDraft {
  hasExisting: boolean;
  baselineSecret: string | null;
  dirty: boolean;
  value: string;
  revealed: boolean;
}

export type SecretOperation =
  | { action: "keep" }
  | { action: "clear" }
  | { action: "replace"; secret: string };

const MAX_CANDIDATES = 50;
export const GOOGLE_GEMINI_DEFAULT_BASE_URL = GOOGLE_VERTEX_EXPRESS_URL;
export const MODEL_ADAPTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "openai-chat", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-gemini", label: "Google Gemini / Vertex AI" },
  ...Object.entries(MODEL_PROVIDERS).map(([value, { label }]) => ({ value, label })),
];

export function modelAdapterOf(config: Record<string, unknown>): string {
  if (isModelProvider(config.provider)) return config.provider;
  if (config.protocol === "google-gemini" && String(config.baseUrl).replace(/\/+$/, "") === GOOGLE_AI_STUDIO_URL) return "google-ai-studio";
  return String(config.protocol || "openai-chat");
}

export function modelConnectionFields(
  adapter: string,
  baseUrl: string,
  savedProvider?: unknown,
): { protocol: string; provider?: string; baseUrl: string } {
  const address = baseUrl.trim();
  const protocol = isModelProvider(adapter) ? MODEL_PROVIDERS[adapter].protocol : adapter;
  // 旧版官方 Studio 资源已能从地址识别，保存时沿用其凭据身份。自定义 Studio 地址显式保存入口。
  const implicitStudio = adapter === "google-ai-studio" && savedProvider !== adapter &&
    address.replace(/\/+$/, "") === GOOGLE_AI_STUDIO_URL;
  const provider = isModelProvider(adapter) && !implicitStudio ? adapter : undefined;
  return { protocol, provider, baseUrl: address };
}

export function modelCredentialScope(adapter: string, baseUrl: string, savedProvider?: unknown): string {
  const { protocol, provider } = modelConnectionFields(adapter, baseUrl, savedProvider);
  let origin = baseUrl.trim();
  try { origin = new URL(origin).origin; } catch { /* 允许正在输入的草稿地址。 */ }
  return [provider, protocol, origin].join("|");
}

export function modelPresets(protocol: unknown, baseUrl: unknown): readonly string[] | undefined {
  const wire = protocol === "google-ai-studio" ? "google-gemini" : protocol;
  return usesVertexExpressPresets(wire, baseUrl) ? VERTEX_EXPRESS_MODELS : undefined;
}

/** 返回所选服务商或 Gemini 入口的默认地址，通用协议允许自行填写。 */
export function defaultModelBaseUrl(protocol: string): string {
  if (isModelProvider(protocol)) return MODEL_PROVIDERS[protocol].baseUrl;
  return protocol === "google-gemini" ? GOOGLE_VERTEX_EXPRESS_URL : "";
}

/**
 * 切换接口协议时同步调整服务地址：
 * 明确选择服务商时填入官方地址，切换通用协议时保留用户输入的代理地址。
 */
export function resolveModelBaseUrlOnProtocolChange(
  currentUrl: string,
  nextProtocol: string,
  previousAdapter?: string,
): string {
  const raw = String(currentUrl ?? "");
  const trimmed = raw.trim();
  const nextDefault = defaultModelBaseUrl(nextProtocol);
  if (isModelProvider(nextProtocol)) return nextDefault;
  const wasDefault = trimmed.replace(/\/+$/, "") === defaultModelBaseUrl(previousAdapter ?? "google-gemini");
  return !trimmed || wasDefault ? nextDefault : raw;
}

export function filterModelNames(models: readonly string[] | undefined, query: string): string[] {
  const keyword = String(query ?? "").trim().toLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of models ?? []) {
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    if (keyword.length === 0 || name.toLowerCase().includes(keyword)) result.push(name);
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

export function modelTestNote(
  result: { ok?: boolean; elapsedMs?: number; error?: { message?: string } } | null | undefined,
): string {
  if (result === null || result === undefined) return "";
  if (result.ok === true) {
    const ms = Math.max(0, Math.round(Number(result.elapsedMs ?? 0)));
    return `测试通过 · ${ms} ms`;
  }
  return `测试失败：${result.error?.message ?? "模型请求失败"}`;
}

/** 过滤并决定模型控件下方展示的单条点击日志（读取列表与测试连接相互覆盖）。 */
export function visibleProbeNotice(
  notice: ProbeNotice | null | undefined,
  currentModel: string,
): ProbeNotice | null {
  if (!notice || typeof notice.text !== "string" || notice.text.length === 0) {
    return null;
  }
  const source: ProbeNotice["source"] = notice.source === "test" ? "test" : "list";
  const role: ProbeNotice["role"] = notice.role === "alert" ? "alert" : "status";
  if (
    source === "test" &&
    typeof notice.model === "string" &&
    notice.model !== String(currentModel ?? "").trim()
  ) {
    return null;
  }
  return {
    source,
    role,
    text: notice.text,
    ...(typeof notice.model === "string" ? { model: notice.model } : {}),
    ...(notice.attempt !== undefined ? { attempt: notice.attempt } : {}),
  };
}

/** 已保存密钥在文本框中默认显示的占位掩码（配合 password 控件隐藏）。 */
export const SECRET_MASK_SENTINEL = "************";

/** 判断资源凭据状态是否代表后端已有保存的凭据或引用。 */
function hasSavedCredentialStatus(status: string | undefined): boolean {
  return status === "stored" || status === "reference" || status === "unavailable";
}

/** 创建模型密钥文本框的草稿状态。 */
export function createSecretDraft(status: string | undefined): SecretDraft {
  const hasExisting = hasSavedCredentialStatus(status);
  return {
    hasExisting,
    baselineSecret: null,
    dirty: false,
    value: hasExisting ? SECRET_MASK_SENTINEL : "",
    revealed: false,
  };
}

/**
 * 处理密钥文本框输入变化：
 * - 尚未显式明文查看时，退格删除掩码直接清空，追加粘贴自动剥离掩码前缀/后缀；
 * - 若改回已读取的原密钥原文，恢复未改动状态，保存时继续保留原密钥。
 */
export function nextSecretDraftOnInput(draft: SecretDraft, rawValue: string): SecretDraft {
  const input = String(rawValue ?? "");
  if (draft.hasExisting && !draft.dirty && draft.baselineSecret === null) {
    if (input === SECRET_MASK_SENTINEL) {
      return draft;
    }
    let nextValue = input;
    if (
      input.length < SECRET_MASK_SENTINEL.length &&
      (SECRET_MASK_SENTINEL.startsWith(input) || SECRET_MASK_SENTINEL.endsWith(input))
    ) {
      nextValue = "";
    } else if (input.startsWith(SECRET_MASK_SENTINEL)) {
      nextValue = input.slice(SECRET_MASK_SENTINEL.length);
    } else if (input.endsWith(SECRET_MASK_SENTINEL)) {
      nextValue = input.slice(0, input.length - SECRET_MASK_SENTINEL.length);
    }
    return {
      ...draft,
      dirty: true,
      value: nextValue,
    };
  }
  if (draft.hasExisting) {
    if (draft.baselineSecret !== null && input === draft.baselineSecret) {
      return {
        ...draft,
        dirty: false,
        value: input,
      };
    }
    return {
      ...draft,
      dirty: true,
      value: input,
    };
  }
  return {
    ...draft,
    dirty: input.length > 0,
    value: input,
  };
}

/** 将后端按需取回的密钥原文写入草稿（若用户已在编辑则不覆盖用户输入）。 */
export function applyRevealedSecret(draft: SecretDraft, secretText: string): SecretDraft {
  const text = String(secretText ?? "");
  if (draft.dirty) {
    return { ...draft, revealed: true };
  }
  return {
    ...draft,
    baselineSecret: text,
    value: text,
    revealed: true,
    dirty: false,
  };
}

/** 隐藏未改动过的已保存密钥时，重新用占位掩码替代内存中展示的原文。 */
export function hideUneditedSecret(draft: SecretDraft): SecretDraft {
  if (!draft.hasExisting || draft.dirty) {
    return { ...draft, revealed: false };
  }
  return {
    ...draft,
    baselineSecret: null,
    value: SECRET_MASK_SENTINEL,
    revealed: false,
  };
}

/** 推导保存时提交给后端的密钥意图：保留、清空或替换。 */
export function secretOperationOf(draft: SecretDraft): SecretOperation {
  if (!draft.dirty) {
    return { action: "keep" };
  }
  if (draft.value.length === 0) {
    return draft.hasExisting ? { action: "clear" } : { action: "keep" };
  }
  return { action: "replace", secret: draft.value };
}
