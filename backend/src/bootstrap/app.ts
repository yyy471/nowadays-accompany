import fs from "node:fs";
import type http from "node:http";
import {
  ConversationService,
  type ChatModelPortFactory,
} from "../application/conversation-service.js";
import { AutonomyService } from "../application/autonomy-service.js";
import { AppearanceService } from "../application/appearance-service.js";
import { VoiceService } from "../application/voice-service.js";
import { ImageServiceService } from "../application/image-service.js";
import { SceneImageSettingsService } from "../application/scene-image-settings.js";
import { MemoryQueryService } from "../application/memory-query-service.js";
import {
  MemoryRuntime,
  type MemoryModelFactory,
} from "../application/memory-runtime.js";
import { MessageService } from "../application/message-service.js";
import { ModelBindingResolver } from "../application/model-binding-resolver.js";
import { ModelService } from "../application/model-service.js";
import { CredentialResolver } from "../application/credential-resolver.js";
import { ResourceService } from "../application/resource-service.js";
import { RoleAccess } from "../application/role-access.js";
import { RoleService } from "../application/role-service.js";
import { RolesNotStoppedError } from "../domain/errors.js";
import { RoleActivityService } from "../application/role-activity-service.js";
import { RoleDeletionService } from "../application/role-deletion-service.js";
import { AppError } from "../domain/errors.js";
import {
  SceneImageService,
  type SceneImageServiceOptions,
} from "../application/scene-image-service.js";
import { createHttpServer } from "../http/server.js";
import type { ApiServices } from "../http/routes.js";
import { AppStore } from "../storage/app-store.js";
import { SecretStore } from "../storage/secret-store.js";
import { SecretCipher } from "../security/secret-cipher.js";
import { FixedSceneImagePlanner } from "../scene/fixed-planner.js";
import { FakeSceneImageGenerator } from "../scene/fake-generator.js";
import { ConfiguredSceneImageGenerator } from "../scene/comfyui-generator.js";
import { ModelSceneImagePlanner } from "../scene/model-planner.js";
import type { BackendConfig } from "./config.js";

export interface BackendAppOptions {
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
  sceneImagePlanner?: SceneImageServiceOptions["planner"];
  sceneImageGenerator?: SceneImageServiceOptions["generator"];
  sceneImageGenerationTimeoutMs?: number;
  sceneImageInspector?: SceneImageServiceOptions["imageInspector"];
  /** 删除等待在途工作收尾的期限；超时返回可重试失败并保留角色（283 §16）。 */
  roleDeletionWaitMs?: number;
}

export interface BackendApp {
  config: BackendConfig;
  appStore: AppStore;
  services: ApiServices;
  conversation: ConversationService;
  server: http.Server;
  close(): Promise<void>;
}

export function createBackendApp(
  config: BackendConfig,
  options: BackendAppOptions = {},
): BackendApp {
  fs.mkdirSync(config.dataRoot, { recursive: true });
  const now = options.now ?? (() => new Date());
  const appStore = new AppStore(config.appDatabasePath);
  const credentials = new CredentialResolver(
    config.appRoot,
    new SecretStore(appStore.db, new SecretCipher(config.appRoot)),
  );
  const roleService = new RoleService(appStore, config.dataRoot);
  const roleAccess = new RoleAccess(appStore, config.dataRoot);
  const activity = new RoleActivityService(appStore, { now });
  const messageService = new MessageService(roleAccess);
  // 模型解析同时服务运行时、影响报告与维护校验（283 R04）。
  const bindings = new ModelBindingResolver(appStore, roleAccess);  // 资源服务先于对话服务创建；唤醒回调在对话服务就绪后接入（R02）。
  let wakePendingWork: (roleId?: string) => void = () => undefined;
  // 记忆整理收尾后通知对话层确认停止（283 §4 R01）。
  let externalIdle: (roleId: string) => void = () => undefined;
  // 记忆与对话执行的在途角色；资源服务再补上标注／规划已领取的调用（283 §13 R01）。
  let externalInflightRoleIds: (resourceId: string) => string[] = () => [];
  // 角色删除收尾期间拒绝该角色的新过场图任务（283 §14 R03）。
  let isRoleDeleting: (roleId: string) => boolean = () => false;
  const resourceService = new ResourceService(appStore, roleAccess, {
    credentialResolver: credentials,
    bindings,
    now,
    // 模型维护按实际依赖暂停角色并等待后端确认停止（278 §2）。
    activityOf: (roleId) => {
      const view = activity.view(roleId);
      return { state: view.state, running: view.running };
    },
    pauseRoles: async (roleIds) => {
      const pausedRoleIds: string[] = [];
      const pending: Array<{ roleId: string; state: string; running: boolean }> = [];
      for (const roleId of roleIds) {
        let view = activity.view(roleId);
        // 已停止或用户先前已发起停止的角色不属于本次操作的暂停名单（283 §5 R05）。
        if (view.state === "stopped") continue;
        const initiated = view.state === "active";
        if (initiated) activity.requestStop(roleId);
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && activity.view(roleId).state !== "stopped") {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        view = activity.view(roleId);
        if (view.state !== "stopped") {
          pending.push({ roleId, state: view.state, running: view.running });
        } else if (initiated) {
          // 只记录由本次操作发起且已经确认停止的角色。
          pausedRoleIds.push(roleId);
        }
      }
      if (pending.length > 0) {
        // 超时或失败时仍返回本次已经停止的角色，界面可在原处恢复（283 §4 R05）。
        throw new RolesNotStoppedError(pending, pausedRoleIds);
      }
      return { pausedRoleIds };
    },
    wakePendingWork: (roleId) => wakePendingWork(roleId),
    externalInflightRoleIds: (resourceId) =>
      externalInflightRoleIds(resourceId),
  });
  // 维护期间拒绝先恢复活动再领取调用（283 R01）。
  activity.setResumeGuard((roleId) => resourceService.assertResumeAllowed(roleId));
  const appearanceService = new AppearanceService(roleAccess);
  const voiceService = new VoiceService(roleAccess, { now });
  const imageServices = new ImageServiceService(appStore, {
    credentialResolver: credentials,
    now,
  });
  const sceneImageSettings = new SceneImageSettingsService(
    roleAccess,
    imageServices,
    {
      now,
      bindings,
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
    },
  );
  const memoryService = new MemoryQueryService(roleAccess, {
    now,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const modelService = new ModelService(appStore, config.appRoot, {
    now,
    credentialResolver: credentials,
  });
  const autonomy = new AutonomyService(roleAccess, {
    now,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const memoryRuntime = options.disableMemoryRuntime
    ? null
    : new MemoryRuntime(
        appStore,
        roleAccess,
        bindings,
        config.appRoot,
        config.dataRoot,
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
        },
      );
  const conversation = new ConversationService(
    appStore,
    roleAccess,
    bindings,
    memoryService,
    config.appRoot,
    config.dataRoot,
    {
      now,
      credentialResolver: credentials,
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      ...(options.typingMs === undefined ? {} : { typingMs: options.typingMs }),
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
    },
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
    resumeWork: (roleId) => conversation.rescheduleAfterStop(roleId),
  });
  memoryRuntime?.recoverOnStartup();
  conversation.recoverOnStartup();
  // 执行记录恢复后再核对持久化的停止请求：已无在途执行或后台工具的
  // stopping 记录自动收敛为 stopped，避免重启后卡在正在停止（RA-R05）。
  activity.reconcileStartup();
  // 完成上一次删除中断留下的角色绑定清理（RP-R05）。
  resourceService.reconcilePendingDeletions();
  const sceneImages = new SceneImageService(appStore, roleAccess, config.dataRoot, {
    now,
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
        fallback: new FixedSceneImagePlanner(),
      }),
    generator:
      options.sceneImageGenerator ??
      new ConfiguredSceneImageGenerator({
        source: sceneImageSettings.source,
        fallback: new FakeSceneImageGenerator(),
      }),
    ...(options.sceneImageGenerationTimeoutMs === undefined
      ? {}
      : { generationTimeoutMs: options.sceneImageGenerationTimeoutMs }),
    ...(options.sceneImageInspector === undefined
      ? {}
      : { imageInspector: options.sceneImageInspector }),
    isRoleDeleting: (roleId) => isRoleDeleting(roleId),
  });
  sceneImages.recoverOnStartup();
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
        conversation.wakePendingWork(roleId);
      },
    },
    config.dataRoot,
    { now },
  );
  roleDeletion.reconcilePendingDeletions();
  isRoleDeleting = (roleId) => roleDeletion.isDeleting(roleId);
  autonomy.setWakeListener((roleId) => conversation.refreshWakeTimer(roleId));
  autonomy.setProactiveMessageListener((notice) =>
    conversation.queueSegmentAnnotation(notice),
  );
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
    sceneImages,
    imageServices,
    sceneImageSettings,
    activity,
    roleDeletion,
  };
  let server: http.Server;
  try {
    server = createHttpServer({ version: "0.1.0", services });
  } catch (error) {
    appStore.close();
    throw error;
  }

  let closed = false;
  return {
    config,
    appStore,
    services,
    conversation,
    server,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await conversation.close();
      await sceneImages.close();
      if (server.listening) {
        await closeServer(server);
      }
      appStore.close();
    },
  };
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
