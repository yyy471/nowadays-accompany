export interface ImageSettingsView {
  serviceId: string;
  modelType: "text2img";
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

export const IMAGE_MODEL_TYPE_LABEL: string;

export function createImageForm(settings: ImageSettingsView | null | undefined): ImageForm;
export function toImagePayload(form: ImageForm): ImageSettingsView;
export function withOutfitPrompt(form: ImageForm, outfitId: string, text: string): ImageForm;
export function validateImageForm(form: ImageForm): ImageFormIssue[];
export function describeImageSummary(view: ImageSettingsViewPayload | null | undefined): string;
export function summarizeImageProbe(probe: ImageProbe | null | undefined): string;
export function describeImageFailure(code: string | null, message: string): string;
