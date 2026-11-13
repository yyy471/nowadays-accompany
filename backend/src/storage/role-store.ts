import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AppError,
  BindingConflictError,
  ExecutionAlreadyCommittedError,
  ExecutionNotFoundError,
  ExecutionTaskConflictError,
  InvalidExecutionReferenceError,
  InvalidToolCallReferenceError,
  RevisionConflictError,
  RoleNotFoundError,
  StateVersionConflictError,
  SubmissionConflictError,
  TaskNotFoundError,
  TaskStateConflictError,
  ToolCallConflictError,
  ToolCallNotFoundError,
  ToolCallStatusConflictError,
  ToolResultConflictError,
  ToolResultEvidenceRequiredError,
  ToolResultNotFoundError,
  WindowNotFoundError,
} from "../domain/errors.js";
import { registerToolResultEvidence } from "./evidence.js";
import { openBusinessDatabase } from "./schema.js";

export interface RoleDefinition {
  text: string;
  payload: Record<string, unknown>;
}

export interface RoleRecord {
  roleId: string;
  displayName: string;
  definition: RoleDefinition;
  definitionRevision: number;
  state: Record<string, unknown>;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface WindowRecord {
  windowId: string;
  roleId: string;
  kind: "main" | "custom";
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  messageId: string;
  windowId: string;
  sender: "user" | "assistant";
  content: string;
  sourcePlatform: string;
  status: string;
  sequence: number;
  submissionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitMessageInput {
  content: string;
  submissionId: string;
  sourcePlatform: string;
}

export interface SubmitMessageResult {
  message: MessageRecord;
  duplicate: boolean;
}

export interface ListMessagesResult {
  items: MessageRecord[];
  nextAfter: number | null;
  nextBefore: number | null;
}

export interface MessagePageQuery {
  after?: number | null;
  before?: number | null;
  limit: number;
}

export type BindingCapability = "chat_model" | "memory_model" | "mcp" | "skill";

export interface RoleBindingRecord {
  roleId: string;
  capability: BindingCapability;
  resourceId: string;
  modelName: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoleBindingInput {
  capability: BindingCapability;
  resourceId: string;
  modelName: string | null;
  enabled: boolean;
}

export type TaskStatus = "active" | "paused" | "completed" | "failed";

export type TaskOrigin = "user" | "autonomous" | "memory";

export interface TaskRecord {
  taskId: string;
  roleId: string;
  goal: string;
  status: TaskStatus;
  endReason: string | null;
  origin: TaskOrigin;
  initiatorExecutionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExecutionTriggerType =
  | "user_message"
  | "autonomous"
  | "tool_result"
  | "recovery";

export type ExecutionStatus =
  | "running"
  | "paused"
  | "completed"
  | "superseded"
  | "failed";

export interface ExecutionRecord {
  executionId: string;
  roleId: string;
  windowId: string | null;
  triggerType: ExecutionTriggerType;
  triggerMessageId: string | null;
  status: ExecutionStatus;
  stateVersionLoaded: number | null;
  stateVersionCommitted: number | null;
  decisionRound: number | null;
  createdAt: string;
  updatedAt: string;
}

export type ExecutionTaskRelation = "initiates" | "continues" | "references";

export interface ExecutionTaskRecord {
  executionId: string;
  taskId: string;
  relation: ExecutionTaskRelation;
  createdAt: string;
}

export type ToolCallStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "unknown";

export type ToolCallMode = "foreground" | "background";

export interface ToolCallRecord {
  toolCallId: string;
  taskId: string;
  executionId: string;
  stepKey: string;
  toolName: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  mode: ToolCallMode;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ToolCallModeEventRecord {
  eventId: string;
  toolCallId: string;
  mode: ToolCallMode;
  changedAt: string;
}

export type ToolResultStatus = "success" | "failed" | "unknown";

export interface ToolResultRecord {
  toolCallId: string;
  status: ToolResultStatus;
  rawResponse: unknown;
  adaptedResult: unknown;
  diagnosticCode: string | null;
  error: unknown;
  savedAt: string;
  previousStatus: ToolResultStatus | null;
  previousDiagnosticCode: string | null;
  previousRawResponse: unknown;
  previousAdaptedResult: unknown;
  previousError: unknown;
  reconciledAt: string | null;
  /** 核查补录时提供证据关联的原调用编号。 */
  reconciledByCallId: string | null;
}

export interface ToolResultInput {
  roleId: string;
  toolCallId: string;
  status: ToolResultStatus;
  rawResponse?: unknown;
  adaptedResult?: unknown;
  diagnosticCode?: string | null;
  error?: unknown;
  /** 核查补录时提供证据关联的原调用编号（GAP-03）。 */
  reconciledByCallId?: string | null;
  /** 仅允许把结果未知的原调用补录为明确结果，在保存事务内核对。 */
  requireReconciledFromUnknown?: boolean;
  now?: string;
}

export interface TaskResourceContinuationRecord {
  taskId: string;
  resourceId: string;
  grantedAt: string;
  endedAt: string | null;
}

export interface TaskNoteRecord {
  noteId: string;
  taskId: string;
  roleId: string;
  note: string;
  createdAt: string;
}

interface RoleRow {
  role_id: string;
  display_name: string;
  definition_text: string;
  definition_payload_json: string;
  definition_revision: number;
  state_json: string;
  state_version: number;
  created_at: string;
  updated_at: string;
}

interface WindowRow {
  window_id: string;
  role_id: string;
  kind: "main" | "custom";
  source: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  message_id: string;
  window_id: string;
  sender: "user" | "assistant";
  content: string;
  source_platform: string;
  status: string;
  sequence: number;
  submission_id: string | null;
  submission_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface RoleBindingRow {
  role_id: string;
  capability: BindingCapability;
  resource_id: string;
  model_name: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  task_id: string;
  role_id: string;
  goal: string;
  status: TaskStatus;
  end_reason: string | null;
  origin: TaskOrigin;
  initiator_execution_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ExecutionRow {
  execution_id: string;
  role_id: string;
  window_id: string | null;
  trigger_type: ExecutionTriggerType;
  trigger_message_id: string | null;
  status: ExecutionStatus;
  state_version_loaded: number | null;
  state_version_committed: number | null;
  decision_round: number | null;
  created_at: string;
  updated_at: string;
}

interface ExecutionTaskRow {
  execution_id: string;
  task_id: string;
  relation: ExecutionTaskRelation;
  created_at: string;
}

interface ToolCallRow {
  tool_call_id: string;
  task_id: string;
  execution_id: string;
  step_key: string;
  tool_name: string;
  args_json: string;
  status: ToolCallStatus;
  mode: ToolCallMode;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ToolCallModeEventRow {
  event_id: string;
  tool_call_id: string;
  mode: ToolCallMode;
  changed_at: string;
}

interface ToolResultRow {
  tool_call_id: string;
  status: ToolResultStatus;
  raw_response_json: string | null;
  adapted_result_json: string | null;
  diagnostic_code: string | null;
  error_json: string | null;
  saved_at: string;
  previous_status: ToolResultStatus | null;
  previous_diagnostic_code: string | null;
  previous_raw_response_json: string | null;
  previous_adapted_result_json: string | null;
  previous_error_json: string | null;
  reconciled_at: string | null;
  reconciled_by_call_id: string | null;
}

interface TaskResourceContinuationRow {
  task_id: string;
  resource_id: string;
  granted_at: string;
  ended_at: string | null;
}

export class RoleStore {
  readonly db: Database.Database;
  readonly path: string;
  readonly schemaVersion: number;
  private readonly timeZone: string | undefined;

  constructor(
    dbPath: string,
    options: { create?: boolean; timeZone?: string } = {},
  ) {
    this.timeZone = options.timeZone;
    const opened = openBusinessDatabase(dbPath, options);
    this.db = opened.db;
    this.path = opened.path;
    this.schemaVersion = opened.schemaVersion;
  }

  hasRole(roleId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM roles WHERE role_id = ?")
      .get(roleId) as { found: number } | undefined;
    return row !== undefined;
  }

  createRoleRecord(input: {
    roleId: string;
    displayName: string;
    definitionText: string;
    definitionPayload: Record<string, unknown>;
    initialState: Record<string, unknown>;
  }): { role: RoleRecord; window: WindowRecord } {
    return this.db.transaction(() => {
      if (this.hasRole(input.roleId)) {
        throw new Error(`ROLE_ALREADY_EXISTS:${input.roleId}`);
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO roles (role_id, display_name, definition_text, definition_payload_json, definition_revision, state_json, state_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.roleId,
          input.displayName,
          input.definitionText,
          JSON.stringify(input.definitionPayload),
          "1",
          JSON.stringify(input.initialState),
          "1",
          now,
          now,
        );
      const windowId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO windows (window_id, role_id, kind, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(windowId, input.roleId, "main", "nowadays", now, now);
      return {
        role: this.getRole(input.roleId),
        window: this.getWindow(input.roleId, windowId),
      };
    })();
  }

  getRole(roleId: string): RoleRecord {
    const row = this.db
      .prepare(
        "SELECT role_id, display_name, definition_text, definition_payload_json, definition_revision, state_json, state_version, created_at, updated_at FROM roles WHERE role_id = ?",
      )
      .get(roleId) as RoleRow | undefined;
    if (!row) {
      throw new RoleNotFoundError(roleId);
    }
    return mapRole(row);
  }

  getDefaultWindow(roleId: string): WindowRecord {
    const row = this.db
      .prepare(
        "SELECT window_id, role_id, kind, source, created_at, updated_at FROM windows WHERE role_id = ? AND kind = 'main' ORDER BY rowid ASC LIMIT 1",
      )
      .get(roleId) as WindowRow | undefined;
    if (!row) {
      throw new WindowNotFoundError("main");
    }
    return mapWindow(row);
  }

  updateDefinition(input: {
    roleId: string;
    displayName?: string;
    definitionText?: string;
    definitionPayload?: Record<string, unknown>;
    expectedRevision?: number;
  }): RoleRecord {
    return this.db.transaction(() => {
      const current = this.getRole(input.roleId);
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== current.definitionRevision
      ) {
        throw new RevisionConflictError(
          input.expectedRevision,
          current.definitionRevision,
        );
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE roles SET display_name = ?, definition_text = ?, definition_payload_json = ?, definition_revision = ?, updated_at = ? WHERE role_id = ?",
        )
        .run(
          input.displayName ?? current.displayName,
          input.definitionText ?? current.definition.text,
          JSON.stringify(
            input.definitionPayload ?? current.definition.payload,
          ),
          current.definitionRevision + 1,
          now,
          input.roleId,
        );
      return this.getRole(input.roleId);
    })();
  }

  getState(roleId: string): {
    state: Record<string, unknown>;
    stateVersion: number;
    updatedAt: string;
  } {
    const role = this.getRole(roleId);
    return {
      state: role.state,
      stateVersion: role.stateVersion,
      updatedAt: role.updatedAt,
    };
  }

  setState(input: {
    roleId: string;
    state: Record<string, unknown>;
    expectedVersion?: number;
  }): { stateVersion: number; updatedAt: string } {
    return this.db.transaction(() => {
      const current = this.getRole(input.roleId);
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== current.stateVersion
      ) {
        throw new StateVersionConflictError(
          input.expectedVersion,
          current.stateVersion,
        );
      }
      const nextVersion = current.stateVersion + 1;
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE roles SET state_json = ?, state_version = ?, updated_at = ? WHERE role_id = ?",
        )
        .run(JSON.stringify(input.state), nextVersion, now, input.roleId);
      return { stateVersion: nextVersion, updatedAt: now };
    })();
  }

  createWindow(input: {
    roleId: string;
    kind: "main" | "custom";
    source: string;
  }): WindowRecord {
    return this.db.transaction(() => {
      if (!this.hasRole(input.roleId)) {
        throw new RoleNotFoundError(input.roleId);
      }
      const windowId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO windows (window_id, role_id, kind, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(windowId, input.roleId, input.kind, input.source, now, now);
      return this.getWindow(input.roleId, windowId);
    })();
  }

  getOrCreateWindow(input: {
    roleId: string;
    kind: "main" | "custom";
    source: string;
  }): WindowRecord {
    return this.db.transaction(() => {
      if (!this.hasRole(input.roleId)) {
        throw new RoleNotFoundError(input.roleId);
      }
      const row = this.db
        .prepare(
          `SELECT window_id, role_id, kind, source, created_at, updated_at
             FROM windows
            WHERE role_id = ? AND kind = ? AND source = ?
            ORDER BY rowid ASC LIMIT 1`,
        )
        .get(input.roleId, input.kind, input.source) as WindowRow | undefined;
      if (row) {
        return mapWindow(row);
      }
      return this.createWindow(input);
    })();
  }

  listWindows(roleId: string): WindowRecord[] {
    const rows = this.db
      .prepare(
        "SELECT window_id, role_id, kind, source, created_at, updated_at FROM windows WHERE role_id = ? ORDER BY rowid ASC",
      )
      .all(roleId) as WindowRow[];
    return rows.map(mapWindow);
  }

  getWindow(roleId: string, windowId: string): WindowRecord {
    const row = this.db
      .prepare(
        "SELECT window_id, role_id, kind, source, created_at, updated_at FROM windows WHERE window_id = ? AND role_id = ?",
      )
      .get(windowId, roleId) as WindowRow | undefined;
    if (!row) {
      throw new WindowNotFoundError(windowId);
    }
    return mapWindow(row);
  }

  submitMessage(
    roleId: string,
    windowId: string,
    input: SubmitMessageInput,
  ): SubmitMessageResult {
    return this.db.transaction(() => {
      this.getWindow(roleId, windowId);
      const submissionHash = createHash("sha256")
        .update(input.content, "utf8")
        .digest("hex");
      const existing = this.db
        .prepare(
          "SELECT message_id, window_id, sender, content, source_platform, status, sequence, submission_id, submission_hash, created_at, updated_at FROM messages WHERE window_id = ? AND submission_id = ?",
        )
        .get(windowId, input.submissionId) as MessageRow | undefined;
      if (existing) {
        if (existing.submission_hash !== submissionHash) {
          throw new SubmissionConflictError(windowId, input.submissionId);
        }
        return { message: mapMessage(existing), duplicate: true };
      }
      const sequence = (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM messages WHERE window_id = ?",
          )
          .get(windowId) as { next_sequence: number }
      ).next_sequence;
      const messageId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO messages (message_id, window_id, sender, content, source_platform, status, sequence, submission_id, submission_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          messageId,
          windowId,
          "user",
          input.content,
          input.sourcePlatform,
          "received",
          sequence,
          input.submissionId,
          submissionHash,
          now,
          now,
        );
      const inserted = this.db
        .prepare(
          "SELECT message_id, window_id, sender, content, source_platform, status, sequence, submission_id, submission_hash, created_at, updated_at FROM messages WHERE message_id = ?",
        )
        .get(messageId) as MessageRow;
      return { message: mapMessage(inserted), duplicate: false };
    })();
  }

  /** 只读查询：按提交标识找回已接收的消息，不要求角色仍在活动。 */
  findMessageBySubmission(
    windowId: string,
    submissionId: string,
  ): MessageRecord | null {
    const row = this.db
      .prepare(
        "SELECT message_id, window_id, sender, content, source_platform, status, sequence, submission_id, submission_hash, created_at, updated_at FROM messages WHERE window_id = ? AND submission_id = ?",
      )
      .get(windowId, submissionId) as MessageRow | undefined;
    return row === undefined ? null : mapMessage(row);
  }

  listMessages(
    roleId: string,
    windowId: string,
    after: number,
    limit: number,
  ): ListMessagesResult {
    return this.listMessagePage(roleId, windowId, { after, limit });
  }

  /**
   * 无游标时返回最近一页；after 向前翻页，before 向历史翻页。
   * 返回按 sequence 升序。
   */
  listMessagePage(
    roleId: string,
    windowId: string,
    query: MessagePageQuery,
  ): ListMessagesResult {
    this.getWindow(roleId, windowId);
    const limit = query.limit;
    const columns =
      "message_id, window_id, sender, content, source_platform, status, sequence, submission_id, submission_hash, created_at, updated_at";
    if (query.after !== undefined && query.after !== null) {
      const rows = this.db
        .prepare(
          `SELECT ${columns} FROM messages WHERE window_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
        )
        .all(windowId, query.after, limit + 1) as MessageRow[];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        items: page.map(mapMessage),
        nextAfter: hasMore ? (page.at(-1)?.sequence ?? null) : null,
        nextBefore: null,
      };
    }
    const before =
      query.before !== undefined && query.before !== null
        ? query.before
        : Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM messages WHERE window_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`,
      )
      .all(windowId, before, limit + 1) as MessageRow[];
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
    return {
      items: page.map(mapMessage),
      nextAfter: null,
      nextBefore: hasMore ? (page[0]?.sequence ?? null) : null,
    };
  }

  listRoleBindings(roleId: string): RoleBindingRecord[] {
    this.assertRole(roleId);
    const rows = this.db
      .prepare(
        "SELECT role_id, capability, resource_id, model_name, enabled, created_at, updated_at FROM role_bindings WHERE role_id = ? ORDER BY capability ASC, resource_id ASC",
      )
      .all(roleId) as RoleBindingRow[];
    return rows.map(mapRoleBinding);
  }

  replaceRoleBindings(
    roleId: string,
    bindings: readonly RoleBindingInput[],
  ): RoleBindingRecord[] {
    return this.db.transaction(() => {
      this.assertRole(roleId);
      this.db
        .prepare("DELETE FROM role_bindings WHERE role_id = ?")
        .run(roleId);
      const now = new Date().toISOString();
      const seen = new Set<string>();
      let chatModels = 0;
      let memoryModels = 0;
      const insert = this.db.prepare(
        "INSERT INTO role_bindings (role_id, capability, resource_id, model_name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const binding of bindings) {
        const pair = `${binding.capability}:${binding.resourceId}`;
        if (seen.has(pair)) {
          throw new BindingConflictError("同一能力重复绑定了同一资源", {
            capability: binding.capability,
            resourceId: binding.resourceId,
          });
        }
        seen.add(pair);
        if (binding.capability === "chat_model") {
          chatModels += 1;
          if (chatModels > 1) {
            throw new BindingConflictError("每个角色最多绑定一个对话模型");
          }
        }
        if (binding.capability === "memory_model") {
          memoryModels += 1;
          if (memoryModels > 1) {
            throw new BindingConflictError("每个角色最多绑定一个记忆模型");
          }
        }
        insert.run(
          roleId,
          binding.capability,
          binding.resourceId,
          binding.modelName,
          binding.enabled ? 1 : 0,
          now,
          now,
        );
      }
      return this.listRoleBindings(roleId);
    })();
  }

  /**
   * 删除指向某个全局资源的绑定行。全局资源被删除时调用：
   * 236 §8 规定关闭的绑定不再拦截删除，删掉资源后这些行必须一起清理，
   * 否则角色会留下指向不存在资源的绑定。
   */
  deleteBindingsForResource(resourceId: string): number {
    const result = this.db
      .prepare("DELETE FROM role_bindings WHERE resource_id = ?")
      .run(resourceId);
    return result.changes;
  }

  createTask(input: {
    roleId: string;
    goal: string;
    origin?: TaskOrigin;
    initiatorExecutionId?: string | null;
  }): TaskRecord {
    return this.db.transaction(() => {
      this.assertRole(input.roleId);
      const taskId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO tasks
             (task_id, role_id, goal, status, end_reason, origin,
              initiator_execution_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          input.roleId,
          input.goal,
          "active",
          null,
          input.origin ?? "user",
          input.initiatorExecutionId ?? null,
          now,
          now,
        );
      return this.getTask(input.roleId, taskId);
    })();
  }

  getTask(roleId: string, taskId: string): TaskRecord {
    const row = this.db
      .prepare(
        "SELECT task_id, role_id, goal, status, end_reason, origin, initiator_execution_id, created_at, updated_at FROM tasks WHERE task_id = ? AND role_id = ?",
      )
      .get(taskId, roleId) as TaskRow | undefined;
    if (!row) {
      throw new TaskNotFoundError(taskId);
    }
    return mapTask(row);
  }

  listTasks(roleId: string): TaskRecord[] {
    this.assertRole(roleId);
    const rows = this.db
      .prepare(
        "SELECT task_id, role_id, goal, status, end_reason, origin, initiator_execution_id, created_at, updated_at FROM tasks WHERE role_id = ? ORDER BY created_at ASC, task_id ASC",
      )
      .all(roleId) as TaskRow[];
    return rows.map(mapTask);
  }

  finishTask(input: {
    roleId: string;
    taskId: string;
    status: "completed" | "failed";
    endReason: string;
  }): TaskRecord {
    return this.db.transaction(() => {
      const current = this.getTask(input.roleId, input.taskId);
      if (current.status === "completed" || current.status === "failed") {
        if (
          current.status === input.status &&
          current.endReason === input.endReason
        ) {
          return current;
        }
        throw new TaskStateConflictError(
          current.taskId,
          current.status,
          input.status,
        );
      }
      this.db
        .prepare(
          "UPDATE tasks SET status = ?, end_reason = ?, updated_at = ? WHERE task_id = ?",
        )
        .run(
          input.status,
          input.endReason,
          new Date().toISOString(),
          input.taskId,
        );
      return this.getTask(input.roleId, input.taskId);
    })();
  }

  pauseTask(input: {
    roleId: string;
    taskId: string;
    endReason: string;
  }): TaskRecord {
    return this.db.transaction(() => {
      const current = this.getTask(input.roleId, input.taskId);
      if (current.status === "paused") {
        return current;
      }
      if (current.status !== "active") {
        throw new TaskStateConflictError(
          current.taskId,
          current.status,
          "paused",
        );
      }
      this.db
        .prepare(
          "UPDATE tasks SET status = 'paused', end_reason = ?, updated_at = ? WHERE task_id = ?",
        )
        .run(input.endReason, new Date().toISOString(), input.taskId);
      return this.getTask(input.roleId, input.taskId);
    })();
  }

  resumeTask(input: { roleId: string; taskId: string }): TaskRecord {
    return this.db.transaction(() => {
      const current = this.getTask(input.roleId, input.taskId);
      if (current.status === "active") {
        return current;
      }
      if (current.status !== "paused") {
        throw new TaskStateConflictError(
          current.taskId,
          current.status,
          "active",
        );
      }
      this.db
        .prepare(
          "UPDATE tasks SET status = 'active', end_reason = NULL, updated_at = ? WHERE task_id = ?",
        )
        .run(new Date().toISOString(), input.taskId);
      return this.getTask(input.roleId, input.taskId);
    })();
  }

  appendTaskNote(input: {
    roleId: string;
    taskId: string;
    note: string;
    now?: string;
  }): TaskNoteRecord {
    const trimmed = input.note.trim();
    if (trimmed.length === 0) {
      throw new AppError(400, "TASK_NOTE_EMPTY", "任务进度笔记不能为空");
    }
    return this.db.transaction(() => {
      this.getTask(input.roleId, input.taskId);
      const noteId = randomUUID();
      const now = input.now ?? new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO task_notes (note_id, task_id, role_id, note, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(noteId, input.taskId, input.roleId, trimmed, now);
      return {
        noteId,
        taskId: input.taskId,
        roleId: input.roleId,
        note: trimmed,
        createdAt: now,
      };
    })();
  }

  listTaskNotes(roleId: string, taskId: string): TaskNoteRecord[] {
    this.getTask(roleId, taskId);
    const rows = this.db
      .prepare(
        "SELECT note_id, task_id, role_id, note, created_at FROM task_notes WHERE task_id = ? AND role_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(taskId, roleId) as Array<{
      note_id: string;
      task_id: string;
      role_id: string;
      note: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      noteId: row.note_id,
      taskId: row.task_id,
      roleId: row.role_id,
      note: row.note,
      createdAt: row.created_at,
    }));
  }

  createExecution(input: {
    roleId: string;
    windowId?: string | null;
    triggerType: ExecutionTriggerType;
    triggerMessageId?: string | null;
    stateVersionLoaded?: number | null;
  }): ExecutionRecord {
    return this.db.transaction(() => {
      this.assertRole(input.roleId);
      let windowId = input.windowId ?? null;
      if (windowId !== null) {
        this.getWindow(input.roleId, windowId);
      }
      if (input.triggerMessageId !== undefined && input.triggerMessageId !== null) {
        const message = this.db
          .prepare(
            "SELECT m.window_id FROM messages m JOIN windows w ON w.window_id = m.window_id WHERE m.message_id = ? AND w.role_id = ?",
          )
          .get(input.triggerMessageId, input.roleId) as
          | { window_id: string }
          | undefined;
        if (!message) {
          throw new InvalidExecutionReferenceError(
            "触发消息不属于该角色",
            { messageId: input.triggerMessageId },
          );
        }
        if (windowId !== null && windowId !== message.window_id) {
          throw new InvalidExecutionReferenceError(
            "触发消息与执行窗口不一致",
            { messageId: input.triggerMessageId, windowId },
          );
        }
        windowId = message.window_id;
      }
      const executionId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO executions (execution_id, role_id, window_id, trigger_type, trigger_message_id, status, state_version_loaded, state_version_committed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          executionId,
          input.roleId,
          windowId,
          input.triggerType,
          input.triggerMessageId ?? null,
          "running",
          input.stateVersionLoaded ?? null,
          null,
          now,
          now,
        );
      return this.getExecution(input.roleId, executionId);
    })();
  }

  getExecution(roleId: string, executionId: string): ExecutionRecord {
    const row = this.db
      .prepare(
        "SELECT execution_id, role_id, window_id, trigger_type, trigger_message_id, status, state_version_loaded, state_version_committed, created_at, updated_at FROM executions WHERE execution_id = ? AND role_id = ?",
      )
      .get(executionId, roleId) as ExecutionRow | undefined;
    if (!row) {
      throw new ExecutionNotFoundError(executionId);
    }
    return mapExecution(row);
  }

  commitExecution(input: {
    roleId: string;
    executionId: string;
    stateVersionCommitted: number;
    status?: "completed" | "superseded" | "failed";
  }): ExecutionRecord {
    return this.db.transaction(() => {
      const current = this.getExecution(input.roleId, input.executionId);
      if (current.stateVersionCommitted !== null) {
        if (current.stateVersionCommitted === input.stateVersionCommitted) {
          return current;
        }
        throw new ExecutionAlreadyCommittedError(
          current.executionId,
          current.stateVersionCommitted,
          input.stateVersionCommitted,
        );
      }
      this.db
        .prepare(
          "UPDATE executions SET status = ?, state_version_committed = ?, updated_at = ? WHERE execution_id = ?",
        )
        .run(
          input.status ?? "completed",
          input.stateVersionCommitted,
          new Date().toISOString(),
          input.executionId,
        );
      return this.getExecution(input.roleId, input.executionId);
    })();
  }

  linkExecutionTask(input: {
    roleId: string;
    executionId: string;
    taskId: string;
    relation: ExecutionTaskRelation;
  }): ExecutionTaskRecord {
    return this.db.transaction(() => {
      this.getExecution(input.roleId, input.executionId);
      this.getTask(input.roleId, input.taskId);
      const existing = this.db
        .prepare(
          "SELECT execution_id, task_id, relation, created_at FROM execution_tasks WHERE execution_id = ? AND task_id = ?",
        )
        .get(input.executionId, input.taskId) as ExecutionTaskRow | undefined;
      if (existing) {
        if (existing.relation !== input.relation) {
          throw new ExecutionTaskConflictError(
            input.executionId,
            input.taskId,
            existing.relation,
          );
        }
        return mapExecutionTask(existing);
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO execution_tasks (execution_id, task_id, relation, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(input.executionId, input.taskId, input.relation, now);
      return {
        executionId: input.executionId,
        taskId: input.taskId,
        relation: input.relation,
        createdAt: now,
      };
    })();
  }

  listExecutionTasks(
    roleId: string,
    executionId: string,
  ): ExecutionTaskRecord[] {
    this.getExecution(roleId, executionId);
    const rows = this.db
      .prepare(
        "SELECT et.execution_id, et.task_id, et.relation, et.created_at FROM execution_tasks et JOIN tasks t ON t.task_id = et.task_id WHERE et.execution_id = ? AND t.role_id = ? ORDER BY et.created_at ASC",
      )
      .all(executionId, roleId) as ExecutionTaskRow[];
    return rows.map(mapExecutionTask);
  }

  beginToolCall(input: {
    roleId: string;
    taskId: string;
    executionId: string;
    stepKey: string;
    toolName: string;
    args: Record<string, unknown>;
  }): { toolCall: ToolCallRecord; duplicate: boolean } {
    return this.db.transaction(() => {
      this.getExecution(input.roleId, input.executionId);
      this.getTask(input.roleId, input.taskId);
      const linked = this.db
        .prepare(
          "SELECT 1 AS found FROM execution_tasks WHERE execution_id = ? AND task_id = ?",
        )
        .get(input.executionId, input.taskId) as
        | { found: number }
        | undefined;
      if (!linked) {
        throw new InvalidToolCallReferenceError(
          "执行与任务尚未建立关联",
          { executionId: input.executionId, taskId: input.taskId },
        );
      }
      const argsJson = canonicalJson(input.args);
      const existing = this.db
        .prepare(
          `SELECT t.tool_call_id, t.task_id, t.execution_id, t.step_key, t.tool_name, t.args_json, t.status, t.created_at, t.started_at, t.finished_at,
                  COALESCE((SELECT e.mode FROM tool_call_mode_events e WHERE e.tool_call_id = t.tool_call_id ORDER BY e.rowid DESC LIMIT 1), 'foreground') AS mode
             FROM tool_calls t WHERE t.execution_id = ? AND t.step_key = ?`,
        )
        .get(input.executionId, input.stepKey) as ToolCallRow | undefined;
      if (existing) {
        if (
          existing.task_id !== input.taskId ||
          existing.tool_name !== input.toolName ||
          existing.args_json !== argsJson
        ) {
          throw new ToolCallConflictError(input.executionId, input.stepKey);
        }
        return { toolCall: mapToolCall(existing), duplicate: true };
      }
      const toolCallId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO tool_calls (tool_call_id, task_id, execution_id, step_key, tool_name, args_json, status, created_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          toolCallId,
          input.taskId,
          input.executionId,
          input.stepKey,
          input.toolName,
          argsJson,
          "pending",
          now,
          null,
          null,
        );
      this.db
        .prepare(
          "INSERT INTO tool_call_mode_events (event_id, tool_call_id, mode, changed_at) VALUES (?, ?, ?, ?)",
        )
        .run(randomUUID(), toolCallId, "foreground", now);
      return {
        toolCall: this.getToolCall(input.roleId, toolCallId),
        duplicate: false,
      };
    })();
  }

  getToolCall(roleId: string, toolCallId: string): ToolCallRecord {
    const row = this.db
      .prepare(
        `SELECT t.tool_call_id, t.task_id, t.execution_id, t.step_key, t.tool_name, t.args_json, t.status, t.created_at, t.started_at, t.finished_at,
                COALESCE((SELECT e.mode FROM tool_call_mode_events e WHERE e.tool_call_id = t.tool_call_id ORDER BY e.rowid DESC LIMIT 1), 'foreground') AS mode
           FROM tool_calls t JOIN executions x ON x.execution_id = t.execution_id
          WHERE t.tool_call_id = ? AND x.role_id = ?`,
      )
      .get(toolCallId, roleId) as ToolCallRow | undefined;
    if (!row) {
      throw new ToolCallNotFoundError(toolCallId);
    }
    return mapToolCall(row);
  }

  /**
   * 将模型侧调用编号解析为业务工具调用编号。
   * 模型看到的外部工具编号是提供方返回的 wire id，核查工具需要业务编号；
   * 同一执行内的映射随模型调用保存，未知引用返回 null。
   */
  resolveToolCallReference(input: {
    roleId: string;
    executionId: string;
    reference: string;
  }): string | null {
    const direct = this.db
      .prepare(
        `SELECT 1 FROM tool_calls t JOIN executions e ON e.execution_id = t.execution_id
          WHERE t.tool_call_id = ? AND e.role_id = ?`,
      )
      .get(input.reference, input.roleId);
    if (direct !== undefined) {
      return input.reference;
    }
    const rows = this.db
      .prepare(
        "SELECT raw_response_json FROM model_calls WHERE role_id = ? AND execution_id = ?",
      )
      .all(input.roleId, input.executionId) as Array<{
      raw_response_json: string | null;
    }>;
    for (const row of rows) {
      if (row.raw_response_json === null) {
        continue;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(row.raw_response_json);
      } catch {
        continue;
      }
      if (payload === null || typeof payload !== "object") {
        continue;
      }
      const mapping = (payload as { wireCallIds?: unknown }).wireCallIds;
      if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) {
        continue;
      }
      const mapped = (mapping as Record<string, unknown>)[input.reference];
      if (typeof mapped !== "string") {
        continue;
      }
      const exists = this.db
        .prepare(
          `SELECT 1 FROM tool_calls t JOIN executions e ON e.execution_id = t.execution_id
            WHERE t.tool_call_id = ? AND e.role_id = ?`,
        )
        .get(mapped, input.roleId);
      if (exists !== undefined) {
        return mapped;
      }
    }
    return null;
  }

  listToolCalls(roleId: string, executionId: string): ToolCallRecord[] {    this.getExecution(roleId, executionId);
    const rows = this.db
      .prepare(
        `SELECT t.tool_call_id, t.task_id, t.execution_id, t.step_key, t.tool_name, t.args_json, t.status, t.created_at, t.started_at, t.finished_at,
                COALESCE((SELECT e.mode FROM tool_call_mode_events e WHERE e.tool_call_id = t.tool_call_id ORDER BY e.rowid DESC LIMIT 1), 'foreground') AS mode
           FROM tool_calls t WHERE t.execution_id = ? ORDER BY t.created_at ASC, t.rowid ASC`,
      )
      .all(executionId) as ToolCallRow[];
    return rows.map(mapToolCall);
  }

  listTaskToolCalls(roleId: string, taskId: string): ToolCallRecord[] {
    this.getTask(roleId, taskId);
    const rows = this.db
      .prepare(
        `SELECT t.tool_call_id, t.task_id, t.execution_id, t.step_key, t.tool_name, t.args_json, t.status, t.created_at, t.started_at, t.finished_at,
                COALESCE((SELECT e.mode FROM tool_call_mode_events e WHERE e.tool_call_id = t.tool_call_id ORDER BY e.rowid DESC LIMIT 1), 'foreground') AS mode
           FROM tool_calls t WHERE t.task_id = ? ORDER BY t.created_at ASC, t.rowid ASC`,
      )
      .all(taskId) as ToolCallRow[];
    return rows.map(mapToolCall);
  }

  markToolCallRunning(roleId: string, toolCallId: string): ToolCallRecord {
    return this.db.transaction(() => {
      const current = this.getToolCall(roleId, toolCallId);
      if (current.status === "running") {
        return current;
      }
      if (current.status !== "pending") {
        throw new ToolCallStatusConflictError(
          toolCallId,
          current.status,
          "running",
        );
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE tool_calls SET status = ?, started_at = COALESCE(started_at, ?) WHERE tool_call_id = ?",
        )
        .run("running", now, toolCallId);
      return this.getToolCall(roleId, toolCallId);
    })();
  }

  finishToolCall(
    roleId: string,
    toolCallId: string,
    status: ToolResultStatus,
  ): ToolCallRecord {
    return this.db.transaction(() => {
      const current = this.getToolCall(roleId, toolCallId);
      if (current.status === status) {
        return current;
      }
      if (
        current.status === "success" ||
        current.status === "failed" ||
        current.status === "unknown"
      ) {
        throw new ToolCallStatusConflictError(
          toolCallId,
          current.status,
          status,
        );
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE tool_calls SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE tool_call_id = ?",
        )
        .run(status, now, now, toolCallId);
      return this.getToolCall(roleId, toolCallId);
    })();
  }

  recoverInterruptedToolCalls(
    roleId: string,
    now = new Date().toISOString(),
    includedExecutionIds: readonly string[] = [],
  ): number {
    const included = includedExecutionIds.filter(
      (executionId) => executionId.length > 0,
    );
    const placeholders = included.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT tc.tool_call_id, tc.status
           FROM tool_calls tc JOIN executions e ON e.execution_id = tc.execution_id
          WHERE e.role_id = ? AND tc.status IN ('pending', 'running')
            AND (
              e.status NOT IN ('running', 'paused')
              ${included.length === 0 ? "" : `OR e.execution_id IN (${placeholders})`}
            )
            AND NOT EXISTS (
              SELECT 1 FROM tool_results tr WHERE tr.tool_call_id = tc.tool_call_id
            )
          ORDER BY tc.created_at ASC, tc.rowid ASC`,
      )
      .all(roleId, ...included) as Array<{
      tool_call_id: string;
      status: "pending" | "running";
    }>;
    let recovered = 0;
    for (const row of rows) {
      const dispatched = row.status === "running";
      const message = dispatched
        ? "进程中断，无法确认该调用是否已经执行及其结果"
        : "进程中断时该调用尚未派发";
      try {
        this.saveToolResult({
          roleId,
          toolCallId: row.tool_call_id,
          status: dispatched ? "unknown" : "failed",
          adaptedResult: { error: { code: "PROCESS_INTERRUPTED", message } },
          diagnosticCode: "PROCESS_INTERRUPTED",
          error: { code: "PROCESS_INTERRUPTED", message },
          now,
        });
        recovered += 1;
      } catch {
        // 单个调用的历史状态异常不应阻塞其他调用的恢复与任务续行。
      }
    }
    return recovered;
  }

  switchToolCallMode(input: {
    roleId: string;
    toolCallId: string;
    mode: ToolCallMode;
  }): ToolCallModeEventRecord {
    return this.db.transaction(() => {
      const current = this.getToolCall(input.roleId, input.toolCallId);
      if (current.mode === input.mode) {
        const existing = this.db
          .prepare(
            "SELECT event_id, tool_call_id, mode, changed_at FROM tool_call_mode_events WHERE tool_call_id = ? ORDER BY rowid DESC LIMIT 1",
          )
          .get(input.toolCallId) as ToolCallModeEventRow | undefined;
        if (existing) {
          return mapToolCallModeEvent(existing);
        }
      }
      const eventId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO tool_call_mode_events (event_id, tool_call_id, mode, changed_at) VALUES (?, ?, ?, ?)",
        )
        .run(eventId, input.toolCallId, input.mode, now);
      return {
        eventId,
        toolCallId: input.toolCallId,
        mode: input.mode,
        changedAt: now,
      };
    })();
  }

  listToolCallModeEvents(
    roleId: string,
    toolCallId: string,
  ): ToolCallModeEventRecord[] {
    this.getToolCall(roleId, toolCallId);
    const rows = this.db
      .prepare(
        "SELECT event_id, tool_call_id, mode, changed_at FROM tool_call_mode_events WHERE tool_call_id = ? ORDER BY rowid ASC",
      )
      .all(toolCallId) as ToolCallModeEventRow[];
    return rows.map(mapToolCallModeEvent);
  }

  saveToolResult(input: ToolResultInput): {
    result: ToolResultRecord;
    duplicate: boolean;
  } {
    return this.db.transaction(() => {
      const call = this.getToolCall(input.roleId, input.toolCallId);
      const reconcileOnly = input.requireReconciledFromUnknown === true;
      if (
        (input.status === "success" || input.status === "failed") &&
        !hasResultEvidence(input)
      ) {
        throw new ToolResultEvidenceRequiredError(input.toolCallId);
      }
      const existing = this.db
        .prepare(
          "SELECT tool_call_id, status, raw_response_json, adapted_result_json, diagnostic_code, error_json, saved_at, previous_status, previous_diagnostic_code, previous_raw_response_json, previous_adapted_result_json, previous_error_json, reconciled_at, reconciled_by_call_id FROM tool_results WHERE tool_call_id = ?",
        )
        .get(input.toolCallId) as ToolResultRow | undefined;
      if (reconcileOnly) {
        if (existing !== undefined && existing.status === input.status) {
          // 同一补录结论重复提交时保持幂等，不重写原记录。
          return { result: mapToolResult(existing), duplicate: true };
        }
        if (call.status !== "unknown") {
          if (existing !== undefined && existing.status !== "unknown") {
            throw new ToolResultConflictError(
              input.toolCallId,
              existing.status,
              input.status,
            );
          }
          throw new ToolCallStatusConflictError(
            input.toolCallId,
            call.status,
            input.status,
          );
        }
        if (existing !== undefined && existing.status !== "unknown") {
          throw new ToolResultConflictError(
            input.toolCallId,
            existing.status,
            input.status,
          );
        }
      }
      const now = input.now ?? new Date().toISOString();
      if (existing) {
        if (existing.status === input.status) {
          return { result: mapToolResult(existing), duplicate: true };
        }
        if (existing.status === "unknown" && input.status !== "unknown") {
          if (
            (call.status === "success" || call.status === "failed") &&
            call.status !== input.status
          ) {
            throw new ToolCallStatusConflictError(
              input.toolCallId,
              call.status,
              input.status,
            );
          }
          this.db
            .prepare(
              "UPDATE tool_results SET status = ?, raw_response_json = ?, adapted_result_json = ?, diagnostic_code = ?, error_json = ?, previous_status = 'unknown', previous_diagnostic_code = ?, previous_raw_response_json = ?, previous_adapted_result_json = ?, previous_error_json = ?, reconciled_at = ?, reconciled_by_call_id = ? WHERE tool_call_id = ?",
            )
            .run(
              input.status,
              stringifyOptional(input.rawResponse),
              stringifyOptional(input.adaptedResult),
              input.diagnosticCode ?? null,
              stringifyOptional(input.error),
              existing.diagnostic_code,
              existing.raw_response_json,
              existing.adapted_result_json,
              existing.error_json,
              now,
              input.reconciledByCallId ?? null,
              input.toolCallId,
            );
          this.db
            .prepare(
              "UPDATE tool_calls SET status = ?, started_at = COALESCE(started_at, ?), finished_at = COALESCE(finished_at, ?) WHERE tool_call_id = ?",
            )
            .run(input.status, now, now, input.toolCallId);
          registerToolResultEvidence(this.db, {
            roleId: input.roleId,
            toolCallId: input.toolCallId,
            ...(this.timeZone ? { timeZone: this.timeZone } : {}),
            now,
          });
          return {
            result: this.getToolResult(input.roleId, input.toolCallId),
            duplicate: false,
          };
        }
        throw new ToolResultConflictError(
          input.toolCallId,
          existing.status,
          input.status,
        );
      }
      const reconciledFromCall =
        call.status === "unknown" && input.status !== "unknown";
      if (
        !reconciledFromCall &&
        (call.status === "success" ||
          call.status === "failed" ||
          call.status === "unknown") &&
        call.status !== input.status
      ) {
        throw new ToolCallStatusConflictError(
          input.toolCallId,
          call.status,
          input.status,
        );
      }
      this.db
        .prepare(
          "INSERT INTO tool_results (tool_call_id, status, raw_response_json, adapted_result_json, diagnostic_code, error_json, saved_at, previous_status, reconciled_at, reconciled_by_call_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.toolCallId,
          input.status,
          stringifyOptional(input.rawResponse),
          stringifyOptional(input.adaptedResult),
          input.diagnosticCode ?? null,
          stringifyOptional(input.error),
          now,
          reconciledFromCall ? "unknown" : null,
          reconciledFromCall ? now : null,
          reconciledFromCall ? (input.reconciledByCallId ?? null) : null,
        );
      this.db
        .prepare(
          "UPDATE tool_calls SET status = ?, started_at = COALESCE(started_at, ?), finished_at = COALESCE(finished_at, ?) WHERE tool_call_id = ?",
        )
        .run(input.status, now, now, input.toolCallId);
      registerToolResultEvidence(this.db, {
        roleId: input.roleId,
        toolCallId: input.toolCallId,
        ...(this.timeZone ? { timeZone: this.timeZone } : {}),
        now,
      });
      return {
        result: this.getToolResult(input.roleId, input.toolCallId),
        duplicate: false,
      };
    })();
  }

  getToolResult(roleId: string, toolCallId: string): ToolResultRecord {
    this.getToolCall(roleId, toolCallId);
    const row = this.db
      .prepare(
        "SELECT tool_call_id, status, raw_response_json, adapted_result_json, diagnostic_code, error_json, saved_at, previous_status, previous_diagnostic_code, previous_raw_response_json, previous_adapted_result_json, previous_error_json, reconciled_at, reconciled_by_call_id FROM tool_results WHERE tool_call_id = ?",
      )
      .get(toolCallId) as ToolResultRow | undefined;
    if (!row) {
      throw new ToolResultNotFoundError(toolCallId);
    }
    return mapToolResult(row);
  }

  grantResourceContinuation(input: {
    roleId: string;
    taskId: string;
    resourceId: string;
  }): TaskResourceContinuationRecord {
    return this.db.transaction(() => {
      this.getTask(input.roleId, input.taskId);
      const existing = this.db
        .prepare(
          "SELECT task_id, resource_id, granted_at, ended_at FROM task_resource_continuations WHERE task_id = ? AND resource_id = ?",
        )
        .get(input.taskId, input.resourceId) as
        | TaskResourceContinuationRow
        | undefined;
      const now = new Date().toISOString();
      if (existing) {
        if (existing.ended_at === null) {
          return mapTaskResourceContinuation(existing);
        }
        this.db
          .prepare(
            "UPDATE task_resource_continuations SET granted_at = ?, ended_at = NULL WHERE task_id = ? AND resource_id = ?",
          )
          .run(now, input.taskId, input.resourceId);
        return {
          taskId: input.taskId,
          resourceId: input.resourceId,
          grantedAt: now,
          endedAt: null,
        };
      }
      this.db
        .prepare(
          "INSERT INTO task_resource_continuations (task_id, resource_id, granted_at, ended_at) VALUES (?, ?, ?, ?)",
        )
        .run(input.taskId, input.resourceId, now, null);
      return {
        taskId: input.taskId,
        resourceId: input.resourceId,
        grantedAt: now,
        endedAt: null,
      };
    })();
  }

  endResourceContinuation(input: {
    roleId: string;
    taskId: string;
    resourceId: string;
  }): boolean {
    return this.db.transaction(() => {
      this.getTask(input.roleId, input.taskId);
      const result = this.db
        .prepare(
          "UPDATE task_resource_continuations SET ended_at = ? WHERE task_id = ? AND resource_id = ? AND ended_at IS NULL",
        )
        .run(new Date().toISOString(), input.taskId, input.resourceId);
      return result.changes > 0;
    })();
  }

  endOpenResourceContinuationsForTerminalTasks(
    roleId: string,
    now = new Date().toISOString(),
  ): number {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE task_resource_continuations
              SET ended_at = ?
            WHERE ended_at IS NULL
              AND EXISTS (
                SELECT 1 FROM tasks t
                 WHERE t.task_id = task_resource_continuations.task_id
                   AND t.role_id = ? AND t.status IN ('completed', 'failed')
                   AND task_resource_continuations.granted_at < t.updated_at
              )`,
        )
        .run(now, roleId);
      return result.changes;
    })();
  }

  /**
   * 仍未结束的任务链对该资源的占用（DL-71／DL-73、283 R03）。
   *
   * active／paused 任务算占用；已终结任务若仍留着开启的续用记录，并且确实
   * 发出过工具调用（结果可能晚到或连接仍在收尾），也继续算占用，直到结算
   * 与收尾完成关闭记录。没有工具调用的终态残留记录不拦修改，由启动恢复或
   * 终结流程清理。
   */
  listOpenResourceContinuations(
    resourceId: string,
  ): Array<{ taskId: string; taskStatus: TaskStatus }> {
    const rows = this.db
      .prepare(
        `SELECT c.task_id AS task_id, t.status AS task_status
           FROM task_resource_continuations c
           JOIN tasks t ON t.task_id = c.task_id
          WHERE c.resource_id = ? AND c.ended_at IS NULL
            AND (
              t.status IN ('active', 'paused')
              OR EXISTS (
                SELECT 1 FROM tool_calls tc WHERE tc.task_id = c.task_id
              )
            )
          ORDER BY c.granted_at ASC, c.task_id ASC`,
      )
      .all(resourceId) as Array<{ task_id: string; task_status: TaskStatus }>;
    return rows.map((row) => ({
      taskId: row.task_id,
      taskStatus: row.task_status,
    }));
  }

  /** 任务是否还有已发出但未结算的工具调用；终结后要等它们结算再释放资源。 */
  hasUnsettledToolCalls(roleId: string, taskId: string): boolean {
    this.getTask(roleId, taskId);
    const row = this.db
      .prepare(
        `SELECT 1 AS found
           FROM tool_calls tc
          WHERE tc.task_id = ? AND tc.status IN ('pending', 'running')
            AND NOT EXISTS (
              SELECT 1 FROM tool_results tr
               WHERE tr.tool_call_id = tc.tool_call_id
            )
          LIMIT 1`,
      )
      .get(taskId) as { found: number } | undefined;
    return row !== undefined;
  }

  listResourceContinuations(
    roleId: string,
    taskId: string,
  ): TaskResourceContinuationRecord[] {
    this.getTask(roleId, taskId);
    const rows = this.db
      .prepare(
        "SELECT task_id, resource_id, granted_at, ended_at FROM task_resource_continuations WHERE task_id = ? ORDER BY granted_at ASC, resource_id ASC",
      )
      .all(taskId) as TaskResourceContinuationRow[];
    return rows.map(mapTaskResourceContinuation);
  }

  private assertRole(roleId: string): void {
    if (!this.hasRole(roleId)) {
      throw new RoleNotFoundError(roleId);
    }
  }

  close(): void {
    this.db.close();
  }
}

function mapRole(row: RoleRow): RoleRecord {
  return {
    roleId: row.role_id,
    displayName: row.display_name,
    definition: {
      text: row.definition_text,
      payload: JSON.parse(row.definition_payload_json) as Record<
        string,
        unknown
      >,
    },
    definitionRevision: row.definition_revision,
    state: JSON.parse(row.state_json) as Record<string, unknown>,
    stateVersion: row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWindow(row: WindowRow): WindowRecord {
  return {
    windowId: row.window_id,
    roleId: row.role_id,
    kind: row.kind,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    messageId: row.message_id,
    windowId: row.window_id,
    sender: row.sender,
    content: row.content,
    sourcePlatform: row.source_platform,
    status: row.status,
    sequence: row.sequence,
    submissionId: row.submission_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoleBinding(row: RoleBindingRow): RoleBindingRecord {
  return {
    roleId: row.role_id,
    capability: row.capability,
    resourceId: row.resource_id,
    modelName: row.model_name,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    roleId: row.role_id,
    goal: row.goal,
    status: row.status,
    endReason: row.end_reason,
    origin: row.origin,
    initiatorExecutionId: row.initiator_execution_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapExecution(row: ExecutionRow): ExecutionRecord {
  return {
    executionId: row.execution_id,
    roleId: row.role_id,
    windowId: row.window_id,
    triggerType: row.trigger_type,
    triggerMessageId: row.trigger_message_id,
    status: row.status,
    stateVersionLoaded: row.state_version_loaded,
    stateVersionCommitted: row.state_version_committed,
    decisionRound: row.decision_round,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapExecutionTask(row: ExecutionTaskRow): ExecutionTaskRecord {
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    relation: row.relation,
    createdAt: row.created_at,
  };
}

function mapToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    toolCallId: row.tool_call_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    stepKey: row.step_key,
    toolName: row.tool_name,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
    status: row.status,
    mode: row.mode,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapToolCallModeEvent(
  row: ToolCallModeEventRow,
): ToolCallModeEventRecord {
  return {
    eventId: row.event_id,
    toolCallId: row.tool_call_id,
    mode: row.mode,
    changedAt: row.changed_at,
  };
}

function mapToolResult(row: ToolResultRow): ToolResultRecord {
  return {
    toolCallId: row.tool_call_id,
    status: row.status,
    rawResponse:
      row.raw_response_json === null
        ? null
        : (JSON.parse(row.raw_response_json) as unknown),
    adaptedResult:
      row.adapted_result_json === null
        ? null
        : (JSON.parse(row.adapted_result_json) as unknown),
    diagnosticCode: row.diagnostic_code,
    error:
      row.error_json === null ? null : (JSON.parse(row.error_json) as unknown),
    savedAt: row.saved_at,
    previousStatus: row.previous_status,
    previousDiagnosticCode: row.previous_diagnostic_code,
    previousRawResponse:
      row.previous_raw_response_json === null
        ? null
        : (JSON.parse(row.previous_raw_response_json) as unknown),
    previousAdaptedResult:
      row.previous_adapted_result_json === null
        ? null
        : (JSON.parse(row.previous_adapted_result_json) as unknown),
    previousError:
      row.previous_error_json === null
        ? null
        : (JSON.parse(row.previous_error_json) as unknown),
    reconciledAt: row.reconciled_at,
    reconciledByCallId: row.reconciled_by_call_id,
  };
}

function mapTaskResourceContinuation(
  row: TaskResourceContinuationRow,
): TaskResourceContinuationRecord {
  return {
    taskId: row.task_id,
    resourceId: row.resource_id,
    grantedAt: row.granted_at,
    endedAt: row.ended_at,
  };
}

function hasResultEvidence(input: ToolResultInput): boolean {
  return (
    input.rawResponse !== undefined ||
    input.adaptedResult !== undefined ||
    input.error !== undefined
  );
}

function stringifyOptional(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return JSON.stringify(value) ?? null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
