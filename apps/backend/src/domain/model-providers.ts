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

// 2026-11-20 核对 Express 快速入门、生成示例及模型生命周期，出处见角色配置规范。
export const VERTEX_EXPRESS_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash"] as const;

export function usesVertexExpressPresets(protocol: unknown, baseUrl: unknown): boolean {
  if (protocol !== "google-gemini" || typeof baseUrl !== "string") return false;
  try {
    const url = new URL(baseUrl.trim());
    return url.origin === "https://aiplatform.googleapis.com" &&
      /^\/v1(?:beta1)?\/publishers\/google\/*$/.test(url.pathname) &&
      !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}
