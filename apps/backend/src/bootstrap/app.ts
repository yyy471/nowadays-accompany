import type http from "node:http";
import { ExtensionHost } from "../application/extensions/extension-host.js";
import {
  ConversationService,
  type ChatModelPortFactory,
} from "../application/conversation/conversation-service.js";
import { AutonomyService } from "../application/conversation/autonomy-service.js";
import { AppearanceService } from "../application/media/appearance-service.js";
import { GlobalVoiceService } from "../application/media/global-voice-service.js";
import { VoiceService } from "../application/media/voice-service.js";
import { ImageServiceService } from "../application/media/image-service.js";
import { SceneImageSettingsService } from "../application/media/scene-image-settings.js";
import { MemoryQueryService } from "../application/memory/memory-query-service.js";
import {
  MemoryRuntime,
  type MemoryModelFactory,
} from "../application/memory/memory-runtime.js";
import { MessageService } from "../application/conversation/message-service.js";
import { PiToolProxy } from "../mcp/tool-proxy.js";
import { ManagedPi } from "../mcp/managed-pi.js";
import { EngineeringPool } from "../mcp/engineering-pool.js";
import { isAdminSeat } from "../domain/admin-seat.js";
import { PiModelProxy } from "../mcp/model-proxy.js";
import { ModelBindingResolver } from "../application/resources/model-binding-resolver.js";
import { ModelService } from "../application/resources/model-service.js";
import { CredentialResolver } from "../application/resources/credential-resolver.js";
import { ResourceService } from "../application/resources/resource-service.js";
import { RoleAccess } from "../application/role/role-access.js";
import { RoleService } from "../application/role/role-service.js";
import { RoleActivityService } from "../application/role/role-activity-service.js";
import { RoleDeletionService } from "../application/role/role-deletion-service.js";
import { TokenUsageService } from "../application/resources/token-usage-service.js";
import { ensurePresetAssistant } from "../application/role/preset-assistant.js";
import type { AdminToolServices } from "../application/role/admin-tools.js";
import { AppError } from "../domain/errors.js";
import {
  SceneImageService,
  type SceneImageServiceOptions,
} from "../application/media/scene-image-service.js";
import { createHttpServer } from "../http/server.js";
import type { ApiServices } from "../http/routes.js";
import { AppStore } from "../storage/core/app-store.js";
import { SecretStore } from "../storage/core/secret-store.js";
import { SecretCipher } from "../security/secret-cipher.js";
import { FixedSceneImagePlanner } from "../scene/fixed-planner.js";
import { FakeSceneImageGenerator } from "../scene/fake-generator.js";
import { ConfiguredSceneImageGenerator } from "../scene/comfyui-generator.js";
import { ModelSceneImagePlanner } from "../scene/model-planner.js";
import type { BackendConfig } from "./config.js";
import { checkAppDatabaseFiles, lockInstallation } from "../storage/core/installation-lock.js";
import { recoverRoleTransfer } from "../application/transfer/role-transfer-publication.js";

export interface BackendAppOptions {
  piLeaseMs?: number;
  coplayWindowMs?: number;
  extensionTimeouts?: { initMs: number; callMs: number };
  batchDelayMs?: number;
  now?: () => Date;
  timeZone?: string;
  typingMs?: number;
  autoRecallLimit?: number;
  maxToolRounds?: number;
  toolForegroundWaitMs?: number;
  modelPortFactory?: ChatModelPortFactory;
  memoryModelFactory?: MemoryModelFactory;
  memoryIdleMs?: number;
  disableMemoryRuntime?: boolean;
  disablePresetAssistant?: boolean;
  sceneImagePlanner?: SceneImageServiceOptions["planner"];
  sceneImageGenerator?: SceneImageServiceOptions["generator"];
  sceneImageGenerationTimeoutMs?: number;
  sceneImageInspector?: SceneImageServiceOptions["imageInspector"];
  /** 删除等待在途工作收尾的期限；超时返回可重试失败并保留角色（283 §16）。 */
  roleDeletionWaitMs?: number;
  /** 模型／媒体维护等待依赖角色停止的超时阈值（默认 20 秒，测试可覆写）。 */
  maintenancePauseTimeoutMs?: number;
}

import { MediaMaintenance } from '../application/media/media-maintenance.js';

export interface BackendApp {
  config: BackendConfig;
  appStore: AppStore;
  roleAccess: RoleAccess;
  services: ApiServices;
  conversation: ConversationService;
  server: http.Server;
  close(): Promise<void>;
}

export function createBackendApp(
  config: BackendConfig,
  options: BackendAppOptions = {},
): BackendApp {
  const release = lockInstallation(config);
  let appStore: AppStore | undefined;
  let roleAccess: RoleAccess | undefined;
  let stopStartup: (() => Promise<void>) | undefined;
  try {
    checkAppDatabaseFiles(config);
    appStore = new AppStore(config.appDatabasePath);
    recoverRoleTransfer(config, appStore);
    roleAccess = new RoleAccess(appStore, config.dataRoot);
    const app = assembleBackendApp(config, appStore, options, roleAccess, stop => { stopStartup = stop; });
    let closing: Promise<void> | undefined;
    return {
      ...app,
      close() {
        return closing ??= (async () => {
          try { await app.close(); }
          finally {
            try { await roleAccess!.closeAll(); }
            finally { try { appStore!.close(); } finally { release(); } }
          }
        })();
      },
    };
  } catch (error) {
    const finalize = () => { try { appStore?.close(); } finally { release(); } };
    const closePool = () => roleAccess?.closeAll();
    if (stopStartup) {
      void stopStartup().then(closePool, closePool).then(finalize, finalize);
    } else {
      try {
        const draining = closePool();
        if (draining) void draining.then(finalize, finalize);
        else finalize();
      } catch { finalize(); }
    }
    throw error;
  }
}

function assembleBackendApp(
  config: BackendConfig, appStore: AppStore, options: BackendAppOptions, roleAccess: RoleAccess, registerStartupStop: (stop: () => Promise<void>) => void,
): BackendApp {
  const now = options.now ?? (() => new Date());
  const credentials = new CredentialResolver(
    config.appRoot,
    new SecretStore(appStore.db, new SecretCipher(config.appRoot)),
  );
  const roleService = new RoleService(appStore, config.dataRoot, roleAccess);
  const activity = new RoleActivityService(appStore, { now });
  const messageService = new MessageService(roleAccess, now);
  // 模型解析同时服务运行时、影响报告与维护校验（283 R04）。
  const bindings = new ModelBindingResolver(appStore, roleAccess, credentials);  // 资源服务先于对话服务创建；唤醒回调在对话服务就绪后接入（R02）。
  let wakePendingWork: (roleId?: string) => void = () => undefined;
  // 记忆整理收尾后通知对话层确认停止（283 §4 R01）。
  let externalIdle: (roleId: string) => void = () => undefined;
  // 记忆与对话执行的在途角色；资源服务再补上标注／规划已领取的调用（283 §13 R01）。
  let externalInflightRoleIds: (resourceId: string) => string[] = () => [];
  // 角色删除收尾期间拒绝该角色的新过场图任务（283 §14 R03）。
  let isRoleDeleting: (roleId: string) => boolean = () => false;
  const resourceService = new ResourceService(appStore, roleAccess, {
    appRoot: config.appRoot,
    credentialResolver: credentials,
    bindings,
    now,
    // 模型维护按实际依赖暂停角色并等待后端确认停止（278 §2）。
    activityOf: (roleId) => {
      const view = activity.view(roleId);
      return { state: view.state, running: view.running };
    },
    pauseRoles: (roleIds) => activity.pauseRoles(roleIds, options.maintenancePauseTimeoutMs),
    wakePendingWork: (roleId) => wakePendingWork(roleId),
    externalInflightRoleIds: (resourceId) =>
      externalInflightRoleIds(resourceId),
  });
  // 维护期间拒绝先恢复活动再领取调用（283 R01）。
  const mediaMaintenance = new MediaMaintenance(appStore, roleAccess, activity, resourceService.pauseRoles);
  activity.setResumeGuard((roleId) => { resourceService.assertResumeAllowed(roleId); mediaMaintenance.assertResumeAllowed(roleId); });
  const appearanceService = new AppearanceService(roleAccess);
  const voiceServices = new GlobalVoiceService(appStore, { now });
  voiceServices.backfillFromRoles(roleAccess);
  const voiceService = new VoiceService(roleAccess, {
    now,
    voiceServices,
    mediaMaintenance,
  });
  const imageServices = new ImageServiceService(appStore, {
    credentialResolver: credentials,
    now,
  });
  const tokenUsage = new TokenUsageService(appStore, roleAccess, {
    now,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    listLiveRoles: () =>
      roleService
        .listRoles()
        .filter((item) => item.status === "ready")
        .map((item) => ({
          roleId: item.roleId,
          displayName: item.displayName,
        })),
  });
  const onModelCallFinished = (event: import("../domain/token-usage.js").TokenUsageCallEvent) => {
    tokenUsage.recordCall(event);
  };
  const sceneImageSettings = new SceneImageSettingsService(
    roleAccess,
    imageServices,
    {
      now,
      bindings,
      mediaMaintenance,
      appearance: appearanceService,
      appRoot: config.appRoot,
      credentialResolver: credentials,
      ...(options.modelPortFactory === undefined
        ? {}
        : { modelFactory: options.modelPortFactory }),
      maintenance: {
        isUnder: (resourceId) => resourceService.isUnderMaintenance(resourceId),
        wait: (resourceId, signal) =>
          resourceService.waitForMaintenanceEnd(resourceId, signal),
      },
      claim: {
        claim: (roleId, resourceId) =>
          resourceService.claimModelCall(roleId, resourceId),
      },
      onModelCallFinished,
    },
  );
  const memoryService = new MemoryQueryService(roleAccess, {
    now,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const modelService = new ModelService(appStore, config.appRoot, {
    now,
    credentialResolver: credentials,
    onModelCallFinished,
  });
  const autonomy: AutonomyService = new AutonomyService(roleAccess, {
    now, coplayWindowMs: options.coplayWindowMs,
    coplayActive: id => appStore.getRoleIndex(id)?.initStatus === "ready" && activity.gate.canStart(id),
    onCoplayDue: id => conversation.runDueAutonomy(id),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const memoryRuntime = options.disableMemoryRuntime
    ? null
    : new MemoryRuntime(
        appStore,
        roleAccess,
        bindings,
        config.appRoot,
        {
          now,
          credentialResolver: credentials,
          ...(options.timeZone === undefined
            ? {}
            : { timeZone: options.timeZone }),
          ...(options.memoryModelFactory === undefined
            ? {}
            : { modelFactory: options.memoryModelFactory }),
          ...(options.memoryIdleMs === undefined
            ? {}
            : { idleMs: options.memoryIdleMs }),
          // 维护窗口内暂缓后台记忆调用，结束后重新唤醒（283 R01/R02）。
          maintenance: (resourceId) =>
            resourceService.isUnderMaintenance(resourceId),
          onIdle: (roleId) => externalIdle(roleId),
          // 删除收尾期间不再接收新的记忆整理（283 §16）。
          isRoleDeleting: (roleId) => isRoleDeleting(roleId),
          onModelCallFinished,
        },
      );
  // 管理工具需要反向引用对话服务（任务查询与记忆触发），构造完成后再补上。
  const extensions = new ExtensionHost(config.appRoot, options.extensionTimeouts, autonomy.coplay);
  const engineeringPool = new EngineeringPool(appStore, resourceService, roleAccess);
  const modelProxy = new PiModelProxy(credentials, tokenUsage, resourceService, appStore,
    (id, model, status, retryAfter) => {
      if (status === undefined || status === 401 || status === 402 || status === 403 || status === 429 || status >= 500) {
        engineeringPool.reportFailure(id, model, status === 429 ? retryAfter : null);
      }
    });
  const toolProxy = new PiToolProxy(modelProxy, appStore, roleAccess, autonomy, config.appRoot,
    (roleId, taskId) => conversation.releaseTaskResources(roleId, taskId));
  const pi: ManagedPi = new ManagedPi(modelProxy, toolProxy, engineeringPool, extensions.work, () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("PI_HTTP_SERVER_UNAVAILABLE");
    return address.port;
  }, roleId => activity.view(roleId).state === "active",
  roleId => isAdminSeat(roleAccess.requireReady(roleId).builtinKey), roleAccess,
  () => appStore.listRoleIndexes().filter(r => r.initStatus === "ready" && isAdminSeat(r.builtinKey)).map(r => r.roleId),
  roleId => wakePendingWork(roleId), options.piLeaseMs);
  const adminServices: AdminToolServices = {
    pi, extensions,
    roles: roleService,
    activity,
    messages: messageService,
    memory: memoryService,
    autonomy,
    resources: resourceService,
    modelServices: modelService,
    voiceServices,
    imageServices,
    now,
  };
  const conversation = new ConversationService(
    appStore,
    roleAccess,
    bindings,
    memoryService,
    config.appRoot,
    {
      now,
      credentialResolver: credentials,
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      ...(options.typingMs === undefined ? {} : { typingMs: options.typingMs }),
      ...(options.batchDelayMs === undefined ? {} : { batchDelayMs: options.batchDelayMs }),
      ...(options.autoRecallLimit === undefined
        ? {}
        : { autoRecallLimit: options.autoRecallLimit }),
      ...(options.maxToolRounds === undefined
        ? {}
        : { maxToolRounds: options.maxToolRounds }),
      ...(options.toolForegroundWaitMs === undefined
        ? {}
        : { toolForegroundWaitMs: options.toolForegroundWaitMs }),
      ...(options.modelPortFactory === undefined
        ? {}
        : { modelPortFactory: options.modelPortFactory }),
      memoryRuntime,
      autonomy,
      activity: activity.gate,
      // 维护中的模型服务暂缓新执行与调用领取（283 R01）。
      isResourceUnderMaintenance: (resourceId) =>
        resourceService.isUnderMaintenance(resourceId),
      // 后台句段标注等待维护结束后重新解析配置（278 §2.1）。
      waitForMaintenanceEnd: (resourceId, signal) =>
        resourceService.waitForMaintenanceEnd(resourceId, signal),
      // 后台记忆也在途时，对话节点暂停与收尾都不能先确认停止（283 §5 R01）。
      hasExternalWork: (roleId) => memoryRuntime?.isBusy(roleId) ?? false,
      // 后台句段标注的调用领取（283 §13 R01）。
      claimModelCall: (roleId, resourceId) =>
        resourceService.claimModelCall(roleId, resourceId),
      // 预置默认助手的内部管理工具直接复用应用服务（DL-159）。
      adminServices,
      onModelCallFinished,
      resolveVoiceRuntime: (settings) => {
        if (!settings.serviceId) {
          return {
            protocol: settings.protocol,
            enabled: settings.enabled,
            ttsEngine: settings.ttsEngine,
          };
        }
        const linked = voiceServices.findRecord(settings.serviceId);
        if (linked === null || !linked.enabled) {
          return {
            protocol: settings.protocol,
            enabled: false,
            ttsEngine: null,
          };
        }
        return {
          protocol: linked.config.protocol,
          enabled: settings.enabled,
          ttsEngine: settings.ttsEngine ?? linked.config.defaultEngine ?? null,
        };
      },
    },
  );
  adminServices.conversation = conversation;
  // 首句合成遇到后台正在进行的句段情绪标注时短暂等待其落库，不抢在无情绪状态下先发合成。
  voiceService.setAnnotationWaiter((messageId, timeoutMs, signal) =>
    conversation.awaitMessageAnnotation(messageId, timeoutMs, signal),
  );
  // 模型恢复或维护结束后重新检查已有待处理窗口与任务续行（283 R02）。
  wakePendingWork = (roleId) => conversation.wakePendingWork(roleId);
  externalInflightRoleIds = (resourceId) =>
    [...new Set([
      ...(memoryRuntime?.inflightRoleIds(resourceId) ?? []),
      ...conversation.inflightRoleIds(resourceId),
    ])].sort();
  externalIdle = (roleId) => conversation.notifyExternalIdle(roleId);
  activity.attachRuntime({
    // 后台记忆整理也属于角色在途工作：停止确认与维护等待都要计入（283 §4 R01）。
    isRunning: (roleId) =>
      conversation.isRunning(roleId) ||
      (memoryRuntime?.isBusy(roleId) ?? false),
    // 恢复后把停止时暂停的原任务链与到期待办接回调度（RA-R02）。
    stopExchanges: (roleId) => {
      autonomy.coplay.discard(batch => batch.roleId === roleId);
      void pi.stop(roleId).catch(error => console.warn("PI_STOP_FAILED", roleId, error));
      conversation.exchanges.stop(roleId);
    },
    resumeWork: (roleId) => conversation.rescheduleAfterStop(roleId),
  });
  const configuredSceneGenerator = new ConfiguredSceneImageGenerator({
    source: sceneImageSettings.source, fallback: new FakeSceneImageGenerator(),
  });
  const sceneImages = new SceneImageService(appStore, roleAccess, config.dataRoot, {
    captureImageService: roleId => {
      const config = configuredSceneGenerator.lock(roleId);
      if (!config?.settings || !sceneImageSettings.source.findServiceRecord(config.settings.serviceId)?.enabled) return null;
      return config;
    },
    now,
    mediaMaintenance,
    planner:
      options.sceneImagePlanner ??
      new ModelSceneImagePlanner(roleAccess, bindings, {
        appRoot: config.appRoot,
        now,
        credentialResolver: credentials,
        ...(options.timeZone === undefined
          ? {}
          : { timeZone: options.timeZone }),
        ...(options.modelPortFactory === undefined
          ? {}
          : { modelFactory: options.modelPortFactory }),
        // 过场图规划等待维护结束并按已保存配置重新解析（278 §2.1）。
        maintenance: {
          isUnder: (resourceId) =>
            resourceService.isUnderMaintenance(resourceId),
          wait: (resourceId, signal) =>
            resourceService.waitForMaintenanceEnd(resourceId, signal),
        },
        // 规划的调用领取与维护检查同步完成（283 §13 R01）。
        claim: {
          claim: (roleId, resourceId) =>
            resourceService.claimModelCall(roleId, resourceId),
        },
        onModelCallFinished,
        fallback: new FixedSceneImagePlanner(),
      }),
    generator: options.sceneImageGenerator ?? configuredSceneGenerator,
    ...(options.sceneImageGenerationTimeoutMs === undefined
      ? {}
      : { generationTimeoutMs: options.sceneImageGenerationTimeoutMs }),
    ...(options.sceneImageInspector === undefined
      ? {}
      : { imageInspector: options.sceneImageInspector }),
    isRoleDeleting: (roleId) => isRoleDeleting(roleId),
  });
  conversation.setSceneImageService(sceneImages);
  const waitForMemoryIdle = async (
    roleId: string,
    timeoutMs: number,
  ): Promise<boolean> => {
    if (memoryRuntime === null) return true;
    const deadline = Date.now() + timeoutMs;
    while (memoryRuntime.isBusy(roleId)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };
  const roleDeletionWaitMs = options.roleDeletionWaitMs ?? 15_000;
  const roleDeletion = new RoleDeletionService(
    appStore,
    roleAccess,
    {
      dispose: async (roleId) => {
        try {
          // 先中止过场图任务，取消尚未领取的标注等待，再等待已发出的工作收尾。
          await pi.stop(roleId);
          await sceneImages.cancelRole(roleId);
          conversation.cancelQueuedAnnotations(roleId);
          // 领取表与记忆队列共用一个删除期限；超时保留角色和队列（283 §15/§16）。
          const deadline = Date.now() + roleDeletionWaitMs;
          const remaining = () => Math.max(0, deadline - Date.now());
          const settled = await resourceService.waitForRoleInflightIdle(
            roleId,
            remaining(),
          );
          if (!settled) {
            throw new Error("BACKGROUND_CALL_STILL_RUNNING");
          }
          if (!(await waitForMemoryIdle(roleId, remaining()))) {
            throw new Error("MEMORY_MAINTENANCE_STILL_RUNNING");
          }
          await conversation.waitForQuiescent(roleId);
        } catch {
          throw new AppError(
            409,
            "ROLE_BUSY",
            "角色仍有在途工作，请稍后再删除",
            { roleId },
          );
        }
        await conversation.disposeRole(roleId);
        await memoryRuntime?.disposeRole(roleId);
      },
      onDeletionFailed: (roleId) => {
        // 删除保护已释放：补发删除期间被拒绝的维护唤醒与待处理检查（283 §17）。
        memoryRuntime?.restoreRole(roleId);
        conversation.wakePendingWork(roleId);
      },
    },
    config.dataRoot,
    { now },
  );
  isRoleDeleting = (roleId) => roleDeletion.isDeleting(roleId);
  autonomy.setWakeListener((roleId) => conversation.refreshWakeTimer(roleId));
  autonomy.setProactiveMessageListener(notice => {
    const { coplayShare, roleId, windowId, messageId } = notice;
    if (coplayShare && !isAdminSeat(appStore.getRoleIndex(roleId)?.builtinKey ?? null))
      extensions.publishCoplayShare({ roleId, windowId, messageId, ...coplayShare });
    conversation.queueSegmentAnnotation(notice);
  });
  const services: ApiServices = {
    roles: roleService,
    messages: messageService,
    resources: resourceService,
    memory: memoryService,
    modelServices: modelService,
    conversation,
    autonomy,
    appearance: appearanceService,
    voice: voiceService,
    voiceServices,
    sceneImages,
    imageServices,
    sceneImageSettings,
    activity,
    roleDeletion,
    mediaMaintenance,
    tokenUsage,
    pi, modelProxy, toolProxy, engineeringPool,
    extensions,
  };
  const server = createHttpServer({ version: "0.1.0", services, hostToken: config.hostToken });

  let closing: Promise<void> | undefined;
  const closeRuntime = (): Promise<void> => closing ??= (async () => {
    try {
      const stopped = await Promise.allSettled([pi.close(), conversation.close()]);
      await toolProxy.drain();
      if (server.listening) await closeServer(server);
      for (const result of stopped) if (result.status === "rejected") throw result.reason;
    } finally {
      try { await sceneImages.close(); }
      finally { await extensions.close(); }
    }
  })();
  registerStartupStop(closeRuntime);
  memoryRuntime?.recoverOnStartup();
  conversation.recoverOnStartup();
  // 中断调用收敛后再一次性回填历史 Token 账本，避免重复统计或漏计已结算调用（DL-183）。
  tokenUsage.backfillOnce();
  // 执行记录恢复后再核对持久化的停止请求：已无在途执行或后台工具的
  // stopping 记录自动收敛为 stopped，避免重启后卡在正在停止（RA-R05）。
  activity.reconcileStartup();
  // 完成上一次删除中断留下的角色绑定清理（RP-R05）。
  resourceService.reconcilePendingDeletions();
  sceneImages.recoverOnStartup();
  roleDeletion.reconcilePendingDeletions();
  if (options.disablePresetAssistant !== true) {
    const seat = ensurePresetAssistant({
      appStore,
      roleService,
      presetAssetsDir: config.presetAssetsDir,
      now,
    });
    resourceService.ensureManagedPi(seat.roleId);
  }
  conversation.batchDelivery.recover();
  extensions.restore();
  return { config, appStore, roleAccess, services, conversation, server, close: closeRuntime };

}

export function listen(
  server: http.Server,
  port: number,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        resolve(address.port);
        return;
      }
      reject(new Error("SERVER_ADDRESS_UNAVAILABLE"));
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}
