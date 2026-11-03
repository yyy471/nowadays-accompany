import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  MessageStatus,
  ExecutionStatus,
  TaskStatus,
  ToolCallStatus,
  ToolResultRecord,
} from "../domain/types.js";

interface RoleRow {
  id: string;
  name: string;
  settings_json: string;
  state_json: string;
  state_version: number;
  updated_at: string;
}

interface MessageRow {
  id: string;
  role_id: string;
  window_id: string;
  execution_id: string | null;
  sender: "user" | "assistant";
  content: string;
  status: MessageStatus;
  created_at: string;
}

interface ExecutionRow {
  id: string;
  role_id: string;
  window_id: string;
  trigger_message_id: string | null;
  status: ExecutionStatus;
  state_version_loaded: number | null;
  state_version_committed: number | null;
  created_at: string;
  updated_at: string;
}

interface ToolCallRow {
  id: string;
  task_id: string;
  execution_id: string;
  step_key: string;
  tool_name: string;
  args_json: string;
  status: ToolCallStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ToolResultRow {
  tool_call_id: string;
  status: ToolCallStatus;
  result_json: string | null;
  error_json: string | null;
  saved_at: string;
}

interface JoinedToolRow extends ToolCallRow {
  result_status: ToolCallStatus | null;
  result_json: string | null;
  error_json: string | null;
  saved_at: string | null;
}

export interface RoleSnapshot {
  id: string;
  name: string;
  settings: Record<string, unknown>;
  state: Record<string, unknown>;
  stateVersion: number;
}

export interface ExecutionRecord {
  id: string;
  roleId: string;
  windowId: string;
  triggerMessageId: string | null;
  status: ExecutionStatus;
  stateVersionLoaded: number | null;
  stateVersionCommitted: number | null;
}

export interface RegisterToolCallInput {
  executionId: string;
  roleId: string;
  goal: string;
  stepKey: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface RegisterToolCallResult {
  taskId: string;
  toolCallId: string;
  reused: boolean;
}

export interface ToolCallDetail {
  id: string;
  taskId: string;
  executionId: string;
  stepKey: string;
  toolName: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
}

export interface SaveToolResultInput {
  executionId: string;
  toolCallId: string;
  status: ToolCallStatus;
  result: unknown;
  error: unknown;
}

export interface CommitTurnInput {
  executionId: string;
  replyText: string;
  stateUpdate: Record<string, unknown>;
  faultMode?: "commit_fail";
}

export interface CommitTurnResult {
  replyMessageId: string;
  stateVersion: number;
  alreadyCommitted: boolean;
}

export class BusinessStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        state_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        execution_id TEXT,
        sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('received', 'completed', 'interrupted')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        trigger_message_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'superseded', 'failed')),
        state_version_loaded INTEGER,
        state_version_committed INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'unknown')),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_execution_step
        ON tool_calls (execution_id, step_key);

      CREATE TABLE IF NOT EXISTS tool_results (
        tool_call_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'unknown')),
        result_json TEXT,
        error_json TEXT,
        saved_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        context_json TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS late_outputs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        text TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
    `);
  }

  createRole(input: {
    name: string;
    settings: Record<string, unknown>;
    state: Record<string, unknown>;
  }): RoleSnapshot {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO roles (id, name, settings_json, state_json, state_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.name,
        JSON.stringify(input.settings),
        JSON.stringify(input.state),
        1,
        now,
      );
    return {
      id,
      name: input.name,
      settings: input.settings,
      state: input.state,
      stateVersion: 1,
    };
  }

  getRole(roleId: string): RoleSnapshot {
    const row = this.db
      .prepare(
        "SELECT id, name, settings_json, state_json, state_version, updated_at FROM roles WHERE id = ?",
      )
      .get(roleId) as RoleRow | undefined;
    if (!row) {
      throw new Error(`ROLE_NOT_FOUND:${roleId}`);
    }
    return {
      id: row.id,
      name: row.name,
      settings: JSON.parse(row.settings_json) as Record<string, unknown>,
      state: JSON.parse(row.state_json) as Record<string, unknown>,
      stateVersion: row.state_version,
    };
  }

  patchRole(input: {
    roleId: string;
    settingsPatch?: Record<string, unknown>;
    statePatch?: Record<string, unknown>;
  }): RoleSnapshot {
    return this.db.transaction(() => {
      const current = this.getRole(input.roleId);
      const settings = { ...current.settings, ...(input.settingsPatch ?? {}) };
      const state = { ...current.state, ...(input.statePatch ?? {}) };
      const nextVersion = current.stateVersion + 1;
      this.db
        .prepare(
          "UPDATE roles SET settings_json = ?, state_json = ?, state_version = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          JSON.stringify(settings),
          JSON.stringify(state),
          nextVersion,
          new Date().toISOString(),
          input.roleId,
        );
      return {
        ...current,
        settings,
        state,
        stateVersion: nextVersion,
      };
    })();
  }

  insertUserMessage(input: {
    roleId: string;
    windowId: string;
    content: string;
  }): { id: string } {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO messages (id, role_id, window_id, execution_id, sender, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.roleId,
        input.windowId,
        null,
        "user",
        input.content,
        "received",
        new Date().toISOString(),
      );
    return { id };
  }

  getMessage(messageId: string): MessageRow | undefined {
    return this.db
      .prepare(
        "SELECT id, role_id, window_id, execution_id, sender, content, status, created_at FROM messages WHERE id = ?",
      )
      .get(messageId) as MessageRow | undefined;
  }

  createExecution(input: {
    roleId: string;
    windowId: string;
    triggerMessageId: string;
  }): ExecutionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO executions (id, role_id, window_id, trigger_message_id, status, state_version_loaded, state_version_committed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          input.roleId,
          input.windowId,
          input.triggerMessageId,
          "running",
          null,
          null,
          now,
          now,
        );
      this.db
        .prepare("UPDATE messages SET execution_id = ? WHERE id = ?")
        .run(id, input.triggerMessageId);
    })();
    return {
      id,
      roleId: input.roleId,
      windowId: input.windowId,
      triggerMessageId: input.triggerMessageId,
      status: "running",
      stateVersionLoaded: null,
      stateVersionCommitted: null,
    };
  }

  getExecution(executionId: string): ExecutionRecord {
    const row = this.db
      .prepare(
        "SELECT id, role_id, window_id, trigger_message_id, status, state_version_loaded, state_version_committed, created_at, updated_at FROM executions WHERE id = ?",
      )
      .get(executionId) as ExecutionRow | undefined;
    if (!row) {
      throw new Error(`EXECUTION_NOT_FOUND:${executionId}`);
    }
    return {
      id: row.id,
      roleId: row.role_id,
      windowId: row.window_id,
      triggerMessageId: row.trigger_message_id,
      status: row.status,
      stateVersionLoaded: row.state_version_loaded,
      stateVersionCommitted: row.state_version_committed,
    };
  }

  setExecutionStatus(executionId: string, status: ExecutionStatus): void {
    const result = this.db
      .prepare("UPDATE executions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), executionId);
    if (result.changes !== 1) {
      throw new Error(`EXECUTION_NOT_FOUND:${executionId}`);
    }
  }

  recordContextVersion(executionId: string, stateVersion: number): void {
    this.db
      .prepare(
        "UPDATE executions SET state_version_loaded = ?, updated_at = ? WHERE id = ?",
      )
      .run(stateVersion, new Date().toISOString(), executionId);
  }

  getContextMessages(windowId: string, limit = 20) {
    const rows = this.db
      .prepare(
        "SELECT id, role_id, window_id, execution_id, sender, content, status, created_at FROM messages WHERE window_id = ? ORDER BY rowid DESC LIMIT ?",
      )
      .all(windowId, limit) as MessageRow[];
    return rows.reverse();
  }

  registerToolCall(input: RegisterToolCallInput): RegisterToolCallResult {
    return this.db.transaction(() => {
      const existingCall = this.db
        .prepare(
          "SELECT id, task_id FROM tool_calls WHERE execution_id = ? AND step_key = ? ORDER BY rowid ASC LIMIT 1",
        )
        .get(input.executionId, input.stepKey) as
        | { id: string; task_id: string }
        | undefined;
      if (existingCall) {
        return {
          taskId: existingCall.task_id,
          toolCallId: existingCall.id,
          reused: true,
        };
      }

      const existingTask = this.db
        .prepare(
          "SELECT id FROM tasks WHERE execution_id = ? ORDER BY rowid ASC LIMIT 1",
        )
        .get(input.executionId) as { id: string } | undefined;
      const taskId = existingTask?.id ?? randomUUID();
      const now = new Date().toISOString();
      if (!existingTask) {
        this.db
          .prepare(
            "INSERT INTO tasks (id, role_id, execution_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            taskId,
            input.roleId,
            input.executionId,
            input.goal,
            "active",
            now,
            now,
          );
      }
      const toolCallId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO tool_calls (id, task_id, execution_id, step_key, tool_name, args_json, status, created_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          toolCallId,
          taskId,
          input.executionId,
          input.stepKey,
          input.toolName,
          JSON.stringify(input.args),
          "pending",
          now,
          null,
          null,
        );
      return { taskId, toolCallId, reused: false };
    })();
  }

  getToolCall(toolCallId: string): ToolCallDetail {
    const row = this.db
      .prepare(
        "SELECT id, task_id, execution_id, step_key, tool_name, args_json, status FROM tool_calls WHERE id = ?",
      )
      .get(toolCallId) as
      | {
          id: string;
          task_id: string;
          execution_id: string;
          step_key: string;
          tool_name: string;
          args_json: string;
          status: ToolCallStatus;
        }
      | undefined;
    if (!row) {
      throw new Error(`TOOL_CALL_NOT_FOUND:${toolCallId}`);
    }
    return {
      id: row.id,
      taskId: row.task_id,
      executionId: row.execution_id,
      stepKey: row.step_key,
      toolName: row.tool_name,
      args: JSON.parse(row.args_json) as Record<string, unknown>,
      status: row.status,
    };
  }

  getToolResult(toolCallId: string): ToolResultRecord | null {
    const row = this.db
      .prepare(
        "SELECT tool_call_id, status, result_json, error_json, saved_at FROM tool_results WHERE tool_call_id = ?",
      )
      .get(toolCallId) as ToolResultRow | undefined;
    if (!row) {
      return null;
    }
    const call = this.db
      .prepare("SELECT tool_name FROM tool_calls WHERE id = ?")
      .get(toolCallId) as { tool_name: string } | undefined;
    return {
      toolCallId: row.tool_call_id,
      toolName: call?.tool_name ?? "",
      status: row.status,
      result: row.result_json === null ? null : JSON.parse(row.result_json),
      error: row.error_json === null ? null : JSON.parse(row.error_json),
    };
  }

  markToolCallRunning(toolCallId: string): void {
    const result = this.db
      .prepare(
        "UPDATE tool_calls SET status = ?, started_at = ? WHERE id = ? AND status = ?",
      )
      .run("running", new Date().toISOString(), toolCallId, "pending");
    if (result.changes !== 1) {
      throw new Error(`TOOL_CALL_NOT_PENDING:${toolCallId}`);
    }
  }

  saveToolResult(input: SaveToolResultInput): void {
    this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT tool_call_id FROM tool_results WHERE tool_call_id = ?")
        .get(input.toolCallId);
      if (existing) {
        throw new Error(`TOOL_RESULT_ALREADY_SAVED:${input.toolCallId}`);
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO tool_results (tool_call_id, status, result_json, error_json, saved_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.toolCallId,
          input.status,
          JSON.stringify(input.result ?? null),
          input.error === undefined ? null : JSON.stringify(input.error),
          now,
        );
      const result = this.db
        .prepare("UPDATE tool_calls SET status = ?, finished_at = ? WHERE id = ?")
        .run(input.status, now, input.toolCallId);
      if (result.changes !== 1) {
        throw new Error(`TOOL_CALL_NOT_FOUND:${input.toolCallId}`);
      }
    })();
  }

  getToolResults(executionId: string): ToolResultRecord[] {
    const rows = this.db
      .prepare(
        `SELECT tc.id, tc.task_id, tc.execution_id, tc.tool_name, tc.args_json, tc.status,
                tc.created_at, tc.started_at, tc.finished_at,
                tr.status AS result_status, tr.result_json, tr.error_json, tr.saved_at
         FROM tool_calls tc
         LEFT JOIN tool_results tr ON tr.tool_call_id = tc.id
         WHERE tc.execution_id = ?
         ORDER BY tc.rowid ASC`,
      )
      .all(executionId) as JoinedToolRow[];
    return rows.map((row) => ({
      toolCallId: row.id,
      toolName: row.tool_name,
      status: row.result_status ?? row.status,
      result: row.result_json === null ? null : JSON.parse(row.result_json),
      error: row.error_json === null ? null : JSON.parse(row.error_json),
    }));
  }

  saveDecision(input: {
    executionId: string;
    turn: number;
    context: unknown;
    decision: unknown;
  }): void {
    this.db
      .prepare(
        "INSERT INTO decisions (id, execution_id, turn, context_json, decision_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        input.executionId,
        input.turn,
        JSON.stringify(input.context),
        JSON.stringify(input.decision),
        new Date().toISOString(),
      );
  }

  markExecutionSuperseded(
    executionId: string,
    partialText: string,
  ): { messageId: string | null } {
    return this.db.transaction(() => {
      const execution = this.getExecution(executionId);
      if (execution.status !== "running" && execution.status !== "paused") {
        throw new Error(`EXECUTION_NOT_ACTIVE:${execution.status}`);
      }
      const now = new Date().toISOString();
      let messageId: string | null = null;
      if (partialText.length > 0) {
        messageId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO messages (id, role_id, window_id, execution_id, sender, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            messageId,
            execution.roleId,
            execution.windowId,
            executionId,
            "assistant",
            partialText,
            "interrupted",
            now,
          );
      }
      this.db
        .prepare("UPDATE executions SET status = ?, updated_at = ? WHERE id = ?")
        .run("superseded", now, executionId);
      this.db
        .prepare(
          "UPDATE tasks SET status = ?, updated_at = ? WHERE execution_id = ? AND status = ?",
        )
        .run("paused", now, executionId, "active");
      return { messageId };
    })();
  }

  recordLateOutput(executionId: string, text: string): void {
    this.db
      .prepare(
        "INSERT INTO late_outputs (id, execution_id, text, received_at) VALUES (?, ?, ?, ?)",
      )
      .run(randomUUID(), executionId, text, new Date().toISOString());
  }

  commitTurn(input: CommitTurnInput): CommitTurnResult {
    return this.db.transaction(() => {
      const execution = this.getExecution(input.executionId);
      if (execution.status === "completed") {
        const completedReply = this.db
          .prepare(
            "SELECT id FROM messages WHERE execution_id = ? AND sender = 'assistant' AND status = 'completed' ORDER BY rowid DESC LIMIT 1",
          )
          .get(execution.id) as { id: string } | undefined;
        if (!completedReply) {
          throw new Error(`COMMITTED_REPLY_NOT_FOUND:${execution.id}`);
        }
        return {
          replyMessageId: completedReply.id,
          stateVersion:
            execution.stateVersionCommitted ??
            this.getRole(execution.roleId).stateVersion,
          alreadyCommitted: true,
        };
      }
      if (execution.status !== "running") {
        throw new Error(`EXECUTION_NOT_RUNNING:${execution.status}`);
      }
      const role = this.getRole(execution.roleId);
      const nextState = { ...role.state, ...input.stateUpdate };
      const nextVersion = role.stateVersion + 1;
      const now = new Date().toISOString();

      const replyMessageId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO messages (id, role_id, window_id, execution_id, sender, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          replyMessageId,
          role.id,
          execution.windowId,
          execution.id,
          "assistant",
          input.replyText,
          "completed",
          now,
        );
      this.db
        .prepare(
          "UPDATE roles SET state_json = ?, state_version = ?, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(nextState), nextVersion, now, role.id);
      this.db
        .prepare(
          "UPDATE executions SET status = ?, state_version_committed = ?, updated_at = ? WHERE id = ?",
        )
        .run("completed", nextVersion, now, execution.id);
      this.db
        .prepare(
          "UPDATE tasks SET status = ?, updated_at = ? WHERE execution_id = ? AND status = ?",
        )
        .run("completed", now, execution.id, "active");

      if (input.faultMode === "commit_fail") {
        throw new Error("INJECTED_COMMIT_FAILURE");
      }

      return { replyMessageId, stateVersion: nextVersion, alreadyCommitted: false };
    })();
  }

  snapshot(): Record<string, unknown> {
    const parse = (value: string | null): unknown =>
      value === null ? null : JSON.parse(value);
    return {
      roles: (
        this.db.prepare("SELECT * FROM roles ORDER BY rowid").all() as RoleRow[]
      ).map((row) => ({
        ...row,
        settings: parse(row.settings_json),
        state: parse(row.state_json),
      })),
      executions: this.db
        .prepare("SELECT * FROM executions ORDER BY rowid")
        .all(),
      messages: this.db.prepare("SELECT * FROM messages ORDER BY rowid").all(),
      tasks: this.db.prepare("SELECT * FROM tasks ORDER BY rowid").all(),
      toolCalls: (
        this.db.prepare("SELECT * FROM tool_calls ORDER BY rowid").all() as ToolCallRow[]
      ).map((row) => ({ ...row, args: parse(row.args_json) })),
      toolResults: (
        this.db
          .prepare("SELECT * FROM tool_results ORDER BY rowid")
          .all() as ToolResultRow[]
      ).map((row) => ({
        ...row,
        result: parse(row.result_json),
        error: parse(row.error_json),
      })),
      decisions: this.db
        .prepare("SELECT * FROM decisions ORDER BY rowid")
        .all(),
      lateOutputs: this.db
        .prepare("SELECT * FROM late_outputs ORDER BY rowid")
        .all(),
    };
  }

  close(): void {
    this.db.close();
  }
}
