export const VOICE_LANGUAGES = ["zh", "en", "ja", "es", "ar"] as const;
export type LegacyVoiceLanguage = (typeof VOICE_LANGUAGES)[number];
/** 语言代码由服务声明；旧 IndexTTS 另行限制为 VOICE_LANGUAGES。 */
export type VoiceLanguage = string;

export type VoiceProtocol = "indextts" | "nowadays-tts-v1";
export type VoiceEngine = VoiceProtocol;

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

export interface VoiceProbeResult {
  protocol: "nowadays-tts-v1";
  service: string;
  model: string;
  ready: boolean;
  capabilities: VoiceCapabilities;
  voices: VoicePresetVoice[] | null;
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

export interface VoiceSettingsRecord {
  roleId: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface VoiceConfigView {
  engine: VoiceEngine;
  protocol: VoiceProtocol;
  baseUrl: string;
  voiceSource: VoiceSource;
  reference: VoiceReferenceRecord | null;
  capabilities: VoiceCapabilities | null;
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
