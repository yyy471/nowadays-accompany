import type { TypedEventBus } from '../../core/bus.js';
import type { CoreEvents } from '../../core/events.js';
import type { AuditLog } from '../../core/audit.js';
import type { EventLog } from '../../core/event-log.js';
import type { Metrics } from '../../core/metrics.js';
import type { InstanceSpec, InstanceStatus } from '../../instances/spec.js';
import type { AccountProfileFile, ArtifactRef, ArtifactKind, ResolvedArtifact } from '../../artifacts/types.js';
import type { DeploymentRecord } from '../../artifacts/deploy.js';
import type { ConversationRef } from '../../routing/identity.js';
import type { OutboundMessage } from '../../routing/message.js';
import type { SendOptions, SendResult } from '../../instances/instance.js';
import type { ReadOptions, StoredMessage } from '../../storage/contract.js';
import type { AccountPolicy, ProviderDto } from '../../providers/types.js';
import type { ProviderTestResult } from '../../providers/contract.js';
import type { EffectiveCapabilitiesDto } from '../../providers/router.js';
import type { CapabilityId } from '../../policy/capabilities.js';
import type { JobDto } from '../../jobs/types.js';
import type { MediaData, MediaRef } from '../../media/types.js';
import type { InjectionSettings } from '../../injection/settings.js';
import type { InjectionOperationDto, ManualInjectionResumeResult } from '../../injection/manual.js';
import type { SnowLumaProcess, SnowLumaRuntimeStatus } from '../../injection/snowluma/manager.js';
import type { ConversationRoleBinding } from '../../profiles/role-bindings.js';
import type { AccountDisplayProfile } from '../../profiles/display.js';
import type { AccountSummary } from '../../contracts/accounts.js';
import type { WorldbookEvaluation } from '../../worldbook/types.js';
import type { WorldbookList, WorldbookResourceDetail, WorldbookSaveResult } from '../../contracts/worldbook-resources.js';
import type { MemoryDeleteResult, MemoryExtractionStatusView, MemoryPreviewResult, MemoryRecordDetail, MemoryRecordMutation, MemoryRecordPage, MemoryStateView } from '../../contracts/memory.js';

/** HTTP/CLI 使用的应用端口；实现由 Core 提供。 */
export interface CoreView {
  bus: TypedEventBus<CoreEvents>;
  metrics: Metrics;
  eventLog: EventLog;
  auditLog: AuditLog;
  status(): { instances: InstanceStatus[]; apiUrl?: string; dataRoot?: string };
  startInstance(id: string): Promise<void>;
  stopInstance(id: string): Promise<void>;
  send(instanceId: string, conversation: ConversationRef, message: OutboundMessage, options?: SendOptions): Promise<SendResult>;
  listConversations(accountId?: string): Promise<ConversationRef[]>;
  readMessages(accountId: string, conversation: ConversationRef, options?: ReadOptions): Promise<StoredMessage[]>;
  diagnostics(): unknown;
  listPublicArtifacts(): Promise<ResolvedArtifact[]>;
  listWorldbooks(query?: unknown): Promise<WorldbookList>;
  getWorldbook(id: string, revision: string): Promise<WorldbookResourceDetail>;
  saveWorldbook(raw: unknown): Promise<WorldbookSaveResult>;
  previewWorldbookDraft(raw: unknown): Promise<WorldbookEvaluation>;
  memorySettings(conversation: ConversationRef): Promise<MemoryStateView>;
  saveMemorySettings(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView>;
  previewMemory(conversation: ConversationRef, raw: unknown): Promise<MemoryPreviewResult>;
  listMemoryRecords(conversation: ConversationRef, query?: unknown): Promise<MemoryRecordPage>;
  getMemoryRecord(conversation: ConversationRef, id: string): Promise<MemoryRecordDetail>;
  createMemoryRecord(conversation: ConversationRef, raw: unknown): Promise<MemoryRecordMutation>;
  updateMemoryRecord(conversation: ConversationRef, id: string, raw: unknown): Promise<MemoryRecordMutation>;
  deleteMemoryRecord(conversation: ConversationRef, id: string, raw: unknown): Promise<MemoryDeleteResult>;
  clearMemoryRecords(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView>;
  memoryExtraction(conversation: ConversationRef): Promise<MemoryExtractionStatusView>;
  activateMemoryExtraction(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView>;
  pauseMemoryExtraction(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView>;
  listAccountArtifacts(accountId: string): Promise<ResolvedArtifact[]>;
  artifactCatalog(): Promise<Record<string, string>>;
  listAccounts(options?: { avatars?: boolean }): Promise<AccountSummary[]>;
  slotSpecs(): InstanceSpec[];
  getAccountProfile(accountId: string): Promise<AccountProfileFile | undefined>;
  getAccountDisplay(accountId: string): Promise<AccountDisplayProfile>;
  saveAccountDisplay(accountId: string, raw: unknown): Promise<AccountDisplayProfile>;
  saveAccountProfile(
    accountId: string,
    raw: unknown
  ): Promise<{ profile: AccountProfileFile; reload?: { ok: boolean; error?: string } }>;
  listConversationRoleBindings(
    accountId: string
  ): Promise<Array<ConversationRoleBinding & { state: 'ready' | 'missing'; cardName?: string }>>;
  setConversationRoleBinding(
    conversation: ConversationRef,
    roleCard: ArtifactRef | null
  ): Promise<ConversationRoleBinding | undefined>;
  configureConversationWorldbook(conversation: ConversationRef, raw: unknown, expectedRevision: string, source?: unknown): Promise<ConversationRoleBinding>;
  previewConversationWorldbook(conversation: ConversationRef, text: string): Promise<WorldbookEvaluation>;
  reloadAccount(accountId: string): Promise<Array<{ instanceId: string; ok: boolean; error?: string }>>;
  deployArtifact(kind: ArtifactKind, id: string, revision: string): Promise<DeploymentRecord>;
  rollbackArtifacts(): Promise<DeploymentRecord>;
  deployments(): DeploymentRecord[];
  addSlot(spec: InstanceSpec): Promise<InstanceStatus>;
  removeSlot(id: string): Promise<void>;
  injectionSettings(): InjectionSettings;
  setInjectionSettings(raw: unknown, secret?: string): Promise<{ settings: InjectionSettings; status: SnowLumaRuntimeStatus }>;
  clearInjectionPassword(): Promise<{ status: SnowLumaRuntimeStatus }>;
  injectionStatus(): Promise<SnowLumaRuntimeStatus>;
  testInjectionConnection(): Promise<{ runtime: SnowLumaRuntimeStatus; processCount: number }>;
  retrySnowLumaRuntime(): Promise<SnowLumaRuntimeStatus>;
  resumeInjectionListening(): Promise<ManualInjectionResumeResult>;
  injectionResumeCandidates(): Array<{ slotId: string; accountId: string }>;
  injectionProcesses(options?: { avatars?: boolean }): Promise<SnowLumaProcess[]>;
  injectAndListen(raw: unknown): Promise<InjectionOperationDto>;
  listenInjection(raw: unknown): Promise<InjectionOperationDto>;
  refreshInjection(raw: unknown): Promise<InjectionOperationDto>;
  unloadInjection(raw: unknown): Promise<InjectionOperationDto>;
  injectionOperation(id: string): InjectionOperationDto | undefined;
  credentialStore(): { kind: string; available: boolean };
  listProviders(): Promise<ProviderDto[]>;
  upsertProvider(raw: unknown, secret?: string): Promise<ProviderDto>;
  configureSimpleModel(raw: unknown): Promise<ProviderDto>;
  discoverModels(raw: unknown): Promise<string[]>;
  validateSimpleModel(raw: unknown): Promise<ProviderTestResult>;
  providerRemovalImpact(id: string): { providerId: string; exists: boolean; affectedAccounts: string[] };
  deleteProvider(id: string): Promise<{ removed: boolean; affectedAccounts: string[] }>;
  setProviderCredential(id: string, secret: string): Promise<ProviderDto>;
  deleteProviderCredential(id: string): Promise<ProviderDto>;
  testProvider(id: string, capability: CapabilityId, modelId?: string, confirmCost?: boolean): Promise<ProviderTestResult>;
  testAccountCapability(accountId: string, capability: CapabilityId, confirmCost?: boolean): Promise<ProviderTestResult>;
  getAccountPolicy(accountId: string): AccountPolicy;
  setAccountPolicy(accountId: string, raw: unknown): Promise<AccountPolicy>;
  patchAgentEnabled(accountId: string, enabled: boolean, scope?: { kind?: 'private' | 'group'; peerId?: string }): Promise<AccountPolicy>;
  patchCapabilityEnabled(
    accountId: string,
    capability: CapabilityId,
    enabled: boolean,
    scope?: { kind?: 'private' | 'group'; peerId?: string }
  ): Promise<AccountPolicy>;
  effectiveCapabilities(accountId: string, conversation: ConversationRef): Promise<EffectiveCapabilitiesDto>;
  listJobs(accountId?: string): Promise<JobDto[]>;
  getJob(accountId: string, jobId: string): Promise<JobDto | undefined>;
  cancelJob(accountId: string, jobId: string): Promise<JobDto>;
  listMedia(accountId: string): Promise<MediaRef[]>;
  readMedia(accountId: string, mediaId: string): Promise<MediaData>;
  deleteMedia(accountId: string, mediaId: string): Promise<boolean>;
  cleanupMedia(): Promise<{ deleted: number; skippedInUse: number; failed: number }>;
}
