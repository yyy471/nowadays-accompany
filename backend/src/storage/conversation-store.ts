import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ClaimedMessage,
  ConversationExecutionDetail,
  ConversationMessageView,
  ConversationStreamEvent,
  ConversationStreamType,
  ConversationToolOutcome,
  PendingWindow,
} from "../domain/conversation.js";
import {
  ExecutionNotFoundError,
  ExecutionNotRunningError,
  SseCursorInvalidError,
  StateVersionConflictError,
  WindowNotFoundError,
} from "../domain/errors.js";
import { registerMessageEvidence } from "./evidence.js";
import type {
  ExecutionRecord,
  ExecutionStatus,
  ExecutionTriggerType,
  MessageRecord,
  TaskOrigin,
  ToolCallRecord,
  ToolResultRecord,
} from "./role-store.js";

interface ExecutionRow {
  execution_id: string;
  role_id: string;
  window_id: string | null;
  trigger_type: ExecutionTriggerType;
  trigger_message_id: string | null;
  status: ExecutionStatus;
  state_version_loaded: number | null;
  state_version_committed: number | null;
  superseded_by_execution_id: string | null;
  decision_round: number | null;
  created_at: string;
  updated_at: string;
}

interface StreamRow {
  stream_event_id: number;
  role_id: string;
  window_id: string | null;
  execution_id: string;
  event_type: ConversationStreamType;
  payload_json: string;
  created_at: string;
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
  created_at: string;
  updated_at: string;
}

export interface BeginExecutionResult {
  execution: ExecutionRecord;
  messages: ClaimedMessage[];
  taskId: string | null;
}

export interface CommitConversationInput {
  executionId: string;
  content: string;
  statePatch: Record<string, unknown>;
  countsAsConversationRound?: boolean;
  now?: string;
}

export interface CommitConversationResult {
  execution: ExecutionRecord;
  replyMessage: MessageRecord;
  stateVersion: number;
  decisionRound: number | null;
  event: ConversationStreamEvent;
}

export interface InterruptExecutionInput {
  executionId: string;
  partialText: string;
  status: "superseded" | "failed" | "paused";
  reason: string;
  errorCode?: string | null;
  supersededByExecutionId?: string | null;
  now?: string;
}

export interface InterruptExecutionResult {
  execution: ExecutionRecord;
  replyMessage: MessageRecord | null;
  events: ConversationStreamEvent[];
}

export interface RecoveredExecution {
  executionId: string;
  windowId: string | null;
  triggerType: ExecutionTriggerType;
  taskId: string | null;
  taskStatus: string | null;
  taskOrigin: string | null;
}

export interface RecoverableTaskContinuation {
  taskId: string;
  windowId: string;
  origin: TaskOrigin;
}

export interface PrimaryExecutionTask {
  taskId: string;
  status: string;
  origin: TaskOrigin;
  relation: "initiates" | "continues" | "references";
}

export interface CommittedExecutionGap {
  executionId: string;
  taskId: string;
  windowId: string | null;
  replyContent: string;
}

interface InternalToolReceiptRow {
  execution_id: string;
  window_id: string | null;
  execution_status: string;
  payload_json: string;
  created_at: string;
}

export class ConversationStore {
  constructor(
    private readonly db: Database.Database,
    private readonly roleId: string,
    private readonly timeZone?: string,
  ) {}

  listPendingWindows(): PendingWindow[] {
    const rows = this.db
      .prepare(
        `SELECT m.window_id, MIN(m.sequence) AS first_sequence,
                MAX(m.created_at) AS last_created_at, COUNT(*) AS message_count
           FROM messages m JOIN windows w ON w.window_id = m.window_id
          WHERE w.role_id = ? AND m.sender = 'user'
            AND m.processed_by_execution_id IS NULL
            AND m.claimed_by_execution_id IS NULL
          GROUP BY m.window_id
          ORDER BY MIN(m.created_at) ASC, first_sequence ASC`,
      )
      .all(this.roleId) as Array<{
      window_id: string;
      first_sequence: number;
      last_created_at: string;
      message_count: number;
    }>;
    return rows.map((row) => ({
      windowId: row.window_id,
      firstSequence: row.first_sequence,
      lastCreatedAt: row.last_created_at,
      messageCount: row.message_count,
    }));
  }

  getRunningExecution(): ExecutionRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM executions WHERE role_id = ? AND status = 'running' ORDER BY created_at ASC LIMIT 1",
      )
      .get(this.roleId) as ExecutionRow | undefined;
    return row ? mapExecution(row) : null;
  }

  listRunningExecutions(): ExecutionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM executions WHERE role_id = ? AND status = 'running' ORDER BY created_at ASC, rowid ASC",
      )
      .all(this.roleId) as ExecutionRow[];
    return rows.map(mapExecution);
  }

  getRunningExecutionForWindow(windowId: string): ExecutionRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM executions WHERE role_id = ? AND window_id = ? AND status = 'running' ORDER BY created_at ASC LIMIT 1",
      )
      .get(this.roleId, windowId) as ExecutionRow | undefined;
    return row ? mapExecution(row) : null;
  }

  findInterruptedUserTask(windowId: string): string | null {
    // 待回复消息仍指向原中断执行；在改写消息归属前找回独立任务。
    const row = this.db.prepare(
      `SELECT t.task_id
         FROM messages m
         JOIN executions e ON e.execution_id = m.execution_id
         JOIN execution_tasks et ON et.execution_id = e.execution_id
         JOIN tasks t ON t.task_id = et.task_id
        WHERE m.window_id = ? AND e.role_id = ? AND m.sender = 'user'
          AND m.processed_by_execution_id IS NULL
          AND m.claimed_by_execution_id IS NULL
          AND e.status = 'failed' AND t.status = 'active' AND t.origin = 'user'
          AND EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.task_id = t.task_id)
          AND EXISTS (
            SELECT 1 FROM execution_stream_events se
             WHERE se.execution_id = e.execution_id AND se.event_type = 'execution_failed'
               AND json_extract(se.payload_json, '$.errorCode') = 'PROCESS_INTERRUPTED'
          )
        ORDER BY m.sequence ASC LIMIT 1`,
    ).get(windowId, this.roleId) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }

  beginExecution(input: {
    windowId: string;
    triggerType?: ExecutionTriggerType;
    now?: string;
  }): BeginExecutionResult | null {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      const running = this.getRunningExecution();
      if (running) {
        return null;
      }
      const taskId = this.findInterruptedUserTask(input.windowId);
      const messages = this.db
        .prepare(
          `SELECT m.message_id, m.window_id, m.content, m.sequence, m.created_at
             FROM messages m JOIN windows w ON w.window_id = m.window_id
            WHERE m.window_id = ? AND w.role_id = ? AND m.sender = 'user'
              AND m.processed_by_execution_id IS NULL
              AND m.claimed_by_execution_id IS NULL
            ORDER BY m.sequence ASC`,
        )
        .all(input.windowId, this.roleId) as Array<{
        message_id: string;
        window_id: string;
        content: string;
        sequence: number;
        created_at: string;
      }>;
      if (messages.length === 0) {
        return null;
      }
      const role = this.db
        .prepare("SELECT state_version FROM roles WHERE role_id = ?")
        .get(this.roleId) as { state_version: number } | undefined;
      if (!role) {
        return null;
      }
      const executionId = randomUUID();
      const triggerMessageId = messages[0]?.message_id ?? null;
      this.db
        .prepare(
          `INSERT INTO executions
             (execution_id, role_id, window_id, trigger_type, trigger_message_id,
              status, state_version_loaded, state_version_committed, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?, ?)`,
        )
        .run(
          executionId,
          this.roleId,
          input.windowId,
          input.triggerType ?? "user_message",
          triggerMessageId,
          role.state_version,
          now,
          now,
        );
      if (taskId !== null) {
        this.db.prepare(
          `INSERT INTO execution_tasks (execution_id, task_id, relation, created_at)
           VALUES (?, ?, 'continues', ?)`,
        ).run(executionId, taskId, now);
      }
      this.db
        .prepare(
          `UPDATE messages
              SET execution_id = ?, claimed_by_execution_id = ?
            WHERE window_id = ? AND sender = 'user'
              AND processed_by_execution_id IS NULL
              AND claimed_by_execution_id IS NULL`,
        )
        .run(executionId, executionId, input.windowId);
      return {
        execution: this.getExecution(executionId),
        taskId,
        messages: messages.map((row) => ({
          messageId: row.message_id,
          windowId: row.window_id,
          content: row.content,
          sequence: row.sequence,
          createdAt: row.created_at,
        })),
      };
    })();
  }

  beginTaskContinuation(input: {
    taskId: string;
    windowId: string;
    now?: string;
  }): ExecutionRecord | null {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      if (this.getRunningExecution()) {
        return null;
      }
      const task = this.db
        .prepare(
          "SELECT status FROM tasks WHERE task_id = ? AND role_id = ?",
        )
        .get(input.taskId, this.roleId) as { status: string } | undefined;
      if (!task || task.status !== "active") {
        return null;
      }
      const role = this.db
        .prepare("SELECT state_version FROM roles WHERE role_id = ?")
        .get(this.roleId) as { state_version: number } | undefined;
      if (!role) {
        return null;
      }
      const executionId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO executions
             (execution_id, role_id, window_id, trigger_type, trigger_message_id,
              status, state_version_loaded, state_version_committed, created_at, updated_at)
           VALUES (?, ?, ?, 'tool_result', NULL, 'running', ?, NULL, ?, ?)`,
        )
        .run(
          executionId,
          this.roleId,
          input.windowId,
          role.state_version,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO execution_tasks (execution_id, task_id, relation, created_at)
           VALUES (?, ?, 'continues', ?)`,
        )
        .run(executionId, input.taskId, now);
      return this.getExecution(executionId);
    })();
  }

  getExecution(executionId: string): ExecutionRecord {
    const row = this.db
      .prepare(
        "SELECT * FROM executions WHERE execution_id = ? AND role_id = ?",
      )
      .get(executionId, this.roleId) as ExecutionRow | undefined;
    if (!row) {
      throw new ExecutionNotFoundError(executionId);
    }
    return mapExecution(row);
  }

  getExecutionDetail(
    executionId: string,
    eventLimit = 50,
  ): ConversationExecutionDetail {
    const execution = this.getExecution(executionId);
    const messages = this.db
      .prepare(
        `SELECT * FROM messages
          WHERE execution_id = ? OR claimed_by_execution_id = ?
             OR processed_by_execution_id = ?
          ORDER BY sequence ASC`,
      )
      .all(executionId, executionId, executionId) as MessageRow[];
    const calls = this.db
      .prepare(
        "SELECT * FROM tool_calls WHERE execution_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(executionId) as Array<{
      tool_call_id: string;
      task_id: string;
      execution_id: string;
      step_key: string;
      tool_name: string;
      args_json: string;
      status: ToolCallRecord["status"];
      created_at: string;
      started_at: string | null;
      finished_at: string | null;
    }>;
    const results = this.db
      .prepare(
        "SELECT tr.* FROM tool_results tr JOIN tool_calls tc ON tc.tool_call_id = tr.tool_call_id WHERE tc.execution_id = ? ORDER BY tr.saved_at ASC",
      )
      .all(executionId) as Array<{
      tool_call_id: string;
      status: ToolResultRecord["status"];
      raw_response_json: string | null;
      adapted_result_json: string | null;
      diagnostic_code: string | null;
      error_json: string | null;
      saved_at: string;
      previous_status: ToolResultRecord["previousStatus"];
      previous_diagnostic_code: string | null;
      previous_raw_response_json: string | null;
      previous_adapted_result_json: string | null;
      previous_error_json: string | null;
      reconciled_at: string | null;
    }>;
    return {
      execution,
      triggerMessages: messages
        .filter((row) => row.sender === "user")
        .map(mapMessage),
      toolCalls: calls.map((row) => ({
        toolCallId: row.tool_call_id,
        taskId: row.task_id,
        executionId: row.execution_id,
        stepKey: row.step_key,
        toolName: row.tool_name,
        args: parseJsonObject(row.args_json),
        status: row.status,
        mode: "foreground",
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      })),
      toolResults: results.map((row) => ({
        toolCallId: row.tool_call_id,
        status: row.status,
        rawResponse: parseJsonValue(row.raw_response_json),
        adaptedResult: parseJsonValue(row.adapted_result_json),
        diagnosticCode: row.diagnostic_code,
        error: parseJsonValue(row.error_json),
        savedAt: row.saved_at,
        previousStatus: row.previous_status,
        previousDiagnosticCode: row.previous_diagnostic_code,
        previousRawResponse: parseJsonValue(row.previous_raw_response_json),
        previousAdaptedResult: parseJsonValue(row.previous_adapted_result_json),
        previousError: parseJsonValue(row.previous_error_json),
        reconciledAt: row.reconciled_at,
      })),
      latestEvents: this.listLatestEvents(executionId, eventLimit),
    };
  }

  listRecentMessages(
    windowId: string,
    limit = 30,
  ): ConversationMessageView[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE window_id = ?
            ORDER BY sequence DESC LIMIT ?
         ) ORDER BY sequence ASC`,
      )
      .all(windowId, limit) as MessageRow[];
    return rows.map((row) => ({
      messageId: row.message_id,
      windowId: row.window_id,
      sender: row.sender,
      content: row.content,
      status: row.status,
      sequence: row.sequence,
      createdAt: row.created_at,
    }));
  }

  getRoleContext(): {
    displayName: string;
    definitionText: string;
    definitionPayload: Record<string, unknown>;
    state: Record<string, unknown>;
    stateVersion: number;
  } {
    const row = this.db
      .prepare(
        "SELECT display_name, definition_text, definition_payload_json, state_json, state_version FROM roles WHERE role_id = ?",
      )
      .get(this.roleId) as
      | {
          display_name: string;
          definition_text: string;
          definition_payload_json: string;
          state_json: string;
          state_version: number;
        }
      | undefined;
    if (!row) {
      throw new ExecutionNotRunningError(this.roleId, "role_missing");
    }
    return {
      displayName: row.display_name,
      definitionText: row.definition_text,
      definitionPayload: parseJsonObject(row.definition_payload_json),
      state: parseJsonObject(row.state_json),
      stateVersion: row.state_version,
    };
  }

  insertAssistantMessage(input: {
    windowId: string;
    content: string;
    status: "generating" | "completed" | "interrupted";
    executionId: string;
    sequence?: number;
    now?: string;
  }): MessageRecord {
    const now = input.now ?? new Date().toISOString();
    const sequence =
      input.sequence ??
      (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM messages WHERE window_id = ?",
          )
          .get(input.windowId) as { next_sequence: number }
      ).next_sequence;
    const messageId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO messages
           (message_id, window_id, sender, content, source_platform, status,
            sequence, submission_id, submission_hash, created_at, updated_at,
            execution_id)
         VALUES (?, ?, 'assistant', ?, 'nowadays', ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        messageId,
        input.windowId,
        input.content,
        input.status,
        sequence,
        now,
        now,
        input.executionId,
      );
    return this.getMessage(messageId);
  }

  appendProactiveMessage(input: {
    windowId: string;
    content: string;
    executionId: string;
    now?: string;
  }): MessageRecord {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      const window = this.db
        .prepare(
          "SELECT window_id FROM windows WHERE window_id = ? AND role_id = ?",
        )
        .get(input.windowId, this.roleId) as { window_id: string } | undefined;
      if (!window) {
        throw new WindowNotFoundError(input.windowId);
      }
      const message = this.insertAssistantMessage({
        windowId: input.windowId,
        content: input.content,
        status: "completed",
        executionId: input.executionId,
        now,
      });
      registerMessageEvidence(this.db, {
        roleId: this.roleId,
        messageIds: [message.messageId],
        executionId: input.executionId,
        ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
        now,
      });
      this.db
        .prepare(
          "UPDATE windows SET updated_at = ? WHERE window_id = ? AND role_id = ?",
        )
        .run(now, input.windowId, this.roleId);
      this.appendStreamEventInternal({
        windowId: input.windowId,
        executionId: input.executionId,
        type: "message_completed",
        payload: {
          executionId: input.executionId,
          replyMessageId: message.messageId,
          proactive: true,
        },
        now,
      });
      return message;
    })();
  }

  private generatingMessageId(executionId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT message_id FROM messages WHERE execution_id = ? AND sender = 'assistant' AND status = 'generating' ORDER BY sequence ASC LIMIT 1",
      )
      .get(executionId) as { message_id: string } | undefined;
    return row?.message_id ?? null;
  }

  appendMessageDelta(input: {
    executionId: string;
    windowId: string;
    text: string;
    now?: string;
  }): ConversationStreamEvent {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      if (
        input.text.length > 0 &&
        this.generatingMessageId(input.executionId) === null
      ) {
        this.insertAssistantMessage({
          windowId: input.windowId,
          content: "",
          status: "generating",
          executionId: input.executionId,
          now,
        });
      }
      return this.appendStreamEventInternal({
        windowId: input.windowId,
        executionId: input.executionId,
        type: "message_delta",
        payload: { executionId: input.executionId, delta: input.text },
        now,
      });
    })();
  }

  commitConversation(input: CommitConversationInput): CommitConversationResult {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      const execution = this.getExecution(input.executionId);
      if (execution.status === "completed") {
        const reply = this.db
          .prepare(
            "SELECT * FROM messages WHERE execution_id = ? AND sender = 'assistant' AND status = 'completed' ORDER BY sequence DESC LIMIT 1",
          )
          .get(input.executionId) as MessageRow | undefined;
        if (!reply) {
          throw new ExecutionNotRunningError(input.executionId, execution.status);
        }
        const round = this.decisionRoundOf(input.executionId);
        return {
          execution,
          replyMessage: mapMessage(reply),
          stateVersion: execution.stateVersionCommitted ?? 0,
          decisionRound: round,
          event: this.listLatestEvents(input.executionId, 1)[0]!,
        };
      }
      if (execution.status !== "running") {
        throw new ExecutionNotRunningError(input.executionId, execution.status);
      }
      const role = this.db
        .prepare(
          "SELECT state_json, state_version FROM roles WHERE role_id = ?",
        )
        .get(this.roleId) as
        | { state_json: string; state_version: number }
        | undefined;
      if (!role) {
        throw new ExecutionNotRunningError(input.executionId, "role_missing");
      }
      if (
        execution.stateVersionLoaded !== null &&
        execution.stateVersionLoaded !== role.state_version
      ) {
        throw new StateVersionConflictError(
          execution.stateVersionLoaded,
          role.state_version,
        );
      }
      const nextState = {
        ...parseJsonObject(role.state_json),
        ...input.statePatch,
      };
      const nextVersion = role.state_version + 1;
      this.db
        .prepare(
          "UPDATE roles SET state_json = ?, state_version = ?, updated_at = ? WHERE role_id = ?",
        )
        .run(JSON.stringify(nextState), nextVersion, now, this.roleId);
      const generatingId = this.generatingMessageId(input.executionId);
      let replyMessage: MessageRecord | null = null;
      if (execution.windowId === null) {
        replyMessage = null;
      } else if (generatingId !== null) {
        this.db
          .prepare(
            "UPDATE messages SET content = ?, status = 'completed', updated_at = ? WHERE message_id = ?",
          )
          .run(input.content, now, generatingId);
        replyMessage = this.getMessage(generatingId);
      } else {
        replyMessage = this.insertAssistantMessage({
          windowId: execution.windowId,
          content: input.content,
          status: "completed",
          executionId: input.executionId,
          now,
        });
      }
      if (replyMessage === null) {
        throw new ExecutionNotRunningError(input.executionId, "window_missing");
      }
      const round =
        input.countsAsConversationRound === false
          ? null
          : (
              this.db
                .prepare(
                  "SELECT COALESCE(MAX(decision_round), 0) + 1 AS round FROM executions WHERE role_id = ?",
                )
                .get(this.roleId) as { round: number }
            ).round;
      this.db
        .prepare(
          `UPDATE executions
              SET status = 'completed', state_version_committed = ?,
                  decision_round = ?, updated_at = ?
            WHERE execution_id = ?`,
        )
        .run(nextVersion, round, now, input.executionId);
      this.db
        .prepare(
          `UPDATE messages
              SET processed_by_execution_id = ?, claimed_by_execution_id = NULL,
                  updated_at = ?
            WHERE claimed_by_execution_id = ? AND processed_by_execution_id IS NULL`,
        )
        .run(input.executionId, now, input.executionId);
      const userMessages = this.db
        .prepare(
          "SELECT message_id FROM messages WHERE processed_by_execution_id = ? AND sender = 'user' ORDER BY sequence ASC",
        )
        .all(input.executionId) as Array<{ message_id: string }>;
      registerMessageEvidence(this.db, {
        roleId: this.roleId,
        messageIds: [
          ...userMessages.map((message) => message.message_id),
          replyMessage.messageId,
        ],
        executionId: input.executionId,
        ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
        now,
      });
      const event = this.appendStreamEventInternal({
        windowId: execution.windowId,
        executionId: input.executionId,
        type: "message_completed",
        payload: {
          executionId: input.executionId,
          replyMessageId: replyMessage.messageId,
          stateVersion: nextVersion,
          ...(round === null ? {} : { decisionRound: round }),
        },
        now,
      });
      return {
        execution: this.getExecution(input.executionId),
        replyMessage: this.getMessage(replyMessage.messageId),
        stateVersion: nextVersion,
        decisionRound: round,
        event,
      };
    })();
  }

  interruptExecution(input: InterruptExecutionInput): InterruptExecutionResult {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      const execution = this.getExecution(input.executionId);
      if (execution.status !== "running") {
        return {
          execution,
          replyMessage: null,
          events: [],
        };
      }
      const events: ConversationStreamEvent[] = [];
      let replyMessage: MessageRecord | null = null;
      if (execution.windowId !== null) {
        const generatingId = this.generatingMessageId(input.executionId);
        if (generatingId !== null && input.partialText.length === 0) {
          this.db
            .prepare("DELETE FROM messages WHERE message_id = ?")
            .run(generatingId);
        } else if (input.partialText.length > 0) {
          if (generatingId !== null) {
            this.db
              .prepare(
                "UPDATE messages SET content = ?, status = 'interrupted', updated_at = ? WHERE message_id = ?",
              )
              .run(input.partialText, now, generatingId);
            replyMessage = this.getMessage(generatingId);
          } else {
            const insertedSequence =
              input.status === "superseded"
                ? this.makeRoomForInterruptedReply(
                    execution.windowId,
                    input.executionId,
                  )
                : undefined;
            replyMessage = this.insertAssistantMessage({
              windowId: execution.windowId,
              content: input.partialText,
              status: "interrupted",
              executionId: input.executionId,
              ...(insertedSequence === undefined
                ? {}
                : { sequence: insertedSequence }),
              now,
            });
          }
          registerMessageEvidence(this.db, {
            roleId: this.roleId,
            messageIds: [replyMessage.messageId],
            executionId: input.executionId,
            ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
            now,
          });
          events.push(
            this.appendStreamEventInternal({
              windowId: execution.windowId,
              executionId: input.executionId,
              type: "message_interrupted",
              payload: {
                executionId: input.executionId,
                replyMessageId: replyMessage.messageId,
                reason: input.reason,
              },
              now,
            }),
          );
        }
      }
      this.db
        .prepare(
          `UPDATE executions
              SET status = ?, superseded_by_execution_id = ?, updated_at = ?
            WHERE execution_id = ?`,
        )
        .run(
          input.status,
          input.supersededByExecutionId ?? null,
          now,
          input.executionId,
        );
      this.db
        .prepare(
          "UPDATE messages SET claimed_by_execution_id = NULL, updated_at = ? WHERE claimed_by_execution_id = ? AND processed_by_execution_id IS NULL",
        )
        .run(now, input.executionId);
      events.push(
        this.appendStreamEventInternal({
          windowId: execution.windowId,
          executionId: input.executionId,
          type:
            input.status === "superseded"
              ? "execution_superseded"
              : input.status === "paused"
                ? "execution_paused"
                : "execution_failed",
          payload:
            input.status === "superseded"
              ? {
                  executionId: input.executionId,
                  supersededByExecutionId:
                    input.supersededByExecutionId ?? null,
                }
              : {
                  executionId: input.executionId,
                  errorCode: input.errorCode ?? "EXECUTION_FAILED",
                },
          now,
        }),
      );
      return {
        execution: this.getExecution(input.executionId),
        replyMessage,
        events,
      };
    })();
  }

  appendStreamEvent(input: {
    windowId: string | null;
    executionId: string;
    type: ConversationStreamType;
    payload: Record<string, unknown>;
    now?: string;
  }): ConversationStreamEvent {
    return this.appendStreamEventInternal({
      ...input,
      now: input.now ?? new Date().toISOString(),
    });
  }

  listStreamEventsAfter(
    windowId: string,
    after: number,
    limit = 200,
  ): ConversationStreamEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_stream_events
          WHERE role_id = ? AND window_id = ? AND stream_event_id > ?
          ORDER BY stream_event_id ASC LIMIT ?`,
      )
      .all(this.roleId, windowId, after, limit) as StreamRow[];
    return rows.map(mapStreamEvent);
  }

  listLatestEvents(
    executionId: string,
    limit = 50,
  ): ConversationStreamEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_stream_events
          WHERE role_id = ? AND execution_id = ?
          ORDER BY stream_event_id DESC LIMIT ?`,
      )
      .all(this.roleId, executionId, limit) as StreamRow[];
    return rows.reverse().map(mapStreamEvent);
  }

  latestEventId(windowId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(stream_event_id), 0) AS latest FROM execution_stream_events WHERE role_id = ? AND window_id = ?",
      )
      .get(this.roleId, windowId) as { latest: number };
    return row.latest;
  }

  validateCursor(windowId: string, after: number): void {
    if (after === 0) {
      return;
    }
    const row = this.db
      .prepare(
        "SELECT stream_event_id FROM execution_stream_events WHERE role_id = ? AND window_id = ? AND stream_event_id = ?",
      )
      .get(this.roleId, windowId, after) as
      | { stream_event_id: number }
      | undefined;
    if (!row) {
      throw new SseCursorInvalidError(after);
    }
  }

  startModelCall(input: {
    executionId: string;
    resourceId: string;
    modelName: string;
    protocol: "openai-chat" | "openai-responses" | "anthropic-messages";
    purpose?: "user_chat" | "user_task" | "memory_maintenance" | "autonomous" | "connection_test";
    counted?: boolean;
    now?: string;
  }): string {
    const now = input.now ?? new Date().toISOString();
    const purpose = input.purpose ?? "user_chat";
    return this.db.transaction(() => {
      const modelCallId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO model_calls
             (model_call_id, role_id, execution_id, batch_id, purpose, resource_id,
              model_name, protocol, status, error_code, started_at, finished_at,
              usage_json, raw_response_json)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'running', NULL, ?, NULL, NULL, NULL)`,
        )
        .run(
          modelCallId,
          this.roleId,
          input.executionId,
          purpose,
          input.resourceId,
          input.modelName,
          input.protocol,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO call_metering
             (metering_id, role_id, execution_id, task_id, batch_id, call_kind,
              call_id, purpose, counted, created_at)
           VALUES (?, ?, ?, NULL, NULL, 'model', ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          this.roleId,
          input.executionId,
          modelCallId,
          purpose,
          input.counted === true ? 1 : 0,
          now,
        );
      return modelCallId;
    })();
  }

  finishModelCall(input: {
    modelCallId: string;
    status: "succeeded" | "failed";
    errorCode: string | null;
    usage?: { inputTokens?: number; outputTokens?: number } | null;
    rawResponse?: unknown;
    continuation?: unknown;
    wireCallIds?: Record<string, string>;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    const raw =
      input.rawResponse === undefined &&
      input.continuation === undefined &&
      input.wireCallIds === undefined
        ? null
        : JSON.stringify({
            ...(input.rawResponse === undefined
              ? {}
              : { rawResponse: input.rawResponse }),
            ...(input.continuation === undefined
              ? {}
              : { continuation: input.continuation }),
            ...(input.wireCallIds === undefined
              ? {}
              : { wireCallIds: input.wireCallIds }),
          });
    this.db
      .prepare(
        `UPDATE model_calls
            SET status = ?, error_code = ?, finished_at = ?, usage_json = ?,
                raw_response_json = ?
          WHERE model_call_id = ? AND role_id = ?`,
      )
      .run(
        input.status,
        input.errorCode,
        now,
        input.usage === undefined || input.usage === null
          ? null
          : JSON.stringify(input.usage),
        raw,
        input.modelCallId,
        this.roleId,
      );
  }

  attachWireCallIds(
    modelCallId: string,
    wireCallIds: Record<string, string>,
  ): void {
    const row = this.db
      .prepare(
        "SELECT raw_response_json FROM model_calls WHERE model_call_id = ? AND role_id = ?",
      )
      .get(modelCallId, this.roleId) as
      | { raw_response_json: string | null }
      | undefined;
    if (!row) {
      return;
    }
    const payload =
      row.raw_response_json === null
        ? {}
        : parseJsonObject(row.raw_response_json);
    this.db
      .prepare(
        "UPDATE model_calls SET raw_response_json = ? WHERE model_call_id = ?",
      )
      .run(
        JSON.stringify({
          ...payload,
          wireCallIds: {
            ...(payload.wireCallIds !== null &&
            typeof payload.wireCallIds === "object" &&
            !Array.isArray(payload.wireCallIds)
              ? (payload.wireCallIds as Record<string, string>)
              : {}),
            ...wireCallIds,
          },
        }),
        modelCallId,
      );
  }

  getInternalToolReceipt(executionId: string, stepKey: string): {
    outcome: ConversationToolOutcome | null;
    counted: boolean;
    dispatchedAt: string;
  } | null {
    const row = this.db.prepare(
      `SELECT payload_json, created_at FROM execution_stream_events
        WHERE role_id = ? AND execution_id = ?
          AND event_type IN ('tool_started', 'tool_result_saved')
          AND json_extract(payload_json, '$.internalStepKey') = ?
        ORDER BY stream_event_id DESC LIMIT 1`,
    ).get(this.roleId, executionId, stepKey) as
      { payload_json: string; created_at: string } | undefined;
    if (row === undefined) return null;
    const payload = parseJsonObject(row.payload_json);
    return {
      outcome: (payload.outcome as ConversationToolOutcome | undefined) ?? null,
      counted: payload.counted === true,
      dispatchedAt: typeof payload.dispatchedAt === "string" ? payload.dispatchedAt : row.created_at,
    };
  }

  saveInternalToolReceipt(input: {
    executionId: string;
    windowId: string | null;
    taskId: string | null;
    stepKey: string;
    toolName: string;
    purpose: "user_chat" | "autonomous";
    counted: boolean;
    outcome?: ConversationToolOutcome;
    now: string;
  }): void {
    // 复用业务事件保存步骤凭据；完成凭据与计量在同一事务中落盘。
    this.db.transaction(() => {
      const previous = this.getInternalToolReceipt(input.executionId, input.stepKey);
      const dispatchedAt = previous?.dispatchedAt ?? input.now;
      this.appendStreamEvent({
        windowId: input.windowId,
        executionId: input.executionId,
        type: input.outcome === undefined ? "tool_started" : "tool_result_saved",
        payload: {
          executionId: input.executionId,
          toolCallId: input.stepKey,
          toolName: input.toolName,
          internalStepKey: input.stepKey,
          taskId: input.taskId,
          purpose: input.purpose,
          counted: input.counted,
          dispatchedAt,
          ...(input.outcome === undefined ? {} : { status: input.outcome.status, outcome: input.outcome }),
        },
        now: input.now,
      });
      if (input.outcome !== undefined && input.purpose === "autonomous") {
        this.recordToolMetering({
          executionId: input.executionId,
          taskId: input.taskId,
          toolCallId: input.stepKey,
          purpose: input.purpose,
          counted: input.counted,
          now: dispatchedAt,
        });
      }
    })();
  }

  private latestInternalToolReceipts(taskId: string | null = null): InternalToolReceiptRow[] {
    return this.db.prepare(
      `SELECT s.execution_id, s.window_id, e.status AS execution_status,
              s.payload_json, s.created_at
         FROM execution_stream_events s JOIN executions e ON e.execution_id = s.execution_id
        WHERE s.role_id = ? AND e.role_id = ?
          AND s.event_type IN ('tool_started', 'tool_result_saved')
          AND json_extract(s.payload_json, '$.internalStepKey') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM execution_stream_events newer
             WHERE newer.role_id = s.role_id AND newer.execution_id = s.execution_id
               AND newer.event_type IN ('tool_started', 'tool_result_saved')
               AND newer.stream_event_id > s.stream_event_id
               AND json_extract(newer.payload_json, '$.internalStepKey') = json_extract(s.payload_json, '$.internalStepKey')
          )
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM execution_tasks et
             WHERE et.execution_id = s.execution_id AND et.task_id = ?
               AND et.relation IN ('initiates', 'continues')
          ))
        ORDER BY s.stream_event_id ASC`,
    ).all(this.roleId, this.roleId, taskId, taskId) as InternalToolReceiptRow[];
  }

  reconcileInterruptedInternalTools(now = new Date().toISOString()): number {
    // 启动协调不依赖再次进入原节点；终态任务也必须保存实际操作的未知事实。
    return this.db.transaction(() => {
      let reconciled = 0;
      for (const row of this.latestInternalToolReceipts()) {
        if (row.execution_status === "paused") continue;
        const payload = parseJsonObject(row.payload_json);
        const primary = this.getPrimaryExecutionTask(row.execution_id);
        const task = primary?.relation === "references" ? null : primary;
        const purpose = payload.purpose === "autonomous" ||
          (payload.purpose === undefined && (payload.counted === true || task?.origin === "autonomous"))
          ? "autonomous" : "user_chat";
        const stepKey = String(payload.internalStepKey);
        const dispatchedAt = typeof payload.dispatchedAt === "string" ? payload.dispatchedAt : row.created_at;
        if (payload.outcome === undefined || payload.outcome === null) {
          this.saveInternalToolReceipt({
            executionId: row.execution_id, windowId: row.window_id,
            taskId: task?.taskId ?? null, stepKey, toolName: String(payload.toolName),
            purpose, counted: payload.counted === true, now,
            outcome: {
              status: "unknown", diagnosticCode: "PROCESS_INTERRUPTED",
              adaptedResult: { error: { code: "PROCESS_INTERRUPTED", message: "内部操作已进入执行但结果未保存，请先核查实际记录。" } },
            },
          });
          reconciled++;
        } else if (purpose === "autonomous") {
          // 完成凭据已有时仍允许幂等补账，绝不再消耗点数。
          this.recordToolMetering({
            executionId: row.execution_id, taskId: task?.taskId ?? null,
            toolCallId: stepKey, purpose, counted: payload.counted === true, now: dispatchedAt,
          });
        }
      }
      return reconciled;
    })();
  }

  listTaskInternalToolFacts(taskId: string): Array<{
    stepKey: string; toolName: string; dispatchedAt: string;
    executionId: string; executionStatus: string; outcome: ConversationToolOutcome;
  }> {
    return this.latestInternalToolReceipts(taskId).flatMap((row) => {
      const payload = parseJsonObject(row.payload_json);
      if (payload.outcome === undefined || payload.outcome === null) return [];
      return [{
        stepKey: String(payload.internalStepKey), toolName: String(payload.toolName),
        dispatchedAt: typeof payload.dispatchedAt === "string" ? payload.dispatchedAt : row.created_at,
        executionId: row.execution_id, executionStatus: row.execution_status,
        outcome: payload.outcome as ConversationToolOutcome,
      }];
    });
  }

  recordToolMetering(input: {
    executionId: string;
    taskId: string | null;
    toolCallId: string;
    purpose?: "user_chat" | "user_task" | "memory_maintenance" | "autonomous" | "connection_test";
    counted?: boolean;
    now?: string;
  }): void {
    if (this.db.prepare(
      "SELECT 1 FROM call_metering WHERE role_id = ? AND call_kind = 'tool' AND call_id = ?",
    ).get(this.roleId, input.toolCallId)) return;
    const reservation = this.db.prepare(
      `SELECT updated_at FROM autonomy_tool_reservations
        WHERE role_id = ? AND tool_call_id = ? AND status = 'committed'`,
    ).get(this.roleId, input.toolCallId) as { updated_at: string } | undefined;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO call_metering
           (metering_id, role_id, execution_id, task_id, batch_id, call_kind,
            call_id, purpose, counted, created_at)
         VALUES (?, ?, ?, ?, NULL, 'tool', ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        this.roleId,
        input.executionId,
        input.taskId,
        input.toolCallId,
        input.purpose ?? "user_chat",
        input.counted === true ? 1 : 0,
        reservation?.updated_at ?? input.now ?? new Date().toISOString(),
      );
  }

  recoverInterruptedExecutions(
    now = new Date().toISOString(),
    excludedExecutionIds: readonly string[] = [],
  ): RecoveredExecution[] {
    const excluded = excludedExecutionIds.filter(
      (executionId) => executionId.length > 0,
    );
    const placeholders = excluded.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM executions
          WHERE role_id = ? AND status = 'running'
            ${excluded.length === 0 ? "" : `AND execution_id NOT IN (${placeholders})`}
          ORDER BY created_at ASC`,
      )
      .all(this.roleId, ...excluded) as ExecutionRow[];
    const recovered: RecoveredExecution[] = [];
    for (const row of rows) {
      const text = this.partialText(row.execution_id);
      this.interruptExecution({
        executionId: row.execution_id,
        partialText: text,
        status: "failed",
        reason: "PROCESS_INTERRUPTED",
        errorCode: "PROCESS_INTERRUPTED",
        now,
      });
      this.db
        .prepare(
          "UPDATE model_calls SET status = 'failed', error_code = 'PROCESS_INTERRUPTED', finished_at = ? WHERE execution_id = ? AND status = 'running'",
        )
        .run(now, row.execution_id);
      const task = this.db
        .prepare(
          `SELECT et.task_id, t.status, t.origin
             FROM execution_tasks et JOIN tasks t ON t.task_id = et.task_id
            WHERE et.execution_id = ? AND t.role_id = ?
            ORDER BY CASE WHEN t.origin = 'autonomous' AND t.status = 'active'
                          THEN 0 ELSE 1 END,
                     et.created_at ASC
            LIMIT 1`,
        )
        .get(row.execution_id, this.roleId) as
        | { task_id: string; status: string; origin: string }
        | undefined;
      recovered.push({
        executionId: row.execution_id,
        windowId: row.window_id,
        triggerType: row.trigger_type,
        taskId: task?.task_id ?? null,
        taskStatus: task?.status ?? null,
        taskOrigin: task?.origin ?? null,
      });
    }
    return recovered;
  }

  listSupersededTaskContinuations(): RecoverableTaskContinuation[] {
    const rows = this.db
      .prepare(
        `SELECT et.task_id, t.origin, e.window_id
           FROM execution_tasks et
           JOIN executions e ON e.execution_id = et.execution_id
           JOIN tasks t ON t.task_id = et.task_id
          WHERE t.role_id = ? AND t.status = 'active'
            AND e.status = 'superseded' AND e.window_id IS NOT NULL
            AND (
              t.origin = 'autonomous' OR EXISTS (
                SELECT 1 FROM tool_calls tc WHERE tc.task_id = et.task_id
              )
            )
          ORDER BY e.created_at DESC, e.rowid DESC`,
      )
      .all(this.roleId) as Array<{
      task_id: string;
      origin: TaskOrigin;
      window_id: string;
    }>;
    const seen = new Set<string>();
    const continuations: RecoverableTaskContinuation[] = [];
    for (const row of rows) {
      if (seen.has(row.task_id)) {
        continue;
      }
      seen.add(row.task_id);
      continuations.push({
        taskId: row.task_id,
        windowId: row.window_id,
        origin: row.origin,
      });
    }
    return continuations;
  }

  failRunningModelCalls(
    executionId: string,
    now = new Date().toISOString(),
    errorCode = "PROCESS_INTERRUPTED",
  ): number {
    return this.db.transaction(() => {
      const result = this.db.prepare(
        `UPDATE model_calls
            SET status = 'failed', error_code = ?, finished_at = ?
          WHERE execution_id = ? AND role_id = ? AND status = 'running'`,
      ).run(errorCode, now, executionId, this.roleId);
      if (result.changes > 0) {
        const messageId = this.generatingMessageId(executionId);
        const text = this.partialText(executionId);
        if (messageId !== null && text.length > 0) {
          // 原执行可以继续，但未完成的模型输出必须独立保留，不能被新输出覆盖。
          this.db.prepare(
            "UPDATE messages SET content = ?, status = 'interrupted', updated_at = ? WHERE message_id = ?",
          ).run(text, now, messageId);
          registerMessageEvidence(this.db, {
            roleId: this.roleId, messageIds: [messageId], executionId,
            ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }), now,
          });
          this.appendStreamEventInternal({
            windowId: this.getExecution(executionId).windowId,
            executionId, type: "message_interrupted",
            payload: { executionId, replyMessageId: messageId, reason: errorCode }, now,
          });
        }
      }
      return result.changes;
    })();
  }

  listClaimedMessages(executionId: string): ClaimedMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.message_id, m.window_id, m.content, m.sequence, m.created_at
           FROM messages m JOIN windows w ON w.window_id = m.window_id
          WHERE m.claimed_by_execution_id = ? AND w.role_id = ?
            AND m.sender = 'user' AND m.processed_by_execution_id IS NULL
          ORDER BY m.sequence ASC`,
      )
      .all(executionId, this.roleId) as Array<{
      message_id: string;
      window_id: string;
      content: string;
      sequence: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      messageId: row.message_id,
      windowId: row.window_id,
      content: row.content,
      sequence: row.sequence,
      createdAt: row.created_at,
    }));
  }

  getPrimaryExecutionTask(executionId: string): PrimaryExecutionTask | null {
    const row = this.db
      .prepare(
        `SELECT et.task_id, et.relation, t.status, t.origin
           FROM execution_tasks et JOIN tasks t ON t.task_id = et.task_id
          WHERE et.execution_id = ? AND t.role_id = ?
          ORDER BY CASE et.relation
                     WHEN 'initiates' THEN 0
                     WHEN 'continues' THEN 1
                     ELSE 2
                   END ASC,
                   et.created_at ASC
          LIMIT 1`,
      )
      .get(executionId, this.roleId) as
      | {
          task_id: string;
          relation: "initiates" | "continues" | "references";
          status: string;
          origin: TaskOrigin;
        }
      | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      taskId: row.task_id,
      relation: row.relation,
      status: row.status,
      origin: row.origin,
    };
  }

  listCommittedExecutionGaps(): CommittedExecutionGap[] {
    const rows = this.db
      .prepare(
        `SELECT e.execution_id, et.task_id, e.window_id,
                (SELECT m.content FROM messages m
                  WHERE m.execution_id = e.execution_id
                    AND m.sender = 'assistant' AND m.status = 'completed'
                  ORDER BY m.sequence DESC LIMIT 1) AS reply_content
           FROM executions e
           JOIN execution_tasks et ON et.execution_id = e.execution_id
             AND et.relation IN ('initiates', 'continues')
           JOIN tasks t ON t.task_id = et.task_id AND t.role_id = e.role_id
          WHERE e.role_id = ? AND e.status = 'completed'
            AND e.state_version_committed IS NOT NULL AND t.status = 'active'
            AND EXISTS (
              SELECT 1 FROM messages m
               WHERE m.execution_id = e.execution_id
                 AND m.sender = 'assistant' AND m.status = 'completed'
            )
            AND NOT EXISTS (
              SELECT 1 FROM execution_tasks et2
                JOIN executions e2 ON e2.execution_id = et2.execution_id
               WHERE et2.task_id = et.task_id
                 AND e2.status IN ('running', 'paused')
            )
          ORDER BY e.created_at ASC, e.rowid ASC`,
      )
      .all(this.roleId) as Array<{
      execution_id: string;
      task_id: string;
      window_id: string | null;
      reply_content: string;
    }>;
    return rows.map((row) => ({
      executionId: row.execution_id,
      taskId: row.task_id,
      windowId: row.window_id,
      replyContent: row.reply_content,
    }));
  }

  partialText(executionId: string): string {
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM execution_stream_events
          WHERE role_id = ? AND execution_id = ? AND event_type = 'message_delta'
            AND stream_event_id > COALESCE((
              SELECT MAX(stream_event_id) FROM execution_stream_events
               WHERE role_id = ? AND execution_id = ? AND event_type = 'message_interrupted'
            ), 0)
          ORDER BY stream_event_id ASC`,
      )
      .all(this.roleId, executionId, this.roleId, executionId) as Array<{ payload_json: string }>;
    return rows
      .map((row) => {
        const payload = parseJsonObject(row.payload_json);
        return typeof payload.delta === "string" ? payload.delta : "";
      })
      .join("");
  }

  getMessage(messageId: string): MessageRecord {
    const row = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN windows w ON w.window_id = m.window_id
          WHERE m.message_id = ? AND w.role_id = ?`,
      )
      .get(messageId, this.roleId) as MessageRow | undefined;
    if (!row) {
      throw new ExecutionNotRunningError(messageId, "message_missing");
    }
    return mapMessage(row);
  }

  private makeRoomForInterruptedReply(
    windowId: string,
    executionId: string,
  ): number | undefined {
    const claimed = this.db
      .prepare(
        "SELECT MAX(sequence) AS sequence FROM messages WHERE claimed_by_execution_id = ? AND sender = 'user'",
      )
      .get(executionId) as { sequence: number | null };
    if (claimed.sequence === null) {
      return undefined;
    }
    const later = this.db
      .prepare(
        "SELECT message_id, sequence FROM messages WHERE window_id = ? AND sequence > ? ORDER BY sequence DESC",
      )
      .all(windowId, claimed.sequence) as Array<{
      message_id: string;
      sequence: number;
    }>;
    for (const message of later) {
      this.db
        .prepare("UPDATE messages SET sequence = ? WHERE message_id = ?")
        .run(message.sequence + 1, message.message_id);
    }
    return claimed.sequence + 1;
  }

  private decisionRoundOf(executionId: string): number | null {
    const row = this.db
      .prepare(
        "SELECT decision_round FROM executions WHERE execution_id = ? AND role_id = ?",
      )
      .get(executionId, this.roleId) as
      | { decision_round: number | null }
      | undefined;
    return row?.decision_round ?? null;
  }

  private appendStreamEventInternal(input: {
    windowId: string | null;
    executionId: string;
    type: ConversationStreamType;
    payload: Record<string, unknown>;
    now: string;
  }): ConversationStreamEvent {
    const payload: Record<string, unknown> = {
      ...input.payload,
      executionId: input.executionId,
      ...(input.windowId === null ? {} : { windowId: input.windowId }),
      createdAt: input.now,
    };
    const result = this.db
      .prepare(
        `INSERT INTO execution_stream_events
           (role_id, window_id, execution_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.roleId,
        input.windowId,
        input.executionId,
        input.type,
        JSON.stringify(payload),
        input.now,
      );
    return {
      streamEventId: Number(result.lastInsertRowid),
      roleId: this.roleId,
      windowId: input.windowId,
      executionId: input.executionId,
      type: input.type,
      payload,
      createdAt: input.now,
    };
  }
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

function mapStreamEvent(row: StreamRow): ConversationStreamEvent {
  return {
    streamEventId: row.stream_event_id,
    roleId: row.role_id,
    windowId: row.window_id,
    executionId: row.execution_id,
    type: row.event_type,
    payload: parseJsonObject(row.payload_json),
    createdAt: row.created_at,
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

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonValue(value: string | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
