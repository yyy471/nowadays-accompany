export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export class InvalidRoleIdError extends AppError {
  constructor() {
    super(400, "INVALID_ROLE_ID", "roleId 格式不正确");
  }
}

export class RoleNotFoundError extends AppError {
  constructor(roleId: string) {
    super(404, "ROLE_NOT_FOUND", "角色不存在", { roleId });
  }
}

export class RoleNotReadyError extends AppError {
  constructor(roleId: string, status: string) {
    super(409, "ROLE_NOT_READY", "角色尚未初始化完成", { roleId, status });
  }
}

export class RevisionConflictError extends AppError {
  constructor(expected: number, actual: number) {
    super(409, "REVISION_CONFLICT", "角色设定修订号已变化", {
      expected,
      actual,
    });
  }
}

export class StateVersionConflictError extends AppError {
  constructor(expected: number, actual: number) {
    super(409, "STATE_VERSION_CONFLICT", "角色状态版本已变化", {
      expected,
      actual,
    });
  }
}

export class WindowNotFoundError extends AppError {
  constructor(windowId: string) {
    super(404, "WINDOW_NOT_FOUND", "对话窗口不存在", { windowId });
  }
}

export class SubmissionConflictError extends AppError {
  constructor(windowId: string, submissionId: string) {
    super(409, "SUBMISSION_CONFLICT", "同一提交编号对应了不同消息内容", {
      windowId,
      submissionId,
    });
  }
}

export class RoleInitializationError extends AppError {
  constructor(roleId: string, status: string) {
    super(500, "ROLE_INITIALIZATION_FAILED", "角色初始化失败", {
      roleId,
      status,
    });
  }
}

export class StorageError extends AppError {
  constructor(message: string, details?: unknown) {
    super(500, "STORAGE_ERROR", message, details);
  }
}

export class SchemaMigrationError extends AppError {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(500, "SCHEMA_MIGRATION_FAILED", `SCHEMA_MIGRATION_FAILED:${reason}`, {
      reason,
    });
  }
}

export class FtsUnavailableError extends AppError {
  constructor() {
    super(500, "FTS5_UNAVAILABLE", "当前运行环境缺少 FTS5 trigram 支持");
  }
}

export class ModelCredentialUnavailableError extends AppError {
  constructor(reference: string) {
    super(500, "MODEL_CREDENTIAL_UNAVAILABLE", "模型凭据引用无法读取", {
      reference,
    });
  }
}

export class ModelRequestFailedError extends AppError {
  constructor(message: string, details?: unknown) {
    super(502, "MODEL_REQUEST_FAILED", message, details);
  }
}

export class ModelToolArgumentsError extends AppError {
  constructor(toolName: string) {
    super(502, "MODEL_TOOL_ARGUMENTS_INVALID", "模型工具参数无法解析", {
      toolName,
    });
  }
}

export class SkillNotFoundError extends AppError {
  constructor(name: string) {
    super(404, "SKILL_NOT_FOUND", "Skill 不存在", { name });
  }
}

export class SkillFileInvalidError extends AppError {
  constructor(name: string, relativePath: string) {
    super(400, "SKILL_FILE_INVALID", "Skill 文件路径不合法或不可读", {
      name,
      relativePath,
    });
  }
}

export class ModelBindingMissingError extends AppError {
  constructor(roleId: string, capability: string) {
    super(500, "MODEL_BINDING_MISSING", "角色没有可用的模型绑定", {
      roleId,
      capability,
    });
  }
}

export class ResourceNotFoundError extends AppError {
  constructor(resourceId: string) {
    super(404, "RESOURCE_NOT_FOUND", "资源不存在", { resourceId });
  }
}

export class InvalidResourceConfigError extends AppError {
  constructor(kind: string, issues: unknown) {
    super(400, "INVALID_RESOURCE_CONFIG", "资源配置结构不正确", {
      kind,
      issues,
    });
  }
}

export class ResourceKindMismatchError extends AppError {
  constructor(capability: string, expectedKind: string, actualKind: string) {
    super(400, "RESOURCE_KIND_MISMATCH", "角色能力与资源类型不匹配", {
      capability,
      expectedKind,
      actualKind,
    });
  }
}

export class InvalidBindingError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "INVALID_BINDING", message, details);
  }
}

export class BindingConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, "BINDING_CONFLICT", message, details);
  }
}

export class TaskNotFoundError extends AppError {
  constructor(taskId: string) {
    super(404, "TASK_NOT_FOUND", "任务不存在", { taskId });
  }
}

export class TaskStateConflictError extends AppError {
  constructor(taskId: string, status: string, requested: string) {
    super(409, "TASK_STATE_CONFLICT", "任务已结束，不能再次结束", {
      taskId,
      status,
      requested,
    });
  }
}

export class ExecutionNotFoundError extends AppError {
  constructor(executionId: string) {
    super(404, "EXECUTION_NOT_FOUND", "执行不存在", { executionId });
  }
}

export class InvalidExecutionReferenceError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "INVALID_EXECUTION_REFERENCE", message, details);
  }
}

export class ExecutionAlreadyCommittedError extends AppError {
  constructor(executionId: string, committed: number, requested: number) {
    super(409, "EXECUTION_ALREADY_COMMITTED", "执行已提交过不同状态版本", {
      executionId,
      committed,
      requested,
    });
  }
}

export class ExecutionTaskConflictError extends AppError {
  constructor(executionId: string, taskId: string, current: string) {
    super(409, "EXECUTION_TASK_CONFLICT", "执行与任务已有不同的关联类型", {
      executionId,
      taskId,
      current,
    });
  }
}

export class InvalidToolCallReferenceError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "INVALID_TOOL_CALL_REFERENCE", message, details);
  }
}

export class ToolCallNotFoundError extends AppError {
  constructor(toolCallId: string) {
    super(404, "TOOL_CALL_NOT_FOUND", "工具调用不存在", { toolCallId });
  }
}

export class ToolCallConflictError extends AppError {
  constructor(executionId: string, stepKey: string) {
    super(409, "TOOL_CALL_CONFLICT", "同一执行内的步骤对应了不同的工具调用", {
      executionId,
      stepKey,
    });
  }
}

export class ToolCallStatusConflictError extends AppError {
  constructor(toolCallId: string, status: string, requested: string) {
    super(409, "TOOL_CALL_STATUS_CONFLICT", "工具调用状态不允许该变更", {
      toolCallId,
      status,
      requested,
    });
  }
}

export class ToolResultNotFoundError extends AppError {
  constructor(toolCallId: string) {
    super(404, "TOOL_RESULT_NOT_FOUND", "工具结果尚未保存", { toolCallId });
  }
}

export class ToolResultEvidenceRequiredError extends AppError {
  constructor(toolCallId: string) {
    super(
      400,
      "TOOL_RESULT_EVIDENCE_REQUIRED",
      "补录确定结果必须提供结果记录或核查依据",
      { toolCallId },
    );
  }
}

export class MemoryBatchConflictError extends AppError {
  constructor(roleId: string) {
    super(409, "MEMORY_BATCH_CONFLICT", "该角色已有运行中的记忆整理批次", {
      roleId,
    });
  }
}

export class MemoryEventNotFoundError extends AppError {
  constructor(eventId: string) {
    super(404, "MEMORY_EVENT_NOT_FOUND", "记忆事件不存在", { eventId });
  }
}

export class MemoryVersionConflictError extends AppError {
  constructor(eventId: string, expected: number, actual: number) {
    super(409, "MEMORY_VERSION_CONFLICT", "记忆版本已变化", {
      eventId,
      expected,
      actual,
    });
  }
}

export class MemoryOperationInvalidError extends AppError {
  constructor(message: string, details?: unknown) {
    super(500, "MEMORY_OPERATION_INVALID", message, details);
  }
}

export class InvalidMemoryCorrectionError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "INVALID_MEMORY_CORRECTION", message, details);
  }
}

export class MemorySummaryNotFoundError extends AppError {
  constructor(summaryId: string) {
    super(404, "MEMORY_SUMMARY_NOT_FOUND", "日常摘要不存在", { summaryId });
  }
}

export class MemoryQueryFailedError extends AppError {
  constructor(details?: unknown) {
    super(500, "MEMORY_QUERY_FAILED", "记忆检索执行失败", details);
  }
}

export class DiaryNotFoundError extends AppError {
  constructor(diaryId: string) {
    super(404, "DIARY_NOT_FOUND", "日记不存在", { diaryId });
  }
}

export class DiaryFileMissingError extends AppError {
  constructor(diaryId: string) {
    super(500, "DIARY_FILE_MISSING", "日记文件不存在或不可读", { diaryId });
  }
}

export class ToolResultConflictError extends AppError {
  constructor(toolCallId: string, status: string, requested: string) {
    super(409, "TOOL_RESULT_CONFLICT", "工具结果已按不同状态保存", {
      toolCallId,
      status,
      requested,
    });
  }
}

export class ExecutionNotRunningError extends AppError {
  constructor(executionId: string, status: string) {
    super(409, "EXECUTION_NOT_RUNNING", "执行已不能接受新的决策结果", {
      executionId,
      status,
    });
  }
}

export class TaskEndedError extends AppError {
  constructor(taskId: string, status: string) {
    super(409, "TASK_ENDED", "任务已结束，不能发起新的模型或工具调用", {
      taskId,
      status,
    });
  }
}

export class ExecutionSupersededError extends AppError {
  constructor(executionId: string) {
    super(409, "EXECUTION_SUPERSEDED", "执行已被同一窗口的新消息替代", {
      executionId,
    });
  }
}

export class SseCursorInvalidError extends AppError {
  constructor(after: unknown) {
    super(400, "SSE_CURSOR_INVALID", "补读游标不是本窗口的有效事件编号", {
      after,
    });
  }
}

export class AutonomyBudgetExhaustedError extends AppError {
  constructor(roleId: string, dailyLimit: number, usedPoints: number) {
    super(
      409,
      "AUTONOMY_BUDGET_EXHAUSTED",
      "自主活动额度已用尽",
      { roleId, dailyLimit, usedPoints },
    );
  }
}

export class InputStateInvalidError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "INPUT_STATE_INVALID", message, details);
  }
}
