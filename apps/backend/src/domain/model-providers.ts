export const GOOGLE_VERTEX_EXPRESS_URL = "https://aiplatform.googleapis.com/v1/publishers/google";
export const GOOGLE_AI_STUDIO_URL = "https://generativelanguage.googleapis.com/v1beta";

/** 桌面表单与 HTTP 适配器共用的服务入口。资源仍单独保存实际协议和用户填写的地址。 */
export const MODEL_PROVIDERS = {
  "google-ai-studio": { label: "Google Gemini / AI Studio", protocol: "google-gemini", baseUrl: GOOGLE_AI_STUDIO_URL },
  "opencode-go": { label: "OpenCode Go", protocol: "openai-chat", baseUrl: "https://opencode.ai/inference/go" },
  deepseek: { label: "DeepSeek", protocol: "openai-chat", baseUrl: "https://api.deepseek.com" },
  openrouter: { label: "OpenRouter", protocol: "openai-chat", baseUrl: "https://openrouter.ai/api/v1" },
  xai: { label: "xAI", protocol: "openai-responses", baseUrl: "https://api.x.ai/v1" },
  zai: { label: "Z.AI", protocol: "openai-chat", baseUrl: "https://api.z.ai/api/paas/v4" },
  mimo: { label: "小米 MiMo", protocol: "openai-chat", baseUrl: "https://api.xiaomimimo.com/v1" },
} as const;

export type ModelProvider = keyof typeof MODEL_PROVIDERS;

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && Object.hasOwn(MODEL_PROVIDERS, value);
}

export const VERTEX_SAFETY_LEVELS = ["high", "default", "off"] as const;
export type VertexSafetyLevel = typeof VERTEX_SAFETY_LEVELS[number];

export function isVertexPublisherBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return /\/publishers\/google\/*$/i.test(url.pathname) ||
      url.hostname === "aiplatform.googleapis.com" || url.hostname.endsWith("-aiplatform.googleapis.com");
  } catch {
    return false;
  }
}

// 供用户选择的模型 ID，实际可用性由当前端点和账号决定。
export const VERTEX_EXPRESS_MODELS = [
  "gemini-4-neon", "gemini-4-hydrogen", "gemini-4-carbon", "gemini-4-argon",
  "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3-flash-preview",
  "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
] as const;

export function autoVertexConnection(config: { protocol: string; baseUrl: string; provider?: string | undefined; vertexRouting?: string | undefined }): boolean {
  return config.protocol === "google-gemini" && !config.provider && config.vertexRouting !== "manual"
    && /^https:\/\/aiplatform\.googleapis\.com\/v1(?:beta1)?\/publishers\/google\/*$/.test(config.baseUrl);
}

export function vertexModelPresets(protocol: unknown, baseUrl: unknown): readonly string[] | undefined {
  if (protocol !== "google-gemini" || typeof baseUrl !== "string") return;
  try {
    const url = new URL(baseUrl.trim());
    if (url.origin !== "https://aiplatform.googleapis.com" || url.search || url.hash || url.username || url.password) return;
    if (/^\/v1(?:beta1)?\/publishers\/google\/*$/.test(url.pathname)) return VERTEX_EXPRESS_MODELS;
    if (/^\/v1(?:beta1)?\/projects\/[^/]+\/locations\/global\/publishers\/google\/*$/.test(url.pathname)) return VERTEX_EXPRESS_MODELS;
  } catch {
    return undefined;
  }
}
