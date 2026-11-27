import { CoplayBatches } from "../extensions/coplay-batches.js";
import type Database from "better-sqlite3";
import { AppError, AutonomyBudgetExhaustedError } from "../../domain/errors.js";
import {
  AutonomyStore,
  type AutonomyActivityRecord,
  type AutonomyBudgetRecord,
  type AutonomyWakeRecord,
  type BegunAutonomyWake,
} from "../../storage/conversation/autonomy-store.js";
import { ConversationStore } from "../../storage/conversation/conversation-store.js";
import { localDateFromIso } from "../../storage/memory/evidence.js";
import type { RoleAccess } from "../role/role-access.js";

export interface AutonomyServiceOptions {
  now?: () => Date;
  timeZone?: string;
  coplayWindowMs?: number | undefined;
  coplayActive?: (roleId: string) => boolean;
  onCoplayDue?: (roleId: string) => void;
  /** 自主安排或活动状态变化后广播，前端据此重取对应角色的状态流。 */
  onFeedChange?: (topic: "wake" | "activity", roleId: string) => void;
}

export interface AutonomyStatus {
  budget: AutonomyBudgetRecord;
  nextWake: AutonomyWakeRecord | null;
  activities: AutonomyActivityRecord[];
  paused: boolean;
}

export interface ProactiveMessageNotice {
  coplayShare?: { summary: string; streamEventId: number };
  roleId: string;
  windowId: string;
  messageId: string;
  executionId: string;
}

const AUTONOMY_WINDOW_SOURCE = "nowadays-autonomy";

export class AutonomyService {
  readonly coplay: CoplayBatches;
  private readonly now: () => Date;
  private readonly timeZone: string | undefined;
  private readonly onFeedChange:
    | ((topic: "wake" | "activity", roleId: string) => void)
    | undefined;
  private wakeListener: ((roleId: string) => void) | null = null;
  private proactiveMessageListener:
    | ((notice: ProactiveMessageNotice) => void)
    | null = null;

  constructor(
    private readonly access: RoleAccess,
    options: AutonomyServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone;
    this.onFeedChange = options.onFeedChange;
    this.coplay = new CoplayBatches(roleId => {
      if (!options.coplayActive?.(roleId)) return false;
      const budget = this.getBudget(roleId);
      return budget.unlimited || budget.usedPoints < budget.dailyLimit;
    }, roleId => options.onCoplayDue?.(roleId), options.coplayWindowMs);
  }

  setWakeListener(listener: ((roleId: string) => void) | null): void {
    this.wakeListener = listener;
  }

  setProactiveMessageListener(
    listener: ((notice: ProactiveMessageNotice) => void) | null,
  ): void {
    this.proactiveMessageListener = listener;
  }

  private notifyFeed(topic: "wake" | "activity", roleId: string): void {
    try {
      this.onFeedChange?.(topic, roleId);
    } catch {
      // 广播失败不得影响自主安排的持久化结果。
    }
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
    const budget = this.access.withStore(roleId, (storage) => {
      const now = this.now().toISOString();
      const store = this.store(storage.business.db, roleId);
      return store.setBudget({
        dailyLimit: input.dailyLimit ?? store.getBudget(now).dailyLimit,
        unlimited: input.unlimited,
        now,
      });
    });
    this.coplay.budgetChanged(roleId);
    return budget;
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
    this.notifyFeed("wake", roleId);
    return wake;
  }

  listWakes(roleId: string, limit = 100, offset = 0): AutonomyWakeRecord[] {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).listWakes(limit, offset),
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
    this.notifyFeed("wake", roleId);
    return wake;
  }

  cancelPendingBudgetResumes(
    roleId: string,
    taskId: string,
    reason: string,
  ): number {
    const cancelled = this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).cancelPendingBudgetResumes(
        taskId,
        reason,
        this.now().toISOString(),
      ),
    );
    if (cancelled > 0) this.notifyFeed("wake", roleId);
    return cancelled;
  }

  listActivities(roleId: string, limit = 100, offset = 0): AutonomyActivityRecord[] {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).listActivities(limit, offset),
    );
  }

  listActivitiesWithShares(roleId: string, limit = 100, offset = 0) {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).listActivitiesWithShares(limit, offset),
    );
  }

  hasPendingFirstActivation(roleId: string): boolean {
    return this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).hasPendingFirstActivation(),
    );
  }

  enqueueFirstActivation(roleId: string): void {
    this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).enqueueFirstActivation(this.now().toISOString()),
    );
    this.notifyFeed("activity", roleId);
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

  beginDueWake(roleId: string, windowId: string, coplay?: { wakeId: string; intent: string }): BegunAutonomyWake | null {
    const begun = this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).beginDueWake({
        windowId, coplay,
        now: this.now().toISOString(),
      }),
    );
    if (begun !== null) this.notifyFeed("wake", roleId);
    return begun;
  }

  completeWake(
    roleId: string,
    wakeId: string,
    errorCode: string | null = null,
  ): AutonomyWakeRecord {
    const wake = this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).completeWake({
        wakeId,
        errorCode,
        now: this.now().toISOString(),
      }),
    );
    this.notifyFeed("wake", roleId);
    return wake;
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
    const activity = this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).updateActivity({
        ...input,
        now: this.now().toISOString(),
      }),
    );
    this.notifyFeed("activity", roleId);
    return activity;
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

  coplayShareHistory(roleId: string, windowId: string, after: number | null) {
    return this.access.withStore(roleId, storage => {
      const store = new ConversationStore(storage.business.db, roleId);
      return { cursor: after ?? store.latestEventId(windowId), shares: after === null ? [] : store.coplaySharesAfter(windowId, after) };
    });
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
      const now = this.now().toISOString();
      const { message, coplayShare } = storage.business.db.transaction(() => {
        const autonomy = this.store(storage.business.db, roleId);
        const activity = autonomy.getActivityByExecution(input.executionId);
        const coplay = activity?.wakeId?.startsWith("coplay/") === true;
        const message = store.appendProactiveMessage({
          source: "autonomy_share", coplay, windowId: window.windowId, content, executionId: input.executionId, now,
        });
        if (activity) autonomy.updateActivity({
          activityId: activity.activityId, status: activity.status, sharedMessageId: message.messageId, now,
        });
        return { message, coplayShare: coplay ? {
          summary: Array.from(content).slice(0, 140).join(""), streamEventId: store.latestEventId(window.windowId),
        } : null };
      })();
      this.proactiveMessageListener?.({
        ...(coplayShare && { coplayShare }),
        roleId,
        windowId: window.windowId,
        messageId: message.messageId,
        executionId: input.executionId,
      });
      this.notifyFeed("activity", roleId);
      return { messageId: message.messageId, windowId: window.windowId };
    });
  }

  consumePoint(roleId: string): {
    counted: boolean;
    exhausted: boolean;
    budget: AutonomyBudgetRecord;
  } {
    const result = this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).consumePoint({
        now: this.now().toISOString(),
      }),
    );
    this.coplay.budgetChanged(roleId);
    return result;
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
      this.coplay.budgetChanged(roleId);
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
    const result = this.access.withStore(roleId, (storage) =>
      this.store(storage.business.db, roleId).commitToolReservation({
        toolCallId,
        now: this.now().toISOString(),
      }),
    );
    this.coplay.budgetChanged(roleId);
    return result;
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
    const wake = this.access.withStore(roleId, (storage) => {
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
    this.notifyFeed("activity", roleId);
    this.notifyFeed("wake", roleId);
    return wake;
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
