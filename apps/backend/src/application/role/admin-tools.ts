import { AppError } from "../../domain/errors.js";
import type {
  ConversationTool,
  ConversationToolContext,
  ConversationToolOutcome,
} from "../../domain/conversation.js";
import type { ResourceKind } from "../../domain/resource.js";
import type { AutonomyService } from "../conversation/autonomy-service.js";
import type { ConversationService } from "../conversation/conversation-service.js";
import type { GlobalVoiceService } from "../media/global-voice-service.js";
import type { ImageServiceService } from "../media/image-service.js";
import type { MemoryQueryService } from "../memory/memory-query-service.js";
import type { MessageService } from "../conversation/message-service.js";
import type { ModelService } from "../resources/model-service.js";
import type { ResourceService } from "../resources/resource-service.js";
import type { RoleActivityService } from "./role-activity-service.js";
import type { RoleService } from "./role-service.js";

/**
 * 夏澄内部管理工具（DL-159，方案 A）。
 *
 * 只在 `builtin_key = 'xiacheng'` 的预置助手上挂载：直接调用现有应用服务，
 * 不走本地 HTTP 自循环，保留操作来源与任务记录。
 *
 * 读写边界（方案 A）：
 * - 只读：可查询全部角色、活动三态、任务／用量、记忆、资源与媒体服务；
 * - 写：可管理**其他普通角色**的设定、绑定、额度与启停，以及全局模型／MCP／Skill；
 * - 红线：修改夏澄自身配置、其正在使用的模型连接、以及任何全局语音／生图服务
 *   一律返回 `409 SELF_MODIFICATION_VIA_SETTINGS_ONLY`，引导用户去设置页。
 */
export interface AdminToolServices {
  /** 当前内置助手角色编号；由 loadAgentTools 按实际角色注入。 */
  builtinRoleId?: string;
  roles: RoleService;
  activity: RoleActivityService;
  messages: MessageService;
  memory: MemoryQueryService;
  autonomy: AutonomyService;
  /** 对话服务；由应用层构造完成后补上（任务查询与手动记忆整理使用）。 */
  conversation?: ConversationService;
  resources: ResourceService;
  modelServices: ModelService;
  voiceServices: GlobalVoiceService;
  imageServices: ImageServiceService;
  now: () => Date;
}

export const SELF_MODIFICATION_CODE = "SELF_MODIFICATION_VIA_SETTINGS_ONLY";

const STOP_TIMEOUT_MS = 15_000;

export function createAdminTools(input: AdminToolServices): ConversationTool[] {
  const builtinRoleId = input.builtinRoleId ?? "";
  const {
    roles,
    activity,
    messages,
    memory,
    autonomy,
    resources,
    modelServices,
    voiceServices,
    imageServices,
  } = input;

  /** 对话服务在应用层构造完成后补上；读取任务前确认已就绪。 */
  const conversationService = (): ConversationService => {
    const service = input.conversation;
    if (service === undefined) {
      throw new AppError(503, "CONVERSATION_NOT_READY", "对话服务尚未就绪");
    }
    return service;
  };

  const rejectSettingsOnly = (message: string, details: Record<string, unknown> = {}): never => {
    throw new AppError(409, SELF_MODIFICATION_CODE, message, details);
  };

  const assertNotSelf = (roleId: string, action: string): void => {
    if (roleId === builtinRoleId) {
      rejectSettingsOnly(
        "这是修改我自己的配置；对话里不能自改，请到「角色配置」或「设置」页面操作。",
        { action, roleId },
      );
    }
  };

  const requireRole = (roleId: string): void => {
    roles.getRole(roleId);
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });

  /** 写入前先停到确认停止；返回是否需要恢复原活动态。 */
  const stopForWrite = async (roleId: string): Promise<boolean> => {
    const view = activity.view(roleId);
    if (view.state === "stopped") return false;
    activity.requestStop(roleId);
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (activity.view(roleId).state === "stopped") return true;
      await sleep(100);
    }
    throw new AppError(
      409,
      "ROLE_STOP_TIMEOUT",
      "目标角色没有在期限内确认停止，本次写入已放弃",
      { roleId, state: activity.view(roleId).state },
    );
  };

  /** 按参数或写入前的原状态恢复；恢复失败只汇报，不覆盖已完成的写入。 */
  const resumeIfNeeded = (roleId: string, wasActive: boolean): boolean => {
    if (!wasActive) return false;
    try {
      activity.resume(roleId);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * 停机后写入失败：把停机／恢复结果并入原错误 details 后重抛。
   * 保留原错误码（模型据此判断冲突类型），同时让回执明确给出角色已被恢复，
   * 避免写入失败把角色静默留在 stopped（包 2 §10.2 R04）。
   */
  const failAfterStop = (
    error: unknown,
    recovery: Record<string, unknown>,
  ): never => {
    if (error instanceof AppError) {
      const original =
        error.details !== null &&
        typeof error.details === "object" &&
        !Array.isArray(error.details)
          ? (error.details as Record<string, unknown>)
          : {};
      throw new AppError(error.status, error.code, error.message, {
        ...original,
        ...recovery,
      });
    }
    throw error;
  };

  /** 资源被夏澄自身占用（对话／记忆模型或任务续用）时禁止改写或删除。 */
  const assertResourceNotUsedBySelf = (
    resourceId: string,
    action: string,
  ): void => {
    const impact = resources.impact(resourceId);
    const selfUsage = impact.roles.find((role) => role.roleId === builtinRoleId);
    if (selfUsage !== undefined) {
      rejectSettingsOnly(
        "这个资源正被我使用，我无法在对话里改动它；请到「设置」页面修改。",
        { action, resourceId, usages: selfUsage.usages, taskIds: selfUsage.taskIds },
      );
    }
  };

  const requireResource = (resourceId: string) => resources.getView(resourceId);

  /**
   * 全局语音／生图服务的写入要求全员角色停止（GLOBAL_CONFIG_WRITES），
   * 包含夏澄自己，因此对话内一律拒绝并引导去设置页（DL-159 红线 3）。
   */
  const assertNotMediaService = (serviceId: string, action: string): void => {
    const voice = voiceServices.findRecord(serviceId);
    const image =
      voice === null ? imageServices.findRecord(serviceId) : null;
    if (voice !== null || image !== null) {
      rejectSettingsOnly(
        "全局语音／生图服务需要所有角色停止后由你在设置页修改，我在对话里不能改。",
        { action, serviceId, kind: voice !== null ? "voice" : "image_service" },
      );
    }
  };

  const listTools: ConversationTool[] = [
    defineTool(
      "app_roles_list",
      "查询全部角色档案：角色编号、显示名、是否内置、初始化状态、默认窗口与活动三态。只读。",
      { type: "object", properties: {} },
      async () =>
        roles.listRoles().map((role) => {
          const view = activity.view(role.roleId);
          return {
            roleId: role.roleId,
            displayName: role.displayName,
            isBuiltin: role.isBuiltin,
            builtinKey: role.builtinKey,
            initStatus: role.status,
            initError: role.initError,
            defaultWindowId: role.defaultWindowId,
            activity: view.state,
            running: view.running,
          };
        }),
    ),
    defineTool(
      "app_role_get",
      "读取单个角色的详细状态：设定正文摘要、只读介绍、活动态、自主额度、最近任务与绑定数量。只读。",
      {
        type: "object",
        properties: { roleId: { type: "string" } },
        required: ["roleId"],
      },
      async (args) => {
        const roleId = stringArg(args, "roleId");
        if (roleId === null) return badArguments("app_role_get 需要 roleId");
        const role = roles.getRole(roleId);
        const view = activity.view(roleId);
        return {
          roleId: role.roleId,
          displayName: role.displayName,
          isBuiltin: role.isBuiltin,
          bio: role.bio,
          definitionText: truncate(role.definition.text, 2000),
          stateVersion: role.stateVersion,
          defaultWindowId: role.defaultWindowId,
          activity: view.state,
          running: view.running,
          budget: autonomy.getBudget(roleId),
          bindings: resources.listBindings(roleId).map((binding) => ({
            capability: binding.capability,
            resourceId: binding.resourceId,
            modelName: binding.modelName,
            enabled: binding.enabled,
          })),
          tasks: conversationService().listTasks(roleId).slice(-5),
        };
      },
    ),
    defineTool(
      "app_activities_list",
      "列出所有角色的活动状态（active／stopping／stopped）与是否有执行在跑。只读。",
      { type: "object", properties: {} },
      async () =>
        activity.list().map((view) => ({
          roleId: view.roleId,
          initStatus: view.initStatus,
          state: view.state,
          running: view.running,
          updatedAt: view.updatedAt,
        })),
    ),
    defineTool(
      "app_role_records_query",
      "按角色查询记录：窗口消息、任务（含 token 用量）、记忆检索结果、日记、自主额度与唤醒队列。只读。",
      {
        type: "object",
        properties: {
          roleId: { type: "string" },
          kind: {
            type: "string",
            enum: ["messages", "tasks", "task", "memories", "diaries", "budget", "wakes"],
          },
          windowId: { type: "string", description: "可选：默认取角色主窗口" },
          taskId: { type: "string", description: "kind=task 时必填" },
          query: { type: "string", description: "kind=memories 的检索词" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["roleId", "kind"],
      },
      async (args) => {
        const roleId = stringArg(args, "roleId");
        const kind = stringArg(args, "kind");
        if (roleId === null || kind === null) {
          return badArguments("app_role_records_query 需要 roleId 与 kind");
        }
        requireRole(roleId);
        const limit = integerArg(args, "limit") ?? 20;
        switch (kind) {
          case "messages": {
            const role = roles.getRole(roleId);
            const windowId = stringArg(args, "windowId") ?? role.defaultWindowId;
            const page = messages.list(roleId, windowId, null, limit);
            return {
              windowId,
              items: page.items.map((message) => ({
                messageId: message.messageId,
                sender: message.sender,
                status: message.status,
                content: truncate(message.content, 1000),
                sequence: message.sequence,
                createdAt: message.createdAt,
              })),
              nextBefore: page.nextBefore,
              nextAfter: page.nextAfter,
            };
          }
          case "tasks":
            return conversationService().listTasks(roleId).slice(-limit);
          case "task": {
            const taskId = stringArg(args, "taskId");
            if (taskId === null) return badArguments("kind=task 需要 taskId");
            return conversationService().getTask(roleId, taskId);
          }
          case "memories": {
            const query = stringArg(args, "query") ?? "";
            const result = memory.search(roleId, {
              ...(query.length === 0 ? {} : { query }),
              limit,
            });
            return {
              retrievalId: result.retrievalId,
              items: result.items.map((item) => ({
                type: item.type,
                id: item.id,
                title: item.title,
                snippet: item.snippet,
              })),
            };
          }
          case "diaries":
            return memory.listDiaries(roleId).slice(-limit);
          case "budget":
            return autonomy.getBudget(roleId);
          case "wakes":
            return autonomy.listWakes(roleId, limit);
          default:
            return badArguments(`不支持的查询类型 ${kind}`);
        }
      },
    ),
    defineTool(
      "app_resources_list",
      "列出全局资源（模型／MCP／Skill）：名称、启用态与已脱敏配置。绝不返回密钥明文。只读。",
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["model", "mcp", "skill"] },
        },
      },
      async (args) => {
        const kind = stringArg(args, "kind");
        const items = resources.list(
          kind === "model" || kind === "mcp" || kind === "skill"
            ? (kind as ResourceKind)
            : undefined,
        );
        return items.map((view) => ({
          resourceId: view.resourceId,
          kind: view.kind,
          name: view.name,
          enabled: view.enabled,
          redacted: view.redacted,
          config: view.config,
        }));
      },
    ),
    defineTool(
      "app_resource_inspect",
      "检查一个全局资源的影响范围与引用（哪些角色在用、是否可改可删），配置已脱敏。只读。",
      {
        type: "object",
        properties: { resourceId: { type: "string" } },
        required: ["resourceId"],
      },
      async (args) => {
        const resourceId = stringArg(args, "resourceId");
        if (resourceId === null) return badArguments("app_resource_inspect 需要 resourceId");
        const view = requireResource(resourceId);
        const impact = resources.impact(resourceId);
        const references = resources.references(resourceId);
        return {
          resource: {
            resourceId: view.resourceId,
            kind: view.kind,
            name: view.name,
            enabled: view.enabled,
            redacted: view.redacted,
            config: view.config,
          },
          impact: {
            roles: impact.roles.map((role) => ({
              roleId: role.roleId,
              displayName: role.displayName,
              usages: role.usages,
              state: role.state,
              running: role.running,
              taskIds: role.taskIds,
            })),
            blockingTasks: impact.blockingTasks,
          },
          references: {
            canUpdate: references.canUpdate,
            canDisable: references.canDisable,
            canDelete: references.canDelete,
            items: references.references.map((item) => ({
              roleId: item.roleId,
              reason: item.reason,
              capability: item.capability,
              bindingEnabled: item.bindingEnabled,
              ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
              ...(item.taskStatus === undefined
                ? {}
                : { taskStatus: item.taskStatus }),
            })),
          },
          usedBySelf: impact.roles.some((role) => role.roleId === builtinRoleId),
        };
      },
    ),
    defineTool(
      "app_media_services_list",
      "列出全局语音服务与生图服务（名称、启用态、协议与地址等脱敏配置）。只读。",
      { type: "object", properties: {} },
      async () => {
        const voiceConfig = voiceServices.list();
        return {
          voice: voiceConfig.map((service) => ({
            serviceId: service.serviceId,
            name: service.name,
            enabled: service.enabled,
            config: service.config,
          })),
          image: imageServices.list().map((service) => ({
            serviceId: service.serviceId,
            name: service.name,
            enabled: service.enabled,
            redacted: true,
            config: service.config,
          })),
        };
      },
    ),
  ];

  const roleWriteTools: ConversationTool[] = [
    defineTool(
      "app_role_create",
      "创建一个新的普通角色（初始处于停止态）。返回新角色编号。",
      {
        type: "object",
        properties: {
          displayName: { type: "string" },
          definitionText: { type: "string" },
        },
        required: ["displayName", "definitionText"],
      },
      async (args) => {
        const displayName = stringArg(args, "displayName");
        const definitionText = stringArg(args, "definitionText");
        if (displayName === null || definitionText === null) {
          return badArguments("app_role_create 需要 displayName 与 definitionText");
        }
        const role = roles.createRole({
          displayName,
          definition: { text: definitionText },
        });
        return {
          roleId: role.roleId,
          displayName: role.displayName,
          activity: activity.view(role.roleId).state,
        };
      },
    ),
    defineTool(
      "app_role_activity",
      "启动或停止指定普通角色（不能操作夏澄自己）。停止会等后端确认停止后再返回。",
      {
        type: "object",
        properties: {
          roleId: { type: "string" },
          action: { type: "string", enum: ["start", "stop"] },
        },
        required: ["roleId", "action"],
      },
      async (args) => {
        const roleId = stringArg(args, "roleId");
        const action = stringArg(args, "action");
        if (roleId === null || (action !== "start" && action !== "stop")) {
          return badArguments("app_role_activity 需要 roleId 与 action(start|stop)");
        }
        assertNotSelf(roleId, `activity_${action}`);
        requireRole(roleId);
        if (action === "start") {
          activity.resume(roleId);
          return { roleId, action, activity: activity.view(roleId).state };
        }
        const wasActive = await stopForWrite(roleId);
        return {
          roleId,
          action,
          activity: activity.view(roleId).state,
          stoppedFromActive: wasActive,
        };
      },
    ),
    defineTool(
      "app_role_update",
      "修改其他普通角色的显示名或角色卡正文。运行中的角色会先停止并在成功后按原状态恢复。",
      {
        type: "object",
        properties: {
          roleId: { type: "string" },
          displayName: { type: "string" },
          definitionText: { type: "string" },
          resume: { type: "boolean", description: "默认按写入前状态恢复" },
        },
        required: ["roleId"],
      },
      async (args) => {
        const roleId = stringArg(args, "roleId");
        if (roleId === null) return badArguments("app_role_update 需要 roleId");
        assertNotSelf(roleId, "role_update");
        requireRole(roleId);
        const displayName = stringArg(args, "displayName");
        const definitionText = stringArg(args, "definitionText");
        if (displayName === null && definitionText === null) {
          return badArguments("app_role_update 至少需要 displayName 或 definitionText");
        }
        const wasActive = await stopForWrite(roleId);
        let updated;
        try {
          updated = roles.updateDefinition(roleId, {
            ...(displayName === null ? {} : { displayName }),
            ...(definitionText === null
              ? {}
              : { definition: { text: definitionText } }),
          });
        } catch (error) {
          const resumed = resumeIfNeeded(roleId, wasActive);
          return failAfterStop(error, {
            roleStopped: wasActive,
            resumed,
            activity: activity.view(roleId).state,
          });
        }
        const resume = args.resume === false ? false : wasActive;
        const resumed = resume ? resumeIfNeeded(roleId, wasActive) : false;
        return {
          roleId,
          definitionRevision: updated.definitionRevision,
          stoppedForWrite: wasActive,
          resumed,
          activity: activity.view(roleId).state,
        };
      },
    ),
    defineTool(
      "app_role_bindings_set",
      "整体替换其他普通角色的能力绑定（对话模型／记忆模型／MCP／Skill）。运行中的角色会先停止。",
      {
        type: "object",
        properties: {
          roleId: { type: "string" },
          bindings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                capability: {
                  type: "string",
                  enum: ["chat_model", "memory_model", "mcp", "skill"],
                },
                resourceId: { type: "string" },
                modelName: { type: "string" },
                enabled: { type: "boolean" },
              },
              required: ["capability", "resourceId"],
            },
          },
          expectedRevision: { type: "string" },
          resume: { type: "boolean" },
        },
        required: ["roleId", "bindings"],
      },
      async (args) => {
        const roleId = stringArg(args, "roleId");
        if (roleId === null) return badArguments("app_role_bindings_set 需要 roleId");
        assertNotSelf(roleId, "role_bindings_set");
        requireRole(roleId);
        const raw = Array.isArray(args.bindings) ? args.bindings : null;
        if (raw === null) return badArguments("bindings 必须是数组");
        const parsed: Array<{
          capability: "chat_model" | "memory_model" | "mcp" | "skill";
          resourceId: string;
          modelName?: string;
          enabled: boolean;
        }> = [];
        for (const entry of raw) {
          const record = asObject(entry);
          if (record === null) return badArguments("bindings 的每一项必须是对象");
          const capability = record.capability;
          const resourceId = record.resourceId;
          if (
            (capability !== "chat_model" &&
              capability !== "memory_model" &&
              capability !== "mcp" &&
              capability !== "skill") ||
            typeof resourceId !== "string"
          ) {
            return badArguments("bindings 需要合法的 capability 与 resourceId");
          }
          parsed.push({
            capability,
            resourceId,
            ...(typeof record.modelName === "string"
              ? { modelName: record.modelName }
              : {}),
            enabled: record.enabled !== false,
          });
        }
        const wasActive = await stopForWrite(roleId);
        const expectedRevision = stringArg(args, "expectedRevision");
        let view;
        try {
          view = resources.replaceBindings(
            roleId,
            parsed,
            expectedRevision ?? undefined,
          );
        } catch (error) {
          const resumed = resumeIfNeeded(roleId, wasActive);
          return failAfterStop(error, {
            roleStopped: wasActive,
            resumed,
            activity: activity.view(roleId).state,
          });
        }
        const resume = args.resume === false ? false : wasActive;
        const resumed = resume ? resumeIfNeeded(roleId, wasActive) : false;
        return {
          roleId,
          revision: view.revision,
          bindings: view.items,
          stoppedForWrite: wasActive,
          resumed,
        };
      },
    ),
    defineTool(
      "app_role_autonomy_set",
      "设置其他普通角色的自主活动每日额度（或无限）。不能修改夏澄自己的额度。",
      {
        type: "object",
        properties: {
          roleId: { type: "string" },
          unlimited: { type: "boolean" },
          dailyLimit: { type: "integer", minimum: 1 },
        },
        required: ["roleId", "unlimited"],
      },
      async (args) => {
        const roleId = stringArg(args, "roleId");
        if (roleId === null || typeof args.unlimited !== "boolean") {
          return badArguments("app_role_autonomy_set 需要 roleId 与 unlimited");
        }
        assertNotSelf(roleId, "role_autonomy_set");
        requireRole(roleId);
        const dailyLimit = integerArg(args, "dailyLimit");
        return autonomy.setBudget(roleId, {
          unlimited: args.unlimited,
          ...(dailyLimit === null ? {} : { dailyLimit }),
        });
      },
    ),
  ];

  const resourceWriteTools: ConversationTool[] = [
    defineTool(
      "app_resource_create",
      "新建全局资源：模型／MCP／Skill／语音服务／生图服务。不能修改夏澄正在使用的模型连接。",
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["model", "mcp", "skill", "voice", "image_service"],
          },
          name: { type: "string" },
          config: { type: "object" },
          secret: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["kind", "name", "config"],
      },
      async (args) => {
        const kind = stringArg(args, "kind");
        const name = stringArg(args, "name");
        const config = asObject(args.config);
        if (kind === null || name === null || config === null) {
          return badArguments("app_resource_create 需要 kind、name 与 config");
        }
        const secret = stringArg(args, "secret");
        const enabled = args.enabled === false ? false : true;
        if (kind === "voice") {
          const created = voiceServices.create({
            name,
            config,
            enabled,
          });
          return { kind, serviceId: created.serviceId, name: created.name };
        }
        if (kind === "image_service") {
          const created = imageServices.create({
            name,
            config,
            enabled,
            ...(secret === null ? {} : { secret }),
          });
          return { kind, serviceId: created.serviceId, name: created.name };
        }
        if (kind !== "model" && kind !== "mcp" && kind !== "skill") {
          return badArguments(`不支持创建的资源类型 ${kind}`);
        }
        const created = resources.create({
          kind,
          name,
          config,
          enabled,
          ...(secret === null ? {} : { secret }),
        });
        return {
          kind,
          resourceId: created.resourceId,
          name: created.name,
          enabled: created.enabled,
        };
      },
    ),
    defineTool(
      "app_resource_toggle",
      "启用或停用全局 MCP／Skill（只切换开关，立即对下一个新任务生效）。",
      {
        type: "object",
        properties: {
          resourceId: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["resourceId", "enabled"],
      },
      async (args) => {
        const resourceId = stringArg(args, "resourceId");
        if (resourceId === null || typeof args.enabled !== "boolean") {
          return badArguments("app_resource_toggle 需要 resourceId 与 enabled");
        }
        assertNotMediaService(resourceId, "resource_toggle");
        const resource = requireResource(resourceId);
        if (resource.kind !== "mcp" && resource.kind !== "skill") {
          rejectSettingsOnly(
            "只有 MCP／Skill 支持在对话里直接启停；模型、语音与生图服务请到设置页操作。",
            { resourceId, kind: resource.kind },
          );
        }
        assertResourceNotUsedBySelf(resourceId, "resource_toggle");
        const view = resources.update(resourceId, { enabled: args.enabled });
        return { resourceId, enabled: view.enabled, name: view.name };
      },
    ),
    defineTool(
      "app_resource_update",
      "修改全局模型／MCP／Skill 的名称、启停或连接配置；只依赖普通角色时按维护流程暂停并汇报。",
      {
        type: "object",
        properties: {
          resourceId: { type: "string" },
          name: { type: "string" },
          config: { type: "object" },
          secret: { type: "string" },
          enabled: { type: "boolean" },
          resumeRoles: { type: "boolean", description: "默认不自动恢复被暂停的角色" },
        },
        required: ["resourceId"],
      },
      async (args) => {
        const resourceId = stringArg(args, "resourceId");
        if (resourceId === null) return badArguments("app_resource_update 需要 resourceId");
        assertNotMediaService(resourceId, "resource_update");
        requireResource(resourceId);
        assertResourceNotUsedBySelf(resourceId, "resource_update");
        const patch: Record<string, unknown> = {};
        const name = stringArg(args, "name");
        const config = asObject(args.config);
        const secret = stringArg(args, "secret");
        if (name !== null) patch.name = name;
        if (config !== null) patch.config = config;
        if (secret !== null) patch.secret = secret;
        if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
        if (Object.keys(patch).length === 0) {
          return badArguments("没有需要更新的字段");
        }
        resources.validateUpdate(resourceId, patch);
        const plan = resources.maintenancePlan(resourceId, patch);
        let maintenance = false;
        let pausedRoleIds: string[] = [];
        let updatedView: ReturnType<typeof resources.update> | null = null;
        let failure: unknown = null;
        let resumedRoleIds: string[] = [];
        try {
          if (plan.connectionChanged) {
            resources.beginMaintenance(resourceId);
            maintenance = true;
          }
          if (plan.pauseRoleIds.length > 0) {
            const pause = resources.pauseRoles;
            if (pause === null) {
              throw new AppError(
                409,
                "ROLES_NOT_STOPPED",
                "角色维护协调尚未配置，请稍后重试",
                { roleIds: plan.pauseRoleIds },
              );
            }
            pausedRoleIds = (await pause(plan.pauseRoleIds)).pausedRoleIds;
          }
          updatedView = resources.update(resourceId, patch);
        } catch (error) {
          failure = error;
        } finally {
          // 必须在维护窗口结束后再恢复角色：维护中 resume 会被 resumeGuard 拒绝（283 R01）。
          if (maintenance) {
            resources.endMaintenance(resourceId);
          }
          // 成功时按 resumeRoles 参数恢复；失败时无条件回滚本次暂停的角色，
          // 避免写入失败把角色静默留在 stopped（包 2 §10.2 R04）。
          const shouldResume = failure !== null || args.resumeRoles === true;
          if (shouldResume) {
            resumedRoleIds = pausedRoleIds.filter((roleId) => {
              try {
                activity.resume(roleId);
                return true;
              } catch {
                return false;
              }
            });
          }
          if (failure !== null) {
            failAfterStop(failure, {
              pausedRoleIds,
              resumedRoleIds,
              rolledBackRoleIds: resumedRoleIds,
              activity: pausedRoleIds.map((roleId) => ({
                roleId,
                state: activity.view(roleId).state,
              })),
            });
          }
        }
        return {
          resourceId,
          name: updatedView!.name,
          enabled: updatedView!.enabled,
          connectionChanged: plan.connectionChanged,
          pausedRoleIds,
          resumedRoleIds,
        };
      },
    ),
    defineTool(
      "app_resource_delete",
      "删除全局模型／MCP／Skill。正在被夏澄使用或仍有活跃任务依赖时会被拒绝。",
      {
        type: "object",
        properties: { resourceId: { type: "string" } },
        required: ["resourceId"],
      },
      async (args) => {
        const resourceId = stringArg(args, "resourceId");
        if (resourceId === null) return badArguments("app_resource_delete 需要 resourceId");
        assertNotMediaService(resourceId, "resource_delete");
        assertResourceNotUsedBySelf(resourceId, "resource_delete");
        const removed = resources.remove(resourceId);
        return removed;
      },
    ),
    defineTool(
      "app_model_test",
      "对已保存的模型服务发起一次真实模型测试，返回连通性与耗时。只读探测，不改配置。",
      {
        type: "object",
        properties: {
          resourceId: { type: "string" },
          model: { type: "string" },
        },
        required: ["resourceId", "model"],
      },
      async (args) => {
        const resourceId = stringArg(args, "resourceId");
        const model = stringArg(args, "model");
        if (resourceId === null || model === null) {
          return badArguments("app_model_test 需要 resourceId 与 model");
        }
        return modelServices.testForResource(resourceId, model);
      },
    ),
    defineTool(
      "app_role_memory_trigger",
      "触发指定角色的手动记忆整理批次（与设置页「立即整理」同语义）。",
      {
        type: "object",
        properties: { roleId: { type: "string" } },
        required: ["roleId"],
      },
      async (args) => {
        const roleId = stringArg(args, "roleId");
        if (roleId === null) return badArguments("app_role_memory_trigger 需要 roleId");
        requireRole(roleId);
        const result = memory.trigger(roleId);
        void input.conversation?.runMemoryPending(roleId);
        return { roleId, ...result };
      },
    ),
    defineTool(
      "app_role_wake_manage",
      "管理普通角色的唤醒安排：列出、取消或新增一次唤醒（可携带原任务编号以接回任务链）。",
      {
        type: "object",
        properties: {
          roleId: { type: "string" },
          action: { type: "string", enum: ["list", "cancel", "schedule"] },
          wakeId: { type: "string" },
          wakeAt: { type: "string", description: "ISO 时间" },
          intent: { type: "string" },
          taskId: { type: "string" },
        },
        required: ["roleId", "action"],
      },
      async (args) => {
        const roleId = stringArg(args, "roleId");
        const action = stringArg(args, "action");
        if (roleId === null || action === null) {
          return badArguments("app_role_wake_manage 需要 roleId 与 action");
        }
        requireRole(roleId);
        if (action === "list") {
          return autonomy.listWakes(roleId, 50);
        }
        if (action === "cancel") {
          const wakeId = stringArg(args, "wakeId");
          if (wakeId === null) return badArguments("cancel 需要 wakeId");
          return autonomy.cancelWake(roleId, wakeId);
        }
        if (action === "schedule") {
          const wakeAt = stringArg(args, "wakeAt");
          const intent = stringArg(args, "intent");
          if (wakeAt === null || intent === null) {
            return badArguments("schedule 需要 wakeAt 与 intent");
          }
          const taskId = stringArg(args, "taskId");
          return autonomy.scheduleWake(roleId, {
            wakeAt,
            intent,
            ...(taskId === null ? {} : { taskId }),
          });
        }
        return badArguments(`不支持的唤醒操作 ${action}`);
      },
    ),
  ];

  return [...listTools, ...roleWriteTools, ...resourceWriteTools];
}

function defineTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: (
    args: Record<string, unknown>,
    context: ConversationToolContext,
  ) => Promise<unknown> | unknown,
): ConversationTool {
  return {
    name,
    description,
    inputSchema,
    // 内部管理工具直接调用应用服务，按内部工具保存回执，不走 HTTP 自循环。
    source: "admin",
    async execute(args, context): Promise<ConversationToolOutcome> {
      try {
        const result = await handler(args, context);
        return { status: "success", rawResponse: result, adaptedResult: result };
      } catch (error) {
        const code =
          error instanceof AppError
            ? error.code
            : error instanceof Error && "code" in error
              ? String((error as { code?: unknown }).code)
              : "ADMIN_TOOL_FAILED";
        const message =
          error instanceof Error ? error.message : "内部管理操作失败";
        const details =
          error instanceof AppError ? (error.details ?? null) : null;
        return {
          status: "failed",
          diagnosticCode: code,
          adaptedResult: {
            error: { code, message, ...(details === null ? {} : { details }) },
          },
          error: { code, message },
        };
      }
    },
  };
}

function badArguments(message: string): never {
  throw new AppError(400, "INVALID_TOOL_ARGUMENTS", message);
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function integerArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function truncate(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length <= limit ? value : `${chars.slice(0, limit).join("")}…`;
}
