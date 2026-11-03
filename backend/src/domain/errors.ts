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

export class ToolResultConflictError extends AppError {
  constructor(toolCallId: string, status: string, requested: string) {
    super(409, "TOOL_RESULT_CONFLICT", "工具结果已按不同状态保存", {
      toolCallId,
      status,
      requested,
    });
  }
}
