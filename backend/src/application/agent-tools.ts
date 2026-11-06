import path from "node:path";
import { spawn } from "node:child_process";
import {
  eventCorrectionSchema,
  memorySearchRequestSchema,
  summaryCorrectionSchema,
} from "../domain/memory.js";
import {
  AppError,
  AutonomyBudgetExhaustedError,
  SkillNotFoundError,
} from "../domain/errors.js";
import type {
  ConversationTool,
  ConversationToolContext,
  ConversationToolOutcome,
  SkillBrief,
} from "../domain/conversation.js";
import { MemoryQueryService } from "./memory-query-service.js";
import type { AutonomyService } from "./autonomy-service.js";
import { McpToolClient, type McpToolInfo } from "../mcp/client.js";
import { SkillLibrary } from "../skills/skill-library.js";
import type { AppStore } from "../storage/app-store.js";
import type { RoleAccess } from "./role-access.js";

export interface AgentToolCatalog {
  tools: ConversationTool[];
  skillBriefs: SkillBrief[];
  warnings: string[];
  close(): Promise<void>;
}

export interface LoadAgentToolsInput {
  roleId: string;
  appStore: AppStore;
  roleAccess: RoleAccess;
  memory: MemoryQueryService;
  autonomy?: AutonomyService | null;
  allowAutonomyShare?: boolean;
  continuationResourceIds?: readonly string[];
  appRoot: string;
  workspaceDir: string;
}

const TOOL_RESULT_LIMIT = 8000;

export async function loadAgentTools(
  input: LoadAgentToolsInput,
): Promise<AgentToolCatalog> {
  const warnings: string[] = [];
  const mcpPools: McpConnectionPool[] = [];
  const tools: ConversationTool[] = [
    memorySearchTool(input.roleId, input.memory),
    memoryEventTool(input.roleId, input.memory),
    memoryEvidenceTool(input.roleId, input.memory),
    memorySummaryTool(input.roleId, input.memory),
    memoryCorrectEventTool(input.roleId, input.memory),
    memoryCorrectSummaryTool(input.roleId, input.memory),
    memorySummaryEvidenceTool(input.roleId, input.memory),
    diaryWriteTool(input.roleId, input.memory),
    memoryDiaryTool(input.roleId, input.memory),
    stateUpdateTool(),
    taskProgressTool(input.roleId, input.roleAccess),
    taskPauseTool(input.roleId, input.roleAccess),
    taskFinishTool(input.roleId, input.roleAccess),
    toolReconcileTool(input.roleId, input.roleAccess),
  ];
  if (input.autonomy !== null && input.autonomy !== undefined) {
    tools.push(autonomyScheduleTool(input.roleId, input.autonomy));
    if (input.allowAutonomyShare === true) {
      tools.push(autonomyShareTool(input.roleId, input.autonomy));
    }
  }
  const skillBriefs: SkillBrief[] = [];
  const skillResourceIds: string[] = [];
  const continuation = new Set(input.continuationResourceIds ?? []);
  const bindings = input.roleAccess.withStore(input.roleId, (storage) =>
    storage.business.listRoleBindings(input.roleId),
  );
  const candidates: Array<{
    resourceId: string;
    capability: "mcp" | "skill";
  }> = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (
      binding.capability !== "mcp" &&
      binding.capability !== "skill"
    ) {
      continue;
    }
    if (!binding.enabled && !continuation.has(binding.resourceId)) {
      continue;
    }
    seen.add(binding.resourceId);
    candidates.push({
      resourceId: binding.resourceId,
      capability: binding.capability,
    });
  }
  for (const resourceId of continuation) {
    if (seen.has(resourceId)) {
      continue;
    }
    let resource;
    try {
      resource = input.appStore.getResource(resourceId);
    } catch {
      continue;
    }
    if (resource.kind === "mcp" || resource.kind === "skill") {
      candidates.push({ resourceId, capability: resource.kind });
    }
  }
  for (const binding of candidates) {
    let resource;
    try {
      resource = input.appStore.getResource(binding.resourceId);
    } catch {
      continue;
    }
    if (!resource.enabled && !continuation.has(binding.resourceId)) {
      continue;
    }
    if (binding.capability === "skill" && resource.kind === "skill") {
      const library = skillLibraryFor(
        input.appStore,
        input.appRoot,
        resource.resourceId,
      );
      if (library === null) {
        warnings.push(`Skill 资源 ${resource.name} 缺少 sourcePath`);
        continue;
      }
      skillResourceIds.push(resource.resourceId);
      for (const metadata of library.list()) {
        skillBriefs.push({
          name: metadata.name,
          description: metadata.description,
          directory: metadata.directory,
        });
      }
      continue;
    }
    if (binding.capability === "mcp" && resource.kind === "mcp") {
      const config = readMcpConfig(input.appStore, resource.resourceId);
      if (config === null) {
        warnings.push(`MCP 资源 ${resource.name} 配置不完整`);
        continue;
      }
      let client: McpToolClient | null = null;
      try {
        client = await McpToolClient.connect(
          withWorkspaceEnv(config, input.workspaceDir),
          { cwd: input.workspaceDir },
        );
        const serverTools = await client.listTools();
        const pool = new McpConnectionPool(
          input.appStore,
          resource.resourceId,
          input.workspaceDir,
        );
        mcpPools.push(pool);
        tools.push(
          ...serverTools.map((tool, index) =>
            mcpTool(
              input.roleId,
              resource.name,
              tool,
              index,
              pool,
            ),
          ),
        );
      } catch (error) {
        warnings.push(
          `MCP 资源 ${resource.name} 不可用：${safeMessage(error)}`,
        );
      } finally {
        await client?.close().catch(() => {});
      }
    }
  }
  if (skillResourceIds.length > 0) {
    tools.push(
      skillReadTool(input.appStore, input.appRoot, skillResourceIds),
      skillRunTool(
        input.appStore,
        input.appRoot,
        skillResourceIds,
        input.workspaceDir,
      ),
    );
  }
  return {
    tools,
    skillBriefs: dedupeSkills(skillBriefs),
    warnings,
    async close() {
      await Promise.all(mcpPools.map((pool) => pool.close()));
    },
  };
}

function skillLibraryFor(
  appStore: AppStore,
  appRoot: string,
  resourceId: string,
): SkillLibrary | null {
  let resource;
  try {
    resource = appStore.getResource(resourceId);
  } catch {
    return null;
  }
  if (resource.kind !== "skill") {
    return null;
  }
  const sourcePath =
    typeof resource.config.sourcePath === "string"
      ? resource.config.sourcePath
      : "";
  if (sourcePath.length === 0) {
    return null;
  }
  return new SkillLibrary(
    path.isAbsolute(sourcePath)
      ? sourcePath
      : path.resolve(appRoot, sourcePath),
  );
}

function readMcpConfig(
  appStore: AppStore,
  resourceId: string,
): { command: string; args: string[]; env: Record<string, string> } | null {
  let resource;
  try {
    resource = appStore.getResource(resourceId);
  } catch {
    return null;
  }
  if (resource.kind !== "mcp") {
    return null;
  }
  const config = resource.config;
  if (
    typeof config.command !== "string" ||
    !Array.isArray(config.args) ||
    config.args.some((arg) => typeof arg !== "string")
  ) {
    return null;
  }
  const env =
    config.env !== null &&
    typeof config.env === "object" &&
    !Array.isArray(config.env)
      ? (config.env as Record<string, string>)
      : {};
  return {
    command: config.command,
    args: config.args as string[],
    env,
  };
}

function withWorkspaceEnv(
  config: { command: string; args: string[]; env: Record<string, string> },
  workspaceDir: string,
): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: config.command,
    args: config.args,
    env: { NOWADAYS_WORKSPACE: workspaceDir, ...config.env },
  };
}

function memorySearchTool(
  roleId: string,
  memory: MemoryQueryService,
): ConversationTool {
  return {
    name: "memory_search",
    source: "memory",
    description:
      "检索角色的长期记忆，同时返回事件、日常摘要和日记。成功但无命中时返回空列表；查询失败会返回错误，不能用未命中推断事情从未发生。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: ["event", "daily_summary", "diary"],
          },
        },
        people: { type: "array", items: { type: "string" } },
        topics: { type: "array", items: { type: "string" } },
        places: { type: "array", items: { type: "string" } },
        emotions: { type: "array", items: { type: "string" } },
        sources: { type: "array", items: { type: "string" } },
        dateFrom: { type: "string" },
        dateTo: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      return runTool(async () => {
        const parsed = memorySearchRequestSchema.safeParse(args);
        if (!parsed.success) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "memory_search 参数不符合检索契约",
          );
        }
        try {
          const result = memory.search(roleId, parsed.data, {
            mode: "agent",
            executionId: context.executionId,
          });
          return {
            status: "success",
            rawResponse: result,
            adaptedResult: {
              status: result.items.length === 0 ? "no_match" : "succeeded",
              retrievalId: result.retrievalId,
              items: result.items,
            },
          };
        } catch (error) {
          return failedOutcome(errorCode(error), safeMessage(error));
        }
      });
    },
  };
}

function memoryEventTool(
  roleId: string,
  memory: MemoryQueryService,
): ConversationTool {
  return {
    name: "memory_event",
    source: "memory",
    description:
      "读取一条记忆事件的详情、标签和原始来源。需要核对具体经历时使用。",
    inputSchema: {
      type: "object",
      properties: { eventId: { type: "string" } },
      required: ["eventId"],
    },
    async execute(args, context) {
      return runTool(async () => {
        const eventId = stringArg(args, "eventId");
        if (!eventId) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "memory_event 需要 eventId",
          );
        }
        try {
          const event = memory.getEvent(roleId, eventId);
          memory.recordRecall(roleId, {
            executionId: context.executionId,
            type: "event",
            id: eventId,
          });
          return {
            status: "success",
            rawResponse: event,
            adaptedResult: truncateValue(event, TOOL_RESULT_LIMIT),
          };
        } catch (error) {
          return failedOutcome(errorCode(error), safeMessage(error));
        }
      });
    },
  };
}

function memoryEvidenceTool(
  roleId: string,
  memory: MemoryQueryService,
): ConversationTool {
  return {
    name: "memory_evidence",
    source: "memory",
    description:
      "读取原始消息或工具结果证据。事件来源中的证据编号可直接读取；原始对话和实际观测不可被纠错改写。",
    inputSchema: {
      type: "object",
      properties: { evidenceId: { type: "string" } },
      required: ["evidenceId"],
    },
    async execute(args) {
      return runTool(async () => {
        const evidenceId = stringArg(args, "evidenceId");
        if (!evidenceId) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "memory_evidence 需要 evidenceId",
          );
        }
        try {
          const evidence = memory.getEvidence(roleId, evidenceId);
          return {
            status: "success",
            rawResponse: evidence,
            adaptedResult: truncateValue(evidence, TOOL_RESULT_LIMIT),
          };
        } catch (error) {
          return failedOutcome(errorCode(error), safeMessage(error));
        }
      });
    },
  };
}

function memorySummaryTool(
  roleId: string,
  memory: MemoryQueryService,
): ConversationTool {
  return {
    name: "memory_summary",
    source: "memory",
    description:
      "读取一篇日常摘要及其来源范围。摘要只提供概况，需要原文时继续读取来源证据。",
    inputSchema: {
      type: "object",
      properties: { summaryId: { type: "string" } },
      required: ["summaryId"],
    },
    async execute(args, context) {
      return runTool(async () => {
        const summaryId = stringArg(args, "summaryId");
        if (!summaryId) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "memory_summary 需要 summaryId",
          );
        }
        try {
          const summary = memory.getSummary(roleId, summaryId);
          memory.recordRecall(roleId, {
            executionId: context.executionId,
            type: "daily_summary",
            id: summaryId,
          });
          return {
            status: "success",
            rawResponse: summary,
            adaptedResult: truncateValue(summary, TOOL_RESULT_LIMIT),
          };
        } catch (error) {
          return failedOutcome(errorCode(error), safeMessage(error));
        }
      });
    },
  };
}

function memoryCorrectEventTool(
  roleId: string,
  memory: MemoryQueryService,
): ConversationTool {
  return {
    name: "memory_correct_event",
    source: "memory",
    description:
      "按当前版本纠错一条记忆事件。只修改整理后的事件，不改原始对话；版本冲突时不覆盖新内容。",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        expectedVersion: { type: "integer", minimum: 1 },
        patch: {
          type: "object",
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            subjectiveExperience: { type: "string" },
            occurredAtStart: { type: "string" },
            occurredAtEnd: { type: ["string", "null"] },
            tags: { type: "object" },
          },
        },
        addEvidenceIds: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
      },
      required: ["eventId", "expectedVersion", "patch"],
    },
    async execute(args) {
      return runTool(async () => {
        const eventId = stringArg(args, "eventId");
        if (!eventId) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "memory_correct_event 需要 eventId",
          );
        }
        const parsed = eventCorrectionSchema.safeParse({
          expectedVersion: args.expectedVersion,
          patch: args.patch ?? {},
          ...(Array.isArray(args.addEvidenceIds)
            ? { addEvidenceIds: args.addEvidenceIds }
            : {}),
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        });
        if (!parsed.success) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "memory_correct_event 参数不符合纠错契约",
          );
        }
        try {
          const updated = memory.correctEvent(roleId, eventId, parsed.data);
          return {
            status: "success",
            rawResponse: updated,
            adaptedResult: updated,
          };
        } catch (error) {
          return failedOutcome(errorCode(error), safeMessage(error));
        }
      });
    },
  };
}

function memoryCorrectSummaryTool(
  roleId: string,
  memory: MemoryQueryService,
): ConversationTool {
  return {
    name: "memory_correct_summary",
    source: "memory",
    description:
      "按当前版本纠错一篇日常摘要。摘要纠错不修改原始消息与证据，版本冲突时不覆盖新内容。",
    inputSchema: {
      type: "object",
      properties: {
        summaryId: { type: "string" },
        expectedVersion: { type: "integer", minimum: 1 },
        summary: { type: "string" },
        reason: { type: "string" },
      },
      required: ["summaryId", "expectedVersion", "summary"],
    },
    async execute(args) {
      return runTool(async () => {
        const summaryId = stringArg(args, "summaryId");
        if (!summaryId) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "memory_correct_summary 需要 summaryId",
          );
        }
        const parsed = summaryCorrectionSchema.safeParse({
          expectedVersion: args.expectedVersion,
          summary: args.summary,
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        });
        if (!parsed.success) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "memory_correct_summary 参数不符合纠错契约",
          );
        }
        try {
          const updated = memory.correctSummary(roleId, summaryId, parsed.data);
          return {
            status: "success",
            rawResponse: updated,
            adaptedResult: updated,
          };
        } catch (error) {
          return failedOutcome(errorCode(error), safeMessage(error));
        }
      });
    },
  };
}

function memorySummaryEvidenceTool(
  roleId: string,
  memory: MemoryQueryService,
): ConversationTool {
  return {
    name: "memory_summary_evidence",
    source: "memory",
    description:
      "按摘要来源范围读取原始消息和工具证据，可按窗口与消息序号 fromSequence／toSequence 收窄。原文只读，不受纠错改写。",
    inputSchema: {
      type: "object",
      properties: {
        summaryId: { type: "string" },
        windowId: { type: "string" },
        fromSequence: { type: "integer", minimum: 1 },
        toSequence: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["summaryId"],
    },
    async execute(args, context) {
      return runTool(async () => {
        const summaryId = stringArg(args, "summaryId");
        if (!summaryId) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "memory_summary_evidence 需要 summaryId",
          );
        }
        const windowId = stringArg(args, "windowId");
        const fromSequence = integerArg(args, "fromSequence");
        const toSequence = integerArg(args, "toSequence");
        const limit = integerArg(args, "limit");
        try {
          const items = memory.getSummaryEvidence(roleId, summaryId, {
            ...(windowId === null ? {} : { windowId }),
            ...(fromSequence === null ? {} : { fromSequence }),
            ...(toSequence === null ? {} : { toSequence }),
            ...(limit === null ? {} : { limit }),
          });
          memory.recordRecall(roleId, {
            executionId: context.executionId,
            type: "daily_summary",
            id: summaryId,
          });
          return {
            status: "success",
            rawResponse: { summaryId, items },
            adaptedResult: truncateValue(
              {
                summaryId,
                noMatch: items.length === 0,
                items,
              },
              TOOL_RESULT_LIMIT,
            ),
          };
        } catch (error) {
          return failedOutcome(errorCode(error), safeMessage(error));
        }
      });
    },
  };
}

function diaryWriteTool(
  roleId: string,
  memory: MemoryQueryService,
): ConversationTool {
  return {
    name: "diary_write",
    source: "memory",
    description:
      "以角色口吻写一篇日记并保存为工作空间 Markdown。只在角色确实想记录时使用，不把每轮对话自动变成日记。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        occurredAt: { type: "string" },
        eventIds: { type: "array", items: { type: "string" } },
      },
      required: ["content"],
    },
    async execute(args) {
      return runTool(async () => {
        const content = stringArg(args, "content");
        if (!content) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "diary_write 需要 content",
          );
        }
        const eventIds = Array.isArray(args.eventIds)
          ? args.eventIds.filter(
              (value): value is string => typeof value === "string",
            )
          : undefined;
        try {
          const diary = memory.createDiary(roleId, {
            content,
            ...(typeof args.occurredAt === "string"
              ? { occurredAt: args.occurredAt }
              : {}),
            ...(eventIds === undefined ? {} : { eventIds }),
          });
          return {
            status: "success",
            rawResponse: {
              diaryId: diary.diaryId,
              relativePath: diary.relativePath,
            },
            adaptedResult: {
              diaryId: diary.diaryId,
              relativePath: diary.relativePath,
              experienceDate: diary.experienceDate,
            },
          };
        } catch (error) {
          return failedOutcome(errorCode(error), safeMessage(error));
        }
      });
    },
  };
}

function autonomyScheduleTool(
  roleId: string,
  autonomy: AutonomyService,
): ConversationTool {
  return {
    name: "autonomy_schedule",
    source: "autonomy",
    description:
      "安排自己在未来某个时间自主做一件事。安排会持久保存，到点且没有用户消息或任务续行时执行；只能安排未来时间。携带 taskId 时唤醒会接回同一任务继续（用于暂停后的延后处理）。",
    inputSchema: {
      type: "object",
      properties: {
        wakeAt: { type: "string" },
        intent: { type: "string" },
        taskId: {
          type: "string",
          description: "可选：接回的任务编号，只能省略或等于当前任务编号",
        },
      },
      required: ["wakeAt", "intent"],
    },
    async execute(args, context) {
      return runTool(async () => {
        const wakeAt = stringArg(args, "wakeAt");
        const intent = stringArg(args, "intent");
        if (!wakeAt || !intent) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "autonomy_schedule 需要 wakeAt 和 intent",
          );
        }
        if (intent.length > 2000) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "自主安排目标不能超过 2000 字",
          );
        }
        const requestedTaskId = stringArg(args, "taskId");
        if (requestedTaskId !== null) {
          if (context.taskId === null || requestedTaskId !== context.taskId) {
            return failedOutcome(
              "TASK_REFERENCE_MISMATCH",
              "autonomy_schedule 只能携带当前任务的编号",
            );
          }
        }
        try {
          const wake = autonomy.scheduleWake(roleId, {
            wakeAt,
            intent,
            sourceExecutionId: context.executionId,
            taskId: requestedTaskId ?? context.taskId,
          });
          return {
            status: "success",
            rawResponse: wake,
            adaptedResult: {
              wakeId: wake.wakeId,
              scheduledAt: wake.scheduledAt,
            },
          };
        } catch (error) {
          return failedOutcome(errorCode(error), safeMessage(error));
        }
      });
    },
  };
}

function autonomyShareTool(
  roleId: string,
  autonomy: AutonomyService,
): ConversationTool {
  return {
    name: "autonomy_share",
    source: "autonomy",
    description:
      "在自主活动中主动向主对话窗口分享一条消息。只在确实想对用户说点什么时使用；分享不结束当前活动。",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
    async execute(args, context) {
      return runTool(async () => {
        if (context.autonomous !== true) {
          return failedOutcome(
            "AUTONOMY_SHARE_NOT_AUTONOMOUS",
            "只有自主活动可以主动分享",
          );
        }
        const content = stringArg(args, "content");
        if (!content) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "autonomy_share 需要 content",
          );
        }
        if (content.length > 2000) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "主动分享内容不能超过 2000 字",
          );
        }
        try {
          const shared = autonomy.shareMessage(roleId, {
            content,
            executionId: context.executionId,
          });
          return {
            status: "success",
            rawResponse: shared,
            adaptedResult: shared,
          };
        } catch (error) {
          return failedOutcome(errorCode(error), safeMessage(error));
        }
      });
    },
  };
}

function stateUpdateTool(): ConversationTool {
  return {
    name: "state_update",
    source: "state",
    description:
      "提出本轮角色当前状态的局部补丁。补丁会与回复、执行完成在同一事务提交，不会立即生效；版本冲突时整轮回滚。",
    inputSchema: {
      type: "object",
      properties: { patch: { type: "object" } },
      required: ["patch"],
    },
    async execute(args) {
      const patch = args.patch;
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        return failedOutcome(
          "INVALID_TOOL_ARGUMENTS",
          "state_update 需要对象形式的 patch",
        );
      }
      return {
        status: "success",
        rawResponse: { accepted: true },
        adaptedResult: { accepted: true },
      };
    },
  };
}

function skillReadTool(
  appStore: AppStore,
  appRoot: string,
  resourceIds: readonly string[],
): ConversationTool {
  return {
    name: "skill_read",
    source: "skill",
    description:
      "按需读取已启用 Skill 的正文或参考文件。Skill 的简介已在上下文中，只有需要完整说明或脚本时再读取。",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string" },
        path: { type: "string" },
      },
      required: ["skill"],
    },
    async execute(args) {
      return runTool(async () => {
        const skill = stringArg(args, "skill");
        if (!skill) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "skill_read 需要 skill 名称",
          );
        }
        const relativePath = stringArg(args, "path");
        let lastError: unknown = null;
        for (const resourceId of resourceIds) {
          const library = skillLibraryFor(appStore, appRoot, resourceId);
          if (library === null) {
            lastError = new SkillNotFoundError(skill);
            continue;
          }
          try {
            if (relativePath === null || relativePath.length === 0) {
              const document = library.read(skill);
              return {
                status: "success",
                rawResponse: document,
                adaptedResult: truncateText(document.body, TOOL_RESULT_LIMIT),
              };
            }
            const file = library.readFile(skill, relativePath);
            return {
              status: "success",
              rawResponse: file,
              adaptedResult: truncateText(file.content, TOOL_RESULT_LIMIT),
            };
          } catch (error) {
            lastError = error;
          }
        }
        return failedOutcome(
          errorCode(lastError),
          safeMessage(lastError, "Skill 文件不可读"),
        );
      });
    },
  };
}

function skillRunTool(
  appStore: AppStore,
  appRoot: string,
  resourceIds: readonly string[],
  workspaceDir: string,
): ConversationTool {
  return {
    name: "skill_run",
    source: "skill",
    recorded: true,
    description:
      "运行已启用 Skill 包内的脚本。脚本以 Skill 目录为工作目录（可用相对路径访问随包资源），NOWADAYS_WORKSPACE 指向角色工作空间；实际输出与失败状态会进入工具调用记录。读取脚本正文请用 skill_read。",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string" },
        script: { type: "string", description: "Skill 包内相对路径（.js/.mjs）" },
        args: { type: "array", items: { type: "string" } },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
      },
      required: ["skill", "script"],
    },
    async execute(args, context) {
      const skill = stringArg(args, "skill");
      const script = stringArg(args, "script");
      if (skill === null || script === null) {
        return failedOutcome(
          "INVALID_TOOL_ARGUMENTS",
          "skill_run 需要 skill 和 script",
        );
      }
      const scriptArgs = Array.isArray(args.args)
        ? args.args.filter((value): value is string => typeof value === "string")
        : [];
      if (scriptArgs.length > 50) {
        return failedOutcome(
          "INVALID_TOOL_ARGUMENTS",
          "脚本参数不能超过 50 个",
        );
      }
      const timeoutMs = integerArg(args, "timeoutMs") ?? 30_000;
      if (timeoutMs < 1000 || timeoutMs > 120_000) {
        return failedOutcome(
          "INVALID_TOOL_ARGUMENTS",
          "timeoutMs 需在 1000 到 120000 毫秒之间",
        );
      }
      let resolved: { absolutePath: string; directory: string } | null = null;
      let lastError: unknown = null;
      for (const resourceId of resourceIds) {
        const library = skillLibraryFor(appStore, appRoot, resourceId);
        if (library === null) {
          lastError = new SkillNotFoundError(skill);
          continue;
        }
        try {
          resolved = library.resolveScript(skill, script);
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (resolved === null) {
        return failedOutcome(
          errorCode(lastError),
          safeMessage(lastError, "Skill 脚本不可定位"),
        );
      }
      context.checkDispatch?.();
      context.onDispatch?.();
      return runSkillScriptProcess(
        resolved.absolutePath,
        resolved.directory,
        workspaceDir,
        scriptArgs,
        timeoutMs,
      );
    },
  };
}

function runSkillScriptProcess(
  scriptPath: string,
  cwd: string,
  workspaceDir: string,
  scriptArgs: readonly string[],
  timeoutMs: number,
): Promise<ConversationToolOutcome> {
  return new Promise<ConversationToolOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const append = (target: "out" | "err", chunk: Buffer): void => {
      const current = target === "out" ? stdout : stderr;
      const next = current + chunk.toString("utf8");
      if (Array.from(next).length > 1_000_000) {
        truncated = true;
        if (target === "out") {
          stdout = truncateText(next, 1_000_000);
        } else {
          stderr = truncateText(next, 1_000_000);
        }
        return;
      }
      if (target === "out") {
        stdout = next;
      } else {
        stderr = next;
      }
    };
    let timedOut = false;
    let settled = false;
    const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
      cwd,
      env: {
        ...process.env,
        NOWADAYS_WORKSPACE: workspaceDir,
        NOWADAYS_SKILL_DIR: cwd,
      },
      shell: false,
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));
    // 已派发脚本的副作用已经发生，插话只替代回复，不终止脚本本身；
    // 脚本按实际退出或自身超时结算，结果仍归原调用。
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    const finish = (outcome: ConversationToolOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    child.on("error", (error) => {
      finish(
        failedOutcome(
          "SKILL_SCRIPT_SPAWN_FAILED",
          safeMessage(error, "Skill 脚本启动失败"),
        ),
      );
    });
    child.on("close", (code, signalName) => {
      const output = {
        exitCode: code,
        signal: signalName,
        timedOut,
        stdout,
        stderr,
        truncated,
      };
      if (timedOut) {
        finish({
          status: "failed",
          rawResponse: output,
          adaptedResult: truncateValue(output, TOOL_RESULT_LIMIT),
          diagnosticCode: "SKILL_SCRIPT_TIMEOUT",
          error: { message: "Skill 脚本执行超时" },
        });
        return;
      }
      if (code === 0) {
        finish({
          status: "success",
          rawResponse: output,
          adaptedResult: truncateValue(output, TOOL_RESULT_LIMIT),
        });
        return;
      }
      finish({
        status: "failed",
        rawResponse: output,
        adaptedResult: truncateValue(output, TOOL_RESULT_LIMIT),
        diagnosticCode: "SKILL_SCRIPT_EXIT",
        error: { message: `Skill 脚本以退出码 ${code} 结束`, exitCode: code },
      });
    });
  });
}

function memoryDiaryTool(
  roleId: string,
  memory: MemoryQueryService,
): ConversationTool {
  return {
    name: "memory_diary",
    source: "memory",
    description:
      "按日记编号读取正文及关联事件。长日记分段读取：返回 fromChar 到 toChar 的内容与 hasMore；hasMore 为 true 时用更大的 fromChar 继续读取。",
    inputSchema: {
      type: "object",
      properties: {
        diaryId: { type: "string" },
        fromChar: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 20000 },
      },
      required: ["diaryId"],
    },
    async execute(args, context) {
      return runTool(async () => {
        const diaryId = stringArg(args, "diaryId");
        if (diaryId === null) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "memory_diary 需要 diaryId",
          );
        }
        const fromChar = integerArg(args, "fromChar") ?? 0;
        const maxChars = integerArg(args, "maxChars") ?? 4000;
        if (fromChar < 0 || maxChars < 1 || maxChars > 20000) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "fromChar 需不小于 0，maxChars 需在 1 到 20000 之间",
          );
        }
        const segment = memory.getDiarySegment(roleId, diaryId, {
          fromChar,
          maxChars,
        });
        try {
          memory.recordRecall(roleId, {
            executionId: context.executionId,
            type: "diary",
            id: diaryId,
          });
        } catch {
          // 召回登记失败不影响读取结果。
        }
        return {
          status: "success",
          rawResponse: segment,
          adaptedResult: truncateValue(segment, TOOL_RESULT_LIMIT),
        };
      });
    },
  };
}

function taskProgressTool(
  roleId: string,
  roleAccess: RoleAccess,
): ConversationTool {
  return {
    name: "task_progress",
    source: "task",
    description:
      "为当前任务保存一条进度笔记。笔记跨轮次保留，暂停后接续时随任务上下文一起出现；用于记录阶段成果和已读位置。",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    },
    async execute(args, context) {
      return runTool(async () => {
        const note = stringArg(args, "note");
        if (note === null) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "task_progress 需要 note",
          );
        }
        if (note.length > 2000) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "进度笔记不能超过 2000 字",
          );
        }
        if (context.taskId === null) {
          return failedOutcome("TASK_REQUIRED", "当前没有活动任务，无法保存进度");
        }
        const taskId = context.taskId;
        const saved = roleAccess.withStore(roleId, (storage) =>
          storage.business.appendTaskNote({ roleId, taskId, note }),
        );
        return {
          status: "success",
          rawResponse: saved,
          adaptedResult: { noteId: saved.noteId, taskId: saved.taskId },
        };
      });
    },
  };
}

function taskPauseTool(
  roleId: string,
  roleAccess: RoleAccess,
): ConversationTool {
  return {
    name: "task_pause",
    source: "task",
    description:
      "声明本轮先暂停当前任务：目标尚未完成，保留任务编号、进度笔记与资源延续，稍后由携带任务编号的唤醒或新消息接回。回复本身仍会正常保存。",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "暂停原因" },
        note: { type: "string", description: "可选：同时保存一条进度笔记" },
      },
      required: ["reason"],
    },
    async execute(args, context) {
      return runTool(async () => {
        const reason = stringArg(args, "reason");
        if (reason === null) {
          return failedOutcome("INVALID_TOOL_ARGUMENTS", "task_pause 需要 reason");
        }
        if (context.taskId === null) {
          return failedOutcome("TASK_REQUIRED", "当前没有活动任务，无法暂停");
        }
        const taskId = context.taskId;
        const note = stringArg(args, "note");
        if (note !== null && note.length <= 2000) {
          try {
            roleAccess.withStore(roleId, (storage) =>
              storage.business.appendTaskNote({ roleId, taskId, note }),
            );
          } catch {
            // 笔记保存失败不改变暂停意图。
          }
        }
        return {
          status: "success",
          rawResponse: { taskId, kind: "pause", reason },
          adaptedResult: { taskId, kind: "pause", reason },
        };
      });
    },
  };
}

function taskFinishTool(
  roleId: string,
  roleAccess: RoleAccess,
): ConversationTool {
  return {
    name: "task_finish",
    source: "task",
    description:
      "声明当前任务按真实结果结束：completed 或 failed 及结束原因。结束会触发经历整理并释放任务资源延续。",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "failed"] },
        endReason: { type: "string" },
        note: { type: "string", description: "可选：同时保存一条进度笔记" },
      },
      required: ["status", "endReason"],
    },
    async execute(args, context) {
      return runTool(async () => {
        const status =
          args.status === "completed" || args.status === "failed"
            ? args.status
            : null;
        const endReason = stringArg(args, "endReason");
        if (status === null || endReason === null) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "task_finish 需要 status（completed 或 failed）和 endReason",
          );
        }
        if (context.taskId === null) {
          return failedOutcome("TASK_REQUIRED", "当前没有活动任务，无法结束");
        }
        const taskId = context.taskId;
        const note = stringArg(args, "note");
        if (note !== null && note.length <= 2000) {
          try {
            roleAccess.withStore(roleId, (storage) =>
              storage.business.appendTaskNote({ roleId, taskId, note }),
            );
          } catch {
            // 笔记保存失败不改变结束意图。
          }
        }
        return {
          status: "success",
          rawResponse: { taskId, kind: "finish", status, endReason },
          adaptedResult: { taskId, kind: "finish", status, endReason },
        };
      });
    },
  };
}

function toolReconcileTool(
  roleId: string,
  roleAccess: RoleAccess,
): ConversationTool {
  return {
    name: "tool_reconcile",
    source: "memory",
    description:
      "对结果未知的工具调用补录核查结论：按原 toolCallId 保存明确结果与证据关联，保留之前的未知记录。只在取得明确证据后调用；证据仍不足时保持未知，不要调用。",
    inputSchema: {
      type: "object",
      properties: {
        toolCallId: { type: "string", description: "要补录的原调用编号" },
        status: { type: "string", enum: ["success", "failed"] },
        observation: { type: "string", description: "核查结论说明" },
        verifiedByToolCallId: {
          type: "string",
          description: "可选：用于核查的那次调用编号",
        },
        result: { description: "可选：核查得到的结构化结果" },
      },
      required: ["toolCallId", "status", "observation"],
    },
    async execute(args, context) {
      return runTool(async () => {
        const toolCallId = stringArg(args, "toolCallId");
        const status =
          args.status === "success" || args.status === "failed"
            ? args.status
            : null;
        const observation = stringArg(args, "observation");
        if (toolCallId === null || status === null || observation === null) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "tool_reconcile 需要 toolCallId、status 和 observation",
          );
        }
        if (observation.length > 2000) {
          return failedOutcome(
            "INVALID_TOOL_ARGUMENTS",
            "核查说明不能超过 2000 字",
          );
        }
        const verifiedBy = stringArg(args, "verifiedByToolCallId");
        let resolvedVerifiedBy: string | null = null;
        if (verifiedBy !== null) {
          // 模型看到的是提供方 wire id，核查关联需要同一执行内的业务调用编号。
          resolvedVerifiedBy = roleAccess.withStore(roleId, (storage) =>
            storage.business.resolveToolCallReference({
              roleId,
              executionId: context.executionId,
              reference: verifiedBy,
            }),
          );
          if (resolvedVerifiedBy === null) {
            return failedOutcome(
              "VERIFIED_BY_CALL_NOT_FOUND",
              `用于核查的调用 ${verifiedBy} 不存在`,
            );
          }
        }
        const adaptedResult = {
          observation,
          ...(resolvedVerifiedBy === null
            ? {}
            : { verifiedByToolCallId: resolvedVerifiedBy }),
          ...(args.result === undefined ? {} : { result: args.result }),
        };
        const saved = roleAccess.withStore(roleId, (storage) =>
          storage.business.saveToolResult({
            roleId,
            toolCallId,
            status,
            adaptedResult,
            reconciledByCallId: resolvedVerifiedBy,
            requireReconciledFromUnknown: true,
          }),
        );
        return {
          status: "success",
          rawResponse: saved,
          adaptedResult: {
            toolCallId,
            status: saved.result.status,
            reconciled: !saved.duplicate,
            reconciledAt: saved.result.reconciledAt,
          },
        };
      });
    },
  };
}

interface McpConnectionEntry {
  fingerprint: string;
  client: McpToolClient;
  active: number;
  retired: boolean;
  closing: Promise<void> | null;
}

function mcpConfigFingerprint(config: {
  command: string;
  args: string[];
  env: Record<string, string>;
}): string {
  const env = Object.keys(config.env)
    .sort()
    .map((key) => [key, config.env[key]]);
  return JSON.stringify([config.command, config.args, env]);
}

class McpConnectionPool {
  private readonly entries: McpConnectionEntry[] = [];
  private closed = false;

  constructor(
    private readonly appStore: AppStore,
    private readonly resourceId: string,
    private readonly workspaceDir: string,
  ) {}

  async acquire(): Promise<{
    client: McpToolClient;
    release: () => void;
  }> {
    if (this.closed) {
      throw new AppError(409, "MCP_CHAIN_CLOSED", "MCP 连接已随任务链释放");
    }
    const config = readMcpConfig(this.appStore, this.resourceId);
    if (config === null) {
      throw new AppError(502, "MCP_CONFIG_INVALID", "MCP 资源配置已不可用");
    }
    const fingerprint = mcpConfigFingerprint(config);
    let entry =
      this.entries.find((candidate) => !candidate.retired) ?? null;
    if (entry === null || entry.fingerprint !== fingerprint) {
      if (entry !== null) {
        this.retire(entry);
      }
      entry = {
        fingerprint,
        client: await McpToolClient.connect(
          withWorkspaceEnv(config, this.workspaceDir),
          { cwd: this.workspaceDir },
        ),
        active: 0,
        retired: false,
        closing: null,
      };
      this.entries.push(entry);
    }
    const acquired = entry;
    acquired.active += 1;
    let released = false;
    return {
      client: acquired.client,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        acquired.active -= 1;
        if (acquired.retired && acquired.active === 0) {
          void this.closeEntry(acquired);
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      this.entries.map((entry) => {
        entry.retired = true;
        return entry.active === 0
          ? this.closeEntry(entry)
          : Promise.resolve();
      }),
    );
  }

  private retire(entry: McpConnectionEntry): void {
    entry.retired = true;
    if (entry.active === 0) {
      void this.closeEntry(entry);
    }
  }

  private closeEntry(entry: McpConnectionEntry): Promise<void> {
    if (entry.closing === null) {
      entry.closing = entry.client.close().catch(() => {});
    }
    return entry.closing;
  }
}

function mcpTool(
  roleId: string,
  resourceName: string,
  info: McpToolInfo,
  index: number,
  pool: McpConnectionPool,
): ConversationTool {
  const exposedName = `mcp_${sanitizeToolName(resourceName)}_${index}_${sanitizeToolName(info.name)}`;
  return {
    name: exposedName,
    source: "mcp",
    description:
      info.description.length > 0
        ? `[${resourceName}] ${info.description}`
        : `[${resourceName}] ${info.name}`,
    inputSchema:
      info.inputSchema !== null &&
      typeof info.inputSchema === "object" &&
      !Array.isArray(info.inputSchema)
        ? (info.inputSchema as Record<string, unknown>)
        : { type: "object" },
    async execute(args, context) {
      if (context.signal.aborted) {
        return failedOutcome("EXECUTION_SUPERSEDED", "执行已被替代");
      }
      let release: (() => void) | null = null;
      try {
        const acquired = await pool.acquire();
        release = acquired.release;
        context.checkDispatch?.();
        context.onDispatch?.();
        const result = await acquired.client.callTool(info.name, args);
        const adapted = adaptMcpContent(result.content, result.structuredContent);
        if (result.isError) {
          return {
            status: "failed",
            rawResponse: result,
            adaptedResult: truncateText(adapted, TOOL_RESULT_LIMIT),
            diagnosticCode: "MCP_TOOL_ERROR",
            error: { message: "MCP 工具返回错误" },
          };
        }
        return {
          status: "success",
          rawResponse: result,
          adaptedResult: truncateText(adapted, TOOL_RESULT_LIMIT),
        };
      } catch (error) {
        if (
          error instanceof AutonomyBudgetExhaustedError ||
          (error instanceof AppError &&
            (error.code === "TASK_ENDED" ||
              error.code === "EXECUTION_SUPERSEDED"))
        ) {
          throw error;
        }
        if (
          error instanceof AppError &&
          (error.code === "MCP_CONFIG_INVALID" ||
            error.code === "MCP_CHAIN_CLOSED")
        ) {
          return failedOutcome(error.code, error.message);
        }
        const code =
          error instanceof Error && error.message.includes("TIMEOUT")
            ? "MCP_TOOL_TIMEOUT"
            : "MCP_TOOL_OUTCOME_UNKNOWN";
        return {
          status: "unknown",
          adaptedResult: {
            error: code,
            message: "MCP 调用未能确认结果，不能当作成功或未执行",
          },
          diagnosticCode: code,
          error: { message: safeMessage(error, "MCP 调用失败"), roleId },
        };
      } finally {
        release?.();
      }
    },
  };
}

function runTool(
  action: () => Promise<ConversationToolOutcome>,
): Promise<ConversationToolOutcome> {
  return action().catch((error) =>
    failedOutcome(errorCode(error), safeMessage(error)),
  );
}

function failedOutcome(
  code: string,
  message: string,
): ConversationToolOutcome {
  return {
    status: "failed",
    diagnosticCode: code,
    adaptedResult: { error: { code, message } },
    error: { code, message },
  };
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "TOOL_EXECUTION_FAILED";
}

function safeMessage(error: unknown, fallback = "工具执行失败"): string {
  if (error instanceof AppError) {
    return error.message;
  }
  return error instanceof Error && error.message.length <= 200
    ? error.message
    : fallback;
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function integerArg(
  args: Record<string, unknown>,
  key: string,
): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function truncateValue(value: unknown, limit: number): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || Array.from(text).length <= limit) {
    return value;
  }
  return { truncated: true, content: truncateText(text, limit) };
}

function truncateText(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("")}\n[内容已截断]`;
}

function adaptMcpContent(content: unknown, structured: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      } else {
        parts.push(JSON.stringify(block));
      }
    }
  }
  if (structured !== undefined) {
    parts.push(JSON.stringify(structured));
  }
  return parts.join("\n");
}

function sanitizeToolName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
  return normalized.length > 0 ? normalized : "tool";
}

function dedupeSkills(items: SkillBrief[]): SkillBrief[] {
  const seen = new Set<string>();
  const result: SkillBrief[] = [];
  for (const item of items) {
    if (seen.has(item.name)) {
      continue;
    }
    seen.add(item.name);
    result.push(item);
  }
  return result;
}
