import { WorldbookResourceService } from '../application/worldbooks/worldbook-resource-service.js';
import type { WorldbookList, WorldbookResourceDetail, WorldbookSaveResult } from '../contracts/worldbook-resources.js';
import { MemoryService } from '../application/memory/memory-service.js';
import { ConversationMemoryContextService, type ConversationMemoryCapture } from '../application/memory/conversation-memory-context.js';
import { ExtractionCoordinator } from '../application/memory/extraction/coordinator.js';
import { ExtractionQuotaStore } from '../application/memory/extraction/quota.js';
import { MemoryExtractionRunner, type ExtractionChatPort } from '../application/memory/extraction/runner.js';
import type { MemoryDeleteResult, MemoryExtractionStatusView, MemoryPreviewResult, MemoryRecordDetail, MemoryRecordMutation, MemoryRecordPage, MemoryStateView } from '../contracts/memory.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { TypedEventBus } from './bus.js';
import type { CoreEvents } from './events.js';
import type { ExtractionTurnCompletion } from './extraction-events.js';
import { AccompanyError } from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { AuditLog } from './audit.js';
import { DataRootLock } from './data-root-lock.js';
import { EventLog } from './event-log.js';
import { withTimeout } from './concurrency.js';
import type { Limits } from './limits.js';
import { Metrics } from './metrics.js';
import { LayeredConfig } from '../config/layered.js';
import type { OutboundChannel } from '../channels/contract.js';
import { OneBotChannel } from '../channels/onebot/client.js';
import { FakeChannel } from '../channels/fake.js';
import type { RuntimeEndpoints } from '../injection/contract.js';
import { QqInstance, type ChannelHandlers, type InstanceChannelFactory, type SendOptions, type SendResult } from '../instances/instance.js';
import { InstanceSupervisor } from '../instances/supervisor.js';
import type { InstanceSpec, InstanceStatus, NormalizedInstanceSpec } from '../instances/spec.js';
import { AccountLeases } from '../instances/account-leases.js';
import { RuntimeRegistry, type RuntimeLease } from '../instances/runtime-registry.js';
import { assertIdentifier, conversationKey, type ChatKind, type ConversationRef } from '../routing/identity.js';
import type { OutboundMessage } from '../routing/message.js';
import { JsonlStore } from '../storage/jsonl-store.js';
import type { MessageStore, ReadOptions, StoredMessage } from '../storage/contract.js';
import { DesiredStateStore } from '../storage/desired-state.js';
import { ListeningStore } from '../storage/listening-store.js';
import { SlotStore } from '../storage/slot-store.js';
import { createApiServer, type ApiHandle } from '../service/server.js';
import type { CoreView } from '../application/ports/control-api.js';
import type { AccountSummary } from '../contracts/accounts.js';
import type { AgentHost, AgentHostFactoryInput } from '../host/contract.js';
import { InjectionSettingsStore, type InjectionSettings } from '../injection/settings.js';
import { SnowLumaRuntimeController } from '../injection/snowluma/runtime.js';
import {
  SNOWLUMA_MANAGEMENT_CREDENTIAL_REF,
  SnowLumaManager,
  type SnowLumaProcess,
  type SnowLumaRuntimeStatus
} from '../injection/snowluma/manager.js';
import { PluginStateStore } from '../host/state.js';
import { LocalArtifactStore } from '../artifacts/local.js';
import type { DeploymentRecord } from '../artifacts/deploy.js';
import { AccountProfileService } from '../profiles/profile.js';
import { type ConversationRoleBinding, type ResolvedConversationRoleBinding } from '../profiles/role-bindings.js';
import { AccountDisplayStore, type AccountDisplayProfile } from '../profiles/display.js';
import { AccountDirectory } from '../profiles/account-directory.js';
import { AccountService } from '../application/accounts/account-service.js';
import { QqConnectionService } from '../application/qq-connections/qq-connection-service.js';
import { ModelSettingsService } from '../application/model-settings/model-settings-service.js';
import { DeploymentService } from '../application/deployments/deployment-service.js';
import { RuntimeLifecycle } from '../application/lifecycle/runtime-lifecycle.js';
import { assembleRuntime, type RuntimeAssembly, type RuntimeHooks } from '../bootstrap/assemble-runtime.js';
import { ConfigStore } from '../providers/config-store.js';
import {
  type AccountPolicy,
  type ProviderDto
} from '../providers/types.js';
import { PolicyService } from '../policy/policy.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { ExtensionToolService } from '../application/extensions/extension-tool-service.js';
import { PluginRuntimeService } from '../application/extensions/plugin-runtime-service.js';
import { ProviderRouter, type EffectiveCapabilitiesDto } from '../providers/router.js';
import type { ProviderTestResult } from '../providers/contract.js';
import type { CapabilityId } from '../policy/capabilities.js';
import { MediaService } from '../media/service.js';
import type { MediaData } from '../media/types.js';
import { MediaJobService } from '../jobs/service.js';
import type { JobDto } from '../jobs/types.js';
import type { MediaRef } from '../media/types.js';
import { TurnScheduler } from '../agent/scheduler.js';
import { createAgentEngine } from '../agent/engine.js';
import {
  CredentialVaultUnavailableError,
  type CredentialVault
} from '../secrets/vault.js';
import {
  type AccountProfileFile,
  type ArtifactKind,
  type ResolvedArtifact,
  type ResolvedProfile
} from '../artifacts/types.js';
import type { CoreOptions } from './options.js';

export type { CoreApiOptions, CoreOptions } from './options.js';

export interface CoreStatus {
  dataRoot: string;
  apiUrl?: string;
  instances: InstanceStatus[];
}

export interface Diagnostics {
  dataRoot: string;
  apiUrl?: string;
  limits: Limits;
  instances: InstanceStatus[];
  runtimes: ReturnType<RuntimeRegistry['snapshot']>;
  accounts: Record<string, string>;
  desired: Record<string, 'running' | 'stopped'>;
  metrics: Record<string, number>;
  latestEventId: number;
  audit: ReturnType<AuditLog['recent']>;
  artifacts: { publicRoot: string; deployments: DeploymentRecord[] };
  phase1: {
    configFile: string;
    configVersion: number;
    configFingerprint: string;
    vault: { kind: string; available: boolean };
    providers: number;
    endpoints: ReturnType<ProviderRouter['endpoints']>;
    scheduler: ReturnType<TurnScheduler['snapshot']>;
  };
}

/**
 * 核心容器：组装 runtime、实例会话、收敛器、配置和 API。
 * 没有模块级单例；同一个进程里可以创建多个 Core，但同一 dataRoot 只允许一个写者。
 */
export class Core implements CoreView {
  readonly bus: TypedEventBus<CoreEvents>;
  readonly supervisor: InstanceSupervisor;
  readonly config: LayeredConfig;
  readonly metrics: Metrics;
  readonly eventLog: EventLog;
  readonly auditLog: AuditLog;
  readonly configV2: ConfigStore;
  readonly policy: PolicyService;
  readonly providers: ProviderRouter;
  readonly media: MediaService;
  readonly jobs: MediaJobService;
  readonly extensions: ExtensionRegistry;
  readonly extensionTools: ExtensionToolService;
  readonly agentScheduler: TurnScheduler;

  readonly #dataRoot: string;
  readonly #logger: Logger;
  readonly #options: CoreOptions;
  readonly #lifecycle: RuntimeLifecycle;
  readonly #limits: Limits;
  readonly #stores = new Map<string, MessageStore>();
  readonly #pluginStates = new Map<string, PluginStateStore>();
  readonly #pluginRuntimes: PluginRuntimeService;
  readonly #runtimeLeases = new Map<string, RuntimeLease>();
  readonly #runtimeRegistry: RuntimeRegistry;
  readonly #accountLeases: AccountLeases;
  readonly #artifacts: LocalArtifactStore;
  readonly #worldbooks: WorldbookResourceService;
  readonly #memories: MemoryService;
  readonly #extractionQuota: ExtractionQuotaStore;
  readonly #extractionCoordinator: ExtractionCoordinator;
  readonly #conversationMemory: ConversationMemoryContextService;
  readonly #profiles: AccountProfileService;
  readonly #accountDisplays: AccountDisplayStore;
  readonly #accountDirectory: AccountDirectory;
  readonly #accountService: AccountService;
  readonly #deploymentService: DeploymentService;
  readonly #modelSettings: ModelSettingsService;
  readonly #desiredStore: DesiredStateStore;
  readonly #slotStore?: SlotStore;
  readonly #listening: ListeningStore;
  readonly #injectionSettings: InjectionSettingsStore;
  readonly snowLuma: SnowLumaManager;
  readonly #connections: QqConnectionService;
  readonly #snowLumaRuntime: SnowLumaRuntimeController;
  readonly #dataRootLock?: DataRootLock;
  readonly #credentialVault: CredentialVault;
  readonly #publicWork = new Set<Promise<unknown>>();
  #api: ApiHandle | undefined;
  #healthTimer: NodeJS.Timeout | undefined;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #started = false;
  #stopped = false;

  private constructor(options: CoreOptions, runtime: RuntimeAssembly, extractionQuota: ExtractionQuotaStore) {
    this.#options = options;
    this.#dataRoot = path.resolve(options.dataRoot);
    this.#logger = runtime.logger;
    this.#limits = runtime.limits;
    this.#desiredStore = runtime.desiredStore;
    this.#slotStore = runtime.slotStore;
    this.#listening = runtime.listening;
    this.#injectionSettings = runtime.injectionSettings;
    this.#dataRootLock = runtime.dataRootLock;
    this.config = runtime.config;
    this.configV2 = runtime.configV2;
    this.#artifacts = runtime.artifacts;
    this.#worldbooks = new WorldbookResourceService({ publicRoot: runtime.artifacts.publicRoot });
    this.#profiles = runtime.profiles;
    this.#accountDisplays = runtime.accountDisplays;
    this.#accountDirectory = runtime.accountDirectory;
    this.#accountService = runtime.accountService;
    this.#memories = new MemoryService({
      roles: { contextEpoch: (accountId, conversation) => this.#accountService.historyEpoch(accountId, conversation) },
      accountDir: (accountId) => this.#accountService.locate(accountId).dir,
      messages: { lastSeq: (accountId, conversation) => this.#messageStore(accountId).lastSeq({ ...conversation, accountId }) },
      ...(options.now ? { now: options.now } : {})
    });
    this.#conversationMemory = new ConversationMemoryContextService({
      memories: this.#memories,
      roles: { resolve: (accountId, conversation) => this.#accountService.resolveRoleBinding(accountId, conversation) }
    });
    this.#deploymentService = runtime.deploymentService;
    this.#modelSettings = runtime.modelSettings;
    this.#credentialVault = runtime.credentialVault;
    this.snowLuma = runtime.snowLuma;
    this.#snowLumaRuntime = runtime.snowLumaRuntime;
    this.extensions = runtime.extensions;
    this.extensionTools = runtime.extensionTools;
    this.#pluginRuntimes = runtime.pluginRuntimes;
    this.policy = runtime.policy;
    this.agentScheduler = runtime.agentScheduler;
    this.media = runtime.media;
    this.jobs = runtime.jobs;
    this.providers = runtime.providers;
    this.#runtimeRegistry = runtime.runtimeRegistry;
    this.supervisor = runtime.supervisor;
    this.#accountLeases = runtime.accountLeases;
    this.#connections = runtime.connections;
    this.metrics = runtime.metrics;
    this.eventLog = runtime.eventLog;
    this.auditLog = runtime.auditLog;
    this.bus = runtime.bus;
    this.#extractionQuota = extractionQuota;
    const extractionLogger = this.#logger.child('memory-extraction');
    const enqueueOnConversation = async (
      completion: ExtractionTurnCompletion,
      task: () => Promise<void>
    ): Promise<void> => {
      const instance = this.supervisor.get(completion.instanceId);
      if (!instance) throw new AccompanyError('not_connected', `instance ${completion.instanceId} is not running`);
      await instance.enqueueConversationTask({
        accountId: completion.accountId,
        conversation: completion.conversation,
        sessionEpoch: completion.sessionEpoch
      }, task);
    };
    const extractionChat: ExtractionChatPort = {
      resolve: (accountId, conversation) => {
        const resolution = this.providers.resolve(accountId, conversation, 'chat');
        return {
          enabled: resolution.enabled,
          ...(resolution.providerId ? { providerId: resolution.providerId } : {}),
          ...(resolution.modelId ? { modelId: resolution.modelId } : {})
        };
      },
      chat: async (input) => {
        const executed = await this.providers.chat(
          input.accountId,
          input.conversation,
          { messages: input.messages },
          input.signal,
          undefined,
          {},
          input.isStillAllowed,
          { fallback: false, retry: false }
        );
        return {
          ...(executed.result.text !== undefined ? { text: executed.result.text } : {}),
          ...(executed.result.toolCalls ? { toolCalls: executed.result.toolCalls } : {}),
          used: executed.used
        };
      }
    };
    const extractionRunner = new MemoryExtractionRunner({
      memories: this.#memories,
      chat: extractionChat,
      contextEpoch: (accountId, conversation) => this.#accountService.historyEpoch(accountId, conversation),
      memoryGuard: async (accountId, conversation, contextEpoch) =>
        (await this.#memories.runtimeSnapshot(accountId, conversation, contextEpoch)).guard,
      enqueueCommit: enqueueOnConversation,
      logger: extractionLogger
    });
    this.#extractionCoordinator = new ExtractionCoordinator({
      memories: {
        status: (conversation) => this.#memories.extractionStatus(conversation),
        beginAttempt: (conversation, expectedScope, expectedGeneration, expectedThroughSeq, at) =>
          this.#memories.beginExtractionAttempt(conversation, expectedScope, expectedGeneration, expectedThroughSeq, at),
        recordFailure: (conversation, expectedScope, expectedGeneration, failure) =>
          this.#memories.recordExtractionFailure(conversation, expectedScope, expectedGeneration, failure),
        advance: (conversation, input) => this.#memories.advanceExtraction(conversation, input)
      },
      quota: this.#extractionQuota,
      store: (accountId) => this.#messageStore(accountId),
      contextEpoch: (accountId, conversation) => this.#accountService.historyEpoch(accountId, conversation),
      runner: extractionRunner,
      enqueue: enqueueOnConversation,
      ...(options.now ? { now: options.now } : {}),
      logger: extractionLogger
    });
    this.bus.on('memory:extraction-candidate', (completion) => this.#extractionCoordinator.notify(completion));
    this.#lifecycle = new RuntimeLifecycle({ logger: this.#logger.child('lifecycle') });
    this.#registerLifecycle();
  }

  #registerLifecycle(): void {
    const lifecycle = this.#lifecycle;
    lifecycle.add('stop', 'memory-extraction', () => { this.#extractionCoordinator.close(); });
    lifecycle.add('stop', 'model-settings', () => this.#modelSettings.drain());
    lifecycle.add('stop', 'qq-connections', () => this.#connections.stop());
    lifecycle.add('stop', 'health-monitor', () => {
      if (this.#healthTimer) {
        clearInterval(this.#healthTimer);
        this.#healthTimer = undefined;
      }
    });
    lifecycle.add('stop', 'api', async () => {
      if (!this.#api) return;
      await this.#api.close().catch((error: unknown) => {
        this.#logger.warn('api close failed', {
          message: error instanceof Error ? error.message : String(error)
        });
      });
      this.#api = undefined;
    });
    lifecycle.add('stop', 'deployments', async () => {
      try {
        await withTimeout(
          this.#deploymentService.drain(),
          this.#limits.shutdownTimeoutMs,
          `deployment drain timed out after ${this.#limits.shutdownTimeoutMs}ms`
        );
      } catch (error) {
        this.#logger.warn('deployment did not finish before shutdown', {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
    lifecycle.add('drain', 'memory-extraction', () => this.#extractionCoordinator.drain());
    lifecycle.add('drain', 'instances', async () => {
      try {
        await withTimeout(
          this.supervisor.stopAll(),
          this.#limits.shutdownTimeoutMs,
          `shutdown timed out after ${this.#limits.shutdownTimeoutMs}ms`
        );
      } catch (error) {
        this.#logger.warn('shutdown timeout; forcing resource release', {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
    lifecycle.add('dispose', 'host', async () => {
      try {
        await this.#options.host?.dispose?.();
      } catch (error) {
        this.#logger.warn('host dispose failed', { message: error instanceof Error ? error.message : String(error) });
      }
    });
    lifecycle.add('dispose', 'extension-tools', () => this.extensionTools.close());
    lifecycle.add('dispose', 'plugin-runtimes', () => this.#pluginRuntimes.close());
    lifecycle.add('dispose', 'jobs', async () => {
      try {
        await this.jobs.dispose();
      } catch (error) {
        this.#logger.warn('media jobs dispose failed', { message: error instanceof Error ? error.message : String(error) });
      }
    });
    lifecycle.add('dispose', 'media-cleanup', async () => { await this.media.cleanup(); });
    lifecycle.add('dispose', 'media', () => this.media.dispose());
    lifecycle.add('dispose', 'config-v2', () => this.configV2.dispose());
    lifecycle.add('dispose', 'memory-extraction-quota', () => this.#extractionQuota.dispose());
    lifecycle.add('dispose', 'injection-settings', () => this.#injectionSettings.dispose());
    lifecycle.add('dispose', 'account-displays', () => this.#accountDisplays.close());
    lifecycle.add('dispose', 'stores', async () => {
      await Promise.allSettled([...this.#stores.values()].map((store) => store.dispose()));
      await Promise.allSettled([...this.#pluginStates.values()].map((store) => store.dispose()));
    });
    lifecycle.add('dispose', 'supervisor', () => { this.supervisor.dispose(); });
    lifecycle.add('dispose', 'runtime-leases', async () => {
      await Promise.allSettled([...this.#runtimeLeases.values()].map((lease) => lease.release()));
      this.#runtimeLeases.clear();
    });
    lifecycle.add('dispose', 'runtime-registry', () => this.#runtimeRegistry.dispose());
    lifecycle.add('dispose', 'snowluma-runtime', () => this.#snowLumaRuntime.stop());
    lifecycle.add('dispose', 'dynamic-desired', async () => {
      for (const id of this.#connections.dynamicSlotIds()) {
        try {
          await this.#desiredStore.delete(id);
        } catch (error) {
          this.#logger.warn('dynamic desired state cleanup failed', {
            instanceId: id,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });
    lifecycle.add('dispose', 'desired-store', () => this.#desiredStore.dispose());
    lifecycle.add('dispose', 'listening-store', () => this.#listening.dispose());
    lifecycle.add('dispose', 'slot-store', async () => { await this.#slotStore?.dispose(); });
    lifecycle.add('dispose', 'account-leases', () => { this.#accountLeases.clear(); });
    lifecycle.add('dispose', 'observability', () => {
      this.bus.clear();
      this.eventLog.clear();
      this.auditLog.clear();
    });
    lifecycle.add('dispose', 'data-root-lock', async () => { await this.#dataRootLock?.release(); });
  }

  static async create(options: CoreOptions): Promise<Core> {
    const logger =
      options.logger ?? createLogger({ scope: 'nowadays', level: options.logLevel ?? 'info' });
    let core: Core | undefined;
    const hooks: RuntimeHooks = {
      createInstance: (spec) => {
        if (!core) throw new Error('runtime is not assembled');
        return core.#createInstance(spec);
      },
      deployTargets: () => (core ? core.#deployTargets() : []),
      reloadAgents: (accountId) => (core ? core.#reloadAgents(accountId) : Promise.resolve()),
      cancelRevokedJobs: (accountId) => (core ? core.#cancelRevokedJobs(accountId) : Promise.resolve()),
      releaseRuntime: (id) => (core ? core.#releaseRuntimeLease(id) : Promise.resolve()),
      isStopped: () => (core ? core.#stopped : false)
    };
    let runtime: RuntimeAssembly | undefined;
    try {
      runtime = await assembleRuntime({ options, logger, hooks });
      const extractionQuota = await ExtractionQuotaStore.load(
        path.join(path.resolve(options.dataRoot), 'state', 'memory-extraction-quota.json'),
        options.now ? { now: options.now } : {}
      );
      core = new Core(options, runtime, extractionQuota);
      for (const spec of runtime.initialSpecs) core.supervisor.add(spec);
      if (runtime.slotStore && !runtime.slotStore.loaded) await runtime.slotStore.save(runtime.initialSpecs);
      core.metrics.set('instances.total', core.supervisor.list().length);
      return core;
    } catch (error) {
      if (core) await core.stop().catch(() => {});
      else await runtime?.dispose().catch(() => {});
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.#stopped) throw new AccompanyError('core_stopped', 'core has been stopped');
    if (this.#started) return this.#startPromise;
    this.#started = true;
    const starting = (async () => {
      if (this.#options.manualStartOnly && this.#injectionSettings.get().resumeLastListen === true) {
        await this.#connections.restoreListeningSlots();
      }
      // 先起控制面：桌面端窗口要尽快拿到 UI，实例注入可以在后台继续。
      if (this.#options.api?.enabled) {
        this.#api = await createApiServer({
          core: this,
          ...(this.#options.api.host ? { host: this.#options.api.host } : {}),
          ...(this.#options.api.port !== undefined ? { port: this.#options.api.port } : {}),
          ...(this.#options.api.token ? { token: this.#options.api.token } : {}),
          ...(this.#options.api.maxBodyBytes !== undefined ? { maxBodyBytes: this.#options.api.maxBodyBytes } : {}),
          ...(this.#options.api.uiDir ? { uiDir: this.#options.api.uiDir } : {}),
          maxSseClients: this.#limits.maxSseClients,
          metrics: this.metrics,
          eventLog: this.eventLog,
          auditLog: this.auditLog,
          logger: this.#logger.child('api')
        });
        this.#assertNotStopped();
        this.#logger.info('api listening', { url: this.#api.url });
      }
      if (this.#options.manualStartOnly) {
        // 手动注入模式：恢复槽位展示，但绝不自动注入或开始监听。
        this.#logger.info('manual start only; instances wait for an explicit user action');
      } else {
        const result = await this.supervisor.startAll();
        if (result.failed.length > 0) {
          this.#logger.warn('some instances failed to start', { failed: result.failed });
        }
      }
      this.#assertNotStopped();
      this.#startHealthMonitor();
      if (this.#options.autoStartSnowLuma) void this.#snowLumaRuntime.ensureStarted();
      this.#connections.start();
    })();
    this.#startPromise = starting.catch(async (error: unknown) => {
      this.#stopped = true;
      this.#started = false;
      await this.#drainPublicWork();
      await this.#lifecycle.close();
      throw error;
    });
    return this.#startPromise;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#started = false;
    const startPromise = this.#startPromise;
    this.#stopPromise = (async () => {
      await startPromise?.catch(() => {});
      await this.#drainPublicWork();
      await this.#lifecycle.close();
    })();
    return this.#stopPromise;
  }

  #assertNotStopped(): void {
    if (this.#stopped) throw new AccompanyError('core_stopped', 'core has been stopped');
  }

  #runPublicWork<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.#stopped) return Promise.reject(new AccompanyError('core_stopped', 'core has been stopped'));
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const tracked = new Promise<T>((resolveWork, rejectWork) => {
      resolve = resolveWork;
      reject = rejectWork;
    });
    this.#publicWork.add(tracked);
    try {
      void Promise.resolve(operation()).then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    void tracked.then(
      () => this.#publicWork.delete(tracked),
      () => this.#publicWork.delete(tracked)
    );
    return tracked;
  }

  async #drainPublicWork(): Promise<void> {
    while (this.#publicWork.size > 0) {
      await Promise.allSettled([...this.#publicWork]);
    }
  }

  async #releaseRuntimeLease(id: string): Promise<void> {
    const lease = this.#runtimeLeases.get(id);
    this.#runtimeLeases.delete(id);
    await lease?.release();
  }

  async startInstance(id: string): Promise<void> {
    return this.#runPublicWork(() => this.supervisor.start(id));
  }

  async stopInstance(id: string): Promise<void> {
    return this.#runPublicWork(() => this.#connections.stopInstance(id));
  }

  async send(
    instanceId: string,
    conversation: ConversationRef,
    message: OutboundMessage,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.#runPublicWork(() => {
      const instance = this.supervisor.get(instanceId);
      if (!instance) throw new Error(`unknown instance: ${instanceId}`);
      return instance.send(conversation, message, options);
    });
  }

  status(): CoreStatus {
    return {
      dataRoot: this.#dataRoot,
      ...(this.#api ? { apiUrl: this.#api.url } : {}),
      instances: this.supervisor.list().map((status) => {
        const accountId = status.accountId ?? this.supervisor.get(status.id)?.spec.accountId;
        if (!accountId) return status;
        return { ...status, automaticPaused: this.policy.resolveAccount(accountId).agentEnabled === false };
      })
    };
  }

  diagnostics(): Diagnostics {
    return {
      dataRoot: this.#dataRoot,
      ...(this.#api ? { apiUrl: this.#api.url } : {}),
      limits: this.#limits,
      instances: this.supervisor.list(),
      runtimes: this.#runtimeRegistry.snapshot(),
      accounts: this.#accountLeases.snapshot(),
      desired: this.#desiredStore.snapshot(),
      metrics: this.metrics.snapshot(),
      latestEventId: this.eventLog.latestId,
      audit: this.auditLog.recent(50),
      artifacts: {
        publicRoot: this.#artifacts.publicRoot,
        deployments: this.#deploymentService.deployments()
      },
      phase1: {
        configFile: this.configV2.filePath,
        configVersion: this.configV2.version,
        configFingerprint: this.configV2.fingerprint,
        vault: { kind: this.#credentialVault.kind, available: this.#credentialVault.available },
        providers: this.configV2.snapshot().providers.length,
        endpoints: this.providers.endpoints(),
        scheduler: this.agentScheduler.snapshot()
      }
    };
  }

  async listConversations(accountId?: string): Promise<ConversationRef[]> {
    const conversations = new Map<string, ConversationRef>();
    for (const store of this.#stores.values()) {
      if (!store.listConversations) continue;
      for (const conversation of await store.listConversations(accountId)) {
        conversations.set(conversationKey(conversation), conversation);
      }
    }
    return [...conversations.values()];
  }

  listPublicArtifacts(): Promise<ResolvedArtifact[]> {
    return this.#artifacts.listPublic();
  }

  listWorldbooks(query: unknown = {}): Promise<WorldbookList> {
    return this.#runPublicWork(() => this.#worldbooks.list(query));
  }

  getWorldbook(id: string, revision: string): Promise<WorldbookResourceDetail> {
    return this.#runPublicWork(() => this.#worldbooks.detail(id, revision));
  }

  saveWorldbook(raw: unknown): Promise<WorldbookSaveResult> {
    return this.#runPublicWork(() => this.#worldbooks.save(raw));
  }

  previewWorldbookDraft(raw: unknown): ReturnType<WorldbookResourceService['previewDraft']> {
    return this.#runPublicWork(() => this.#worldbooks.previewDraft(raw));
  }

  memorySettings(conversation: ConversationRef): Promise<MemoryStateView> {
    return this.#runPublicWork(() => this.#memories.settings(conversation));
  }

  saveMemorySettings(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView> {
    return this.#runPublicWork(() => this.#memories.saveSettings(conversation, raw));
  }

  previewMemory(conversation: ConversationRef, raw: unknown): Promise<MemoryPreviewResult> {
    return this.#runPublicWork(() => this.#memories.preview(conversation, raw));
  }

  listMemoryRecords(conversation: ConversationRef, query: unknown = {}): Promise<MemoryRecordPage> {
    return this.#runPublicWork(() => this.#memories.listRecords(conversation, query));
  }

  getMemoryRecord(conversation: ConversationRef, id: string): Promise<MemoryRecordDetail> {
    return this.#runPublicWork(() => this.#memories.getRecord(conversation, id));
  }

  createMemoryRecord(conversation: ConversationRef, raw: unknown): Promise<MemoryRecordMutation> {
    return this.#runPublicWork(() => this.#memories.createRecord(conversation, raw));
  }

  updateMemoryRecord(conversation: ConversationRef, id: string, raw: unknown): Promise<MemoryRecordMutation> {
    return this.#runPublicWork(() => this.#memories.updateRecord(conversation, id, raw));
  }

  deleteMemoryRecord(conversation: ConversationRef, id: string, raw: unknown): Promise<MemoryDeleteResult> {
    return this.#runPublicWork(() => this.#memories.deleteRecord(conversation, id, raw));
  }

  clearMemoryRecords(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView> {
    return this.#runPublicWork(() => this.#memories.clear(conversation, raw));
  }

  memoryExtraction(conversation: ConversationRef): Promise<MemoryExtractionStatusView> {
    return this.#runPublicWork(async () => ({
      ...await this.#memories.extractionStatus(conversation),
      ...this.#extractionCoordinator.status(conversation)
    }));
  }

  activateMemoryExtraction(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView> {
    return this.#runPublicWork(() => this.#memories.activateExtraction(conversation, raw));
  }

  pauseMemoryExtraction(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView> {
    return this.#runPublicWork(() => this.#memories.pauseExtraction(conversation, raw));
  }

  artifactCatalog(): Promise<Record<string, string>> {
    return this.#artifacts.readCatalog(this.#artifacts.publicRoot);
  }

  slotSpecs(): InstanceSpec[] {
    return this.supervisor.listSpecs();
  }

  listAccounts(options: { avatars?: boolean } = {}): Promise<AccountSummary[]> {
    return this.#accountService.list(options);
  }

  readMessages(
    accountId: string,
    conversation: ConversationRef,
    options?: ReadOptions
  ): Promise<StoredMessage[]> {
    return this.#runPublicWork(async () => {
      const { dir, instance } = this.#locateAccount(accountId);
      const store = this.#storeFor(instance?.spec, accountId, dir);
      return store.read({ ...conversation, accountId }, options);
    });
  }

  credentialStore(): { kind: string; available: boolean } {
    return this.#modelSettings.credentialStore();
  }

  listProviders(): Promise<ProviderDto[]> {
    return this.#modelSettings.listProviders();
  }

  upsertProvider(raw: unknown, secret?: string, setting?: { capability: string; modelId: string }): Promise<ProviderDto> {
    return this.#runPublicWork(() => this.#modelSettings.upsertProvider(raw, secret, setting));
  }

  providerRemovalImpact(id: string): { providerId: string; exists: boolean; affectedAccounts: string[] } {
    return this.#modelSettings.providerRemovalImpact(id);
  }

  deleteProvider(id: string): Promise<{ removed: boolean; affectedAccounts: string[] }> {
    return this.#runPublicWork(() => this.#modelSettings.deleteProvider(id));
  }

  setProviderCredential(id: string, secret: string): Promise<ProviderDto> {
    return this.#runPublicWork(() => this.#modelSettings.setProviderCredential(id, secret));
  }

  deleteProviderCredential(id: string): Promise<ProviderDto> {
    return this.#runPublicWork(() => this.#modelSettings.deleteProviderCredential(id));
  }

  testProvider(
    id: string,
    capability: CapabilityId,
    modelId?: string,
    confirmCost = false
  ): Promise<ProviderTestResult> {
    return this.#runPublicWork(() => this.#modelSettings.testProvider(id, capability, modelId, confirmCost));
  }

  configureSimpleModel(raw: unknown): Promise<ProviderDto> {
    return this.#runPublicWork(() => this.#modelSettings.configureSimpleModel(raw));
  }

  discoverModels(raw: unknown): Promise<string[]> {
    return this.#runPublicWork(() => this.#modelSettings.discoverModels(raw));
  }

  validateSimpleModel(raw: unknown): Promise<ProviderTestResult> {
    return this.#runPublicWork(() => this.#modelSettings.validateSimpleModel(raw));
  }

  testAccountCapability(accountId: string, capability: CapabilityId, confirmCost = false): Promise<ProviderTestResult> {
    return this.#runPublicWork(() => this.#modelSettings.testAccountCapability(accountId, capability, confirmCost));
  }

  getAccountPolicy(accountId: string): AccountPolicy {
    return this.#modelSettings.getAccountPolicy(accountId);
  }

  setAccountPolicy(accountId: string, raw: unknown): Promise<AccountPolicy> {
    return this.#runPublicWork(() => this.#modelSettings.setAccountPolicy(accountId, raw));
  }

  patchAgentEnabled(
    accountId: string,
    enabled: boolean,
    scope?: { kind?: ChatKind; peerId?: string }
  ): Promise<AccountPolicy> {
    return this.#runPublicWork(() => this.#modelSettings.patchAgentEnabled(accountId, enabled, scope));
  }

  patchCapabilityEnabled(
    accountId: string,
    capability: CapabilityId,
    enabled: boolean,
    scope?: { kind?: ChatKind; peerId?: string }
  ): Promise<AccountPolicy> {
    return this.#runPublicWork(() => this.#modelSettings.patchCapabilityEnabled(accountId, capability, enabled, scope));
  }

  effectiveCapabilities(accountId: string, conversation: ConversationRef): Promise<EffectiveCapabilitiesDto> {
    return this.#modelSettings.effectiveCapabilities(accountId, conversation);
  }

  listJobs(accountId?: string): Promise<JobDto[]> {
    return this.#runPublicWork(() => {
      if (accountId) return this.jobs.list(assertIdentifier(accountId, 'accountId'));
      return this.#knownAccountIds().then((ids) => this.jobs.listAll(ids));
    });
  }

  getJob(accountId: string, jobId: string): Promise<JobDto | undefined> {
    return this.#runPublicWork(() => this.jobs.get(assertIdentifier(accountId, 'accountId'), jobId));
  }

  cancelJob(accountId: string, jobId: string): Promise<JobDto> {
    return this.#runPublicWork(() => this.jobs.cancel(assertIdentifier(accountId, 'accountId'), jobId));
  }

  listMedia(accountId: string): Promise<MediaRef[]> {
    return this.media.list(assertIdentifier(accountId, 'accountId'));
  }

  readMedia(accountId: string, mediaId: string): Promise<MediaData> {
    return this.media.read(assertIdentifier(accountId, 'accountId'), mediaId);
  }

  deleteMedia(accountId: string, mediaId: string): Promise<boolean> {
    return this.#runPublicWork(() => this.media.delete(assertIdentifier(accountId, 'accountId'), mediaId));
  }

  injectionSettings(): InjectionSettings {
    return this.#injectionSettings.get();
  }

  setInjectionSettings(raw: unknown, secret?: string): Promise<{ settings: InjectionSettings; status: SnowLumaRuntimeStatus }> {
    return this.#runPublicWork(async () => {
      const previous = this.#injectionSettings.get();
      if (this.#connections.hasMappings() && raw && typeof raw === 'object') {
        const requested = raw as { runtimeDir?: unknown; baseUrl?: unknown };
        const runtimeDir = typeof requested.runtimeDir === 'string' ? path.resolve(requested.runtimeDir.trim()) : undefined;
        const baseUrl = typeof requested.baseUrl === 'string' ? requested.baseUrl.replace(/\/+$/, '') : undefined;
        if (runtimeDir !== previous.runtimeDir || baseUrl !== previous.baseUrl) {
          throw new AccompanyError('injection_settings_busy', '请先停止全部 QQ 监听，再更换 SnowLuma runtime 或管理地址。');
        }
      }
      const settings = await this.#injectionSettings.set(raw);
      if (secret !== undefined && secret !== '') {
        if (!this.#credentialVault.available) throw new CredentialVaultUnavailableError();
        await this.#credentialVault.set(SNOWLUMA_MANAGEMENT_CREDENTIAL_REF, secret);
      }
      if (previous.runtimeDir !== settings.runtimeDir || previous.baseUrl !== settings.baseUrl) await this.#snowLumaRuntime.stop();
      this.snowLuma.configure(settings);
      if (this.#started && this.#options.autoStartSnowLuma) void this.#snowLumaRuntime.ensureStarted();
      return { settings, status: await this.injectionStatus() };
    });
  }

  clearInjectionPassword(): Promise<{ status: SnowLumaRuntimeStatus }> {
    return this.#runPublicWork(async () => {
      await this.#credentialVault.delete(SNOWLUMA_MANAGEMENT_CREDENTIAL_REF).catch(() => {});
      this.snowLuma.configure(this.#injectionSettings.get());
      return { status: await this.snowLuma.status() };
    });
  }

  async injectionStatus(): Promise<SnowLumaRuntimeStatus> {
    const status = await this.snowLuma.status();
    if (!this.#options.autoStartSnowLuma) return {
      ...status,
      owner: status.running ? 'external' : 'none',
      startupState: !status.configured ? 'unconfigured' : status.running ? 'external' : 'unconfigured'
    };
    const startup = this.#snowLumaRuntime.status();
    return { ...status, owner: startup.owner === 'none' && status.running ? 'external' : startup.owner,
      startupState: startup.state, ...(startup.error ? { error: startup.error } : {}) };
  }

  async testInjectionConnection(): Promise<{ runtime: SnowLumaRuntimeStatus; processCount: number }> {
    const status = await this.injectionStatus();
    if (!status.configured) throw new AccompanyError('snowluma_runtime_unavailable', '请先选择已完成官方初始化的 SnowLuma 运行目录并保存。');
    if (!status.compatible) throw new AccompanyError('snowluma_version_incompatible', `当前支持 SnowLuma ${status.supportedVersion}，检测到 ${status.version ?? '未知版本'}。`);
    if (!status.running) throw new AccompanyError('snowluma_unreachable', '管理服务未运行，请使用 SnowLuma 官方入口启动，再检查连接。');
    if (!status.autoLoadKnown || status.autoLoadEnabled) throw new AccompanyError('snowluma_autoload_invalid', '请在 SnowLuma 官方设置中明确关闭自动注入（hookAutoLoad），再检查连接。');
    // Authenticate and read the process list without injecting or allocating an instance.
    const processes = await this.snowLuma.listProcesses();
    return { runtime: await this.injectionStatus(), processCount: processes.length };
  }

  retrySnowLumaRuntime(): Promise<SnowLumaRuntimeStatus> {
    return this.#runPublicWork(async () => {
      if (!this.#options.autoStartSnowLuma) {
        throw new AccompanyError('snowluma_managed_disabled', 'this core does not own the SnowLuma management service');
      }
      if (!this.#started || this.#stopped) {
        throw new AccompanyError('core_not_started', 'core has not started');
      }
      // Only a failed startup is retried; a live managed or external service is left untouched.
      if (this.#snowLumaRuntime.status().state !== 'error') return this.injectionStatus();
      await this.#snowLumaRuntime.stop();
      await this.#snowLumaRuntime.ensureStarted();
      return this.injectionStatus();
    });
  }

  async resumeInjectionListening() {
    return this.#runPublicWork(() => this.#connections.resumeInjectionListening());
  }

  injectionResumeCandidates(): Array<{ slotId: string; accountId: string }> {
    return this.#connections.resumeCandidates();
  }

  injectionProcesses(options: { avatars?: boolean } = {}): Promise<SnowLumaProcess[]> {
    return this.#runPublicWork(() => this.#connections.processes(options));
  }

  injectAndListen(raw: unknown) {
    return this.#runPublicWork(() => this.#connections.injectAndListen(raw));
  }

  listenInjection(raw: unknown) {
    return this.#runPublicWork(() => this.#connections.listen(raw));
  }

  refreshInjection(raw: unknown) {
    return this.#runPublicWork(() => this.#connections.refresh(raw));
  }

  unloadInjection(raw: unknown) {
    return this.#runPublicWork(() => this.#connections.unload(raw));
  }

  injectionOperation(id: string) {
    return this.#connections.operation(id);
  }

  cleanupMedia(): Promise<{ deleted: number; skippedInUse: number; failed: number }> {
    return this.#runPublicWork(async () => {
      const accounts = await this.#knownAccountIds();
      const inUse = new Map<string, Set<string>>();
      for (const accountId of accounts) inUse.set(accountId, await this.jobs.inUseMedia(accountId));
      const result = await this.media.cleanup(inUse);
      this.bus.emit('media:cleanup', {
        deleted: result.deleted.length,
        skippedInUse: result.skippedInUse.length,
        failed: result.failed.length,
        at: this.#now()
      });
      return {
        deleted: result.deleted.length,
        skippedInUse: result.skippedInUse.length,
        failed: result.failed.length
      };
    });
  }

  getAccountProfile(accountId: string): Promise<AccountProfileFile | undefined> {
    return this.#accountService.getProfile(accountId);
  }

  getAccountDisplay(accountId: string): Promise<AccountDisplayProfile> {
    return this.#accountService.getDisplay(accountId);
  }

  saveAccountDisplay(accountId: string, raw: unknown): Promise<AccountDisplayProfile> {
    return this.#runPublicWork(() => this.#accountService.saveDisplay(accountId, raw));
  }

  listConversationRoleBindings(accountId: string): ReturnType<AccountService['listRoleBindings']> {
    return this.#accountService.listRoleBindings(accountId);
  }

  listAccountArtifacts(accountId: string): Promise<ResolvedArtifact[]> {
    return this.#accountService.listAccountArtifacts(accountId);
  }

  setConversationRoleBinding(
    conversation: ConversationRef,
    roleCard: { source: 'public' | 'private'; id: string; revision?: string } | null
  ): Promise<ConversationRoleBinding | undefined> {
    return this.#runPublicWork(() => this.#accountService.setRoleBinding(conversation, roleCard));
  }

  configureConversationWorldbook(conversation: ConversationRef, raw: unknown, expectedRevision: string, source?: unknown): ReturnType<AccountService['configureWorldbook']> {
    return this.#runPublicWork(() => this.#accountService.configureWorldbook(conversation, raw, expectedRevision, source));
  }

  previewConversationWorldbook(conversation: ConversationRef, text: string): ReturnType<AccountService['previewWorldbook']> {
    return this.#runPublicWork(() => this.#accountService.previewWorldbook(conversation, text));
  }

  resolveConversationRoleBinding(
    accountId: string,
    conversation: ConversationRef
  ): Promise<ResolvedConversationRoleBinding | undefined> {
    return this.#accountService.resolveRoleBinding(accountId, conversation);
  }

  resolveConversationMemory(
    accountId: string,
    conversation: ConversationRef
  ): Promise<ConversationMemoryCapture | undefined> {
    return this.#conversationMemory.capture(accountId, conversation);
  }

  saveAccountProfile(
    accountId: string,
    raw: unknown
  ): Promise<{ profile: AccountProfileFile; reload?: { ok: boolean; error?: string } }> {
    return this.#runPublicWork(() => this.#accountService.saveProfile(accountId, raw));
  }

  reloadAccount(accountId: string): Promise<Array<{ instanceId: string; ok: boolean; error?: string }>> {
    return this.#runPublicWork(() => this.#accountService.reload(accountId));
  }

  deployArtifact(kind: ArtifactKind, id: string, revision: string): Promise<DeploymentRecord> {
    return this.#runPublicWork(() => this.#deploymentService.deployArtifact(kind, id, revision));
  }

  rollbackArtifacts(): Promise<DeploymentRecord> {
    return this.#runPublicWork(() => this.#deploymentService.rollbackArtifacts());
  }

  deployments(): DeploymentRecord[] {
    return this.#deploymentService.deployments();
  }

  addSlot(spec: InstanceSpec): Promise<InstanceStatus> {
    return this.#runPublicWork(async () => {
      const instance = this.supervisor.add(spec);
      this.metrics.set('instances.total', this.supervisor.list().length);
      try {
        await this.#connections.saveConfiguredSlots();
      } catch (error) {
        await this.supervisor.remove(instance.id);
        this.metrics.set('instances.total', this.supervisor.list().length);
        throw error;
      }
      if (this.#started) await this.supervisor.start(instance.id);
      return instance.status();
    });
  }

  removeSlot(id: string): Promise<void> {
    return this.#runPublicWork(() => this.#connections.removeSlot(id));
  }

  instanceDataDir(instanceId: string): string {
    return path.join(this.#dataRoot, 'instances', instanceId);
  }

  #locateAccount(accountId: string): { dir: string; instance?: QqInstance } {
    const located = this.#accountService.locate(accountId);
    return {
      dir: located.dir,
      ...(located.instanceId ? { instance: this.supervisor.get(located.instanceId) } : {})
    };
  }

  async #reloadAgents(accountId?: string): Promise<void> {
    for (const status of this.supervisor.list()) {
      const instance = this.supervisor.get(status.id);
      if (!instance) continue;
      const bound = instance.accountId ?? instance.spec.accountId;
      if (!bound) continue;
      if (accountId && bound !== accountId) continue;
      const profile = instance.currentProfile;
      if (!profile) continue;
      if (!instance.state.is('online', 'degraded')) continue;
      // 宿主只有一种：配置或档案变化后统一重建，hostEpoch 前进让旧宿主在途状态失效。
      try {
        await instance.reloadProfile();
      } catch (error) {
        this.#logger.warn('agent reload after configuration change failed', {
          instanceId: instance.id,
          accountId: bound,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /** 配置撤销后，该账号排队或等待远端的任务不再具备执行的授权基础。 */
  async #cancelRevokedJobs(accountId: string): Promise<void> {
    let jobs: JobDto[];
    try {
      jobs = await this.jobs.list(accountId);
    } catch (error) {
      this.#logger.warn('failed to inspect jobs after policy change', {
        accountId,
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    for (const job of jobs) {
      if (job.state !== 'queued' && job.state !== 'running' && job.state !== 'waiting_remote') continue;
      const requirements =
        job.capability === 'image.understand'
          ? { media: 'image' as const }
          : job.capability === 'video.understand'
            ? { media: 'video' as const }
            : {};
      if (this.providers.resolve(job.accountId, job.conversation, job.capability, requirements).enabled) continue;
      await this.jobs.cancel(job.accountId, job.id).catch((error: unknown) => {
        this.#logger.warn('failed to cancel revoked media job', {
          accountId,
          jobId: job.id,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  #startHealthMonitor(): void {
    if (this.#limits.healthCheckIntervalMs <= 0 || this.#healthTimer) return;
    const timer = setInterval(() => {
      for (const instance of this.supervisor.list()) {
        const target = this.supervisor.get(instance.id);
        if (!target) continue;
        void target.checkHealth().catch((error: unknown) => {
          this.#logger.warn('health check failed', {
            instanceId: instance.id,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }, this.#limits.healthCheckIntervalMs);
    timer.unref?.();
    this.#healthTimer = timer;
  }

  #createInstance(spec: NormalizedInstanceSpec): QqInstance {
    const logger = this.#logger.child(spec.id);
    if (spec.accountId) this.#accountLeases.acquire(spec.accountId, spec.id);
    const lease = this.#runtimeRegistry.acquire(spec, { logger: logger.child('runtime') });
    this.#runtimeLeases.set(spec.id, lease);

    const createChannel: InstanceChannelFactory = (endpoints, handlers, signal) =>
      this.#createChannel(spec, endpoints, handlers, logger.child('channel'), signal);
    const hostFactory = this.#options.hostFactory;
    const createHost = hostFactory
      ? (input: AgentHostFactoryInput) => hostFactory(input)
      : this.#options.host
        ? undefined
        : (input: AgentHostFactoryInput) => this.#createDefaultHost(input);

    return new QqInstance({
      spec,
      backend: lease,
      createChannel,
      resolveStore: (accountId) => this.#storeFor(spec, accountId),
      resolveProfile: (accountId) => this.#profiles.resolve(this.#accountDirectory.forSpec(spec, accountId), accountId),
      stateFor: (accountId) => this.#pluginStateFor(spec, accountId),
      ...(createHost ? { createHost } : {}),
      profileFingerprint: (profile) => this.#profileFingerprint(profile),
      agentStatus: (profile) => this.#agentStatus(profile),
      bus: this.bus,
      logger,
      limits: this.#limits,
      metrics: this.metrics,
      runtimeKey: lease.key,
      claimAccount: (accountId) => this.#accountLeases.acquire(accountId, spec.id),
      releaseAccount: (accountId) => {
        this.#accountLeases.release(accountId, spec.id);
        // 该账号最后一个实例释放后，插件 Worker 不再为它保留执行能力。
        if (this.#accountLeases.ownerOf(accountId)) return;
        this.#pluginRuntimes.close(accountId).catch((error: unknown) => {
          this.#logger.warn('plugin runtime close after release failed', {
            accountId,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      },
      automaticReplyAllowed: (accountId, conversation) =>
        this.policy.resolve(accountId, conversation).agentEnabled,
      resolveConversationRole: (accountId, conversation) => this.resolveConversationRoleBinding(accountId, conversation),
      resolveConversationMemory: (accountId, conversation) => this.resolveConversationMemory(accountId, conversation),
      configResolver: (scope) => this.config.resolve(scope),
      ...(this.#options.host ? { host: this.#options.host } : {}),
      ...(this.#options.now ? { now: this.#options.now } : {}),
      ...(this.#options.recordId ? { recordId: this.#options.recordId } : {})
    });
  }

  async #createDefaultHost(input: AgentHostFactoryInput): Promise<AgentHost | undefined> {
    if (!this.policy.hasBindings(input.accountId)) return undefined;
    // 宿主代际重建时同步插件 Worker：新的 handshake 结果决定这一代能看到并执行哪些插件工具。
    await this.#pluginRuntimes.sync(input.accountId);
    const configuredHistory = this.#options.agent?.maxHistoryMessages ?? 40;
    const maxHistoryMessages = Math.max(
      1,
      Math.min(configuredHistory, this.#limits.maxHostHistory)
    );
    return createAgentEngine({
      instanceId: input.instanceId,
      accountId: input.accountId,
      profile: input.profile,
      logger: input.logger,
      sessionSignal: input.signal,
      sessionEpoch: input.sessionEpoch,
      hostEpoch: input.hostEpoch,
      profileFingerprint: input.profileFingerprint,
      providers: this.providers,
      media: this.media,
      jobs: this.jobs,
      scheduler: this.agentScheduler,
      extensions: this.extensions,
      tools: this.extensionTools,
      maxHistoryMessages,
      maxHistoryChars: this.#options.agent?.maxHistoryChars ?? 12_000,
      maxObservedMedia: this.#options.agent?.maxObservedMedia ?? 4,
      onTurn: (event) => {
        this.bus.emit('agent:turn', { ...event, at: this.#now() });
      },
      ...(this.#options.now ? { now: this.#options.now } : {})
    });
  }

  #agentStatus(profile: ResolvedProfile): { mode: 'agent' | 'custom'; configured: boolean } {
    if (this.#options.host || this.#options.hostFactory) return { mode: 'custom', configured: true };
    return { mode: 'agent', configured: this.policy.hasBindings(profile.accountId) };
  }

  #profileFingerprint(profile: ResolvedProfile): string {
    const policy = this.policy.resolveAccount(profile.accountId);
    return crypto
      .createHash('sha1')
      .update(
        JSON.stringify({
          revision: profile.revision,
          config: this.configV2.fingerprint,
          policy
        })
      )
      .digest('hex')
      .slice(0, 16);
  }

  #knownAccountIds(): Promise<string[]> {
    return this.#accountDirectory.listKnown();
  }

  #now(): number {
    return this.#options.now ? this.#options.now() : Date.now();
  }

  #messageStore(accountId: string): MessageStore {
    const { dir, instance } = this.#locateAccount(accountId);
    return this.#storeFor(instance?.spec, accountId, dir);
  }

  #storeFor(spec: NormalizedInstanceSpec | undefined, accountId: string, dirOverride?: string): MessageStore {
    const accountDir = dirOverride ?? this.#accountDirectory.forSpec(spec, accountId);
    const existing = this.#stores.get(accountDir);
    if (existing) return existing;
    const createDefault = (): MessageStore =>
      new JsonlStore({
        root: path.join(accountDir, 'messages'),
        accountId,
        ...(this.#options.maxRecordsPerConversation !== undefined
          ? { maxRecordsPerConversation: this.#options.maxRecordsPerConversation }
          : {}),
        ...(this.#options.segmentRecords !== undefined ? { segmentRecords: this.#options.segmentRecords } : {}),
        logger: this.#logger.child(`${spec?.id ?? 'account'}:${accountId}:store`)
      });
    const store = spec ? (this.#options.storeFactory?.(spec, accountDir) ?? createDefault()) : createDefault();
    this.#stores.set(accountDir, store);
    return store;
  }

  #pluginStateFor(spec: NormalizedInstanceSpec, accountId: string): PluginStateStore {
    const key = path.join(this.#accountDirectory.forSpec(spec, accountId), 'plugin-state');
    const existing = this.#pluginStates.get(key);
    if (existing) return existing;
    const store = new PluginStateStore(key, this.#logger.child(`${spec.id}:${accountId}:plugin-state`));
    this.#pluginStates.set(key, store);
    return store;
  }

  #deployTargets(): Array<{
    id: string;
    accountId?: string;
    currentProfile?: ResolvedProfile;
    validateProfile: () => Promise<ResolvedProfile>;
    applyProfile: (profile: ResolvedProfile) => Promise<void>;
  }> {
    const targets = [];
    for (const status of this.supervisor.list()) {
      const instance = this.supervisor.get(status.id);
      if (!instance) continue;
      const current = instance.currentProfile;
      targets.push({
        id: instance.id,
        ...(instance.accountId ? { accountId: instance.accountId } : {}),
        ...(current ? { currentProfile: current } : {}),
        validateProfile: () => instance.validateProfile(),
        applyProfile: (profile: ResolvedProfile) => instance.applyProfile(profile)
      });
    }
    return targets;
  }

  #createChannel(
    spec: NormalizedInstanceSpec,
    endpoints: RuntimeEndpoints,
    handlers: ChannelHandlers,
    logger: Logger,
    signal?: AbortSignal
  ): OutboundChannel {
    if (this.#options.channelFactory) {
      return this.#options.channelFactory({
        spec,
        instanceId: spec.id,
        endpoints,
        logger,
        ...(signal ? { signal } : {}),
        maxConcurrentActions: this.#limits.maxConcurrentActions,
        onEvent: handlers.onEvent,
        onStatus: handlers.onStatus
      });
    }
    if (spec.backend === 'fake' && this.#options.autoFakeChannel) {
      return new FakeChannel(
        {
          spec,
          instanceId: spec.id,
          endpoints,
          logger,
          ...(signal ? { signal } : {}),
          maxConcurrentActions: this.#limits.maxConcurrentActions,
          onEvent: handlers.onEvent,
          onStatus: handlers.onStatus
        },
        { ...(spec.accountId ? { selfId: spec.accountId } : {}) }
      );
    }
    return new OneBotChannel({
      spec,
      instanceId: spec.id,
      endpoints,
      logger,
      ...(signal ? { signal } : {}),
      maxConcurrentActions: this.#limits.maxConcurrentActions,
      onEvent: handlers.onEvent,
      onStatus: handlers.onStatus
    });
  }
}

export function createCore(options: CoreOptions): Promise<Core> {
  return Core.create(options);
}
