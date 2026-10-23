import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TypedEventBus } from './bus.js';
import type { CoreEvents } from './events.js';
import { AccompanyError, InvalidSpecError, IsolationError } from './errors.js';
import { createLogger, type Logger, type LogLevel } from './logger.js';
import { AuditLog } from './audit.js';
import { DataRootLock } from './data-root-lock.js';
import { EventLog } from './event-log.js';
import { withTimeout } from './concurrency.js';
import { normalizeLimits, type Limits } from './limits.js';
import { Metrics } from './metrics.js';
import { LayeredConfig } from '../config/layered.js';
import type { ChannelFactory, OutboundChannel } from '../channels/contract.js';
import { OneBotChannel } from '../channels/onebot/client.js';
import { FakeChannel } from '../channels/fake.js';
import { FakeInjectionBackend, type FakeBackendOptions } from '../injection/fake.js';
import { SnowLumaBackend } from '../injection/snowluma/backend.js';
import type { BackendFactory, InjectionBackend, RuntimeEndpoints } from '../injection/contract.js';
import { QqInstance, type ChannelHandlers, type InstanceChannelFactory, type SendOptions, type SendResult } from '../instances/instance.js';
import { InstanceSupervisor } from '../instances/supervisor.js';
import type { InstanceSpec, InstanceStatus, NormalizedInstanceSpec } from '../instances/spec.js';
import { AccountLeases } from '../instances/account-leases.js';
import { RuntimeRegistry, type RuntimeLease } from '../instances/runtime-registry.js';
import { assertIdentifier, conversationKey, safePathSegment, type ChatKind, type ConversationRef } from '../routing/identity.js';
import type { OutboundMessage } from '../routing/message.js';
import { JsonlStore } from '../storage/jsonl-store.js';
import type { MessageStore, ReadOptions, StoredMessage } from '../storage/contract.js';
import { DesiredStateStore } from '../storage/desired-state.js';
import { ListeningStore } from '../storage/listening-store.js';
import { SlotStore } from '../storage/slot-store.js';
import { createApiServer, type ApiHandle, type AccountSummary, type CoreView } from '../service/server.js';
import type { AgentHost, AgentHostFactory, AgentHostFactoryInput } from '../host/contract.js';
import { InjectionSettingsStore, type InjectionSettings } from '../injection/settings.js';
import { ManualInjectionService } from '../injection/manual.js';
import { QqAvatarCache } from '../injection/qq-avatar.js';
import { SnowLumaRuntimeController, type SnowLumaRuntimeControllerOptions } from '../injection/snowluma/runtime.js';
import {
  SNOWLUMA_MANAGEMENT_CREDENTIAL_REF,
  SnowLumaManager,
  type SnowLumaProcess,
  type SnowLumaRuntimeStatus
} from '../injection/snowluma/manager.js';
import { PluginStateStore } from '../host/state.js';
import { createWorkerHost } from '../host/worker.js';
import { LocalArtifactStore } from '../artifacts/local.js';
import { RollingDeployer, type DeploymentRecord } from '../artifacts/deploy.js';
import { AccountProfileService } from '../profiles/profile.js';
import { ConversationRoleBindingStore, type ConversationRoleBinding, type ResolvedConversationRoleBinding } from '../profiles/role-bindings.js';
import { loadAccountDisplay, saveAccountDisplay, type AccountDisplayProfile } from '../profiles/display.js';
import { ConfigStore } from '../providers/config-store.js';
import { buildSimpleProvider, discoverProviderModels, parseModelSetup } from '../providers/setup.js';
import { sanitizeErrorText } from '../providers/errors.js';
import {
  accountPolicyFor,
  defaultAccountPolicy,
  parseProvider,
  redactProvider,
  type AccountPolicy,
  type ProviderConfig,
  type ProviderDto,
  type RuntimeConfigV2
} from '../providers/types.js';
import { PolicyService, patchAgentEnabled, patchCapability } from '../policy/policy.js';
import { ExtensionRegistry, SkillRuntime } from '../extensions/registry.js';
import { ProviderRouter, type EffectiveCapabilitiesDto } from '../providers/router.js';
import type { ProviderAdapter, ProviderTestResult } from '../providers/contract.js';
import type { CapabilityId } from '../policy/capabilities.js';
import { OpenAiCompatibleAdapter } from '../providers/adapters/openai.js';
import { VideoPollingAdapter } from '../providers/adapters/video.js';
import { FakeProviderAdapter } from '../providers/adapters/fake.js';
import { MediaService } from '../media/service.js';
import type { MediaData } from '../media/types.js';
import { MediaJobService } from '../jobs/service.js';
import type { JobDto, MediaJob } from '../jobs/types.js';
import type { MediaRef } from '../media/types.js';
import { TurnScheduler } from '../agent/scheduler.js';
import { createAgentEngine } from '../agent/engine.js';
import { registerBuiltInAgentTools } from '../agent/engine.js';
import {
  CredentialVaultUnavailableError,
  UnavailableCredentialVault,
  defaultCredentialRef,
  type CredentialVault
} from '../secrets/vault.js';
import {
  artifactRefKey,
  summarizeProfile,
  type AccountProfileFile,
  type ArtifactKind,
  type ResolvedArtifact,
  type ResolvedProfile
} from '../artifacts/types.js';

export interface CoreApiOptions {
  enabled?: boolean;
  host?: string;
  port?: number;
  token?: string;
  maxBodyBytes?: number;
  /** 桌面端构建产物目录；设置后由控制面同源托管 UI，静态资源不需要 token。 */
  uiDir?: string;
}

export interface CoreOptions {
  dataRoot: string;
  instances: InstanceSpec[];
  backendFactory?: BackendFactory;
  channelFactory?: ChannelFactory;
  /** dataDir 已解析为账号目录（<base>/accounts/<qq>），返回的 store 只服务该账号。 */
  storeFactory?: (spec: NormalizedInstanceSpec, dataDir: string) => MessageStore;
  api?: CoreApiOptions;
  logger?: Logger;
  logLevel?: LogLevel;
  maxRecordsPerConversation?: number;
  segmentRecords?: number;
  limits?: Partial<Limits>;
  /** 旧入口：同一个宿主对象服务所有账号；新部署优先用 hostFactory。 */
  host?: AgentHost;
  /** 按账号创建宿主；不提供时，有插件的账号使用内置 worker 宿主。 */
  hostFactory?: AgentHostFactory;
  profiles?: {
    /** 公用制品根，默认 <dataRoot>/public。 */
    publicRoot?: string;
  };
  /** 把槽位规格持久化到 <dataRoot>/slots.json；桌面端开启，CLI 默认关闭。 */
  persistSlots?: boolean;
  /** 覆盖槽位规格文件路径。 */
  slotsFile?: string;
  /** SnowLuma 手动注入设置；默认 <dataRoot>/injection.json。 */
  injectionSettingsFile?: string;
  /** 桌面端默认只恢复展示，不自动注入/监听。 */
  manualStartOnly?: boolean;
  /** 测试注入用的管理请求实现。 */
  snowLumaFetchImpl?: typeof fetch;
  /** 测试注入用的 QQ 公开头像请求实现。 */
  avatarFetchImpl?: typeof fetch;
  /** Start only the management service; QQ injection/listening still requires a click. */
  autoStartSnowLuma?: boolean;
  snowLumaRuntimeOptions?: Partial<Omit<SnowLumaRuntimeControllerOptions, 'manager' | 'logger'>>;
  injectionPollIntervalMs?: number;
  /** backend=fake 时自动接 FakeChannel，便于桌面端演示与本地联调。 */
  autoFakeChannel?: boolean;
  lockDataRoot?: boolean;
  /** 系统保护的凭据库；不提供时拒绝保存 Key，不静默写明文。 */
  credentialVault?: CredentialVault;
  /** 额外或覆盖内置适配器；同一 id 后注册者优先。 */
  providerAdapters?: ProviderAdapter[];
  /** schemaVersion=2 的模型/策略配置；默认 <dataRoot>/config.v2.json。 */
  modelConfigFile?: string;
  agent?: {
    maxHistoryMessages?: number;
    maxHistoryChars?: number;
    maxObservedMedia?: number;
  };
  now?: () => number;
  recordId?: () => string;
}

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
  readonly agentScheduler: TurnScheduler;

  readonly #dataRoot: string;
  readonly #logger: Logger;
  readonly #options: CoreOptions;
  readonly #limits: Limits;
  readonly #stores = new Map<string, MessageStore>();
  readonly #pluginStates = new Map<string, PluginStateStore>();
  readonly #runtimeLeases = new Map<string, RuntimeLease>();
  readonly #runtimeRegistry: RuntimeRegistry;
  readonly #accountLeases = new AccountLeases();
  readonly #artifacts: LocalArtifactStore;
  readonly #profiles: AccountProfileService;
  readonly #roleBindings = new ConversationRoleBindingStore();
  readonly #deployer: RollingDeployer;
  readonly #deployments: DeploymentRecord[] = [];
  #deployChain: Promise<void> = Promise.resolve();
  #modelSetupChain: Promise<unknown> = Promise.resolve();
  readonly #desiredStore: DesiredStateStore;
  readonly #slotStore?: SlotStore;
  readonly #listening: ListeningStore;
  readonly #injectionSettings: InjectionSettingsStore;
  readonly snowLuma: SnowLumaManager;
  readonly #manualInjection: ManualInjectionService;
  readonly #snowLumaRuntime: SnowLumaRuntimeController;
  readonly #qqAvatars: QqAvatarCache;
  readonly #dynamicSlots = new Set<string>();
  readonly #processSlots = new Map<number, { slotId: string; accountId: string; missing: number; mappedEpoch: number }>();
  #processMappingEpoch = 0;
  #dynamicChain: Promise<unknown> = Promise.resolve();
  #processScan: Promise<SnowLumaProcess[]> | undefined;
  #injectionTimer: NodeJS.Timeout | undefined;
  readonly #dataRootLock?: DataRootLock;
  readonly #credentialVault: CredentialVault;
  #api: ApiHandle | undefined;
  #healthTimer: NodeJS.Timeout | undefined;
  #started = false;
  #stopped = false;

  private constructor(
    options: CoreOptions,
    config: LayeredConfig,
    configV2: ConfigStore,
    logger: Logger,
    desiredStore: DesiredStateStore,
    injectionSettings: InjectionSettingsStore,
    listening: ListeningStore,
    slotStore?: SlotStore,
    dataRootLock?: DataRootLock
  ) {
    this.#options = options;
    this.#dataRoot = path.resolve(options.dataRoot);
    this.#logger = logger;
    this.#limits = normalizeLimits(options.limits);
    this.#desiredStore = desiredStore;
    this.#slotStore = slotStore;
    this.#listening = listening;
    this.#injectionSettings = injectionSettings;
    this.#dataRootLock = dataRootLock;
    this.config = config;
    this.configV2 = configV2;
    this.#artifacts = new LocalArtifactStore(
      options.profiles?.publicRoot ? path.resolve(options.profiles.publicRoot) : path.join(this.#dataRoot, 'public'),
      logger.child('artifacts')
    );
    this.#profiles = new AccountProfileService(this.#artifacts, logger.child('profiles'));
    this.#deployer = new RollingDeployer({
      listTargets: () => this.#deployTargets(),
      logger: logger.child('deploy'),
      ...(options.now ? { now: options.now } : {})
    });
    this.metrics = new Metrics();
    this.eventLog = new EventLog();
    this.auditLog = new AuditLog();
    this.bus = new TypedEventBus<CoreEvents>({
      onHandlerError: (error, info) => {
        this.#logger.error('event handler failed', {
          type: info.type,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
    this.bus.onAny((type, payload) => {
      const at = payload && typeof payload === 'object' && typeof (payload as { at?: unknown }).at === 'number'
        ? (payload as { at: number }).at
        : Date.now();
      this.eventLog.append(String(type), payload, at);
    });

    this.#credentialVault = options.credentialVault ?? new UnavailableCredentialVault();
    this.snowLuma = new SnowLumaManager({
      vault: this.#credentialVault,
      logger: logger.child('snowluma'),
      settings: injectionSettings.get(),
      ...(options.snowLumaFetchImpl ? { fetchImpl: options.snowLumaFetchImpl } : {})
    });
    this.#snowLumaRuntime = new SnowLumaRuntimeController({
      ...options.snowLumaRuntimeOptions, manager: this.snowLuma, logger: logger.child('snowluma-runtime')
    });
    this.#qqAvatars = new QqAvatarCache({
      ...(options.avatarFetchImpl ? { fetchImpl: options.avatarFetchImpl } : {}),
      logger: logger.child('qq-avatar')
    });
    this.extensions = new ExtensionRegistry();
    registerBuiltInAgentTools(this.extensions);
    this.policy = new PolicyService(configV2);
    this.agentScheduler = new TurnScheduler({
      maxGlobal: this.#limits.maxChatConcurrency,
      maxPerAccount: this.#limits.maxAccountChatConcurrency,
      maxPending: this.#limits.maxChatPending
    });
    this.media = new MediaService({
      accountDir: (accountId) => this.#accountDirForAccount(accountId),
      accountIds: () => this.#knownAccountIds(),
      maxImageBytes: this.#limits.maxImageBytes,
      maxVideoBytes: this.#limits.maxVideoBytes,
      maxDownloadMs: this.#limits.mediaDownloadTimeoutMs,
      retentionDays: () => Math.min(this.#limits.mediaRetentionDays, configV2.snapshot().media.retentionDays),
      logger: logger.child('media'),
      ...(options.now ? { now: options.now } : {})
    });
    this.jobs = new MediaJobService({
      accountDir: (accountId) => path.join(this.#accountDirForAccount(accountId), 'jobs'),
      accountIds: () => this.#knownAccountIds(),
      maxConcurrentJobs: this.#limits.maxMediaConcurrentJobs,
      maxAccountConcurrentJobs: this.#limits.maxAccountMediaConcurrentJobs,
      maxPendingJobs: this.#limits.maxMediaJobPending,
      maxPerAccountPending: this.#limits.maxPerAccountMediaJobPending,
      timeoutMs: this.#limits.mediaJobTimeoutMs,
      logger: logger.child('jobs'),
      ...(options.now ? { now: options.now } : {}),
      ...(options.recordId ? { recordId: options.recordId } : {}),
      onUpdate: (job) => {
        this.bus.emit('job:update', {
          accountId: job.accountId,
          jobId: job.id,
          state: job.state,
          capability: job.capability,
          delivery: job.delivery,
          at: this.#now()
        });
      }
    });
    const skills = new SkillRuntime(() => this.configV2.snapshot().skills);
    this.providers = new ProviderRouter({
      config: configV2,
      policy: this.policy,
      skills,
      extensions: this.extensions,
      vault: this.#credentialVault,
      adapters: [
        new FakeProviderAdapter(),
        new OpenAiCompatibleAdapter(),
        new VideoPollingAdapter(),
        ...(options.providerAdapters ?? [])
      ],
      logger: logger.child('providers'),
      metrics: this.metrics,
      ...(options.now ? { now: options.now } : {}),
      onUsage: (usage) => {
        this.bus.emit('provider:usage', {
          accountId: usage.accountId,
          capability: usage.capability,
          providerId: usage.providerId,
          modelId: usage.modelId,
          ok: usage.ok,
          durationMs: usage.durationMs,
          ...(usage.code ? { code: usage.code } : {}),
          at: this.#now()
        });
      }
    });

    let supervisor: InstanceSupervisor | undefined;
    const backendFactory: BackendFactory =
      options.backendFactory ??
      ((spec, deps) => this.#defaultBackend(spec, deps, () => supervisor?.get(spec.id)));
    this.#runtimeRegistry = new RuntimeRegistry({
      backendFactory,
      logger: logger.child('runtimes'),
      ...(options.now ? { now: options.now } : {})
    });
    supervisor = new InstanceSupervisor({
      bus: this.bus,
      logger: logger.child('supervisor'),
      createInstance: (spec) => this.#createInstance(spec),
      limits: this.#limits,
      metrics: this.metrics,
      desiredStore,
      runtimeRegistry: this.#runtimeRegistry,
      ...(options.now ? { now: options.now } : {})
    });
    this.supervisor = supervisor;
    this.#manualInjection = new ManualInjectionService({
      manager: this.snowLuma,
      logger: logger.child('manual-injection'),
      host: {
        slot: (id) => this.supervisor.get(id)?.spec,
        resumeCandidates: () => {
          const runtimeDir = this.#injectionSettings.get().runtimeDir;
          if (!runtimeDir) return [];
          const resolved = path.resolve(runtimeDir);
          return this.supervisor.listSpecs().filter((spec) =>
            spec.backend === 'snowluma' && spec.runtimeDir !== undefined && path.resolve(spec.runtimeDir) === resolved
          );
        },
        instanceStatus: (id) => this.supervisor.get(id)?.status(),
        accountOwner: (accountId) => this.#accountLeases.ownerOf(accountId),
        startSlot: async (id) => {
          await this.supervisor.start(id);
        },
        stopSlot: async (id) => {
          await this.stopInstance(id);
        },
        rebindSlot: (id, accountId) => this.#rebindSlotAccount(id, accountId),
        resolveSlotForAccount: (accountId, pid) => this.#ensureDynamicSlot(accountId, pid),
        trackProcess: (pid, slotId, accountId) => { this.#trackProcess(pid, slotId, accountId); },
        slotForProcess: (pid) => this.#processSlots.get(pid)?.slotId,
        rememberListening: (slotId, accountId) => this.#rememberListening(slotId, accountId),
        forgetListening: (slotId) => this.#forgetListening(slotId)
      },
      ...(options.now ? { now: options.now } : {})
    });
  }

  static async create(options: CoreOptions): Promise<Core> {
    const dataRoot = path.resolve(options.dataRoot);
    const logger =
      options.logger ?? createLogger({ scope: 'nowadays', level: options.logLevel ?? 'info' });
    let lock: DataRootLock | undefined;
    try {
      if (options.lockDataRoot !== false) {
        lock = await DataRootLock.acquire(dataRoot, logger.child('lock'));
      }
      const config = await LayeredConfig.load(path.join(dataRoot, 'config.json'), logger.child('config'));
      const configV2 = await ConfigStore.load({
        filePath: options.modelConfigFile
          ? path.resolve(options.modelConfigFile)
          : path.join(dataRoot, 'config.v2.json'),
        legacyFile: path.join(dataRoot, 'config.json'),
        logger: logger.child('providers')
      });
      const desiredStore = await DesiredStateStore.load(
        path.join(dataRoot, 'state', 'desired.json'),
        logger.child('desired')
      );
      const slotStore = options.persistSlots
        ? await SlotStore.load(
            options.slotsFile ? path.resolve(options.slotsFile) : path.join(dataRoot, 'slots.json'),
            logger.child('slots')
          )
        : undefined;
      const injectionSettings = await InjectionSettingsStore.load({
        filePath: options.injectionSettingsFile
          ? path.resolve(options.injectionSettingsFile)
          : path.join(dataRoot, 'injection.json'),
        logger: logger.child('injection')
      });
      const listening = await ListeningStore.load(
        path.join(dataRoot, 'state', 'listening.json'),
        logger.child('listening')
      );
      const initial = slotStore?.loaded ? slotStore.list() : options.instances;
      const core = new Core(options, config, configV2, logger, desiredStore, injectionSettings, listening, slotStore, lock);
      try {
        for (const spec of initial) core.supervisor.add(spec);
        if (slotStore && !slotStore.loaded) await slotStore.save(initial);
        core.metrics.set('instances.total', core.supervisor.list().length);
      } catch (error) {
        await core.stop();
        throw error;
      }
      return core;
    } catch (error) {
      await lock?.release();
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.#stopped) throw new Error('core has been stopped');
    if (this.#started) return;
    this.#started = true;
    try {
      if (this.#options.manualStartOnly && this.#injectionSettings.get().resumeLastListen === true) {
        await this.#restoreListeningSlots();
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
      this.#startHealthMonitor();
      if (this.#options.autoStartSnowLuma) void this.#snowLumaRuntime.ensureStarted();
      this.#injectionTimer = setInterval(() => {
        if (this.#processSlots.size && !this.#stopped) void this.injectionProcesses().catch(() => {});
      }, this.#options.injectionPollIntervalMs ?? 5000);
      this.#injectionTimer.unref();
    } catch (error) {
      this.#started = false;
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#started = false;
    await this.#modelSetupChain.catch(() => {});
    if (this.#injectionTimer) clearInterval(this.#injectionTimer);
    await this.#manualInjection.dispose();
    await this.#processScan?.catch(() => {});
    await this.#dynamicChain.catch(() => {});
    if (this.#healthTimer) {
      clearInterval(this.#healthTimer);
      this.#healthTimer = undefined;
    }
    if (this.#api) {
      await this.#api.close().catch((error: unknown) => {
        this.#logger.warn('api close failed', { message: error instanceof Error ? error.message : String(error) });
      });
      this.#api = undefined;
    }
    try {
      await withTimeout(
        this.#deployChain,
        this.#limits.shutdownTimeoutMs,
        `deployment drain timed out after ${this.#limits.shutdownTimeoutMs}ms`
      );
    } catch (error) {
      this.#logger.warn('deployment did not finish before shutdown', {
        message: error instanceof Error ? error.message : String(error)
      });
    }
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
    try {
      await this.#options.host?.dispose?.();
    } catch (error) {
      this.#logger.warn('host dispose failed', { message: error instanceof Error ? error.message : String(error) });
    }
    try {
      await this.jobs.dispose();
    } catch (error) {
      this.#logger.warn('media jobs dispose failed', { message: error instanceof Error ? error.message : String(error) });
    }
    try {
      await this.media.cleanup();
      await this.media.dispose();
      await this.configV2.dispose();
    } catch (error) {
      this.#logger.warn('media/config dispose failed', { message: error instanceof Error ? error.message : String(error) });
    }
    await this.#injectionSettings.dispose().catch(() => {});
    await Promise.allSettled([...this.#stores.values()].map((store) => store.dispose()));
    await Promise.allSettled([...this.#pluginStates.values()].map((store) => store.dispose()));
    this.supervisor.dispose();
    await Promise.allSettled([...this.#runtimeLeases.values()].map((lease) => lease.release()));
    this.#runtimeLeases.clear();
    await this.#runtimeRegistry.dispose();
    await this.#snowLumaRuntime.stop();
    for (const id of this.#dynamicSlots) await this.#desiredStore.delete(id);
    await this.#desiredStore.dispose();
    await this.#listening.dispose().catch(() => {});
    await this.#slotStore?.dispose();
    this.#accountLeases.clear();
    this.bus.clear();
    this.eventLog.clear();
    this.auditLog.clear();
    await this.#dataRootLock?.release();
  }

  async startInstance(id: string): Promise<void> {
    await this.supervisor.start(id);
  }

  async stopInstance(id: string): Promise<void> {
    await this.#withDynamicLock(async () => {
      if (this.#dynamicSlots.has(id)) await this.removeSlot(id);
      else {
        await this.supervisor.stop(id);
        await this.#forgetListening(id);
      }
      for (const [pid, record] of this.#processSlots) if (record.slotId === id) this.#processSlots.delete(pid);
    });
  }

  async send(
    instanceId: string,
    conversation: ConversationRef,
    message: OutboundMessage,
    options?: SendOptions
  ): Promise<SendResult> {
    const instance = this.supervisor.get(instanceId);
    if (!instance) throw new Error(`unknown instance: ${instanceId}`);
    return instance.send(conversation, message, options);
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
        deployments: [...this.#deployments]
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

  artifactCatalog(): Promise<Record<string, string>> {
    return this.#artifacts.readCatalog(this.#artifacts.publicRoot);
  }

  slotSpecs(): InstanceSpec[] {
    return this.supervisor.listSpecs();
  }

  async listAccounts(options: { avatars?: boolean } = {}): Promise<AccountSummary[]> {
    const entries = new Map<string, { accountId: string; dir: string; slots: Set<string> }>();
    const add = (accountId: string, dir: string): { slots: Set<string> } => {
      const existing = entries.get(accountId);
      if (existing) {
        existing.dir = dir;
        return existing;
      }
      const entry = { accountId, dir, slots: new Set<string>() };
      entries.set(accountId, entry);
      return entry;
    };
    for (const status of this.supervisor.list()) {
      const instance = this.supervisor.get(status.id);
      if (!instance) continue;
      for (const accountId of new Set(
        [instance.accountId, instance.spec.accountId].filter((value): value is string => Boolean(value))
      )) {
        add(accountId, this.#accountDir(instance.spec, accountId)).slots.add(instance.id);
      }
    }
    const accountsRoot = path.join(this.#dataRoot, 'accounts');
    for (const name of await safeReaddir(accountsRoot)) {
      if (name.startsWith('.')) continue;
      const dir = path.join(accountsRoot, name);
      try {
        if (!(await fs.stat(dir)).isDirectory()) continue;
      } catch {
        continue;
      }
      add(name, dir);
    }

    const result: AccountSummary[] = [];
    const localAvatars = new Map<string, string>();
    for (const entry of entries.values()) {
      let profile: AccountProfileFile | undefined;
      let error: string | undefined;
      try {
        profile = await this.#profiles.load(entry.dir);
      } catch (loadError) {
        error = loadError instanceof Error ? loadError.message : String(loadError);
      }
      let summary: AccountSummary['profile'];
      try {
        summary = summarizeProfile(await this.#profiles.resolve(entry.dir, entry.accountId));
      } catch (resolveError) {
        error = resolveError instanceof Error ? resolveError.message : String(resolveError);
      }
      if (options.avatars) {
        const display = await loadAccountDisplay(entry.dir).catch(() => undefined);
        if (display?.avatarDataUrl) localAvatars.set(entry.accountId, display.avatarDataUrl);
      }
      result.push({
        accountId: entry.accountId,
        dir: entry.dir,
        state: error ? 'invalid' : 'ready',
        ...(profile ? { file: profile } : {}),
        ...(summary ? { profile: summary } : {}),
        ...(error ? { error } : {}),
        slots: [...entry.slots]
      });
    }
    const finalized = options.avatars
      ? await Promise.all(result.map(async (account) => {
          const avatar = await this.#resolveAccountAvatar(account.accountId, localAvatars.get(account.accountId));
          return avatar ? { ...account, avatarDataUrl: avatar.dataUrl, avatarSource: avatar.source } : account;
        }))
      : result;
    return finalized.sort((left, right) => left.accountId.localeCompare(right.accountId));
  }

  async readMessages(
    accountId: string,
    conversation: ConversationRef,
    options?: ReadOptions
  ): Promise<StoredMessage[]> {
    const { dir, instance } = this.#locateAccount(accountId);
    const store = this.#storeFor(instance?.spec, accountId, dir);
    return store.read({ ...conversation, accountId }, options);
  }

  credentialStore(): { kind: string; available: boolean } {
    return { kind: this.#credentialVault.kind, available: this.#credentialVault.available };
  }

  async listProviders(): Promise<ProviderDto[]> {
    const config = this.configV2.snapshot();
    const result: ProviderDto[] = [];
    for (const provider of config.providers) {
      result.push(redactProvider(provider, await this.providers.credentialConfigured(provider.id)));
    }
    return result;
  }

  async upsertProvider(raw: unknown, secret?: string, setting?: { capability: string; modelId: string }): Promise<ProviderDto> {
    const parsed = parseProvider(raw);
    const previous = this.configV2.provider(parsed.id);
    const ref = parsed.credentialRef ?? (secret ? defaultCredentialRef(parsed.id) : undefined);
    const next: ProviderConfig = ref ? { ...parsed, credentialRef: ref } : parsed;
    let previousSecret: string | undefined;
    if (secret !== undefined && secret !== '') {
      if (!this.#credentialVault.available) throw new CredentialVaultUnavailableError();
      if (ref) previousSecret = await this.#credentialVault.get(ref);
      await this.#credentialVault.set(ref!, secret);
    }
    try {
      await this.configV2.upsertProvider(next, setting);
    } catch (error) {
      if (secret !== undefined && ref) {
        if (previousSecret !== undefined) await this.#credentialVault.set(ref, previousSecret).catch(() => {});
        else if (previous?.credentialRef !== ref) await this.#credentialVault.delete(ref).catch(() => {});
      }
      throw error;
    }
    this.#emitProviderChanged(parsed.id, 'upsert');
    await this.#reloadAgents();
    return redactProvider(this.configV2.provider(parsed.id) ?? next, await this.providers.credentialConfigured(parsed.id));
  }

  async deleteProvider(id: string): Promise<{ removed: boolean; affectedAccounts: string[] }> {
    const provider = this.configV2.provider(id);
    const result = await this.configV2.removeProvider(id);
    if (result.removed) {
      if (provider?.credentialRef) {
        const stillReferenced = this.configV2
          .snapshot()
          .providers.some((entry) => entry.id !== id && entry.credentialRef === provider.credentialRef);
        if (!stillReferenced) await this.#credentialVault.delete(provider.credentialRef).catch(() => {});
      }
      this.#emitProviderChanged(id, 'remove');
      await this.#reloadAgents();
      for (const accountId of result.affectedAccounts) await this.#cancelRevokedJobs(accountId);
    }
    return result;
  }

  async setProviderCredential(id: string, secret: string): Promise<ProviderDto> {
    const provider = this.configV2.provider(id);
    if (!provider) throw new InvalidSpecError(`unknown provider: ${id}`);
    if (!this.#credentialVault.available) throw new CredentialVaultUnavailableError();
    let ref = provider.credentialRef;
    if (!ref) {
      ref = defaultCredentialRef(id);
      await this.configV2.upsertProvider({ ...provider, credentialRef: ref });
      this.#emitProviderChanged(id, 'upsert');
    }
    try {
      await this.#credentialVault.set(ref, secret);
    } catch (error) {
      if (!provider.credentialRef) {
        await this.configV2.upsertProvider(provider).catch(() => {});
      }
      throw error;
    }
    this.#emitProviderChanged(id, 'credential');
    const current = this.configV2.provider(id) ?? provider;
    return redactProvider(current, true);
  }

  async deleteProviderCredential(id: string): Promise<ProviderDto> {
    const provider = this.configV2.provider(id);
    if (!provider) throw new InvalidSpecError(`unknown provider: ${id}`);
    if (provider.credentialRef) await this.#credentialVault.delete(provider.credentialRef).catch(() => {});
    this.#emitProviderChanged(id, 'credential');
    return redactProvider(provider, false);
  }

  testProvider(
    id: string,
    capability: CapabilityId,
    modelId?: string,
    confirmCost = false
  ): Promise<ProviderTestResult> {
    return this.providers.testProvider(id, capability, modelId, confirmCost);
  }

  configureSimpleModel(raw: unknown): Promise<ProviderDto> {
    const save = this.#modelSetupChain.then(() => {
      if (this.#stopped) throw new AccompanyError('core_stopped', 'core has stopped');
      return this.#configureSimpleModel(raw);
    });
    this.#modelSetupChain = save.then(() => undefined, () => undefined);
    return save;
  }

  async #configureSimpleModel(raw: unknown): Promise<ProviderDto> {
    const input = parseModelSetup(raw);
    const existing = input.providerId ? this.configV2.provider(input.providerId) : undefined;
    const provider = buildSimpleProvider(input, existing);
    if (!this.providers.adapterSupports(provider.adapterId, input.capability)) {
      throw new AccompanyError(
        'provider_adapter_unsupported',
        `adapter ${provider.adapterId} does not support ${input.capability}`
      );
    }
    if (input.secret && existing?.credentialRef && this.configV2.snapshot().providers.some((item) => item.id !== existing.id && item.credentialRef === existing.credentialRef)) {
      provider.credentialRef = `provider/${provider.id}/${crypto.randomBytes(4).toString('hex')}`;
    }
    return this.upsertProvider(provider, input.secret, { capability: input.capability, modelId: input.modelId });
  }

  async #setupCredential(provider: ProviderConfig, secret?: string): Promise<string | undefined> {
    if (secret) return secret;
    if (!provider.credentialRef) return undefined;
    if (!this.#credentialVault.available) throw new CredentialVaultUnavailableError();
    return this.#credentialVault.get(provider.credentialRef);
  }

  async discoverModels(raw: unknown): Promise<string[]> {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const input = parseModelSetup({ ...value, capability: 'chat', modelId: 'discovery' });
    const existing = input.providerId ? this.configV2.provider(input.providerId) : undefined;
    const provider = buildSimpleProvider(input, existing);
    return discoverProviderModels(provider, await this.#setupCredential(provider, input.secret));
  }

  async validateSimpleModel(raw: unknown): Promise<ProviderTestResult> {
    const input = parseModelSetup(raw);
    const existing = input.providerId ? this.configV2.provider(input.providerId) : undefined;
    const provider = buildSimpleProvider(input, existing);
    const startedAt = Date.now();
    const credential = await this.#setupCredential(provider, input.secret);
    const redact = (text: string) => sanitizeErrorText(credential ? text.split(credential).join('[已隐藏]') : text);
    try {
      const result = await this.providers.testDraft(provider, input.capability, input.modelId, credential, input.confirmCost);
      return { ...result, ...(result.detail ? { detail: redact(result.detail) } : {}), capability: input.capability, modelId: input.modelId, durationMs: Date.now() - startedAt };
    } catch (error) {
      throw new AccompanyError(error instanceof AccompanyError ? error.code : 'provider_validation_failed', redact(error instanceof Error ? error.message : '模型验证失败'));
    }
  }

  testAccountCapability(accountId: string, capability: CapabilityId, confirmCost = false): Promise<ProviderTestResult> {
    const id = assertIdentifier(accountId, 'accountId');
    return this.providers.testAccountCapability(id, capability, confirmCost);
  }

  getAccountPolicy(accountId: string): AccountPolicy {
    const id = assertIdentifier(accountId, 'accountId');
    return this.configV2.accountPolicy(id) ?? defaultAccountPolicy();
  }

  async setAccountPolicy(accountId: string, raw: unknown): Promise<AccountPolicy> {
    const id = assertIdentifier(accountId, 'accountId');
    const policy = await this.configV2.setAccountPolicy(id, raw);
    this.#emitPolicyChanged(id);
    await this.#reloadAgents(id);
    await this.#cancelRevokedJobs(id);
    return policy;
  }

  async patchAgentEnabled(
    accountId: string,
    enabled: boolean,
    scope?: { kind?: ChatKind; peerId?: string }
  ): Promise<AccountPolicy> {
    const id = assertIdentifier(accountId, 'accountId');
    const current = this.getAccountPolicy(id);
    return this.setAccountPolicy(id, patchAgentEnabled(current, enabled, scope));
  }

  async patchCapabilityEnabled(
    accountId: string,
    capability: CapabilityId,
    enabled: boolean,
    scope?: { kind?: ChatKind; peerId?: string }
  ): Promise<AccountPolicy> {
    const id = assertIdentifier(accountId, 'accountId');
    const current = this.getAccountPolicy(id);
    return this.setAccountPolicy(id, patchCapability(current, capability, enabled, scope));
  }

  effectiveCapabilities(accountId: string, conversation: ConversationRef): Promise<EffectiveCapabilitiesDto> {
    const id = assertIdentifier(accountId, 'accountId');
    if (conversation.accountId !== id) {
      throw new IsolationError('conversation account does not match the requested capability scope');
    }
    return this.providers.effective(id, conversation);
  }

  listJobs(accountId?: string): Promise<JobDto[]> {
    if (accountId) return this.jobs.list(assertIdentifier(accountId, 'accountId'));
    return this.#knownAccountIds().then((ids) => this.jobs.listAll(ids));
  }

  getJob(accountId: string, jobId: string): Promise<JobDto | undefined> {
    return this.jobs.get(assertIdentifier(accountId, 'accountId'), jobId);
  }

  cancelJob(accountId: string, jobId: string): Promise<JobDto> {
    return this.jobs.cancel(assertIdentifier(accountId, 'accountId'), jobId);
  }

  listMedia(accountId: string): Promise<MediaRef[]> {
    return this.media.list(assertIdentifier(accountId, 'accountId'));
  }

  readMedia(accountId: string, mediaId: string): Promise<MediaData> {
    return this.media.read(assertIdentifier(accountId, 'accountId'), mediaId);
  }

  deleteMedia(accountId: string, mediaId: string): Promise<boolean> {
    return this.media.delete(assertIdentifier(accountId, 'accountId'), mediaId);
  }

  injectionSettings(): InjectionSettings {
    return this.#injectionSettings.get();
  }

  async setInjectionSettings(raw: unknown, secret?: string): Promise<{ settings: InjectionSettings; status: SnowLumaRuntimeStatus }> {
    const previous = this.#injectionSettings.get();
    if (this.#processSlots.size && raw && typeof raw === 'object') {
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
  }

  async clearInjectionPassword(): Promise<{ status: SnowLumaRuntimeStatus }> {
    await this.#credentialVault.delete(SNOWLUMA_MANAGEMENT_CREDENTIAL_REF).catch(() => {});
    this.snowLuma.configure(this.#injectionSettings.get());
    return { status: await this.snowLuma.status() };
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

  async retrySnowLumaRuntime(): Promise<SnowLumaRuntimeStatus> {
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
  }

  async resumeInjectionListening() {
    await this.#restoreListeningSlots();
    return this.#manualInjection.resume();
  }

  injectionProcesses(options: { avatars?: boolean } = {}): Promise<SnowLumaProcess[]> {
    const scan = this.#processScan ?? (this.#processScan = this.#scanProcesses());
    if (!options.avatars) return scan;
    return scan.then((processes) => Promise.all(processes.map(async (process) => {
      if (process.avatarDataUrl) return process;
      const accountId = process.uin ?? process.accountHint?.uin;
      if (!accountId) return process;
      const avatar = await this.#resolveAccountAvatar(accountId);
      return avatar ? { ...process, avatarDataUrl: avatar.dataUrl } : process;
    })));
  }

  #scanProcesses(): Promise<SnowLumaProcess[]> {
    const scanEpoch = this.#processMappingEpoch;
    const scan = this.snowLuma.listProcesses({ probeIdentity: true }).then(async (processes) => {
      await this.#withDynamicLock(async () => {
        if (this.#stopped) return;
        for (const [pid, record] of this.#processSlots) {
          // 旧快照不能用来否定刚建立的映射，否则换号重连时可能误删新监听。
          if (record.mappedEpoch > scanEpoch) continue;
          const proc = processes.find((item) => item.pid === pid);
          const changed = proc?.uin && proc.uin !== record.accountId;
          const disconnected = proc && !proc.injected && !proc.connected;
          record.missing = proc && !changed && !disconnected ? 0 : record.missing + 1;
          if (changed || record.missing >= 2) {
            if (this.#dynamicSlots.has(record.slotId)) await this.removeSlot(record.slotId);
            else await this.supervisor.stop(record.slotId);
            this.#processSlots.delete(pid);
          }
        }
      });
      return Promise.all(processes.map(async (proc) => {
        const instanceId = this.#processSlots.get(proc.pid)?.slotId;
        const accountId = proc.uin ?? proc.accountHint?.uin;
        const display = accountId ? await loadAccountDisplay(path.join(this.#dataRoot, 'accounts', accountId)).catch(() => undefined) : undefined;
        const connectedAccount = instanceId ? this.supervisor.get(instanceId)?.status() : undefined;
        const nickname = connectedAccount && connectedAccount.accountId === accountId ? connectedAccount.accountNickname ?? proc.nickname : proc.nickname;
        return { ...proc, ...(instanceId ? { instanceId } : {}),
          ...(nickname ? { nickname } : {}),
          ...(display?.nickname ? { displayName: display.nickname } : {}),
          ...(display?.avatarDataUrl ? { avatarDataUrl: display.avatarDataUrl } : {}) };
      }));
    }).finally(() => { if (this.#processScan === scan) this.#processScan = undefined; });
    return scan;
  }

  injectAndListen(raw: unknown) {
    return this.#manualInjection.injectAndListen(raw);
  }

  listenInjection(raw: unknown) {
    return this.#manualInjection.listen(raw);
  }

  refreshInjection(raw: unknown) {
    return this.#manualInjection.refresh(raw);
  }

  unloadInjection(raw: unknown) {
    return this.#manualInjection.unload(raw);
  }

  injectionOperation(id: string) {
    return this.#manualInjection.operation(id);
  }

  async cleanupMedia(): Promise<{ deleted: number; skippedInUse: number; failed: number }> {
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
  }

  async getAccountProfile(accountId: string): Promise<AccountProfileFile | undefined> {
    return this.#profiles.load(this.#locateAccount(accountId).dir);
  }

  async getAccountDisplay(accountId: string): Promise<AccountDisplayProfile> {
    return loadAccountDisplay(this.#locateAccount(accountId).dir);
  }

  async saveAccountDisplay(accountId: string, raw: unknown): Promise<AccountDisplayProfile> {
    return saveAccountDisplay(this.#locateAccount(accountId).dir, raw);
  }

  async listConversationRoleBindings(
    accountId: string
  ): Promise<Array<ConversationRoleBinding & { state: 'ready' | 'missing'; cardName?: string; resolvedRevision?: string }>> {
    assertIdentifier(accountId, 'accountId');
    const { dir } = this.#locateAccount(accountId);
    const bindings = await this.#roleBindings.list(dir, accountId);
    return Promise.all(
      bindings.map(async (binding) => {
        const card = await this.#artifacts.resolve('role-card', binding.roleCard, dir);
        return {
          ...binding,
          state: card?.manifest.content ? 'ready' as const : 'missing' as const,
          ...(card?.manifest.name ? { cardName: card.manifest.name } : {}),
          ...(card?.ref.revision ? { resolvedRevision: card.ref.revision } : {})
        };
      })
    );
  }

  async listAccountArtifacts(accountId: string): Promise<ResolvedArtifact[]> {
    const { dir } = this.#locateAccount(accountId);
    const store = new LocalArtifactStore(dir, this.#logger.child(`account:${accountId}:artifacts`));
    return (await store.listPublic()).map((artifact) => ({
      ...artifact,
      ref: { ...artifact.ref, source: 'private' as const }
    }));
  }

  async setConversationRoleBinding(
    conversation: ConversationRef,
    roleCard: { source: 'public' | 'private'; id: string; revision?: string } | null
  ): Promise<ConversationRoleBinding | undefined> {
    assertIdentifier(conversation.accountId, 'accountId');
    const normalized = {
      ...conversation,
      accountId: conversation.accountId
    };
    const { dir } = this.#locateAccount(normalized.accountId);
    if (roleCard) {
      const card = await this.#artifacts.resolve('role-card', roleCard, dir);
      if (!card?.manifest.content) {
        throw new InvalidSpecError(`role card ${roleCard.source}:${roleCard.id} cannot be resolved`);
      }
    }
    return this.#roleBindings.set(dir, normalized, roleCard, this.#now());
  }

  async resolveConversationRoleBinding(
    accountId: string,
    conversation: ConversationRef
  ): Promise<ResolvedConversationRoleBinding | undefined> {
    if (conversation.accountId !== accountId) throw new IsolationError('role binding account does not match conversation');
    const { dir } = this.#locateAccount(accountId);
    const binding = await this.#roleBindings.get(dir, conversation);
    if (!binding) return undefined;
    const artifact = await this.#artifacts.resolve('role-card', binding.roleCard, dir);
    if (!artifact?.manifest.content) return undefined;
    const artifactBaseDir = binding.roleCard.source === 'public' ? this.#artifacts.publicRoot : dir;
    const catalogEpoch = binding.roleCard.revision
      ? 0
      : await this.#artifacts.catalogEpoch(artifactBaseDir, 'role-card', binding.roleCard.id);
    return {
      ...binding,
      // Follow-current bindings change context on every catalog transition, even A→B→A.
      // The generation is persisted with the catalog so an unchanged restart retains history.
      revision: `${binding.revision}:${artifact.ref.source}:${artifact.ref.id}:${artifact.ref.revision}:${catalogEpoch}`,
      card: { ...artifact, content: artifact.manifest.content }
    };
  }

  async saveAccountProfile(
    accountId: string,
    raw: unknown
  ): Promise<{ profile: AccountProfileFile; reload?: { ok: boolean; error?: string } }> {
    const { dir, instance } = this.#locateAccount(accountId);
    const profile = await this.#profiles.save(dir, raw);
    if (!instance || !instance.state.is('online', 'degraded', 'awaiting_profile')) return { profile };
    try {
      await instance.reloadProfile();
      return { profile, reload: { ok: true } };
    } catch (error) {
      return {
        profile,
        reload: { ok: false, error: error instanceof Error ? error.message : String(error) }
      };
    }
  }

  async reloadAccount(accountId: string): Promise<Array<{ instanceId: string; ok: boolean; error?: string }>> {
    const results: Array<{ instanceId: string; ok: boolean; error?: string }> = [];
    for (const status of this.supervisor.list()) {
      const instance = this.supervisor.get(status.id);
      if (!instance || instance.accountId !== accountId) continue;
      if (!instance.state.is('online', 'degraded', 'awaiting_profile')) continue;
      try {
        await instance.reloadProfile();
        results.push({ instanceId: instance.id, ok: true });
      } catch (error) {
        results.push({
          instanceId: instance.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return results;
  }

  async deployArtifact(kind: ArtifactKind, id: string, revision: string): Promise<DeploymentRecord> {
    if (this.#stopped) throw new AccompanyError('core_stopped', 'core has been stopped');
    return this.#runDeployment(async () => {
      const catalog = await this.#artifacts.readCatalog(this.#artifacts.publicRoot);
      const from = catalog[artifactRefKey(kind, id)];
      const { current } = await this.#artifacts.setPublicRevision(kind, id, revision);
      const record = await this.#deployer.reloadAll('deploy', {
        kind,
        id,
        ...(from ? { from } : {}),
        to: current
      });
      this.#recordDeployment(record);
      return record;
    });
  }

  async rollbackArtifacts(): Promise<DeploymentRecord> {
    if (this.#stopped) throw new AccompanyError('core_stopped', 'core has been stopped');
    return this.#runDeployment(async () => {
      const { restored, replaced } = await this.#artifacts.rollbackPublic();
      const record = await this.#deployer.reloadAll('rollback', { restored, replaced });
      this.#recordDeployment(record);
      return record;
    });
  }

  deployments(): DeploymentRecord[] {
    return [...this.#deployments];
  }

  async addSlot(spec: InstanceSpec): Promise<InstanceStatus> {
    const instance = this.supervisor.add(spec);
    this.metrics.set('instances.total', this.supervisor.list().length);
    try {
      await this.#persistSlots();
    } catch (error) {
      await this.supervisor.remove(instance.id);
      this.metrics.set('instances.total', this.supervisor.list().length);
      throw error;
    }
    if (this.#started) await this.supervisor.start(instance.id);
    return instance.status();
  }

  async removeSlot(id: string): Promise<void> {
    const instance = this.supervisor.get(id);
    if (!instance) throw new InvalidSpecError(`unknown slot: ${id}`);
    await this.supervisor.stop(id);
    await this.supervisor.remove(id);
    this.#dynamicSlots.delete(id);
    for (const [pid, record] of this.#processSlots) if (record.slotId === id) this.#processSlots.delete(pid);
    const lease = this.#runtimeLeases.get(id);
    this.#runtimeLeases.delete(id);
    await lease?.release();
    await this.#forgetListening(id);
    this.metrics.set('instances.total', this.supervisor.list().length);
    await this.#persistSlots();
  }

  /** 手动注入确认 QQ 号后，把未绑定的槽位重绑到该账号；必须停在槽位后再换号。 */
  async #rebindSlotAccount(id: string, accountId: string): Promise<void> {
    const instance = this.supervisor.get(id);
    if (!instance) throw new InvalidSpecError(`unknown slot: ${id}`);
    const spec = structuredClone(instance.spec);
    if (spec.accountId === accountId) return;
    if (spec.accountId) {
      throw new AccompanyError('injection_slot_bound', `slot ${id} is already bound to ${spec.accountId}`);
    }
    if (!instance.state.is('stopped')) await this.supervisor.stop(id);
    if (!instance.state.is('stopped')) {
      throw new AccompanyError('injection_slot_busy', `slot ${id} did not stop before account binding`);
    }
    const lease = this.#runtimeLeases.get(id);
    this.#runtimeLeases.delete(id);
    await lease?.release();
    await this.supervisor.remove(id);
    try {
      this.supervisor.add({ ...spec, accountId });
      await this.#persistSlots();
    } catch (error) {
      await this.supervisor.remove(id).catch(() => {});
      try {
        this.supervisor.add(spec);
        await this.#persistSlots();
      } catch {
        // 恢复失败时保留原始错误，槽位缺失会在下一次持久化或重启时暴露。
      }
      throw error;
    }
    this.metrics.set('instances.total', this.supervisor.list().length);
    this.#logger.info('slot bound to injected account', { instanceId: id, accountId });
  }

  async #persistSlots(): Promise<void> {
    if (!this.#slotStore) return;
    await this.#slotStore.save(this.supervisor.listSpecs().filter((spec) => !this.#dynamicSlots.has(spec.id)));
  }

  #withDynamicLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#dynamicChain.then(task, task);
    this.#dynamicChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 用上次监听记录重建动态槽位；只恢复待恢复状态，不启动、不注入。 */
  async #restoreListeningSlots(): Promise<void> {
    if (!this.#options.manualStartOnly) return;
    const runtimeDir = this.#injectionSettings.get().runtimeDir;
    if (!runtimeDir) return;
    const resolved = path.resolve(runtimeDir);
    const specs = this.supervisor.listSpecs();
    let added = 0;
    for (const record of this.#listening.list()) {
      if (path.resolve(record.runtimeDir) !== resolved) continue;
      if (this.supervisor.get(record.slotId)) continue;
      const bound = specs.some((spec) =>
        spec.backend === 'snowluma'
        && spec.accountId === record.accountId
        && spec.runtimeDir !== undefined
        && path.resolve(spec.runtimeDir) === resolved
      );
      if (bound) continue;
      const spec: InstanceSpec = {
        id: record.slotId,
        backend: 'snowluma',
        runtimeDir,
        accountId: record.accountId,
        restart: { enabled: false }
      };
      try {
        this.supervisor.add(spec);
        this.#dynamicSlots.add(record.slotId);
        specs.push(spec);
        added += 1;
      } catch (error) {
        this.#logger.warn('restore listening slot failed', {
          slotId: record.slotId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (added > 0) {
      this.metrics.set('instances.total', this.supervisor.list().length);
      this.#logger.info('listening slots restored', { count: added });
    }
  }

  /** 所有账号头像展示共用：本地展示头像优先，缺失时回退到 QQ 公开头像。 */
  async #resolveAccountAvatar(
    accountId: string,
    localAvatarDataUrl?: string
  ): Promise<{ dataUrl: string; source: 'local' | 'qq' } | undefined> {
    if (localAvatarDataUrl) return { dataUrl: localAvatarDataUrl, source: 'local' };
    const dataUrl = await this.#qqAvatars.get(accountId);
    return dataUrl ? { dataUrl, source: 'qq' } : undefined;
  }

  async #rememberListening(slotId: string, accountId: string): Promise<void> {
    const spec = this.supervisor.get(slotId)?.spec;
    if (!spec?.runtimeDir) return;
    try {
      await this.#listening.remember({ slotId, accountId, runtimeDir: path.resolve(spec.runtimeDir) });
    } catch (error) {
      this.#logger.warn('remember listening failed', {
        slotId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #forgetListening(slotId: string): Promise<void> {
    try {
      await this.#listening.forget(slotId);
    } catch (error) {
      this.#logger.warn('forget listening failed', {
        slotId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  #trackProcess(pid: number, slotId: string, accountId: string): void {
    this.#processMappingEpoch += 1;
    this.#processSlots.set(pid, { slotId, accountId, missing: 0, mappedEpoch: this.#processMappingEpoch });
  }

  #ensureDynamicSlot(accountId: string, pid: number): Promise<string> {
    return this.#withDynamicLock(async () => {
      if (this.#stopped) throw new AccompanyError('core_stopped', 'core has stopped');
      assertIdentifier(accountId, 'accountId');
      const runtimeDir = this.#injectionSettings.get().runtimeDir;
      if (!runtimeDir) throw new AccompanyError('snowluma_runtime_unavailable', 'configure the SnowLuma runtime directory first');
      const previous = this.#processSlots.get(pid);
      if (previous && previous.accountId !== accountId) {
        if (this.#dynamicSlots.has(previous.slotId)) {
          if (this.supervisor.get(previous.slotId)) await this.removeSlot(previous.slotId);
        } else if (this.supervisor.get(previous.slotId)) {
          await this.supervisor.stop(previous.slotId);
        }
        this.#processSlots.delete(pid);
      }
      for (const [otherPid, record] of this.#processSlots) {
        if (record.accountId === accountId && otherPid !== pid) throw new AccompanyError('injection_account_in_use', `QQ ${accountId} is already listening through another process`);
      }
      const existing = this.supervisor.listSpecs().find((spec) => spec.backend === 'snowluma' && spec.accountId === accountId && path.resolve(spec.runtimeDir ?? '') === path.resolve(runtimeDir));
      if (existing) {
        this.#trackProcess(pid, existing.id, accountId);
        return existing.id;
      }
      const base = `qq-${accountId}`;
      let id = base;
      while (this.supervisor.get(id)) id = `${base}-${crypto.randomBytes(3).toString('hex')}`;
      const spec: InstanceSpec = { id, backend: 'snowluma', runtimeDir, accountId, restart: { enabled: false } };
      this.#dynamicSlots.add(id);
      try { this.supervisor.add(spec); }
      catch (error) { this.#dynamicSlots.delete(id); throw error; }
      this.metrics.set('instances.total', this.supervisor.list().length);
      this.#trackProcess(pid, id, accountId);
      return id;
    });
  }

  instanceDataDir(instanceId: string): string {
    return path.join(this.#dataRoot, 'instances', instanceId);
  }

  #locateAccount(accountId: string): { dir: string; instance?: QqInstance } {
    for (const status of this.supervisor.list()) {
      const instance = this.supervisor.get(status.id);
      if (!instance) continue;
      if (instance.accountId === accountId || instance.spec.accountId === accountId) {
        return { dir: this.#accountDir(instance.spec, accountId), instance };
      }
    }
    return { dir: this.#accountDir(undefined, accountId) };
  }

  #emitProviderChanged(providerId: string, action: 'upsert' | 'remove' | 'credential'): void {
    this.bus.emit('provider:changed', { providerId, action, at: this.#now() });
  }

  #emitPolicyChanged(accountId?: string): void {
    this.bus.emit('policy:changed', {
      ...(accountId ? { accountId } : {}),
      at: this.#now()
    });
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
      const mode = this.policy.replyModeFor(bound, profile.plugins.length > 0);
      // 只有当前宿主已经是插件模式时才无需替换；agent → plugins 或暂停态变化必须重新装载，
      // 后者同时推进 hostEpoch，让暂停前在途插件的旧状态写入失效。
      const currentHostMode = instance.status().agent?.mode;
      const paused = this.policy.resolveAccount(bound).agentEnabled === false;
      if (mode === 'plugins' && profile.plugins.length > 0 && currentHostMode === 'plugins' && !paused) continue;
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

  #recordDeployment(record: DeploymentRecord): void {
    this.#deployments.push(record);
    if (this.#deployments.length > 20) this.#deployments.shift();
    this.metrics.inc('deployments.total');
    if (!record.ok) this.metrics.inc('deployments.partial');
  }

  #runDeployment<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#deployChain.catch(() => {}).then(task);
    this.#deployChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
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
      resolveProfile: (accountId) => this.#profiles.resolve(this.#accountDir(spec, accountId), accountId),
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
      releaseAccount: (accountId) => this.#accountLeases.release(accountId, spec.id),
      automaticReplyAllowed: (accountId, conversation) =>
        this.policy.resolve(accountId, conversation).agentEnabled,
      resolveConversationRole: (accountId, conversation) => this.resolveConversationRoleBinding(accountId, conversation),
      configResolver: (scope) => this.config.resolve(scope),
      ...(this.#options.host ? { host: this.#options.host } : {}),
      ...(this.#options.now ? { now: this.#options.now } : {}),
      ...(this.#options.recordId ? { recordId: this.#options.recordId } : {})
    });
  }

  async #createDefaultHost(input: AgentHostFactoryInput): Promise<AgentHost | undefined> {
    const hasPlugins = input.profile.plugins.length > 0;
    const mode = this.policy.replyModeFor(input.accountId, hasPlugins);
    if (mode === 'plugins' && hasPlugins) {
      return createWorkerHost({
        accountId: input.accountId,
        profile: input.profile,
        logger: input.logger,
        historyLimit: this.#limits.maxHostHistory,
        pluginTimeoutMs: this.#limits.pluginTimeoutMs
      });
    }
    if (!this.policy.hasBindings(input.accountId)) return undefined;
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
      maxHistoryMessages,
      maxHistoryChars: this.#options.agent?.maxHistoryChars ?? 12_000,
      maxObservedMedia: this.#options.agent?.maxObservedMedia ?? 4,
      onTurn: (event) => {
        this.bus.emit('agent:turn', { ...event, at: this.#now() });
      },
      ...(this.#options.now ? { now: this.#options.now } : {})
    });
  }

  #agentStatus(profile: ResolvedProfile): { mode: 'agent' | 'plugins' | 'custom'; configured: boolean } {
    if (this.#options.host || this.#options.hostFactory) return { mode: 'custom', configured: true };
    const hasPlugins = profile.plugins.length > 0;
    const mode = this.policy.replyModeFor(profile.accountId, hasPlugins);
    if (mode === 'plugins') return { mode: 'plugins', configured: hasPlugins };
    return { mode: 'agent', configured: this.policy.hasBindings(profile.accountId) };
  }

  #profileFingerprint(profile: ResolvedProfile): string {
    const policy = this.policy.resolveAccount(profile.accountId);
    const mode = this.policy.replyModeFor(profile.accountId, profile.plugins.length > 0);
    return crypto
      .createHash('sha1')
      .update(
        JSON.stringify({
          revision: profile.revision,
          config: this.configV2.fingerprint,
          mode,
          policy
        })
      )
      .digest('hex')
      .slice(0, 16);
  }

  async #knownAccountIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const status of this.supervisor.list()) {
      const instance = this.supervisor.get(status.id);
      if (!instance) continue;
      if (instance.accountId) ids.add(instance.accountId);
      if (instance.spec.accountId) ids.add(instance.spec.accountId);
    }
    for (const name of await safeReaddir(path.join(this.#dataRoot, 'accounts'))) {
      if (name.startsWith('.')) continue;
      try {
        if ((await fs.stat(path.join(this.#dataRoot, 'accounts', name))).isDirectory()) ids.add(name);
      } catch {
        // 目录可能在枚举时被删除
      }
    }
    return [...ids];
  }

  #accountDirForAccount(accountId: string): string {
    return this.#locateAccount(accountId).dir;
  }

  #now(): number {
    return this.#options.now ? this.#options.now() : Date.now();
  }

  #accountDir(spec: NormalizedInstanceSpec | undefined, accountId: string): string {
    return path.join(
      spec?.dataDir ? path.resolve(spec.dataDir) : this.#dataRoot,
      'accounts',
      safePathSegment(accountId)
    );
  }

  #storeFor(spec: NormalizedInstanceSpec | undefined, accountId: string, dirOverride?: string): MessageStore {
    const accountDir = dirOverride ?? this.#accountDir(spec, accountId);
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
    const key = path.join(this.#accountDir(spec, accountId), 'plugin-state');
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

  #defaultBackend(
    spec: NormalizedInstanceSpec,
    deps: { logger: Logger },
    lookup: () => QqInstance | undefined
  ): InjectionBackend {
    if (spec.backend === 'snowluma') {
      return new SnowLumaBackend({
        runtimeDir: spec.runtimeDir as string,
        allowTokenless: spec.backendOptions?.allowTokenless === true,
        logger: deps.logger
      });
    }
    return new FakeInjectionBackend((spec.backendOptions ?? {}) as FakeBackendOptions, (error) => {
      lookup()?.handleExternalFailure(error);
    });
  }
}

export function createCore(options: CoreOptions): Promise<Core> {
  return Core.create(options);
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
