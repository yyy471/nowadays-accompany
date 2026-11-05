import type Database from "better-sqlite3";
import { AppError, AutonomyBudgetExhaustedError } from "../domain/errors.js";
import {
  AutonomyStore,
  type AutonomyActivityRecord,
  type AutonomyBudgetRecord,
  type AutonomyWakeRecord,
  type BegunAutonomyWake,
} from "../storage/autonomy-store.js";
import { ConversationStore } from "../storage/conversation-store.js";
import { localDateFromIso } from "../storage/evidence.js";
import type { RoleAccess } from "./role-access.js";

export interface AutonomyServiceOptions {
  now?: () => Date;
  timeZone?: string;
}

export interface AutonomyStatus {
  budget: AutonomyBudgetRecord;
  nextWake: AutonomyWakeRecord | null;
  activities: AutonomyActivityRecord[];
  paused: boolean;
}

const AUTONOMY_WINDOW_SOURCE = "nowadays-autonomy";

export class AutonomyService {
  private readonly now: () => Date;
  private readonly timeZone: string | undefined;
  private wakeListener: ((roleId: string) => void) | null = null;

  constructor(
    private readonly access: RoleAccess,
    options: AutonomyServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone;
  }

  setWakeListener(listener: ((roleId: string) => void) | null): void {
    this.wakeListener = listener;
  }

  getStatus(roleId: string, activityLimit = 20): AutonomyStatus {
    return this.access.withStore(roleId, (storage) => {
      const store = this.store(storage.business.db, roleId);
      const activities = store.listActivities(activityLimit);
      return {
        budget: store.getBudget(this.now().toISOString()),
        nextWake: store.nextPendingWake(),
        activities,
        paused: store.hasPausedActivity(),
      };
    });
  }

  getBudget(roleId: string): AutonomyBudgetRecord {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).getBudget(
        this.now().toISOString(),
      ),
    );
  }

  setBudget(
    roleId: string,
    input: { dailyLimit?: number; unlimited: boolean },
  ): AutonomyBudgetRecord {
    return this.access.withStore(roleId, (storage) => {
      const now = this.now().toISOString();
      const store = this.store(storage.business.db, roleId);
      return store.setBudget({
        dailyLimit: input.dailyLimit ?? store.getBudget(now).dailyLimit,
        unlimited: input.unlimited,
        now,
      });
    });
  }

  scheduleWake(
    roleId: string,
    input: {
      wakeAt: string;
      intent: string;
      sourceExecutionId?: string | null;
      taskId?: string | null;
      kind?: "scheduled" | "budget_resume";
    },
  ): AutonomyWakeRecord {
    const wakeAt = Date.parse(input.wakeAt);
    if (Number.isNaN(wakeAt)) {
      throw new AppError(
        400,
        "AUTONOMY_WAKE_TIME_INVALID",
        "自主安排时间格式无效",
      );
    }
    if (input.kind !== "budget_resume" && wakeAt <= this.now().getTime()) {
      throw new AppError(
        400,
        "AUTONOMY_WAKE_TIME_PAST",
        "自主安排时间必须晚于当前时间",
      );
    }
    const wake = this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).createWake({
        kind: input.kind ?? "scheduled",
        scheduledAt: input.wakeAt,
        intent: input.intent,
        sourceExecutionId: input.sourceExecutionId ?? null,
        taskId: input.taskId ?? null,
        now: this.now().toISOString(),
      }),
    );
    this.wakeListener?.(roleId);
    return wake;
  }

  listWakes(roleId: string, limit = 100): AutonomyWakeRecord[] {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).listWakes(limit),
    );
  }

  cancelWake(roleId: string, wakeId: string): AutonomyWakeRecord {
    const wake = this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).cancelWake(
        wakeId,
        this.now().toISOString(),
      ),
    );
    this.wakeListener?.(roleId);
    return wake;
  }

  cancelPendingBudgetResumes(
    roleId: string,
    taskId: string,
    reason: string,
  ): number {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).cancelPendingBudgetResumes(
        taskId,
        reason,
        this.now().toISOString(),
      ),
    );
  }

  listActivities(roleId: string, limit = 100): AutonomyActivityRecord[] {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).listActivities(limit),
    );
  }

  nextPendingWake(roleId: string): AutonomyWakeRecord | null {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).nextPendingWake(),
    );
  }

  dueWake(roleId: string): AutonomyWakeRecord | null {
    return this.access.withStore(roleId, (storage) => {
      const due = this.store(storage.business.db, roleId).listDueWakes(
        this.now().toISOString(),
      );
      return due[0] ?? null;
    });
  }

  beginDueWake(roleId: string, windowId: string): BegunAutonomyWake | null {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).beginDueWake({
        windowId,
        now: this.now().toISOString(),
      }),
    );
  }

  completeWake(
    roleId: string,
    wakeId: string,
    errorCode: string | null = null,
  ): AutonomyWakeRecord {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).completeWake({
        wakeId,
        errorCode,
        now: this.now().toISOString(),
      }),
    );
  }

  updateActivity(
    roleId: string,
    input: {
      activityId: string;
      status: "running" | "completed" | "failed" | "paused";
      executionId?: string;
      summary?: string | null;
      sharedMessageId?: string | null;
    },
  ): AutonomyActivityRecord {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).updateActivity({
        ...input,
        now: this.now().toISOString(),
      }),
    );
  }

  getLatestActivityByTask(
    roleId: string,
    taskId: string,
  ): AutonomyActivityRecord | null {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).getLatestActivityByTask(taskId),
    );
  }

  ensureAutonomyWindow(roleId: string): string {
    return this.access.withStore(roleId, (storage) =>
      storage.business.getOrCreateWindow({
        roleId,
        kind: "custom",
        source: AUTONOMY_WINDOW_SOURCE,
      }).windowId,
    );
  }

  shareMessage(
    roleId: string,
    input: { content: string; executionId: string },
  ): { messageId: string; windowId: string } {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new AppError(
        400,
        "AUTONOMY_SHARE_EMPTY",
        "主动分享内容不能为空",
      );
    }
    return this.access.withStore(roleId, (storage) => {
      const window = storage.business.getDefaultWindow(roleId);
      const store = new ConversationStore(
        storage.business.db,
        roleId,
        this.timeZone,
      );
      const message = store.appendProactiveMessage({
        windowId: window.windowId,
        content,
        executionId: input.executionId,
        now: this.now().toISOString(),
      });
      const activity = this.store(
        storage.business.db,
        roleId,
      ).getActivityByExecution(input.executionId);
      if (activity !== null) {
        this.store(storage.business.db, roleId).updateActivity({
          activityId: activity.activityId,
          status: activity.status,
          sharedMessageId: message.messageId,
          now: this.now().toISOString(),
        });
      }
      return { messageId: message.messageId, windowId: window.windowId };
    });
  }

  consumePoint(roleId: string): {
    counted: boolean;
    exhausted: boolean;
    budget: AutonomyBudgetRecord;
  } {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).consumePoint({
        now: this.now().toISOString(),
      }),
    );
  }

  reserveToolPoint(
    roleId: string,
    toolCallId: string,
  ): { counted: boolean; localDate: string } {
    return this.access.withStore(roleId, (storage) => {
      const result = this.store(
        storage.business.db,
        roleId,
      ).reserveToolPoint({
        toolCallId,
        now: this.now().toISOString(),
      });
      if (result.exhausted) {
        throw new AutonomyBudgetExhaustedError(
          roleId,
          result.budget.dailyLimit,
          result.budget.usedPoints,
        );
      }
      return {
        counted: result.counted,
        localDate: result.localDate,
      };
    });
  }

  commitToolReservation(
    roleId: string,
    toolCallId: string,
  ): { counted: boolean; found: boolean } {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).commitToolReservation({
        toolCallId,
        now: this.now().toISOString(),
      }),
    );
  }

  releaseToolReservation(roleId: string, toolCallId: string): void {
    this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).releaseToolReservation({
        toolCallId,
        now: this.now().toISOString(),
      }),
    );
  }

  getActivityByExecution(
    roleId: string,
    executionId: string,
  ): AutonomyActivityRecord | null {
    return this.access.withStore(roleId, (storage) =>
      this.store(
        storage.business.db,
        roleId,
      ).getActivityByExecution(executionId),
    );
  }

  pauseForBudget(
    roleId: string,
    input: {
      taskId: string;
      activityId: string | null;
      wakeId: string | null;
    },
  ): AutonomyWakeRecord {
    const now = this.now().toISOString();
    return this.access.withStore(roleId, (storage) => {
      const store = this.store(storage.business.db, roleId);
      const task = storage.business.getTask(roleId, input.taskId);
      if (task.status === "active") {
        storage.business.pauseTask({
          roleId,
          taskId: input.taskId,
          endReason: "AUTONOMY_BUDGET_EXHAUSTED",
        });
      }
      if (input.activityId !== null) {
        const activity = store.getActivity(input.activityId);
        if (activity.status === "running") {
          store.updateActivity({
            activityId: input.activityId,
            status: "paused",
            now,
          });
        }
      }
      if (input.wakeId !== null) {
        const wake = store.getWake(input.wakeId);
        if (wake.status === "claimed") {
          store.completeWake({
            wakeId: input.wakeId,
            errorCode: "AUTONOMY_BUDGET_EXHAUSTED",
            now,
          });
        }
      }
      const existing = store.findPendingBudgetResume(input.taskId);
      if (existing !== null) {
        return existing;
      }
      return store.createWake({
        kind: "budget_resume",
        scheduledAt: nextLocalMidnightIso(this.now(), this.timeZone),
        intent: `额度已恢复，重新评估暂停的活动：${task.goal}`,
        taskId: input.taskId,
        now,
      });
    });
  }

  private store(db: Database.Database, roleId: string): AutonomyStore {
    return new AutonomyStore(db, roleId, this.timeZone);
  }
}

export function nextLocalMidnightIso(now: Date, timeZone?: string): string {
  const iso = now.toISOString();
  if (timeZone === undefined) {
    const local = new Date(now);
    return new Date(
      local.getFullYear(),
      local.getMonth(),
      local.getDate() + 1,
      0,
      0,
      0,
      0,
    ).toISOString();
  }
  const date = localDateFromIso(iso, timeZone);
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`INVALID_LOCAL_DATE:${date}`);
  }
  const targetLocalMs = Date.UTC(year, month - 1, day + 1, 0, 0, 0);
  let instant = targetLocalMs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = localTimeAsUtcMs(instant, timeZone) - instant;
    instant = targetLocalMs - offset;
  }
  return new Date(instant).toISOString();
}

function localTimeAsUtcMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const text = parts.find((part) => part.type === type)?.value ?? "0";
    return Number(text);
  };
  return Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
}
