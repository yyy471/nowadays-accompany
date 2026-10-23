export type InstanceState =
  | 'provisioning'
  | 'starting'
  | 'awaiting_login'
  | 'online'
  | 'degraded'
  | 'awaiting_profile'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface ArtifactRef {
  source: 'public' | 'private';
  id: string;
  revision?: string;
}

export interface RequiredArtifactRef {
  source: 'public' | 'private';
  id: string;
  revision: string;
}

export interface AccountPluginEntry extends ArtifactRef {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface AccountProfileFile {
  version: 1;
  roleCard?: ArtifactRef;
  plugins?: AccountPluginEntry[];
}

export interface ProfileSummary {
  revision: string;
  roleCard?: RequiredArtifactRef;
  plugins: RequiredArtifactRef[];
}

export interface InstanceStatus {
  id: string;
  accountId?: string;
  backend: 'snowluma' | 'fake';
  runtimeKey?: string;
  desiredState?: 'running' | 'stopped';
  state: InstanceState;
  selfIds: string[];
  connected: boolean;
  endpoints?: { httpBaseUrl: string; wsUrl: string };
  ingress?: { pending: number; paused: boolean };
  egress?: { pending: number };
  restartAttempts: number;
  sessionEpoch?: number;
  hostEpoch?: number;
  profileFingerprint?: string;
  agent?: { mode: 'agent' | 'plugins' | 'custom'; configured: boolean };
  lastError?: { code: string; message: string; at: number; retryable?: boolean };
  profileState?: 'idle' | 'loading' | 'ready' | 'missing';
  profile?: ProfileSummary;
  profileError?: string;
  automaticPaused?: boolean;
}

export interface SlotSpec {
  id: string;
  accountId?: string;
  backend: 'snowluma' | 'fake';
  runtimeDir?: string;
  runtimeId?: string;
  dataDir?: string;
  ports?: { http?: number; ws?: number };
  selfIds?: string[];
  restart?: { enabled: boolean; maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
}

export interface SlotsResponse {
  ok: true;
  slots: InstanceStatus[];
  specs: SlotSpec[];
}

export interface ArtifactManifest {
  id: string;
  kind: 'plugin' | 'role-card';
  revision: string;
  name?: string;
  description?: string;
  entry?: string;
  apiVersion?: number;
  content?: string;
}

export interface ArtifactItem {
  ref: RequiredArtifactRef;
  manifest: ArtifactManifest;
}

export interface ArtifactsResponse {
  ok: true;
  current: Record<string, string>;
  artifacts: ArtifactItem[];
}

export interface AccountSummary {
  accountId: string;
  dir: string;
  state: 'ready' | 'invalid';
  file?: AccountProfileFile;
  profile?: ProfileSummary;
  error?: string;
  slots: string[];
}

export interface AccountsResponse {
  ok: true;
  accounts: AccountSummary[];
}

export interface ConversationRef {
  accountId: string;
  kind: 'private' | 'group';
  peerId: string;
}

export interface MessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface StoredMessage {
  id: string;
  at: number;
  direction: 'in' | 'out';
  senderId?: string;
  messageId?: string;
  segments: MessageSegment[];
  meta?: Record<string, unknown>;
  seq?: number;
}

export interface ConversationsResponse {
  ok: true;
  conversations: ConversationRef[];
}

export interface MessagesResponse {
  ok: true;
  messages: StoredMessage[];
}

export interface DeploymentEntry {
  instanceId: string;
  accountId?: string;
  status: 'updated' | 'skipped' | 'failed';
  fromRevision?: string;
  toRevision?: string;
  error?: string;
}

export interface DeploymentRecord {
  id: string;
  action: 'deploy' | 'rollback' | 'reload';
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  entries: DeploymentEntry[];
  detail?: Record<string, unknown>;
}

export interface DeploymentsResponse {
  ok: true;
  deployments: DeploymentRecord[];
}

export interface Diagnostics {
  dataRoot: string;
  apiUrl?: string;
  limits: Record<string, number>;
  instances: InstanceStatus[];
  runtimes: Record<string, unknown>;
  accounts: Record<string, string>;
  desired: Record<string, string>;
  metrics: Record<string, number>;
  latestEventId: number;
  audit: Array<Record<string, unknown>>;
  artifacts: { publicRoot: string; deployments: DeploymentRecord[] };
  phase1?: {
    configFile: string;
    configVersion: number;
    configFingerprint: string;
    vault: { kind: string; available: boolean };
    providers: number;
    endpoints: Array<{ providerId: string; baseUrl: string; active: number; pending: number; limit: number }>;
    scheduler: { active: number; pending: number; accounts: Record<string, { active: number; pending: number }> };
  };
}

export type CapabilityId = 'chat' | 'image.understand' | 'video.understand' | 'image.generate' | 'audio.generate';
export type ProviderLocation = 'local' | 'cloud';
export type VisionMode = 'external' | 'direct';
export type ReplyMode = 'auto' | 'agent' | 'plugins';
export type CancelMode = 'remote' | 'localOnly' | 'none';
export type PolicySource = 'account' | 'kind' | 'conversation' | 'default';
export type JobState = 'queued' | 'running' | 'waiting_remote' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface ProviderModelConfig {
  id: string;
  capabilities: CapabilityId[];
  input: Array<'text' | 'image' | 'video'>;
  supportsTools: boolean;
  parameters: Record<string, unknown>;
}

export interface ProviderDto {
  id: string;
  adapterId: string;
  baseUrl: string;
  location: ProviderLocation;
  credential: { ref?: string; configured: boolean };
  models: ProviderModelConfig[];
  capabilities: CapabilityId[];
  mediaTransports: Array<'inline' | 'url'>;
  limits: { maxConcurrent: number; maxQueue: number };
  timeouts: { requestMs: number; pollIntervalMs: number; pollTimeoutMs: number };
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  options: Record<string, unknown>;
}

export interface ProvidersResponse {
  ok: true;
  providers: ProviderDto[];
  credentialStore: { kind: string; available: boolean };
}

export interface CapabilityTarget {
  providerId: string;
  modelId: string;
  parameters?: Record<string, unknown>;
}

export interface CapabilityBinding extends CapabilityTarget {
  fallback?: CapabilityTarget[];
}

export interface ScopePolicy {
  agentEnabled?: boolean;
  capabilities?: Partial<Record<CapabilityId, boolean>>;
  bindings?: Partial<Record<CapabilityId, CapabilityBinding>>;
  visionMode?: VisionMode;
}

export interface AccountSkillPolicy {
  enabled?: string[];
  disabled?: string[];
  definitions?: Array<{
    id: string;
    name: string;
    description?: string;
    instructions: string;
    tools: string[];
    requires?: CapabilityId[];
    kinds?: Array<'private' | 'group'>;
    peers?: string[];
    enabled?: boolean;
  }>;
}

export interface AccountPolicy extends ScopePolicy {
  allowedProviders: string[];
  crossProviderFallback: boolean;
  media: { allowCloudUpload: boolean };
  replyMode?: ReplyMode;
  enabledTools?: string[];
  skills?: AccountSkillPolicy;
  byKind: Partial<Record<'private' | 'group', ScopePolicy>>;
  byConversation: Record<string, ScopePolicy>;
}

export interface AccountPolicyResponse {
  ok: true;
  policy: AccountPolicy;
}

export interface FallbackStatus {
  providerId: string;
  modelId: string;
  valid: boolean;
  reason?: string;
}

export interface CapabilityDto {
  capability: CapabilityId;
  label: string;
  enabled: boolean;
  reason?: string;
  detail?: string;
  source?: PolicySource;
  bindingSource?: PolicySource;
  providerId?: string;
  modelId?: string;
  location?: ProviderLocation;
  supportsTools: boolean;
  supportsImageInput: boolean;
  cancelMode?: CancelMode;
  credentialRef?: string;
  fallback: FallbackStatus[];
}

export interface SkillStatus {
  id: string;
  name: string;
  tools: string[];
  requires?: CapabilityId[];
  available: boolean;
  reason?: string;
  source?: 'public' | 'private';
}

export interface EffectiveCapabilitiesDto {
  accountId: string;
  conversation: ConversationRef;
  agentEnabled: boolean;
  agentSource: PolicySource;
  visionMode: VisionMode;
  visionSource: PolicySource;
  replyMode: ReplyMode;
  allowCloudUpload: boolean;
  capabilities: CapabilityDto[];
  skills: { available: Array<SkillStatus & { instructions: string }>; unavailable: SkillStatus[] };
}

export interface EffectiveResponse {
  ok: true;
  effective: EffectiveCapabilitiesDto;
}

export interface JobFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface MediaRef {
  mediaId: string;
  accountId: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
  retention: 'temporary' | 'account';
  source: { conversation: ConversationRef; messageId?: string; jobId?: string; direction?: 'in' | 'out' };
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface JobDto {
  id: string;
  accountId: string;
  conversation: ConversationRef;
  capability: CapabilityId;
  originMessageId?: string;
  turnId: string;
  sessionEpoch: number;
  providerId?: string;
  modelId?: string;
  state: JobState;
  actionId?: string;
  cancelMode: CancelMode;
  cancelRequested: boolean;
  remoteCancelled: boolean;
  delivery: 'pending' | 'sent' | 'failed' | 'skipped';
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: JobFailure;
  result?: { text?: string; media?: MediaRef[]; observation?: unknown };
  note?: string;
}

export interface JobsResponse {
  ok: true;
  jobs: JobDto[];
}

export interface MediaResponse {
  ok: true;
  media: MediaRef[];
}

export interface ProviderTestResult {
  ok: boolean;
  detail?: string;
  sample?: { kind: 'image' | 'audio'; mimeType: string; base64: string };
  capability?: CapabilityId;
  modelId?: string;
  providerId?: string;
  durationMs?: number;
}

export interface StreamEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  at: number;
}

export interface InjectionSettings {
  version: 1;
  runtimeDir?: string;
  baseUrl?: string;
}

export interface SnowLumaRuntimeStatus {
  configured: boolean;
  runtimeDir?: string;
  baseUrl?: string;
  version?: string;
  supportedVersion: string;
  compatible: boolean;
  running: boolean;
  authenticated: boolean;
  passwordConfigured: boolean;
  consentRequired: boolean;
  autoLoadEnabled: boolean;
  autoLoadKnown: boolean;
  owner: 'external' | 'managed' | 'none';
  startupState?: 'unconfigured' | 'starting' | 'managed' | 'external' | 'error';
  error?: string;
}

export interface SnowLumaProcess {
  pid: number;
  instanceId?: string;
  name?: string;
  path?: string;
  injected: boolean;
  connected: boolean;
  loggedIn: boolean;
  uin?: string;
  status: string;
  error?: string;
  method?: string;
}

export interface InjectionOperationDto {
  id: string;
  action: 'inject-and-listen' | 'listen' | 'refresh' | 'unload';
  pid: number;
  slotId?: string;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: number;
  finishedAt?: number;
  result?: { uin?: string; process?: SnowLumaProcess; instance?: InstanceStatus };
  error?: { code: string; message: string };
}

export interface InjectionProcessesResponse {
  ok: true;
  processes: SnowLumaProcess[];
}

export interface InjectionRuntimeResponse {
  ok: true;
  runtime: SnowLumaRuntimeStatus;
}

export interface InjectionSettingsResponse {
  ok: true;
  settings: InjectionSettings;
}

export interface InjectionOperationResponse {
  ok: boolean;
  operation: InjectionOperationDto;
}
