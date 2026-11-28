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
  TaskCancelBody,
  TaskFinishBody,
  AutonomyBudgetBody,
  AutonomyWakeBody,
  UpdateDefinitionBody,
  UpdateResourceBody,
} from "./schemas.js";
import { readJsonBody, readOptionalJsonBody } from "./body.js";
import { HttpError, type JsonResponse } from "./errors.js";
import type { Router } from "./router.js";
import type { AppearanceService } from "../application/media/appearance-service.js";
import type { ConversationService } from "../application/conversation/conversation-service.js";
import type { AutonomyService } from "../application/conversation/autonomy-service.js";
import type { FeedEventHub } from "../application/conversation/feed-events.js";
import type { MemoryQueryService } from "../application/memory/memory-query-service.js";
import type { MemoryEmbeddingSettingsService } from "../application/memory/memory-embedding-settings.js";
import { memoryEmbeddingSettingsUpdateSchema, memoryEmbeddingTestSchema } from "../application/memory/memory-embedding-settings.js";
import type { MessageService } from "../application/conversation/message-service.js";
import type { ModelService } from "../application/resources/model-service.js";
import type { ResourceService } from "../application/resources/resource-service.js";
import type { RoleService } from "../application/role/role-service.js";
import type { SceneImageService } from "../application/media/scene-image-service.js";
import type { ImageServiceService } from "../application/media/image-service.js";
import type { SceneImageSettingsService } from "../application/media/scene-image-settings.js";
import type { VoiceService } from "../application/media/voice-service.js";
import type { GlobalVoiceService } from "../application/media/global-voice-service.js";
import type { RoleActivityService } from "../application/role/role-activity-service.js";
import type { RoleDeletionService } from "../application/role/role-deletion-service.js";
import type { RoleTransferHttpService } from "../application/transfer/role-transfer-service.js";
import type { RoleWorkspaceService } from "../application/role/role-workspace-service.js";
import type { TokenUsageService } from "../application/resources/token-usage-service.js";
import {
  TOKEN_USAGE_CATEGORIES,
  TOKEN_USAGE_RANGES,
  type TokenUsageCategory,
  type TokenUsageRange,
} from "../domain/token-usage.js";
import { registerRoleActivityRoutes } from "./role-activity-routes.js";
import { registerRoleTransferWorkspaceRoutes } from "./role-transfer-workspace-routes.js";
import { registerExtensionImportRoutes } from "./extension-import-routes.js";
import { uiActionPayloadBytes, uiActionSchema } from "../application/extensions/extension-files.js";
import { extensionSummary, type CoplayShare } from "../application/extensions/extension-host.js";
import { z } from "zod";
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
  retryReplySchema,
  submitMessageSchema,
  summaryCorrectionBodySchema,
  taskCancelBodySchema,
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
import { registerVoiceServiceRoutes } from "./voice-service-routes.js";
import { putWorldbooksSchema } from "../domain/worldbook.js";
import { engineeringSettingsUpdate, type EngineeringPool } from "../mcp/engineering-pool.js";

import type { MediaMaintenance } from '../application/media/media-maintenance.js';

export interface ApiServices {
  engineeringPool: EngineeringPool;
  pi: import("../mcp/managed-pi.js").ManagedPi;
  toolProxy: import("../mcp/tool-proxy.js").PiToolProxy;
  modelProxy: import("../mcp/model-proxy.js").PiModelProxy;
  extensions: import("../application/extensions/extension-host.js").ExtensionHost;
  roles: RoleService;
  messages: MessageService;
  resources: ResourceService;
  memory: MemoryQueryService;
  memoryEmbeddingSettings: MemoryEmbeddingSettingsService;
  modelServices: ModelService;
  conversation: ConversationService;
  autonomy: AutonomyService;
  appearance: AppearanceService;
  voice: VoiceService;
  voiceServices: GlobalVoiceService;
  sceneImages: SceneImageService;
  imageServices: ImageServiceService;
  sceneImageSettings: SceneImageSettingsService;
  activity: RoleActivityService;
  roleDeletion: RoleDeletionService;
  roleWorkspace: RoleWorkspaceService;
  roleTransfer: RoleTransferHttpService;
  mediaMaintenance: MediaMaintenance;
  tokenUsage: TokenUsageService;
  feedEvents: FeedEventHub;
}

export function registerApiRoutes(
  router: Router,
  services: ApiServices,
  version: string,
): Router {
  for (const route of ["list", "call", "skill/read", "skill/run"]) {
    router.add("POST", "/v1/internal/tool-proxy/" + route, async ({ request }) => ({
      status: 200, body: await services.toolProxy.forward(request, route),
    }));
  }
  for (const [path, flavor] of [
    ["chat/completions", "openai-completions"], ["responses", "openai-responses"],
    ["v1/messages", "anthropic-messages"], ["models/:action", "google-generative-ai"],
    ["publishers/google/models/:action", "google-vertex"],
  ] as const) {
    router.add("POST", "/v1/internal/model-proxy/" + path, async ({ request, response, params }) => {
      await services.modelProxy.forward(request, response, flavor, params.action);
      return undefined;
    });
  }
  router.add("POST", "/v1/internal/model-proxy/release", ({ request, response }) => {
    services.modelProxy.release(request);
    response.writeHead(204).end();
    return undefined;
  });
  router.add("GET", "/v1/engineering/jobs", ({ url }) => {
    if (url.searchParams.get("includeRecent") !== "1") {
      return { status: 200, body: { items: services.pi.running() } };
    }
    const limit = queryInt(url, "limit", { min: 1, max: 50, defaultValue: 20 });
    return { status: 200, body: { items: services.pi.running(), recent: services.pi.recent(limit) } };
  });
  router.add("GET", "/v1/engineering/settings", () => ({ status: 200, body: services.engineeringPool.settings() }));
  router.add("PUT", "/v1/engineering/settings", async ({ request }) => ({
    status: 200, body: services.engineeringPool.update(parseBody(engineeringSettingsUpdate, await readJsonBody(request))),
  }));
  for (const route of ["/v1/engineering/jobs/:jobId/cancel", "/v1/engineering-jobs/:jobId/cancel"]) router.add("POST", route, async ({ params }) => {
    const result = await services.pi.cancel(params.jobId ?? "");
    if (result.isError) throw new AppError(409, "PI_CANCEL_FAILED", "工程取消失败");
    return { status: 200, body: result.structuredContent };
  });
  router.add("GET", "/v1/engineering/events", ({ response }) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const send = () => response.write("event: snapshot\ndata: " + JSON.stringify(services.pi.running()) + "\n\n");
    response.once("close", services.pi.subscribe(send));
    send();
    return undefined;
  });
  // 状态流变更推送：只发送主题与序号，客户端按需重取对应角色的数据。
  router.add("GET", "/v1/feed-events", ({ response }) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.write(`event: ready\ndata: ${JSON.stringify({ seq: services.feedEvents.currentSeq() })}\n\n`);
    const unsubscribe = services.feedEvents.subscribe((event) => {
      response.write(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
    });
    response.once("close", unsubscribe);
    return undefined;
  });
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
  registerRoleTransferWorkspaceRoutes(router, services);
  registerExtensionImportRoutes(router, services.resources);
  router.add("GET", "/v1/extension-events", ({ request, response }) => {
    const header = request.headers["last-event-id"];
    let after: Record<string, number> | undefined;
    if (typeof header === "string") {
      try { after = z.record(z.string(), z.int().nonnegative()).parse(JSON.parse(header)); }
      catch { throw new SseCursorInvalidError(header); }
    }
    // 各角色独立分库，重连时分别续读。首次连接从各默认窗口的当前游标开始。
    const cursors: Record<string, number> = {};
    const replay: CoplayShare[] = [];
    for (const role of services.roles.listRoles()) {
      if (role.isBuiltin || !role.defaultWindowId) continue;
      const { roleId, defaultWindowId: windowId } = role;
      const history = services.autonomy.coplayShareHistory(roleId, windowId, after ? after[roleId] ?? 0 : null);
      cursors[roleId] = history.cursor;
      replay.push(...history.shares.map(share => ({ ...share, roleId, windowId })));
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const writeShare = (share: CoplayShare) => {
      cursors[share.roleId] = share.streamEventId;
      response.write(`id: ${JSON.stringify(cursors)}\nevent: coplay-share\ndata: ${JSON.stringify({ ...share, source: "autonomy_share" })}\n\n`);
    };
    response.write(`id: ${JSON.stringify(cursors)}\n`);
    const unsubscribe = services.extensions.subscribeUi((event, data) => {
      if (event === "coplay-share") writeShare(data as CoplayShare);
      else response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    for (const share of replay) writeShare(share);
    response.once("close", unsubscribe);
    return undefined;
  });
  router.add("GET", "/v1/extensions/:extId/ui/*asset", ({ params, url, response }) => {
    const file = "ui/" + params.asset;
    const body = services.extensions.uiAsset(params.extId ?? "", file, url.searchParams.get("v"));
    const types: Record<string, string> = { html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
      css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", txt: "text/plain; charset=utf-8",
      svg: "image/svg+xml", json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      webp: "image/webp", gif: "image/gif" };
    // 直接打开 HTTP 出口时保持无脚本沙箱，桌面协议自行签发独立 CSP。
    response.setHeader("content-security-policy", "sandbox; default-src 'none'");
    response.setHeader("x-content-type-options", "nosniff");
    return { status: 200, contentType: types[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream", body };
  });
  router.add("GET", "/v1/extensions", () => ({ status: 200, body: { items: services.extensions.list().map(extensionSummary) } }));
  router.add("GET", "/v1/extensions/:extId", ({ params }) => ({ status: 200, body: extensionSummary(services.extensions.get(params.extId ?? "")) }));
  router.add("POST", "/v1/extensions/:extId/ui-action", async ({ request, params }) => {
    const { version, action, payload, ...trigger } = parseBody(uiActionSchema, await readJsonBody(request, uiActionPayloadBytes + 256));
    if (Buffer.byteLength(JSON.stringify(payload)) > uiActionPayloadBytes)
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "界面动作的 JSON 载荷超过 16 KiB");
    const data = await services.extensions.uiAction(params.extId ?? "", version, action, payload, trigger);
    return { status: 200, body: { data } };
  });
  for (const action of ["enable", "disable", "reload"] as const) {
    router.add("POST", `/v1/extensions/:extId/${action}`, async ({ params }) =>
      ({ status: 200, body: await services.extensions.toggle(params.extId ?? "", action) }));
  }
  router.add("DELETE", "/v1/extensions/:extId", async ({ params }) =>
    ({ status: 200, body: await services.extensions.delete(params.extId ?? "") }));
  router.add("GET", "/v1/role-exchanges", ({ url }) => {
    const date = (name: string) => {
      const raw = url.searchParams.get(name);
      if (raw === null) return null;
      if (!Number.isFinite(Date.parse(raw))) throw new HttpError(400, "INVALID_QUERY", "时间格式无效");
      return new Date(raw).toISOString();
    };
    const items = services.conversation.exchanges.list(queryInt(url, "limit", { min: 1, max: 500, defaultValue: 100 }),
      queryInt(url, "offset", { min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0 }), date("from"), date("to"));
    return { status: 200, body: { items } };
  });
  router.add("GET", "/v1/role-exchanges/:sessionId", ({ params }) => ({
    status: 200, body: services.conversation.exchanges.detail(params.sessionId ?? ""),
  }));
  router.add("GET", "/v1/roles/:roleId/worldbooks", ({ params }) => ({
    status: 200, body: services.roles.getWorldbooks(params.roleId ?? ""),
  }));
  router.add("PUT", "/v1/roles/:roleId/worldbooks", async ({ params, request }) => {
    // 支持最大 16 本、每本 64 条及 JSON 转义开销，其他接口维持原请求限额。
    const { expectedRevision, books } = parseBody(putWorldbooksSchema, await readJsonBody(request, 24 * 1024 * 1024));
    return { status: 200, body: services.roles.putWorldbooks(params.roleId ?? "", expectedRevision, books) };
  });
  router.add("GET", "/v1/roles/:roleId/worldbooks/usage", ({ params, url }) => {
    const executionId = url.searchParams.get("executionId")?.trim();
    if (!executionId) throw new HttpError(400, "INVALID_QUERY", "请指定 executionId");
    return { status: 200, body: { items: services.roles.getWorldbookUsage(params.roleId ?? "", executionId) } };
  });
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
    "POST",
    "/v1/roles/:roleId/windows/:windowId/messages/:messageId/retry",
    async ({ request, params }): Promise<JsonResponse> => {
      const { executionId } = parseBody(retryReplySchema, await readJsonBody(request));
      return { status: 200, body: services.conversation.retryFailedReply(
        params.roleId ?? "", params.windowId ?? "", params.messageId ?? "", executionId,
      ) };
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

  router.add("GET", "/v1/roles/:roleId/share-events", async ({ request, response, params, url }) => {
    const seat = services.roles.getRole(params.roleId ?? "");
    if (!seat.isBuiltin) throw new HttpError(404, "ADMIN_SEAT_REQUIRED", "分享通知仅来自主角色席位");
    await services.conversation.streamEvents({roleId: seat.roleId, windowId: seat.defaultWindowId,
      after: parseSseCursor(request, url), clientId: null, sharesOnly: true, request, response});
    return undefined;
  });

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
    "POST",
    "/v1/roles/:roleId/tasks/:taskId/cancel",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<TaskCancelBody>(
        taskCancelBodySchema,
        await readOptionalJsonBody(request),
      );
      return {
        status: 200,
        body: services.conversation.cancelTask({
          roleId: params.roleId ?? "",
          taskId: params.taskId ?? "",
          ...(body.reason === undefined ? {} : { reason: body.reason }),
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
      const offset = queryInt(url, "offset", { min: 0, max: 1_000_000_000, defaultValue: 0 });
      return {
        status: 200,
        body: {
          items: services.autonomy.listWakes(params.roleId ?? "", limit, offset),
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
      const offset = queryInt(url, "offset", { min: 0, max: 1_000_000_000, defaultValue: 0 });
      return {
        status: 200,
        body: {
          items: url.searchParams.get("includeSharedMessage") === "1"
            ? services.autonomy.listActivitiesWithShares(params.roleId ?? "", limit, offset)
            : services.autonomy.listActivities(params.roleId ?? "", limit, offset),
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
    "POST",
    "/v1/resources/:resourceId/secret/reveal",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.resources.revealSecret(params.resourceId ?? ""),
    }),
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
        body: await services.memory.searchHybrid(params.roleId ?? "", body, {
          mode: "manual",
        }),
      };
    },
  );

  // 全局可选 Embedding 配置：未开启时记忆检索完全走纯 FTS5（409 ARCH-03）。
  router.add("GET", "/v1/memory/embedding-settings", (): JsonResponse => ({
    status: 200,
    body: { settings: services.memoryEmbeddingSettings.get() },
  }));

  router.add(
    "PUT",
    "/v1/memory/embedding-settings",
    async ({ request }): Promise<JsonResponse> => {
      const body = parseBody(
        memoryEmbeddingSettingsUpdateSchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: { settings: services.memoryEmbeddingSettings.update(body) },
      };
    },
  );

  router.add(
    "POST",
    "/v1/memory/embedding-settings/test",
    async ({ request }): Promise<JsonResponse> => {
      const input = parseBody(
        memoryEmbeddingTestSchema,
        await readJsonBody(request),
      );
      const result = await services.memoryEmbeddingSettings.testConnection(input);
      return { status: 200, body: { result } };
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
          "user_correction",
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
          "user_correction",
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
      const offset = queryInt(url, "offset", { min: 0, max: 1_000_000_000, defaultValue: 0 });
      return {
        status: 200,
        body: {
          items: services.memory.listBatches(params.roleId ?? "", limit, offset),
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

  router.add(
    "GET",
    "/v1/usage/tokens",
    ({ url }): JsonResponse => {
      const rangeRaw = url.searchParams.get("range")?.trim() || "7d";
      if (!(TOKEN_USAGE_RANGES as readonly string[]).includes(rangeRaw)) {
        throw new HttpError(400, "INVALID_QUERY", "range 必须为 today、7d、30d 或 all");
      }
      const categoryRaw = url.searchParams.get("category")?.trim() || null;
      if (
        categoryRaw !== null &&
        !(TOKEN_USAGE_CATEGORIES as readonly string[]).includes(categoryRaw)
      ) {
        throw new HttpError(400, "INVALID_QUERY", "不支持的用量用途分类");
      }
      const roleKey = url.searchParams.get("roleKey")?.trim() || null;
      const modelKey = url.searchParams.get("modelKey")?.trim() || null;
      return {
        status: 200,
        body: services.tokenUsage.getSummary({
          range: rangeRaw as TokenUsageRange,
          roleKey,
          category: categoryRaw as TokenUsageCategory | null,
          modelKey,
        }),
      };
    },
  );

  registerAppearanceRoutes(router, services);
  registerVoiceRoutes(router, services);
  registerVoiceServiceRoutes(router, services);
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
