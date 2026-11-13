import type {
  CreateResourceBody,
  CreateWindowBody,
  CreateRoleBody,
  DiaryCreateBody,
  EventCorrectionBody,
  InputStateBody,
  MemorySearchBody,
  ModelServiceConfigBody,
  ModelServiceTestBody,
  ResourceModelTestBody,
  PutBindingsBody,
  PutStateBody,
  SubmitMessageBody,
  SummaryCorrectionBody,
  TaskFinishBody,
  AutonomyBudgetBody,
  AutonomyWakeBody,
  UpdateDefinitionBody,
  UpdateResourceBody,
} from "./schemas.js";
import { readJsonBody } from "./body.js";
import { HttpError, type JsonResponse } from "./errors.js";
import type { Router } from "./router.js";
import type { AppearanceService } from "../application/appearance-service.js";
import type { ConversationService } from "../application/conversation-service.js";
import type { AutonomyService } from "../application/autonomy-service.js";
import type { MemoryQueryService } from "../application/memory-query-service.js";
import type { MessageService } from "../application/message-service.js";
import type { ModelService } from "../application/model-service.js";
import type { ResourceService } from "../application/resource-service.js";
import type { RoleService } from "../application/role-service.js";
import type { SceneImageService } from "../application/scene-image-service.js";
import type { ImageServiceService } from "../application/image-service.js";
import type { SceneImageSettingsService } from "../application/scene-image-settings.js";
import type { VoiceService } from "../application/voice-service.js";
import type { RoleActivityService } from "../application/role-activity-service.js";
import type { RoleDeletionService } from "../application/role-deletion-service.js";
import { registerRoleActivityRoutes } from "./role-activity-routes.js";
import { globalWrite, roleWrite } from "./write-guard.js";
import {
  GLOBAL_CONFIG_WRITES,
  RESOURCE_CONFIG_WRITES,
  ROLE_CONFIG_WRITES,
} from "./config-writes.js";
import { InputStateInvalidError, SseCursorInvalidError, AppError } from "../domain/errors.js";
import { resourceKindSchema } from "../domain/resource.js";
import {
  createResourceSchema,
  createRoleSchema,
  createWindowSchema,
  diaryCreateBodySchema,
  eventCorrectionBodySchema,
  inputStateBodySchema,
  memorySearchBodySchema,
  modelServiceConfigBodySchema,
  modelServiceTestBodySchema,
  putBindingsSchema,
  putStateSchema,
  resourceModelTestSchema,
  submitMessageSchema,
  summaryCorrectionBodySchema,
  taskFinishBodySchema,
  autonomyBudgetBodySchema,
  autonomyWakeBodySchema,
  updateDefinitionSchema,
  updateResourceSchema,
} from "./schemas.js";
import { parseBody, queryInt } from "./validation.js";
import { registerAppearanceRoutes } from "./appearance-routes.js";
import { registerSceneImageRoutes } from "./scene-image-routes.js";
import { registerImageServiceRoutes } from "./image-service-routes.js";
import { registerVoiceRoutes } from "./voice-routes.js";

export interface ApiServices {
  roles: RoleService;
  messages: MessageService;
  resources: ResourceService;
  memory: MemoryQueryService;
  modelServices: ModelService;
  conversation: ConversationService;
  autonomy: AutonomyService;
  appearance: AppearanceService;
  voice: VoiceService;
  sceneImages: SceneImageService;
  imageServices: ImageServiceService;
  sceneImageSettings: SceneImageSettingsService;
  activity: RoleActivityService;
  roleDeletion: RoleDeletionService;
}

export function registerApiRoutes(
  router: Router,
  services: ApiServices,
  version: string,
): Router {
  const { activity } = services;
  // 一处注册策略覆盖主路由与拆分的子路由文件，新增配置写入接口不会漏掉保护。
  router.setGuard((method, pattern, handler) => {
    const key = `${method} ${pattern}`;
    if (ROLE_CONFIG_WRITES.has(key)) return roleWrite(activity, handler);
    if (GLOBAL_CONFIG_WRITES.has(key)) return globalWrite(activity, handler);
    if (RESOURCE_CONFIG_WRITES.has(key)) {
      // 资源写入在处理器内按类型处理：模型只暂停实际依赖目标（278 §2），
      // MCP／Skill 由服务层占用检查（DL-148）。
      return handler;
    }
    return handler;
  });
  registerRoleActivityRoutes(router, activity);
  router.add("GET", "/v1/health", (): JsonResponse => ({
    status: 200,
    body: { status: "ok", version },
  }));

  router.add("GET", "/v1/roles", (): JsonResponse => ({
    status: 200,
    body: { items: services.roles.listRoles() },
  }));

  router.add("POST", "/v1/roles", async ({ request }): Promise<JsonResponse> => {
    const body = parseBody<CreateRoleBody>(
      createRoleSchema,
      await readJsonBody(request),
    );
    return {
      status: 201,
      body: { ...services.roles.createRole(body), status: "ready" },
    };
  });

  router.add(
    "DELETE",
    "/v1/roles/:roleId",
    async ({ url, params }): Promise<JsonResponse> => {
      const raw = url.searchParams.get("keepHistory");
      if (raw === null) {
        throw new HttpError(
          400,
          "KEEP_HISTORY_REQUIRED",
          "请明确选择是否保留记忆与对话数据：keepHistory=1 保留，0 清理",
        );
      }
      if (raw !== "1" && raw !== "0" && raw !== "true" && raw !== "false") {
        throw new HttpError(
          400,
          "INVALID_QUERY",
          "keepHistory 只接受 0、1、true 或 false",
        );
      }
      const keepHistory = raw === "1" || raw === "true";
      return {
        status: 200,
        body: await services.roleDeletion.remove(
          params.roleId ?? "",
          keepHistory,
        ),
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/initialize",
    ({ params }): JsonResponse => ({
      status: 200,
      body: {
        ...services.roles.initializeRole(params.roleId ?? ""),
        status: "ready",
      },
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.roles.getRole(params.roleId ?? ""),
    }),
  );

  router.add(
    "PATCH",
    "/v1/roles/:roleId/definition",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<UpdateDefinitionBody>(
        updateDefinitionSchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.roles.updateDefinition(params.roleId ?? "", body),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/state",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.roles.getState(params.roleId ?? ""),
    }),
  );

  router.add(
    "PUT",
    "/v1/roles/:roleId/state",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<PutStateBody>(
        putStateSchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.roles.setState(params.roleId ?? "", body),
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/windows",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<CreateWindowBody>(
        createWindowSchema,
        await readJsonBody(request),
      );
      return {
        status: 201,
        body: services.roles.createWindow(params.roleId ?? "", {
          kind: body.kind ?? "custom",
          source: body.source ?? "nowadays",
        }),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/windows",
    ({ params }): JsonResponse => ({
      status: 200,
      body: { items: services.roles.listWindows(params.roleId ?? "") },
    }),
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/windows/:windowId/messages",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<SubmitMessageBody>(
        submitMessageSchema,
        await readJsonBody(request),
      );
      const roleId = params.roleId ?? "";
      const windowId = params.windowId ?? "";
      // 先按提交标识找回已接收消息：角色随后停止也仍能确认原提交结果。
      const existing = services.conversation.findSubmittedMessage(
        roleId,
        windowId,
        body.submissionId,
      );
      if (existing === null) {
        activity.assertCanStart(roleId);
      }
      const result = services.conversation.submitMessage(roleId, windowId, {
        content: body.content,
        submissionId: body.submissionId,
        sourcePlatform: body.source ?? "nowadays",
      });
      return {
        status: result.duplicate ? 200 : 201,
        body: result,
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/windows/:windowId/messages",
    ({ params, url }): JsonResponse => {
      const afterRaw = url.searchParams.get("after");
      const beforeRaw = url.searchParams.get("before");
      if (afterRaw !== null && beforeRaw !== null) {
        throw new HttpError(
          400,
          "INVALID_QUERY",
          "查询参数 after 与 before 不能同时使用",
        );
      }
      const after =
        afterRaw === null
          ? null
          : queryInt(url, "after", {
              min: 0,
              max: 2_147_483_647,
            });
      const before =
        beforeRaw === null
          ? null
          : queryInt(url, "before", {
              min: 1,
              max: 2_147_483_647,
            });
      const limit = queryInt(url, "limit", {
        min: 1,
        max: 200,
        defaultValue: 50,
      });
      return {
        status: 200,
        body: services.messages.list(
          params.roleId ?? "",
          params.windowId ?? "",
          after,
          limit,
          before,
        ),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/windows/:windowId/messages/:messageId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.messages.get(
        params.roleId ?? "",
        params.windowId ?? "",
        params.messageId ?? "",
      ),
    }),
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/windows/:windowId/input-state",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<InputStateBody>(
        inputStateBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.conversation.updateInputState({
          roleId: params.roleId ?? "",
          windowId: params.windowId ?? "",
          clientId: body.clientId ?? "",
          typing: body.typing,
        }),
      };
    },
  );

  router.add(
    "DELETE",
    "/v1/roles/:roleId/windows/:windowId/input-state",
    ({ params, url }): JsonResponse => {
      const clientId = url.searchParams.get("clientId");
      if (clientId === null || clientId.length === 0) {
        throw new InputStateInvalidError("缺少 clientId");
      }
      return {
        status: 200,
        body: services.conversation.clearInputState({
          roleId: params.roleId ?? "",
          windowId: params.windowId ?? "",
          clientId,
        }),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/windows/:windowId/events",
    async ({ request, response, params, url }): Promise<undefined> => {
      const after = parseSseCursor(request, url);
      const clientId = url.searchParams.get("clientId");
      await services.conversation.streamEvents({
        roleId: params.roleId ?? "",
        windowId: params.windowId ?? "",
        after,
        clientId,
        request,
        response,
      });
      return undefined;
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/executions/:executionId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.conversation.getExecution(
        params.roleId ?? "",
        params.executionId ?? "",
      ),
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/tasks",
    ({ params }): JsonResponse => ({
      status: 200,
      body: { items: services.conversation.listTasks(params.roleId ?? "") },
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/tasks/:taskId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.conversation.getTask(
        params.roleId ?? "",
        params.taskId ?? "",
      ),
    }),
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/tasks/:taskId/finish",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<TaskFinishBody>(
        taskFinishBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.conversation.finishTask({
          roleId: params.roleId ?? "",
          taskId: params.taskId ?? "",
          status: body.status,
          endReason: body.endReason,
        }),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/autonomy",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.autonomy.getStatus(params.roleId ?? ""),
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/autonomy/budget",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.autonomy.getBudget(params.roleId ?? ""),
    }),
  );

  router.add(
    "PUT",
    "/v1/roles/:roleId/autonomy/budget",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<AutonomyBudgetBody>(
        autonomyBudgetBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.autonomy.setBudget(params.roleId ?? "", {
          unlimited: body.unlimited,
          ...(body.dailyLimit === undefined
            ? {}
            : { dailyLimit: body.dailyLimit }),
        }),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/autonomy/wakes",
    ({ params, url }): JsonResponse => {
      const limit = queryInt(url, "limit", {
        min: 1,
        max: 500,
        defaultValue: 100,
      });
      return {
        status: 200,
        body: {
          items: services.autonomy.listWakes(params.roleId ?? "", limit),
        },
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/autonomy/wakes",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<AutonomyWakeBody>(
        autonomyWakeBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 201,
        body: services.autonomy.scheduleWake(params.roleId ?? "", body),
      };
    },
  );

  router.add(
    "DELETE",
    "/v1/roles/:roleId/autonomy/wakes/:wakeId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.autonomy.cancelWake(
        params.roleId ?? "",
        params.wakeId ?? "",
      ),
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/autonomy/activities",
    ({ params, url }): JsonResponse => {
      const limit = queryInt(url, "limit", {
        min: 1,
        max: 500,
        defaultValue: 100,
      });
      return {
        status: 200,
        body: {
          items: services.autonomy.listActivities(params.roleId ?? "", limit),
        },
      };
    },
  );

  router.add(
    "POST",
    "/v1/resources",
    async ({ request }): Promise<JsonResponse> => {
      const body = parseBody<CreateResourceBody>(
        createResourceSchema,
        await readJsonBody(request),
      );
      return { status: 201, body: services.resources.create(body) };
    },
  );

  router.add("GET", "/v1/resources", ({ url }): JsonResponse => {
    const rawKind = url.searchParams.get("kind");
    let kind;
    if (rawKind !== null) {
      const parsed = resourceKindSchema.safeParse(rawKind);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "INVALID_QUERY",
          "查询参数 kind 必须是 model、mcp 或 skill",
        );
      }
      kind = parsed.data;
    }
    return {
      status: 200,
      body: { items: services.resources.list(kind) },
    };
  });

  router.add(
    "GET",
    "/v1/resources/:resourceId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.resources.getView(params.resourceId ?? ""),
    }),
  );

  router.add(
    "GET",
    "/v1/resources/:resourceId/references",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.resources.references(params.resourceId ?? ""),
    }),
  );

  router.add(
    "GET",
    "/v1/resources/:resourceId/impact",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.resources.impact(params.resourceId ?? ""),
    }),
  );

  router.add(
    "PATCH",
    "/v1/resources/:resourceId",
    async ({ request, params }): Promise<JsonResponse> => {
      const resourceId = params.resourceId ?? "";
      const body = parseBody<UpdateResourceBody>(
        updateResourceSchema,
        await readJsonBody(request),
      );
      // 可预判的校验在暂停角色之前完成（283 R05）。
      services.resources.validateUpdate(resourceId, body);
      // 模型连接参数或密钥变化时只暂停实际依赖它的角色（278 §2）。
      const plan = services.resources.maintenancePlan(resourceId, body);
      let pausedRoleIds: string[] = [];
      let maintenance = false;
      try {
        if (plan.connectionChanged) {
          // 维护期间拒绝新增依赖、恢复活动与调用领取（283 R01）。
          services.resources.beginMaintenance(resourceId);
          maintenance = true;
        }
        if (plan.pauseRoleIds.length > 0) {
          const pause = services.resources.pauseRoles;
          if (pause === null) {
            throw new HttpError(
              409,
              "ROLES_NOT_STOPPED",
              "角色维护协调尚未配置，请稍后重试",
              { roles: plan.pauseRoleIds.map((roleId) => ({ roleId, state: "active", running: true })) },
            );
          }
          pausedRoleIds = (await pause(plan.pauseRoleIds)).pausedRoleIds;
        }
        if (plan.waitRoleIds.length > 0) {
          // 已停止角色在目标服务上的在途调用也要结算，但不加入恢复名单（283 §6 R01）。
          const busy = await services.resources.waitForInflightIdle(
            resourceId,
            plan.waitRoleIds,
            20_000,
          );
          if (busy.length > 0) {
            throw new HttpError(
              409,
              "RESOURCE_MAINTENANCE",
              "仍有后台调用正在使用这个服务，请等它结算后再保存",
              { roleIds: busy },
            );
          }
        }
        if (maintenance) {
          // 等待停止期间重新解析实际依赖；新增依赖不能抢在写入前进入。
          const recheck = services.resources.maintenancePlan(resourceId, body);
          const unpaused = recheck.pauseRoleIds.filter(
            (roleId) => !pausedRoleIds.includes(roleId),
          );
          if (unpaused.length > 0) {
            throw new HttpError(
              409,
              "RESOURCE_MAINTENANCE",
              "维护期间出现新的依赖角色，请重新确认影响范围后再保存",
              { roleIds: unpaused },
            );
          }
        }
        const view = services.resources.update(resourceId, body);
        return {
          status: 200,
          body: {
            ...view,
            maintenance: { connectionChanged: plan.connectionChanged, pausedRoleIds },
          },
        };
      } catch (error) {
        // 停止后保存失败也要告诉界面本次暂停了谁，便于原处恢复（283 R05）。
        // 多角色暂停超时时，实际已停止的角色由错误详情带回（283 §4 R05）。
        const stopped = pausedRoleIds.length > 0
          ? pausedRoleIds
          : pausedRoleIdsFromError(error);
        if (stopped.length > 0 && error instanceof AppError) {
          throw withMaintenanceDetails(error, stopped);
        }
        throw error;
      } finally {
        if (maintenance) {
          services.resources.endMaintenance(resourceId);
        }
      }
    },
  );

  router.add(
    "DELETE",
    "/v1/resources/:resourceId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.resources.remove(params.resourceId ?? ""),
    }),
  );

  router.add(
    "POST",
    "/v1/resources/:resourceId/models",
    async ({ params }): Promise<JsonResponse> => ({
      status: 200,
      body: await services.modelServices.listModelsForResource(
        params.resourceId ?? "",
      ),
    }),
  );

  router.add(
    "POST",
    "/v1/resources/:resourceId/model-test",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<ResourceModelTestBody>(
        resourceModelTestSchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: await services.modelServices.testForResource(
          params.resourceId ?? "",
          body.model,
        ),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/bindings",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.resources.bindingsView(params.roleId ?? ""),
    }),
  );

  router.add(
    "PUT",
    "/v1/roles/:roleId/bindings",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<PutBindingsBody>(
        putBindingsSchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.resources.replaceBindings(
          params.roleId ?? "",
          body.bindings,
          body.expectedRevision,
        ),
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/memory/search",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<MemorySearchBody>(
        memorySearchBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.memory.search(params.roleId ?? "", body, {
          mode: "manual",
        }),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/memory/events/:eventId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.memory.getEvent(
        params.roleId ?? "",
        params.eventId ?? "",
      ),
    }),
  );

  router.add(
    "PATCH",
    "/v1/roles/:roleId/memory/events/:eventId",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<EventCorrectionBody>(
        eventCorrectionBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.memory.correctEvent(
          params.roleId ?? "",
          params.eventId ?? "",
          body,
        ),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/memory/evidence/:evidenceId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.memory.getEvidence(
        params.roleId ?? "",
        params.evidenceId ?? "",
      ),
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/memory/summaries/:summaryId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.memory.getSummary(
        params.roleId ?? "",
        params.summaryId ?? "",
      ),
    }),
  );

  router.add(
    "PATCH",
    "/v1/roles/:roleId/memory/summaries/:summaryId",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<SummaryCorrectionBody>(
        summaryCorrectionBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.memory.correctSummary(
          params.roleId ?? "",
          params.summaryId ?? "",
          body,
        ),
      };
    },
  );

  router.add("GET", "/v1/roles/:roleId/diaries", ({ params }): JsonResponse => ({
    status: 200,
    body: { items: services.memory.listDiaries(params.roleId ?? "") },
  }));

  router.add(
    "POST",
    "/v1/roles/:roleId/diaries",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<DiaryCreateBody>(
        diaryCreateBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 201,
        body: services.memory.createDiary(params.roleId ?? "", body),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/diaries/:diaryId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.memory.getDiary(
        params.roleId ?? "",
        params.diaryId ?? "",
      ),
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/memory/status",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.memory.getStatus(params.roleId ?? ""),
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/memory/batches",
    ({ params, url }): JsonResponse => {
      const limit = queryInt(url, "limit", {
        min: 1,
        max: 200,
        defaultValue: 50,
      });
      return {
        status: 200,
        body: {
          items: services.memory.listBatches(params.roleId ?? "", limit),
        },
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/memory/batches",
    ({ params }): JsonResponse => {
      const roleId = params.roleId ?? "";
      // 删除收尾期间不再接收新的手动整理；已有任务照常收尾（283 §15 R03）。
      if (services.roleDeletion.isDeleting(roleId)) {
        throw new HttpError(
          409,
          "ROLE_DELETING",
          "角色正在删除，不能再发起记忆整理",
          { roleId },
        );
      }
      const result = services.memory.trigger(roleId);
      void services.conversation.runMemoryPending(roleId);
      return { status: 202, body: result };
    },
  );

  router.add(
    "POST",
    "/v1/model-services/models",
    async ({ request }): Promise<JsonResponse> => {
      const body = parseBody<ModelServiceConfigBody>(
        modelServiceConfigBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: await services.modelServices.listModels(body),
      };
    },
  );

  router.add(
    "POST",
    "/v1/model-services/test",
    async ({ request }): Promise<JsonResponse> => {
      const body = parseBody<ModelServiceTestBody>(
        modelServiceTestBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: await services.modelServices.test(body),
      };
    },
  );

  registerAppearanceRoutes(router, services);
  registerVoiceRoutes(router, services);
  registerSceneImageRoutes(router, services);
  registerImageServiceRoutes(router, services);

  return router;
}

function parseSseCursor(
  request: import("node:http").IncomingMessage,
  url: URL,
): number | null {
  const header = request.headers["last-event-id"];
  const candidates = [
    url.searchParams.get("after"),
    typeof header === "string" ? header : null,
  ].filter((raw): raw is string => raw !== null);
  if (candidates.length === 0) {
    return null;
  }
  // EventSource 自动重连会保留原 URL 并补上 Last-Event-ID；
  // 两边同时存在时从较新的游标继续，避免重复重放。
  let cursor = 0;
  for (const raw of candidates) {
    if (!/^\d+$/.test(raw)) {
      throw new SseCursorInvalidError(raw);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SseCursorInvalidError(raw);
    }
    cursor = Math.max(cursor, value);
  }
  return cursor;
}

/**
 * 保存失败时补上本次已暂停的角色（283 R05）：界面可保留草稿、显示实际
 * 状态，并在原处提供恢复入口。
 */
function withMaintenanceDetails(
  error: AppError,
  pausedRoleIds: readonly string[],
): HttpError {
  const details =
    error.details !== null &&
    typeof error.details === "object" &&
    !Array.isArray(error.details)
      ? (error.details as Record<string, unknown>)
      : {};
  return new HttpError(error.status, error.code, error.message, {
    ...details,
    maintenance: { pausedRoleIds: [...pausedRoleIds] },
  });
}

/** 从暂停协调抛出的错误详情里读取本次已停止的角色（283 §4 R05）。 */
function pausedRoleIdsFromError(error: unknown): string[] {
  if (!(error instanceof AppError)) {
    return [];
  }
  const details = error.details;
  if (details === null || typeof details !== "object") {
    return [];
  }
  const ids = (details as { pausedRoleIds?: unknown }).pausedRoleIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}
