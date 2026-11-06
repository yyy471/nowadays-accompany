import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError, AutonomyBudgetExhaustedError } from "../domain/errors.js";
import { localDateFromIso } from "./evidence.js";
import type { ExecutionRecord } from "./role-store.js";

export const DEFAULT_AUTONOMY_DAILY_LIMIT = 200;

export type AutonomyWakeKind = "scheduled" | "budget_resume";
export type AutonomyWakeStatus = "pending" | "claimed" | "completed" | "cancelled";
export type AutonomyActivityStatus = "running" | "completed" | "failed" | "paused";
export type AutonomyToolReservationStatus =
  | "reserved"
  | "committed"
  | "released";

export interface AutonomyToolReservationRecord {
  toolCallId: string;
  roleId: string;
  localDate: string;
  counted: boolean;
  status: AutonomyToolReservationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AutonomyBudgetRecord {
  roleId: string;
  localDate: string;
  usedPoints: number;
  dailyLimit: number;
  unlimited: boolean;
  updatedAt: string;
}

export interface AutonomyWakeRecord {
  wakeId: string;
  roleId: string;
  kind: AutonomyWakeKind;
  scheduledAt: string;
  intent: string;
  status: AutonomyWakeStatus;
  sourceExecutionId: string | null;
  taskId: string | null;
  activityId: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BegunAutonomyWake {
  wake: AutonomyWakeRecord;
  execution: ExecutionRecord;
  taskId: string;
  activity: AutonomyActivityRecord;
}

export interface AutonomyActivityRecord {
  activityId: string;
  roleId: string;
  wakeId: string;
  taskId: string;
  executionId: string;
  windowId: string;
  status: AutonomyActivityStatus;
  summary: string | null;
  sharedMessageId: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BudgetRow {
  role_id: string;
  local_date: string;
  used_points: number;
  daily_limit: number;
  unlimited: number;
  updated_at: string;
}

interface WakeRow {
  wake_id: string;
  role_id: string;
  kind: AutonomyWakeKind;
  scheduled_at: string;
  intent: string;
  status: AutonomyWakeStatus;
  source_execution_id: string | null;
  task_id: string | null;
  activity_id: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface ActivityRow {
  activity_id: string;
  role_id: string;
  wake_id: string;
  task_id: string;
  execution_id: string;
  window_id: string;
  status: AutonomyActivityStatus;
  summary: string | null;
  shared_message_id: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ToolReservationRow {
  tool_call_id: string;
  role_id: string;
  local_date: string;
  counted: number;
  status: AutonomyToolReservationStatus;
  created_at: string;
  updated_at: string;
}

export class AutonomyStore {
  constructor(
    private readonly db: Database.Database,
    private readonly roleId: string,
    private readonly timeZone?: string,
  ) {}

  getBudget(nowIso = new Date().toISOString()): AutonomyBudgetRecord {
    return this.db.transaction(() => {
      this.ensureBudgetRow(nowIso);
      return this.readBudget();
    })();
  }

  setBudget(input: {
    dailyLimit: number;
    unlimited: boolean;
    now?: string;
  }): AutonomyBudgetRecord {
    if (!Number.isInteger(input.dailyLimit) || input.dailyLimit <= 0) {
      throw new AppError(
        400,
        "AUTONOMY_BUDGET_INVALID",
        "自主活动每日额度必须是正整数",
      );
    }
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      this.ensureBudgetRow(now);
      this.db
        .prepare(
          `UPDATE autonomy_budget
              SET daily_limit = ?, unlimited = ?, updated_at = ?
            WHERE role_id = ?`,
        )
        .run(
          input.dailyLimit,
          input.unlimited ? 1 : 0,
          now,
          this.roleId,
        );
      return this.readBudget();
    })();
  }

  consumePoint(input: {
    now?: string;
  }): { budget: AutonomyBudgetRecord; counted: boolean; exhausted: boolean } {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      this.ensureBudgetRow(now);
      const current = this.readBudget();
      if (current.unlimited) {
        return { budget: current, counted: false, exhausted: false };
      }
      if (current.usedPoints >= current.dailyLimit) {
        return { budget: current, counted: false, exhausted: true };
      }
      this.db
        .prepare(
          `UPDATE autonomy_budget
              SET used_points = used_points + 1, updated_at = ?
            WHERE role_id = ?`,
        )
        .run(now, this.roleId);
      return {
        budget: this.readBudget(),
        counted: true,
        exhausted: false,
      };
    })();
  }

  releasePoint(input: { localDate: string; now?: string }): void {
    const now = input.now ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE autonomy_budget
            SET used_points = used_points - 1, updated_at = ?
          WHERE role_id = ? AND local_date = ? AND used_points > 0`,
      )
      .run(now, this.roleId, input.localDate);
  }

  reserveToolPoint(input: { toolCallId: string; now?: string }): {
    budget: AutonomyBudgetRecord;
    counted: boolean;
    localDate: string;
    exhausted: boolean;
  } {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      this.ensureBudgetRow(now);
      const current = this.readBudget();
      const existing = this.getToolReservationRow(input.toolCallId);
      if (existing !== undefined) {
        return {
          budget: current,
          counted: existing.counted === 1,
          localDate: existing.local_date,
          exhausted: false,
        };
      }
      if (current.unlimited) {
        this.insertToolReservation({
          toolCallId: input.toolCallId,
          localDate: current.localDate,
          counted: false,
          now,
        });
        return {
          budget: current,
          counted: false,
          localDate: current.localDate,
          exhausted: false,
        };
      }
      if (current.usedPoints >= current.dailyLimit) {
        return {
          budget: current,
          counted: false,
          localDate: current.localDate,
          exhausted: true,
        };
      }
      this.db
        .prepare(
          `UPDATE autonomy_budget
              SET used_points = used_points + 1, updated_at = ?
            WHERE role_id = ?`,
        )
        .run(now, this.roleId);
      this.insertToolReservation({
        toolCallId: input.toolCallId,
        localDate: current.localDate,
        counted: true,
        now,
      });
      return {
        budget: this.readBudget(),
        counted: true,
        localDate: current.localDate,
        exhausted: false,
      };
    })();
  }

  commitToolReservation(input: { toolCallId: string; now?: string }): {
    counted: boolean;
    found: boolean;
  } {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      const row = this.getToolReservationRow(input.toolCallId);
      if (row === undefined) {
        return { counted: false, found: false };
      }
      if (row.status === "committed") {
        return { counted: row.counted === 1, found: true };
      }
      if (row.status === "released") {
        return { counted: false, found: true };
      }
      const currentDate = localDateFromIso(now, this.timeZone);
      if (row.counted === 1 && row.local_date === currentDate) {
        this.markToolReservation({
          toolCallId: input.toolCallId,
          status: "committed",
          counted: true,
          now,
        });
        return { counted: true, found: true };
      }
      this.ensureBudgetRow(now);
      const budget = this.readBudget();
      if (budget.unlimited) {
        this.markToolReservation({
          toolCallId: input.toolCallId,
          status: "committed",
          counted: false,
          now,
        });
        return { counted: false, found: true };
      }
      if (budget.usedPoints >= budget.dailyLimit) {
        throw new AutonomyBudgetExhaustedError(
          this.roleId,
          budget.dailyLimit,
          budget.usedPoints,
        );
      }
      this.db
        .prepare(
          `UPDATE autonomy_budget
              SET used_points = used_points + 1, updated_at = ?
            WHERE role_id = ?`,
        )
        .run(now, this.roleId);
      this.markToolReservation({
        toolCallId: input.toolCallId,
        status: "committed",
        counted: true,
        now,
      });
      return { counted: true, found: true };
    })();
  }

  releaseToolReservation(input: { toolCallId: string; now?: string }): {
    released: boolean;
    refunded: boolean;
  } {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      const row = this.getToolReservationRow(input.toolCallId);
      if (row === undefined || row.status !== "reserved") {
        return { released: false, refunded: false };
      }
      let refunded = false;
      if (row.counted === 1) {
        const result = this.db
          .prepare(
            `UPDATE autonomy_budget
                SET used_points = used_points - 1, updated_at = ?
              WHERE role_id = ? AND local_date = ? AND used_points > 0`,
          )
          .run(now, this.roleId, row.local_date);
        refunded = result.changes > 0;
      }
      this.markToolReservation({
        toolCallId: input.toolCallId,
        status: "released",
        counted: row.counted === 1,
        now,
      });
      return { released: true, refunded };
    })();
  }

  reconcileToolReservations(now = new Date().toISOString()): {
    committed: number;
    released: number;
    metered: number;
  } {
    return this.db.transaction(() => {
      const reserved = this.db
        .prepare(
          `SELECT r.tool_call_id, r.role_id, r.local_date, r.counted, r.status,
                  r.created_at, r.updated_at, tc.status AS call_status,
                  e.status AS execution_status, tr.status AS result_status
             FROM autonomy_tool_reservations r
             JOIN tool_calls tc ON tc.tool_call_id = r.tool_call_id
             JOIN executions e ON e.execution_id = tc.execution_id
             LEFT JOIN tool_results tr ON tr.tool_call_id = r.tool_call_id
            WHERE r.role_id = ? AND r.status = 'reserved'
            ORDER BY r.created_at ASC, r.rowid ASC`,
        )
        .all(this.roleId) as Array<
        ToolReservationRow & {
          call_status: string;
          execution_status: string;
          result_status: string | null;
        }
      >;
      let committed = 0;
      let released = 0;
      for (const row of reserved) {
        if (row.execution_status === "paused") {
          continue;
        }
        // 预留提交先于实际派发；仍为 reserved 说明派发没有被确认。
        const dispatched =
          row.result_status === "success" || row.result_status === "unknown";
        if (dispatched) {
          this.markToolReservation({
            toolCallId: row.tool_call_id,
            status: "committed",
            counted: row.counted === 1,
            now,
          });
          committed += 1;
        } else {
          if (row.counted === 1) {
            this.db
              .prepare(
                `UPDATE autonomy_budget
                    SET used_points = used_points - 1, updated_at = ?
                  WHERE role_id = ? AND local_date = ? AND used_points > 0`,
              )
              .run(now, this.roleId, row.local_date);
          }
          this.markToolReservation({
            toolCallId: row.tool_call_id,
            status: "released",
            counted: row.counted === 1,
            now,
          });
          released += 1;
        }
      }
      let metered = 0;
      const committedRows = this.db
        .prepare(
          `SELECT r.tool_call_id, r.counted, r.updated_at AS dispatched_at, tc.execution_id, tc.task_id
             FROM autonomy_tool_reservations r
             JOIN tool_calls tc ON tc.tool_call_id = r.tool_call_id
            WHERE r.role_id = ? AND r.status = 'committed'
              AND NOT EXISTS (
                SELECT 1 FROM call_metering m
                 WHERE m.call_kind = 'tool' AND m.call_id = r.tool_call_id
              )
            ORDER BY r.created_at ASC, r.rowid ASC`,
        )
        .all(this.roleId) as Array<{
        tool_call_id: string;
        counted: number;
        dispatched_at: string;
        execution_id: string;
        task_id: string;
      }>;
      for (const row of committedRows) {
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO call_metering
               (metering_id, role_id, execution_id, task_id, batch_id,
                call_kind, call_id, purpose, counted, created_at)
             VALUES (?, ?, ?, ?, NULL, 'tool', ?, 'autonomous', ?, ?)`,
          )
          .run(
            randomUUID(),
            this.roleId,
            row.execution_id,
            row.task_id,
            row.tool_call_id,
            row.counted,
            row.dispatched_at,
          );
        metered += result.changes > 0 ? 1 : 0;
      }
      return { committed, released, metered };
    })();
  }

  reconcileTerminalActivities(now = new Date().toISOString()): {
    activities: number;
    wakes: number;
  } {
    return this.db.transaction(() => {
      const activities = this.db
        .prepare(
          `SELECT a.activity_id, e.status AS execution_status,
                  (SELECT m.content FROM messages m
                    WHERE m.execution_id = a.execution_id
                      AND m.sender = 'assistant' AND m.status = 'completed'
                    ORDER BY m.sequence DESC LIMIT 1) AS reply
             FROM autonomy_activities a
             JOIN executions e ON e.execution_id = a.execution_id
            WHERE a.role_id = ? AND a.status = 'running'
              AND e.status IN ('completed', 'failed')
            ORDER BY a.created_at ASC, a.rowid ASC`,
        )
        .all(this.roleId) as Array<{
        activity_id: string;
        execution_status: "completed" | "failed";
        reply: string | null;
      }>;
      for (const row of activities) {
        const status =
          row.execution_status === "completed" ? "completed" : "failed";
        this.db
          .prepare(
            `UPDATE autonomy_activities
                SET status = ?, summary = COALESCE(?, summary),
                    finished_at = ?, updated_at = ?
              WHERE activity_id = ? AND role_id = ?`,
          )
          .run(
            status,
            status === "completed" ? truncateText(row.reply, 2000) : null,
            now,
            now,
            row.activity_id,
            this.roleId,
          );
      }
      const wakes = this.db
        .prepare(
          `SELECT w.wake_id, a.status AS activity_status
             FROM autonomy_wakes w
             JOIN autonomy_activities a ON a.activity_id = w.activity_id
            WHERE w.role_id = ? AND w.status = 'claimed'
              AND a.status IN ('completed', 'failed')`,
        )
        .all(this.roleId) as Array<{
        wake_id: string;
        activity_status: "completed" | "failed";
      }>;
      for (const row of wakes) {
        this.completeWake({
          wakeId: row.wake_id,
          errorCode:
            row.activity_status === "failed" ? "EXECUTION_FAILED" : null,
          now,
        });
      }
      return { activities: activities.length, wakes: wakes.length };
    })();
  }

  getToolReservation(
    toolCallId: string,
  ): AutonomyToolReservationRecord | null {
    const row = this.getToolReservationRow(toolCallId);
    return row === undefined ? null : mapToolReservation(row);
  }

  private getToolReservationRow(
    toolCallId: string,
  ): ToolReservationRow | undefined {
    return this.db
      .prepare(
        `SELECT tool_call_id, role_id, local_date, counted, status,
                created_at, updated_at
           FROM autonomy_tool_reservations
          WHERE tool_call_id = ? AND role_id = ?`,
      )
      .get(toolCallId, this.roleId) as ToolReservationRow | undefined;
  }

  private insertToolReservation(input: {
    toolCallId: string;
    localDate: string;
    counted: boolean;
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO autonomy_tool_reservations
           (tool_call_id, role_id, local_date, counted, status,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'reserved', ?, ?)`,
      )
      .run(
        input.toolCallId,
        this.roleId,
        input.localDate,
        input.counted ? 1 : 0,
        input.now,
        input.now,
      );
  }

  private markToolReservation(input: {
    toolCallId: string;
    status: AutonomyToolReservationStatus;
    counted: boolean;
    now: string;
  }): void {
    this.db
      .prepare(
        `UPDATE autonomy_tool_reservations
            SET status = ?, counted = ?, updated_at = ?
          WHERE tool_call_id = ? AND role_id = ?`,
      )
      .run(
        input.status,
        input.counted ? 1 : 0,
        input.now,
        input.toolCallId,
        this.roleId,
      );
  }

  createWake(input: {
    kind: AutonomyWakeKind;
    scheduledAt: string;
    intent: string;
    sourceExecutionId?: string | null;
    taskId?: string | null;
    now?: string;
  }): AutonomyWakeRecord {
    const scheduled = Date.parse(input.scheduledAt);
    if (Number.isNaN(scheduled)) {
      throw new AppError(
        400,
        "AUTONOMY_WAKE_TIME_INVALID",
        "自主安排时间格式无效",
      );
    }
    const scheduledAt = new Date(scheduled).toISOString();
    const intent = input.intent.trim();
    if (intent.length === 0) {
      throw new AppError(
        400,
        "AUTONOMY_WAKE_INTENT_INVALID",
        "自主安排目标不能为空",
      );
    }
    const now = input.now ?? new Date().toISOString();
    const wakeId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO autonomy_wakes
           (wake_id, role_id, kind, scheduled_at, intent, status,
            source_execution_id, task_id, activity_id, claimed_at,
            completed_at, last_error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        wakeId,
        this.roleId,
        input.kind,
        scheduledAt,
        intent,
        input.sourceExecutionId ?? null,
        input.taskId ?? null,
        now,
        now,
      );
    return this.getWake(wakeId);
  }

  getWake(wakeId: string): AutonomyWakeRecord {
    const row = this.db
      .prepare(
        "SELECT * FROM autonomy_wakes WHERE wake_id = ? AND role_id = ?",
      )
      .get(wakeId, this.roleId) as WakeRow | undefined;
    if (!row) {
      throw new AppError(404, "AUTONOMY_WAKE_NOT_FOUND", "自主安排不存在");
    }
    return mapWake(row);
  }

  listWakes(limit = 100): AutonomyWakeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM autonomy_wakes
          WHERE role_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(this.roleId, limit) as WakeRow[];
    return rows.map(mapWake);
  }

  nextPendingWake(): AutonomyWakeRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM autonomy_wakes
          WHERE role_id = ? AND status = 'pending'
          ORDER BY julianday(scheduled_at) ASC, created_at ASC
          LIMIT 1`,
      )
      .get(this.roleId) as WakeRow | undefined;
    return row === undefined ? null : mapWake(row);
  }

  listDueWakes(nowIso: string): AutonomyWakeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM autonomy_wakes
          WHERE role_id = ? AND status = 'pending'
            AND julianday(scheduled_at) <= julianday(?)
          ORDER BY julianday(scheduled_at) ASC, created_at ASC`,
      )
      .all(this.roleId, nowIso) as WakeRow[];
    return rows.map(mapWake);
  }

  completeWake(input: {
    wakeId: string;
    errorCode?: string | null;
    now?: string;
  }): AutonomyWakeRecord {
    const now = input.now ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE autonomy_wakes
            SET status = 'completed', completed_at = ?, last_error_code = ?, updated_at = ?
          WHERE wake_id = ? AND role_id = ? AND status = 'claimed'`,
      )
      .run(now, input.errorCode ?? null, now, input.wakeId, this.roleId);
    return this.getWake(input.wakeId);
  }

  cancelWake(wakeId: string, now = new Date().toISOString()): AutonomyWakeRecord {
    const result = this.db
      .prepare(
        `UPDATE autonomy_wakes
            SET status = 'cancelled', completed_at = ?, updated_at = ?
          WHERE wake_id = ? AND role_id = ? AND status = 'pending'`,
      )
      .run(now, now, wakeId, this.roleId);
    if (result.changes === 0) {
      const existing = this.db
        .prepare(
          "SELECT 1 FROM autonomy_wakes WHERE wake_id = ? AND role_id = ?",
        )
        .get(wakeId, this.roleId);
      if (existing === undefined) {
        throw new AppError(404, "AUTONOMY_WAKE_NOT_FOUND", "自主安排不存在");
      }
      throw new AppError(
        409,
        "AUTONOMY_WAKE_NOT_PENDING",
        "只有待执行的自主安排可以取消",
      );
    }
    return this.getWake(wakeId);
  }

  cancelPendingBudgetResumes(
    taskId: string,
    reason: string,
    now = new Date().toISOString(),
  ): number {
    const result = this.db
      .prepare(
        `UPDATE autonomy_wakes
            SET status = 'cancelled', completed_at = ?,
                last_error_code = ?, updated_at = ?
          WHERE role_id = ? AND task_id = ? AND kind = 'budget_resume'
            AND status = 'pending'`,
      )
      .run(now, reason, now, this.roleId, taskId);
    return result.changes;
  }

  private cancelPendingWake(
    wakeId: string,
    reason: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE autonomy_wakes
            SET status = 'cancelled', completed_at = ?,
                last_error_code = ?, updated_at = ?
          WHERE wake_id = ? AND role_id = ? AND status = 'pending'`,
      )
      .run(now, reason, now, wakeId, this.roleId);
  }

  listActivities(limit = 100): AutonomyActivityRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM autonomy_activities
          WHERE role_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(this.roleId, limit) as ActivityRow[];
    return rows.map(mapActivity);
  }

  hasPausedActivity(): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM autonomy_activities a
           JOIN tasks t ON t.task_id = a.task_id
          WHERE a.role_id = ? AND a.status = 'paused' AND t.status = 'paused'
          LIMIT 1`,
      )
      .get(this.roleId);
    return row !== undefined;
  }

  getActivity(activityId: string): AutonomyActivityRecord {
    const row = this.db
      .prepare(
        "SELECT * FROM autonomy_activities WHERE activity_id = ? AND role_id = ?",
      )
      .get(activityId, this.roleId) as ActivityRow | undefined;
    if (!row) {
      throw new AppError(
        404,
        "AUTONOMY_ACTIVITY_NOT_FOUND",
        "自主活动不存在",
      );
    }
    return mapActivity(row);
  }

  getLatestActivityByTask(taskId: string): AutonomyActivityRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM autonomy_activities
          WHERE role_id = ? AND task_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(this.roleId, taskId) as ActivityRow | undefined;
    return row === undefined ? null : mapActivity(row);
  }

  getActivityByExecution(executionId: string): AutonomyActivityRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM autonomy_activities
          WHERE role_id = ? AND execution_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(this.roleId, executionId) as ActivityRow | undefined;
    return row === undefined ? null : mapActivity(row);
  }

  findPendingBudgetResume(taskId: string): AutonomyWakeRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM autonomy_wakes
          WHERE role_id = ? AND kind = 'budget_resume'
            AND task_id = ? AND status = 'pending'
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(this.roleId, taskId) as WakeRow | undefined;
    return row === undefined ? null : mapWake(row);
  }

  createActivity(input: {
    wakeId: string;
    taskId: string;
    executionId: string;
    windowId: string;
    now?: string;
  }): AutonomyActivityRecord {
    const now = input.now ?? new Date().toISOString();
    const activityId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO autonomy_activities
           (activity_id, role_id, wake_id, task_id, execution_id, window_id,
            status, summary, shared_message_id, started_at, finished_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        activityId,
        this.roleId,
        input.wakeId,
        input.taskId,
        input.executionId,
        input.windowId,
        now,
        now,
        now,
      );
    return this.getActivity(activityId);
  }

  updateActivity(input: {
    activityId: string;
    status: AutonomyActivityStatus;
    executionId?: string;
    summary?: string | null;
    sharedMessageId?: string | null;
    now?: string;
  }): AutonomyActivityRecord {
    const now = input.now ?? new Date().toISOString();
    const sets = ["status = ?", "updated_at = ?"];
    const values: Array<string | null> = [input.status, now];
    if (input.executionId !== undefined) {
      sets.push("execution_id = ?");
      values.push(input.executionId);
    }
    if (input.summary !== undefined) {
      sets.push("summary = ?");
      values.push(input.summary);
    }
    if (input.sharedMessageId !== undefined) {
      sets.push("shared_message_id = ?");
      values.push(input.sharedMessageId);
    }
    if (input.status === "completed" || input.status === "failed") {
      sets.push("finished_at = ?");
      values.push(now);
    }
    values.push(input.activityId, this.roleId);
    this.db
      .prepare(
        `UPDATE autonomy_activities SET ${sets.join(", ")}
          WHERE activity_id = ? AND role_id = ?`,
      )
      .run(...values);
    return this.getActivity(input.activityId);
  }

  beginDueWake(input: {
    windowId: string;
    now?: string;
  }): BegunAutonomyWake | null {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      const running = this.db
        .prepare(
          "SELECT execution_id FROM executions WHERE role_id = ? AND status = 'running' LIMIT 1",
        )
        .get(this.roleId) as { execution_id: string } | undefined;
      if (running) {
        return null;
      }
      const wakeRow = this.db
        .prepare(
          `SELECT * FROM autonomy_wakes
            WHERE role_id = ? AND status = 'pending'
              AND julianday(scheduled_at) <= julianday(?)
            ORDER BY julianday(scheduled_at) ASC, created_at ASC
            LIMIT 1`,
        )
        .get(this.roleId, now) as WakeRow | undefined;
      if (!wakeRow) {
        return null;
      }
      const role = this.db
        .prepare("SELECT state_version FROM roles WHERE role_id = ?")
        .get(this.roleId) as { state_version: number } | undefined;
      if (!role) {
        return null;
      }
      const window = this.db
        .prepare(
          "SELECT window_id FROM windows WHERE window_id = ? AND role_id = ?",
        )
        .get(input.windowId, this.roleId) as
        | { window_id: string }
        | undefined;
      if (!window) {
        throw new AppError(404, "AUTONOMY_WINDOW_NOT_FOUND", "自主活动窗口不存在");
      }

      const wake = mapWake(wakeRow);
      let taskId: string | null = null;
      let relation: "initiates" | "continues" = "initiates";
      if (wake.kind === "budget_resume") {
        if (wake.taskId === null) {
          this.cancelPendingWake(
            wake.wakeId,
            "AUTONOMY_RESUME_TASK_MISSING",
            now,
          );
          return null;
        }
        const task = this.db
          .prepare(
            "SELECT status, origin FROM tasks WHERE task_id = ? AND role_id = ?",
          )
          .get(wake.taskId, this.roleId) as
          | { status: string; origin: string }
          | undefined;
        if (!task || task.origin !== "autonomous") {
          this.cancelPendingWake(
            wake.wakeId,
            "AUTONOMY_RESUME_TASK_MISSING",
            now,
          );
          return null;
        }
        if (task.status !== "paused" && task.status !== "active") {
          this.cancelPendingWake(
            wake.wakeId,
            "AUTONOMY_RESUME_TASK_ENDED",
            now,
          );
          return null;
        }
        taskId = wake.taskId;
        this.db
          .prepare(
            `UPDATE tasks
                SET status = 'active', end_reason = NULL, updated_at = ?
              WHERE task_id = ?`,
          )
          .run(now, taskId);
        relation = "continues";
      } else if (wake.taskId !== null) {
        // scheduled 唤醒携带任务编号：接回原任务链（GAP-02），
        // 任务已终态则取消唤醒，不降级新建链。
        const task = this.db
          .prepare(
            "SELECT status FROM tasks WHERE task_id = ? AND role_id = ?",
          )
          .get(wake.taskId, this.roleId) as { status: string } | undefined;
        if (!task) {
          this.cancelPendingWake(
            wake.wakeId,
            "AUTONOMY_RESUME_TASK_MISSING",
            now,
          );
          return null;
        }
        if (task.status === "completed" || task.status === "failed") {
          this.cancelPendingWake(
            wake.wakeId,
            "AUTONOMY_RESUME_TASK_ENDED",
            now,
          );
          return null;
        }
        taskId = wake.taskId;
        if (task.status === "paused") {
          this.db
            .prepare(
              `UPDATE tasks
                  SET status = 'active', end_reason = NULL, updated_at = ?
                WHERE task_id = ?`,
            )
            .run(now, taskId);
        }
        relation = "continues";
      }

      const executionId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO executions
             (execution_id, role_id, window_id, trigger_type, trigger_message_id,
              status, state_version_loaded, state_version_committed, created_at, updated_at)
           VALUES (?, ?, ?, 'autonomous', NULL, 'running', ?, NULL, ?, ?)`,
        )
        .run(
          executionId,
          this.roleId,
          input.windowId,
          role.state_version,
          now,
          now,
        );

      if (taskId === null) {
        taskId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO tasks
               (task_id, role_id, goal, status, end_reason, origin,
                initiator_execution_id, created_at, updated_at)
             VALUES (?, ?, ?, 'active', NULL, 'autonomous', ?, ?, ?)`,
          )
          .run(
            taskId,
            this.roleId,
            wake.intent,
            executionId,
            now,
            now,
          );
      }

      this.db
        .prepare(
          `INSERT OR IGNORE INTO execution_tasks
             (execution_id, task_id, relation, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(executionId, taskId, relation, now);

      const activityId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO autonomy_activities
             (activity_id, role_id, wake_id, task_id, execution_id, window_id,
              status, summary, shared_message_id, started_at, finished_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL, ?, ?)`,
        )
        .run(
          activityId,
          this.roleId,
          wake.wakeId,
          taskId,
          executionId,
          input.windowId,
          now,
          now,
          now,
        );
      this.db
        .prepare(
          `UPDATE autonomy_wakes
              SET status = 'claimed', activity_id = ?, claimed_at = ?, updated_at = ?
            WHERE wake_id = ? AND status = 'pending'`,
        )
        .run(activityId, now, now, wake.wakeId);

      return {
        wake: this.getWake(wake.wakeId),
        execution: {
          executionId,
          roleId: this.roleId,
          windowId: input.windowId,
          triggerType: "autonomous" as const,
          triggerMessageId: null,
          status: "running" as const,
          stateVersionLoaded: role.state_version,
          stateVersionCommitted: null,
          decisionRound: null,
          createdAt: now,
          updatedAt: now,
        },
        taskId,
        activity: this.getActivity(activityId),
      };
    })();
  }

  private ensureBudgetRow(nowIso: string): void {
    const localDate = localDateFromIso(nowIso, this.timeZone);
    const row = this.db
      .prepare(
        "SELECT role_id, local_date FROM autonomy_budget WHERE role_id = ?",
      )
      .get(this.roleId) as { role_id: string; local_date: string } | undefined;
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO autonomy_budget
             (role_id, local_date, used_points, daily_limit, unlimited, updated_at)
           VALUES (?, ?, 0, ?, 0, ?)`,
        )
        .run(this.roleId, localDate, DEFAULT_AUTONOMY_DAILY_LIMIT, nowIso);
      return;
    }
    if (row.local_date !== localDate) {
      this.db
        .prepare(
          `UPDATE autonomy_budget
              SET local_date = ?, used_points = 0, updated_at = ?
            WHERE role_id = ?`,
        )
        .run(localDate, nowIso, this.roleId);
    }
  }

  private readBudget(): AutonomyBudgetRecord {
    const row = this.db
      .prepare("SELECT * FROM autonomy_budget WHERE role_id = ?")
      .get(this.roleId) as BudgetRow | undefined;
    if (!row) {
      throw new AppError(
        500,
        "AUTONOMY_BUDGET_MISSING",
        "自主活动额度记录缺失",
      );
    }
    return {
      roleId: row.role_id,
      localDate: row.local_date,
      usedPoints: row.used_points,
      dailyLimit: row.daily_limit,
      unlimited: row.unlimited === 1,
      updatedAt: row.updated_at,
    };
  }
}

function mapWake(row: WakeRow): AutonomyWakeRecord {
  return {
    wakeId: row.wake_id,
    roleId: row.role_id,
    kind: row.kind,
    scheduledAt: row.scheduled_at,
    intent: row.intent,
    status: row.status,
    sourceExecutionId: row.source_execution_id,
    taskId: row.task_id,
    activityId: row.activity_id,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActivity(row: ActivityRow): AutonomyActivityRecord {
  return {
    activityId: row.activity_id,
    roleId: row.role_id,
    wakeId: row.wake_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    windowId: row.window_id,
    status: row.status,
    summary: row.summary,
    sharedMessageId: row.shared_message_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapToolReservation(
  row: ToolReservationRow,
): AutonomyToolReservationRecord {
  return {
    toolCallId: row.tool_call_id,
    roleId: row.role_id,
    localDate: row.local_date,
    counted: row.counted === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function truncateText(value: string | null, limit: number): string | null {
  if (value === null) {
    return null;
  }
  const chars = Array.from(value);
  return chars.length <= limit
    ? value
    : `${chars.slice(0, limit).join("")}…`;
}
