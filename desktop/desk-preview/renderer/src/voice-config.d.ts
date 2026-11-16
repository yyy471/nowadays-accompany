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

export const VOICE_PROTOCOLS: readonly VoiceProtocol[];

export function createVoiceForm(config?: VoiceConfigView | null): VoiceForm;

export function toVoicePayload(
  form: VoiceForm,
  options?: {
    capabilities?: VoiceCapabilities | null;
    engines?: Record<string, VoiceEngineStatus> | null;
    defaultEngine?: string | null;
    hasPendingReference?: boolean;
    clearEngine?: boolean;
  }
): Record<string, unknown>;

export function withReferenceAudio(
  form: VoiceForm,
  assetId: string | null | undefined
): VoiceForm;

export function withPendingReferenceAudio(form: VoiceForm): VoiceForm;

export function validateVoiceForm(
  form: VoiceForm,
  options?: {
    capabilities?: VoiceCapabilities | null;
    engines?: Record<string, VoiceEngineStatus> | null;
    hasPendingReference?: boolean;
    requireService?: boolean;
  }
): VoiceFormIssue[];

export function summarizeProbe(probe?: VoiceProbeResult | null): VoiceProbeSummary | null;

export function isPresetVoiceAvailable(
  voices: Array<{ id: string }> | null | undefined,
  voiceId: string
): boolean | null;

export function normalizeBaseUrl(value: string | null | undefined): string;

export function withVoiceService(form: VoiceForm, patch: Partial<VoiceForm>): VoiceForm;

export function isProbeCurrent(
  source: { baseUrl: string; protocol: string } | null | undefined,
  form: VoiceForm
): boolean;

export function resolveCapabilities(input: {
  config?: VoiceConfigView | null;
  form: VoiceForm;
  probe?: VoiceProbeResult | null;
  probeSource?: { baseUrl: string; protocol: string } | null;
}): VoiceCapabilities | null;

export function resolveEngines(input: {
  config?: VoiceConfigView | null;
  form: VoiceForm;
  probe?: VoiceProbeResult | null;
  probeSource?: { baseUrl: string; protocol: string } | null;
}): {
  engines: Record<string, VoiceEngineStatus> | null;
  defaultEngine: string | null;
};

export function pickPresetVoiceForEngine(
  voices: VoicePresetVoice[] | null | undefined,
  voiceId: string,
  ttsEngine: string
): string;

export function describeVoiceFailure(error?: {
  code?: string | null;
  message?: string;
}): string;

export function describeVoiceSummary(config?: VoiceConfigView | null): string;

export function describeProtocolHint(form: VoiceForm): string;

export function validateVoiceServiceDraft(draft: {
  name?: string;
  protocol?: VoiceProtocol | string;
  baseUrl?: string;
}): string | null;

export function toVoiceServiceConfig(draft: {
  protocol: VoiceProtocol;
  baseUrl: string;
  defaultEngine?: string | null;
}): {
  protocol: VoiceProtocol;
  baseUrl: string;
  defaultEngine?: string;
};

export function describeVoiceFailure(error?: { code?: string | null; message?: string }): string;

export function describeVoiceSummary(config?: VoiceConfigView | null): string;

export function describeProtocolHint(form: VoiceForm): string;
