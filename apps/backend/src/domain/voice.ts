import { AppError } from "./errors.js";

export const VOICE_LANGUAGES = ["zh", "en", "ja", "es", "ar"] as const;
export type LegacyVoiceLanguage = (typeof VOICE_LANGUAGES)[number];
/** 语言代码由服务声明；旧 IndexTTS 另行限制为 VOICE_LANGUAGES。 */
export type VoiceLanguage = string;

export type VoiceProtocol = "indextts" | "nowadays-tts-v1";
export type VoiceEngine = VoiceProtocol;

/**
 * 归一化语音服务端点：仅允许 http/https，禁止携带账号、查询串与片段，
 * 同时去掉末尾斜杠保证跨处比较与迁移去重一致。
 */
export function normalizeVoiceBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new AppError(400, "VOICE_BASE_URL_REQUIRED", "音色服务地址不能为空");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(400, "VOICE_BASE_URL_INVALID", "音色服务地址格式不正确");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(400, "VOICE_BASE_URL_INVALID", "音色服务地址需为 HTTP 或 HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError(400, "VOICE_BASE_URL_INVALID", "音色服务地址不能包含账号信息");
  }
  if (url.href.includes("?") || url.href.includes("#")) {
    throw new AppError(
      400,
      "VOICE_BASE_URL_INVALID",
      "音色服务地址不能包含查询串或片段",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

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
  languages: VoiceLanguage[];
  speed: VoiceSpeedRange | null;
}

export interface VoicePresetVoice {
  id: string;
  label: string;
}

export interface VoiceEngineStatus {
  ready: boolean;
  active: boolean;
  onDemand?: boolean | undefined;
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

export interface VoiceReferenceRecord {
  assetId: string;
  roleId: string;
  fileName: string;
  mediaType: string;
  relativePath: string;
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

export interface VoiceServiceSummary {
  serviceId: string;
  name: string;
  enabled: boolean;
  protocol: VoiceProtocol;
  baseUrl: string;
  defaultEngine?: string;
}

export interface VoiceSettingsRecord {
  roleId: string;
  serviceId: string | null;
  engine: VoiceEngine;
  protocol: VoiceProtocol;
  baseUrl: string;
  voiceSource: VoiceSource;
  referenceModeConfirmed: boolean;
  /** 停用只阻止新的对话语音合成，配置本身保留（DL-149）。 */
  enabled: boolean;
  language: VoiceLanguage;
  speed: number;
  emoAlpha: number;
  capabilities: VoiceCapabilities | null;
  ttsEngine: string | null;
  engines: Record<string, VoiceEngineStatus> | null;
  defaultEngine: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceConfigView {
  serviceId?: string | null;
  service?: VoiceServiceSummary | null;
  engine: VoiceEngine;
  protocol: VoiceProtocol;
  ttsEngine: string | null;
  baseUrl: string;
  voiceSource: VoiceSource;
  reference: VoiceReferenceRecord | null;
  capabilities: VoiceCapabilities | null;
  engines?: Record<string, VoiceEngineStatus>;
  defaultEngine?: string;
  enabled: boolean;
  language: VoiceLanguage;
  speed: number;
  emoAlpha: number;
  createdAt: string;
  updatedAt: string;
}

export interface UploadedAudio {
  fileName: string;
  data: Buffer;
}

export interface InspectedAudio {
  mediaType: string;
  extension: string;
}

export interface SynthesizedAudio {
  data: Buffer;
  mediaType: string;
}
