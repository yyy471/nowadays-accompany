export const GOOGLE_GEMINI_DEFAULT_BASE_URL: string;
export const MODEL_ADAPTER_OPTIONS: ReadonlyArray<{ value: string; label: string }>;
export function modelAdapterOf(config: Record<string, unknown>): string;
export function modelConnectionFields(adapter: string, baseUrl: string, savedProvider?: unknown): { protocol: string; provider?: string; baseUrl: string };
export function modelCredentialScope(adapter: string, baseUrl: string, savedProvider?: unknown): string;
export function modelPresets(protocol: unknown, baseUrl: unknown): readonly string[] | undefined;
export const SECRET_MASK_SENTINEL: string;

export interface ProbeNotice {
  source: "list" | "test";
  role: "alert" | "status";
  text: string;
  model?: string;
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

export function defaultModelBaseUrl(protocol: string): string;
export function resolveModelBaseUrlOnProtocolChange(
  currentUrl: string,
  nextProtocol: string,
  previousAdapter?: string,
): string;
export function filterModelNames(
  models: readonly string[] | undefined,
  query: string,
): string[];
export function modelTestNote(
  result:
    | { ok?: boolean; elapsedMs?: number; error?: { message?: string } }
    | null
    | undefined,
): string;
export function visibleProbeNotice(
  notice: ProbeNotice | null | undefined,
  currentModel: string,
): ProbeNotice | null;
export function createSecretDraft(status: string | undefined): SecretDraft;
export function nextSecretDraftOnInput(
  draft: SecretDraft,
  rawValue: string,
): SecretDraft;
export function applyRevealedSecret(
  draft: SecretDraft,
  secretText: string,
): SecretDraft;
export function hideUneditedSecret(draft: SecretDraft): SecretDraft;
export function secretOperationOf(draft: SecretDraft): SecretOperation;
