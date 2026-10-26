import path from 'node:path';
import { LocalArtifactStore } from '../artifacts/local.js';
import { RollingDeployer, type DeployTarget } from '../artifacts/deploy.js';
import { AccountDirectory } from '../profiles/account-directory.js';
import { AccountPresentation } from '../application/accounts/account-presentation.js';
import { AccountService } from '../application/accounts/account-service.js';
import { DeploymentService } from '../application/deployments/deployment-service.js';
import { ModelSettingsService } from '../application/model-settings/model-settings-service.js';
import { QqConnectionService } from '../application/qq-connections/qq-connection-service.js';
import { AccountLeases } from '../instances/account-leases.js';
import { RuntimeRegistry } from '../instances/runtime-registry.js';
import { InstanceSupervisor } from '../instances/supervisor.js';
import type { NormalizedInstanceSpec } from '../instances/spec.js';
import type { QqInstance } from '../instances/instance.js';
import { ExtensionRegistry, SkillRuntime } from '../extensions/registry.js';
import { ExtensionPolicyService } from '../application/extensions/extension-policy-service.js';
import { ExtensionToolService } from '../application/extensions/extension-tool-service.js';
import { PluginRuntimeService } from '../application/extensions/plugin-runtime-service.js';
import { defaultAccountPolicy } from '../providers/types.js';
import { registerBuiltInAgentTools } from '../agent/engine.js';
import { TurnScheduler } from '../agent/scheduler.js';
import { FakeProviderAdapter } from '../providers/adapters/fake.js';
import { OpenAiCompatibleAdapter } from '../providers/adapters/openai.js';
import { VideoPollingAdapter } from '../providers/adapters/video.js';
import { ConfigStore } from '../providers/config-store.js';
import { ProviderRouter } from '../providers/router.js';
import { PolicyService } from '../policy/policy.js';
import { MediaService } from '../media/service.js';
import { MediaJobService } from '../jobs/service.js';
import { FakeInjectionBackend, type FakeBackendOptions } from '../injection/fake.js';
import { SnowLumaBackend } from '../injection/snowluma/backend.js';
import { InjectionSettingsStore } from '../injection/settings.js';
import { QqAvatarCache } from '../injection/qq-avatar.js';
import { SnowLumaManager } from '../injection/snowluma/manager.js';
import { SnowLumaRuntimeController } from '../injection/snowluma/runtime.js';
import { ListeningStore } from '../storage/listening-store.js';
import { SlotStore } from '../storage/slot-store.js';
import { DesiredStateStore } from '../storage/desired-state.js';
import { AccountDisplayStore } from '../profiles/display.js';
import { AccountProfileService } from '../profiles/profile.js';
import { ConversationRoleBindingStore } from '../profiles/role-bindings.js';
import { DataRootLock } from '../core/data-root-lock.js';
import { LayeredConfig } from '../config/layered.js';
import { Metrics } from '../core/metrics.js';
import { EventLog } from '../core/event-log.js';
import { AuditLog } from '../core/audit.js';
import { TypedEventBus } from '../core/bus.js';
import type { CoreEvents } from '../core/events.js';
import { normalizeLimits, type Limits } from '../core/limits.js';
import { createLogger, type Logger } from '../core/logger.js';
import { AccompanyError } from '../core/errors.js';
import type { CoreOptions } from '../core/options.js';
import type { InstanceSpec } from '../instances/spec.js';
import type { InjectionBackend } from '../injection/contract.js';
import {
  UnavailableCredentialVault,
  type CredentialVault
} from '../secrets/vault.js';

export interface RuntimeHooks {
  createInstance(spec: NormalizedInstanceSpec): QqInstance;
  deployTargets(): DeployTarget[];
  reloadAgents(accountId?: string): Promise<void>;
  cancelRevokedJobs(accountId: string): Promise<void>;
  releaseRuntime(id: string): Promise<void>;
  isStopped(): boolean;
}

export interface AssembleRuntimeInput {
  options: CoreOptions;
  logger?: Logger;
  hooks: RuntimeHooks;
}

export interface RuntimeAssembly {
  readonly options: CoreOptions;
  readonly logger: Logger;
  readonly limits: Limits;
  readonly config: LayeredConfig;
  readonly configV2: ConfigStore;
  readonly desiredStore: DesiredStateStore;
  readonly slotStore?: SlotStore;
  readonly listening: ListeningStore;
  readonly injectionSettings: InjectionSettingsStore;
  readonly dataRootLock?: DataRootLock;
  readonly initialSpecs: InstanceSpec[];
  readonly metrics: Metrics;
  readonly eventLog: EventLog;
  readonly auditLog: AuditLog;
  readonly bus: TypedEventBus<CoreEvents>;
  readonly artifacts: LocalArtifactStore;
  readonly profiles: AccountProfileService;
  readonly accountDisplays: AccountDisplayStore;
  readonly accountDirectory: AccountDirectory;
  readonly accountPresentation: AccountPresentation;
  readonly accountService: AccountService;
  readonly roleBindings: ConversationRoleBindingStore;
  readonly credentialVault: CredentialVault;
  readonly snowLuma: SnowLumaManager;
  readonly snowLumaRuntime: SnowLumaRuntimeController;
  readonly qqAvatars: QqAvatarCache;
  readonly extensions: ExtensionRegistry;
  readonly extensionPolicy: ExtensionPolicyService;
  readonly extensionTools: ExtensionToolService;
  readonly pluginRuntimes: PluginRuntimeService;
  readonly policy: PolicyService;
  readonly agentScheduler: TurnScheduler;
  readonly media: MediaService;
  readonly jobs: MediaJobService;
  readonly providers: ProviderRouter;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly supervisor: InstanceSupervisor;
  readonly accountLeases: AccountLeases;
  readonly modelSettings: ModelSettingsService;
  readonly connections: QqConnectionService;
  readonly deploymentService: DeploymentService;
  /** 仅用于构造/装配失败时释放本次已打开的资源；正常关闭由 Core 生命周期负责。 */
  dispose(): Promise<void>;
}

/**
 * 构造运行容器。这里只创建对象、加载持久化状态和注入端口，不启动实例、
 * 不触发 QQ/SnowLuma 操作；不导入 Core 实现，也不调用 Core.create。
 */
export async function assembleRuntime(input: AssembleRuntimeInput): Promise<RuntimeAssembly> {
  const { options, hooks } = input;
  const logger = input.logger ?? options.logger ?? createLogger({ scope: 'nowadays', level: options.logLevel ?? 'info' });
  const dataRoot = path.resolve(options.dataRoot);
  const limits = normalizeLimits(options.limits);
  const now = options.now ?? Date.now;

  let lock: DataRootLock | undefined;
  let configV2: ConfigStore | undefined;
  let desiredStore: DesiredStateStore | undefined;
  let slotStore: SlotStore | undefined;
  let injectionSettings: InjectionSettingsStore | undefined;
  let listening: ListeningStore | undefined;
  let accountDisplays: AccountDisplayStore | undefined;
  let supervisor: InstanceSupervisor | undefined;
  let runtimeRegistry: RuntimeRegistry | undefined;
  try {
    if (options.lockDataRoot !== false) {
      lock = await DataRootLock.acquire(dataRoot, logger.child('lock'));
    }
    const config = await LayeredConfig.load(path.join(dataRoot, 'config.json'), logger.child('config'));
    configV2 = await ConfigStore.load({
      filePath: options.modelConfigFile
        ? path.resolve(options.modelConfigFile)
        : path.join(dataRoot, 'config.v2.json'),
      legacyFile: path.join(dataRoot, 'config.json'),
      logger: logger.child('providers')
    });
    desiredStore = await DesiredStateStore.load(path.join(dataRoot, 'state', 'desired.json'), logger.child('desired'));
    slotStore = options.persistSlots
      ? await SlotStore.load(
          options.slotsFile ? path.resolve(options.slotsFile) : path.join(dataRoot, 'slots.json'),
          logger.child('slots')
        )
      : undefined;
    injectionSettings = await InjectionSettingsStore.load({
      filePath: options.injectionSettingsFile
        ? path.resolve(options.injectionSettingsFile)
        : path.join(dataRoot, 'injection.json'),
      logger: logger.child('injection')
    });
    listening = await ListeningStore.load(path.join(dataRoot, 'state', 'listening.json'), logger.child('listening'));

    const metrics = new Metrics();
    const eventLog = new EventLog();
    const auditLog = new AuditLog();
    const bus = new TypedEventBus<CoreEvents>({
      onHandlerError: (error, info) => {
        logger.error('event handler failed', {
          type: info.type,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
    bus.onAny((type, payload) => {
      const at = payload && typeof payload === 'object' && typeof (payload as { at?: unknown }).at === 'number'
        ? (payload as { at: number }).at
        : Date.now();
      eventLog.append(String(type), payload, at);
    });

    const credentialVault = options.credentialVault ?? new UnavailableCredentialVault();
    const snowLuma = new SnowLumaManager({
      vault: credentialVault,
      logger: logger.child('snowluma'),
      settings: injectionSettings.get(),
      ...(options.snowLumaFetchImpl ? { fetchImpl: options.snowLumaFetchImpl } : {})
    });
    const snowLumaRuntime = new SnowLumaRuntimeController({
      ...options.snowLumaRuntimeOptions,
      manager: snowLuma,
      logger: logger.child('snowluma-runtime')
    });
    const qqAvatars = new QqAvatarCache({
      ...(options.avatarFetchImpl ? { fetchImpl: options.avatarFetchImpl } : {}),
      logger: logger.child('qq-avatar')
    });
    accountDisplays = new AccountDisplayStore();
    const accountPresentation = new AccountPresentation({ displays: accountDisplays, avatars: qqAvatars });
    const artifacts = new LocalArtifactStore(
      options.profiles?.publicRoot ? path.resolve(options.profiles.publicRoot) : path.join(dataRoot, 'public'),
      logger.child('artifacts')
    );
    const profiles = new AccountProfileService(artifacts, logger.child('profiles'));
    const roleBindings = new ConversationRoleBindingStore();

    const extensions = new ExtensionRegistry();
    registerBuiltInAgentTools(extensions);
    const policy = new PolicyService(configV2);
    const agentScheduler = new TurnScheduler({
      maxGlobal: limits.maxChatConcurrency,
      maxPerAccount: limits.maxAccountChatConcurrency,
      maxPending: limits.maxChatPending
    });
    const skills = new SkillRuntime(() => configV2!.snapshot().skills);
    const providers = new ProviderRouter({
      config: configV2,
      policy,
      skills,
      extensions,
      vault: credentialVault,
      adapters: [
        new FakeProviderAdapter(),
        new OpenAiCompatibleAdapter(),
        new VideoPollingAdapter(),
        ...(options.providerAdapters ?? [])
      ],
      logger: logger.child('providers'),
      metrics,
      ...(options.now ? { now: options.now } : {}),
      onUsage: (usage) => {
        bus.emit('provider:usage', {
          accountId: usage.accountId,
          capability: usage.capability,
          providerId: usage.providerId,
          modelId: usage.modelId,
          ok: usage.ok,
          durationMs: usage.durationMs,
          ...(usage.code ? { code: usage.code } : {}),
          at: now()
        });
      }
    });

    const backendFactory = options.backendFactory ?? ((spec: NormalizedInstanceSpec, deps: { logger: Logger }) =>
      defaultBackend(spec, deps, () => supervisor?.get(spec.id)));
    runtimeRegistry = new RuntimeRegistry({
      backendFactory,
      logger: logger.child('runtimes'),
      ...(options.now ? { now: options.now } : {})
    });
    supervisor = new InstanceSupervisor({
      bus,
      logger: logger.child('supervisor'),
      createInstance: (spec) => hooks.createInstance(spec),
      limits,
      metrics,
      desiredStore,
      runtimeRegistry,
      ...(options.now ? { now: options.now } : {})
    });
    const accountLeases = new AccountLeases();
    const accountDirectory = new AccountDirectory({
      dataRoot,
      specs: () => supervisor!.listSpecs()
    });
    const accountService = new AccountService({
      directory: accountDirectory,
      profiles,
      displays: accountDisplays,
      roleBindings,
      artifacts,
      presentation: accountPresentation,
      logger: logger.child('accounts'),
      now: () => now(),
      runtime: {
        snapshots: () => supervisor!.list().flatMap((status) => {
          const instance = supervisor!.get(status.id);
          if (!instance) return [];
          return [{
            instanceId: instance.id,
            ...(instance.accountId ? { accountId: instance.accountId } : {}),
            ...(instance.spec.accountId ? { specAccountId: instance.spec.accountId } : {}),
            ...(instance.spec.dataDir ? { dataDir: instance.spec.dataDir } : {}),
            state: status.state
          }];
        }),
        reload: async (instanceId) => {
          const instance = supervisor!.get(instanceId);
          if (!instance) {
            throw new AccompanyError('account_instance_missing', `instance ${instanceId} is not available`);
          }
          await instance.reloadProfile();
        }
      }
    });

    const media = new MediaService({
      accountDir: (accountId) => accountService.locate(accountId).dir,
      accountIds: () => accountDirectory.listKnown(),
      maxImageBytes: limits.maxImageBytes,
      maxVideoBytes: limits.maxVideoBytes,
      maxDownloadMs: limits.mediaDownloadTimeoutMs,
      retentionDays: () => Math.min(limits.mediaRetentionDays, configV2!.snapshot().media.retentionDays),
      logger: logger.child('media'),
      ...(options.now ? { now: options.now } : {})
    });
    const jobs = new MediaJobService({
      accountDir: (accountId) => path.join(accountService.locate(accountId).dir, 'jobs'),
      accountIds: () => accountDirectory.listKnown(),
      maxConcurrentJobs: limits.maxMediaConcurrentJobs,
      maxAccountConcurrentJobs: limits.maxAccountMediaConcurrentJobs,
      maxPendingJobs: limits.maxMediaJobPending,
      maxPerAccountPending: limits.maxPerAccountMediaJobPending,
      timeoutMs: limits.mediaJobTimeoutMs,
      logger: logger.child('jobs'),
      ...(options.now ? { now: options.now } : {}),
      ...(options.recordId ? { recordId: options.recordId } : {}),
      onUpdate: (job) => {
        bus.emit('job:update', {
          accountId: job.accountId,
          jobId: job.id,
          state: job.state,
          capability: job.capability,
          delivery: job.delivery,
          at: now()
        });
      }
    });

    const accountDirOf = (accountId: string) => accountService.locate(accountId).dir;
    const pluginRuntimes = new PluginRuntimeService({
      accountDir: accountDirOf,
      profiles: (accountId) => profiles.resolve(accountDirOf(accountId), accountId),
      accountPolicy: (accountId) => configV2!.snapshot().accountPolicies[accountId] ?? defaultAccountPolicy(),
      logger: logger.child('plugin-runtime')
    });
    const extensionPolicy = new ExtensionPolicyService({
      config: configV2,
      registry: extensions,
      profiles: (accountId) => profiles.resolve(accountDirOf(accountId), accountId),
      readyPlugins: (accountId) => pluginRuntimes.readyPlugins(accountId),
      readyTools: (accountId) => pluginRuntimes.readyTools(accountId)
    });
    const extensionTools = new ExtensionToolService({
      policy: extensionPolicy,
      accountDir: accountDirOf,
      logger: logger.child('tools'),
      capabilityEnabled: (accountId, conversation) => (capability) =>
        providers.resolve(accountId, conversation, capability).enabled,
      runtime: (accountId) => pluginRuntimes.port(accountId),
      ...(options.now ? { now: options.now } : {})
    });

    const modelSettings = new ModelSettingsService({
      config: configV2,
      providers,
      vault: credentialVault,
      host: {
        stopped: () => hooks.isStopped(),
        providerChanged: (providerId, action) => {
          bus.emit('provider:changed', { providerId, action, at: now() });
        },
        policyChanged: (accountId) => {
          bus.emit('policy:changed', { ...(accountId ? { accountId } : {}), at: now() });
        },
        reloadAgents: (accountId) => hooks.reloadAgents(accountId),
        cancelRevokedJobs: (accountId) => hooks.cancelRevokedJobs(accountId)
      }
    });

    const deploymentService = new DeploymentService({
      artifacts,
      deployer: new RollingDeployer({
        listTargets: () => hooks.deployTargets(),
        logger: logger.child('deploy'),
        ...(options.now ? { now: options.now } : {})
      }),
      host: {
        stopped: () => hooks.isStopped(),
        recorded: (record) => {
          metrics.inc('deployments.total');
          if (!record.ok) metrics.inc('deployments.partial');
        }
      }
    });

    const connections = new QqConnectionService({
      manager: snowLuma,
      logger: logger.child('qq-connections'),
      listening,
      directory: accountDirectory,
      presentation: accountPresentation,
      manualStartOnly: options.manualStartOnly === true,
      ...(options.injectionPollIntervalMs !== undefined ? { pollIntervalMs: options.injectionPollIntervalMs } : {}),
      ...(options.now ? { now: options.now } : {}),
      host: {
        specs: () => supervisor!.listSpecs(),
        spec: (id) => supervisor!.get(id)?.spec,
        status: (id) => supervisor!.get(id)?.status(),
        add: (spec) => { supervisor!.add(spec); },
        start: (id) => supervisor!.start(id),
        stop: (id) => supervisor!.stop(id),
        remove: (id) => supervisor!.remove(id),
        releaseRuntime: (id) => hooks.releaseRuntime(id),
        saveSlots: async (specs) => {
          if (slotStore) await slotStore.save(specs);
        },
        syncCount: () => { metrics.set('instances.total', supervisor!.list().length); },
        accountOwner: (accountId) => accountLeases.ownerOf(accountId),
        isStopped: () => hooks.isStopped(),
        runtimeDir: () => injectionSettings!.get().runtimeDir
      }
    });

    const initialSpecs = slotStore?.loaded ? slotStore.list() : options.instances;
    let disposed = false;
    return {
      options,
      logger,
      limits,
      config,
      configV2,
      desiredStore,
      slotStore,
      listening,
      injectionSettings,
      ...(lock ? { dataRootLock: lock } : {}),
      initialSpecs,
      metrics,
      eventLog,
      auditLog,
      bus,
      artifacts,
      profiles,
      accountDisplays,
      accountDirectory,
      accountPresentation,
      accountService,
      roleBindings,
      credentialVault,
      snowLuma,
      snowLumaRuntime,
      qqAvatars,
      extensions,
      extensionPolicy,
      extensionTools,
      pluginRuntimes,
      policy,
      agentScheduler,
      media,
      jobs,
      providers,
      runtimeRegistry,
      supervisor,
      accountLeases,
      modelSettings,
      connections,
      deploymentService,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await Promise.allSettled([
          connections.stop(),
          snowLumaRuntime.stop(),
          // Executors must drain before their plugin Workers disappear.
          extensionTools.close().then(() => pluginRuntimes.close()),
          jobs.dispose(),
          media.dispose(),
          configV2!.dispose(),
          desiredStore!.dispose(),
          listening!.dispose(),
          injectionSettings!.dispose(),
          accountDisplays!.close(),
          slotStore?.dispose() ?? Promise.resolve()
        ]);
        try {
          await runtimeRegistry!.dispose();
        } finally {
          try {
            supervisor!.dispose();
          } finally {
            await lock?.release();
          }
        }
      }
    };
  } catch (error) {
    await Promise.allSettled([
      configV2?.dispose(),
      desiredStore?.dispose(),
      listening?.dispose(),
      injectionSettings?.dispose(),
      accountDisplays?.close(),
      slotStore?.dispose()
    ].filter((item): item is Promise<void> => item !== undefined));
    await runtimeRegistry?.dispose().catch(() => {});
    await lock?.release();
    throw error;
  }
}

function defaultBackend(
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
