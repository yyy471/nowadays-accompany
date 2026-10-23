export { createCore, Core } from './core/core.js';
export type { CoreOptions, CoreStatus, CoreApiOptions, Diagnostics } from './core/core.js';
export { TypedEventBus } from './core/bus.js';
export type { CoreEvents } from './core/events.js';
export { createLogger, silentLogger, redactFields } from './core/logger.js';
export type { Logger, LogLevel, LogRecord, LogSink } from './core/logger.js';
export { INSTANCE_STATES, InstanceStateMachine, canTransition } from './core/state.js';
export type { InstanceState } from './core/state.js';
export {
  AccompanyError,
  BackendError,
  ChannelError,
  InvalidSpecError,
  InvalidStateTransitionError,
  IsolationError,
  BackpressureError,
  ProfileNotReadyError,
  UnsupportedCapabilityError,
  errorRetryable
} from './core/errors.js';
export { AbortScope } from './core/abort.js';
export { Semaphore, sleep, withTimeout } from './core/concurrency.js';
export { Metrics } from './core/metrics.js';
export type { MetricLabels } from './core/metrics.js';
export { EventLog } from './core/event-log.js';
export type { LoggedEvent, EventLogListener } from './core/event-log.js';
export { AuditLog } from './core/audit.js';
export type { AuditRecord } from './core/audit.js';
export { DataRootLock } from './core/data-root-lock.js';
export { DEFAULT_LIMITS, normalizeLimits } from './core/limits.js';
export type { Limits } from './core/limits.js';
export { isLoopbackHost } from './core/net.js';

export { QqInstance } from './instances/instance.js';
export type {
  ChannelHandlers,
  InstanceChannelFactory,
  QqInstanceOptions,
  SendOptions,
  SendResult
} from './instances/instance.js';
export { InstanceSupervisor } from './instances/supervisor.js';
export type { StartAllResult, SupervisorOptions } from './instances/supervisor.js';
export { DEFAULT_RESTART_POLICY, normalizeSpec } from './instances/spec.js';
export type { InstanceSpec, InstanceStatus, NormalizedInstanceSpec, RestartPolicy } from './instances/spec.js';
export { PortAllocator } from './instances/ports.js';
export { AccountLeases } from './instances/account-leases.js';
export { RuntimeLease, RuntimeRegistry, runtimeKeyFor } from './instances/runtime-registry.js';
export type { RuntimeRegistryOptions, RuntimeSnapshot } from './instances/runtime-registry.js';

export type {
  BackendCapabilities,
  BackendFactory,
  BackendStatus,
  InjectionBackend,
  ProbeInstance,
  ProbeReport,
  RuntimeEndpoints
} from './injection/contract.js';
export { FakeInjectionBackend } from './injection/fake.js';
export type { FakeBackendOptions } from './injection/fake.js';
export { SnowLumaBackend } from './injection/snowluma/backend.js';
export { listProfiles, readRuntimeInfo } from './injection/snowluma/config.js';

export type { ChannelContext, ChannelFactory, OutboundChannel } from './channels/contract.js';
export type { InboundEvent, InboundLifecycleEvent, InboundMessageEvent, InboundNoticeEvent } from './channels/events.js';
export { FakeChannel } from './channels/fake.js';
export { OneBotChannel } from './channels/onebot/client.js';
export { normalizeEvent } from './channels/onebot/normalize.js';

export { conversationKey, parseConversationKey, safePathSegment, assertIdentifier, assertKind } from './routing/identity.js';
export type { ChatKind, ConversationRef } from './routing/identity.js';
export { LoopbackGuard } from './routing/loopback.js';
export type { LoopbackVerdict } from './routing/loopback.js';
export { messageText, normalizeSegments, textMessage } from './routing/message.js';
export type { MessageSegment, OutboundMessage } from './routing/message.js';

export { JsonlStore } from './storage/jsonl-store.js';
export type { JsonlStoreOptions } from './storage/jsonl-store.js';
export type { AppendResult, MessageStore, ReadOptions, StoredMessage } from './storage/contract.js';
export { DesiredStateStore } from './storage/desired-state.js';
export type { DesiredInstanceState } from './storage/desired-state.js';
export { SlotStore } from './storage/slot-store.js';

export { LayeredConfig, mergeLayers } from './config/layered.js';
export type { ConfigLayer, ConfigLayers, ScopeContext } from './config/layered.js';

export { ConversationQueues } from './work/conversation-queues.js';
export type { ConversationQueueOptions } from './work/conversation-queues.js';
export { TokenBucket } from './work/rate-limiter.js';

export type {
  AgentHistoryOptions,
  AgentHost,
  AgentHostFactory,
  AgentHostFactoryInput,
  AgentMessageContext,
  AgentPluginState,
  AgentSendOptions,
  AgentSessionContext
} from './host/contract.js';
export { createWorkerHost } from './host/worker.js';
export type { WorkerHostOptions } from './host/worker.js';
export { PluginStateStore } from './host/state.js';

export { LocalArtifactStore } from './artifacts/local.js';
export { RollingDeployer } from './artifacts/deploy.js';
export type { DeployTarget, DeploymentEntry, DeploymentRecord, RollingDeployerOptions } from './artifacts/deploy.js';
export { artifactRefKey, summarizeProfile } from './artifacts/types.js';
export type {
  AccountPluginEntry,
  AccountProfileFile,
  ArtifactKind,
  ArtifactManifest,
  ArtifactRef,
  ArtifactSourceName,
  ProfileSummary,
  ResolvedArtifact,
  ResolvedPlugin,
  ResolvedProfile,
  ResolvedRoleCard
} from './artifacts/types.js';
export { AccountProfileService } from './profiles/profile.js';

export { CredentialVaultUnavailableError, MemoryCredentialVault, UnavailableCredentialVault, defaultCredentialRef } from './secrets/vault.js';
export type { CredentialVault } from './secrets/vault.js';
export type {
  AccountPolicy,
  AccountSkillPolicy,
  CapabilityBinding,
  ProviderConfig,
  ProviderDto,
  ProviderModelConfig,
  RuntimeConfigV2,
  ScopePolicy
} from './providers/types.js';
export type { JobDto, JobState } from './jobs/types.js';
export type { MediaRef } from './media/types.js';
export type { EffectiveCapabilitiesDto, CapabilityDto } from './providers/router.js';
export type { CapabilityId } from './policy/capabilities.js';
export { CAPABILITY_LABELS } from './policy/capabilities.js';

export { createApiServer } from './service/server.js';
export type { AccountSummary, ApiHandle, ApiServerOptions, CoreView } from './service/server.js';
