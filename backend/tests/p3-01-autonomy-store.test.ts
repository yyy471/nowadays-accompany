import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import { AutonomyStore } from "../src/storage/autonomy-store.js";
import { RoleStorage } from "../src/storage/role-storage.js";

function createRoleStorage(): {
  root: string;
  roleId: string;
  mainWindowId: string;
  autonomyWindowId: string;
  storage: RoleStorage;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p3-01-"));
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const roleId = randomUUID();
  const storage = new RoleStorage(rolePaths(config.dataRoot, roleId));
  const created = storage.business.createRoleRecord({
    roleId,
    displayName: "自主角色",
    definitionText: "喜欢阅读和记录。",
    definitionPayload: {},
    initialState: {},
  });
  const autonomyWindow = storage.business.getOrCreateWindow({
    roleId,
    kind: "custom",
    source: "nowadays-autonomy",
  });
  return {
    root,
    roleId,
    mainWindowId: created.window.windowId,
    autonomyWindowId: autonomyWindow.windowId,
    storage,
  };
}

test("autonomy budget resets by local date, supports unlimited and counts points", () => {
  const fixture = createRoleStorage();
  try {
    const store = new AutonomyStore(
      fixture.storage.business.db,
      fixture.roleId,
      "Asia/Shanghai",
    );
    const first = store.getBudget("2026-11-04T02:00:00.000Z");
    assert.equal(first.localDate, "2026-11-04");
    assert.equal(first.usedPoints, 0);
    assert.equal(first.dailyLimit, 200);
    assert.equal(first.unlimited, false);

    const limited = store.setBudget({
      dailyLimit: 2,
      unlimited: false,
      now: "2026-11-04T02:00:00.000Z",
    });
    assert.equal(limited.dailyLimit, 2);
    assert.deepEqual(
      store.consumePoint({ now: "2026-11-04T02:01:00.000Z" }),
      {
        budget: store.getBudget("2026-11-04T02:01:00.000Z"),
        counted: true,
        exhausted: false,
      },
    );
    const second = store.consumePoint({
      now: "2026-11-04T02:02:00.000Z",
    });
    assert.equal(second.counted, true);
    assert.equal(second.exhausted, false);
    const exhausted = store.consumePoint({
      now: "2026-11-04T02:03:00.000Z",
    });
    assert.equal(exhausted.counted, false);
    assert.equal(exhausted.exhausted, true);
    assert.equal(exhausted.budget.usedPoints, 2);

    const nextDay = store.getBudget("2026-11-04T16:00:00.000Z");
    assert.equal(nextDay.localDate, "2026-11-05");
    assert.equal(nextDay.usedPoints, 0);
    assert.equal(
      store.consumePoint({ now: "2026-11-04T16:01:00.000Z" }).counted,
      true,
    );

    store.setBudget({
      dailyLimit: 1,
      unlimited: true,
      now: "2026-11-04T16:02:00.000Z",
    });
    const unlimited = store.consumePoint({
      now: "2026-11-04T16:03:00.000Z",
    });
    assert.equal(unlimited.counted, false);
    assert.equal(unlimited.exhausted, false);
    assert.equal(unlimited.budget.unlimited, true);
  } finally {
    fixture.storage.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("autonomy wakes persist, claim into tasks and activities, and resume paused tasks", () => {
  const fixture = createRoleStorage();
  try {
    const store = new AutonomyStore(
      fixture.storage.business.db,
      fixture.roleId,
      "Asia/Shanghai",
    );
    const wake = store.createWake({
      kind: "scheduled",
      scheduledAt: "2026-11-04T03:00:00.000Z",
      intent: "稍后阅读本地资料并写笔记",
      now: "2026-11-04T02:00:00.000Z",
    });
    assert.equal(store.nextPendingWake()?.wakeId, wake.wakeId);
    assert.equal(
      store.listDueWakes("2026-11-04T02:30:00.000Z").length,
      0,
    );
    assert.equal(
      store.listDueWakes("2026-11-04T03:00:00.000Z").length,
      1,
    );

    const begun = store.beginDueWake({
      windowId: fixture.autonomyWindowId,
      now: "2026-11-04T03:00:00.000Z",
    });
    assert.ok(begun);
    assert.equal(begun.wake.status, "claimed");
    assert.equal(begun.activity.status, "running");
    assert.equal(begun.activity.wakeId, wake.wakeId);
    const task = fixture.storage.business.getTask(
      fixture.roleId,
      begun.taskId,
    );
    assert.equal(task.origin, "autonomous");
    assert.equal(task.goal, "稍后阅读本地资料并写笔记");
    const relation = fixture.storage.business.db
      .prepare(
        "SELECT relation FROM execution_tasks WHERE execution_id = ? AND task_id = ?",
      )
      .get(begun.execution.executionId, begun.taskId) as {
      relation: string;
    };
    assert.equal(relation.relation, "initiates");

    store.updateActivity({
      activityId: begun.activity.activityId,
      status: "completed",
      summary: "读完并写下笔记。",
      now: "2026-11-04T03:05:00.000Z",
    });
    store.completeWake({
      wakeId: wake.wakeId,
      now: "2026-11-04T03:05:00.000Z",
    });
    assert.equal(store.listActivities()[0]?.summary, "读完并写下笔记。");
    assert.equal(store.listWakes()[0]?.status, "completed");

    const roleRow = fixture.storage.business.db
      .prepare("SELECT state_version FROM roles WHERE role_id = ?")
      .get(fixture.roleId) as { state_version: number };
    fixture.storage.business.commitExecution({
      roleId: fixture.roleId,
      executionId: begun.execution.executionId,
      stateVersionCommitted: roleRow.state_version,
    });

    fixture.storage.business.pauseTask({
      roleId: fixture.roleId,
      taskId: begun.taskId,
      endReason: "AUTONOMY_BUDGET_EXHAUSTED",
    });
    const resumeWake = store.createWake({
      kind: "budget_resume",
      scheduledAt: "2026-11-04T16:00:00.000Z",
      intent: "额度恢复后重新评估暂停的阅读活动",
      taskId: begun.taskId,
      now: "2026-11-04T03:06:00.000Z",
    });
    const resumed = store.beginDueWake({
      windowId: fixture.autonomyWindowId,
      now: "2026-11-04T16:00:00.000Z",
    });
    assert.ok(resumed);
    assert.equal(resumed.wake.wakeId, resumeWake.wakeId);
    assert.equal(resumed.taskId, begun.taskId);
    const resumedTask = fixture.storage.business.getTask(
      fixture.roleId,
      begun.taskId,
    );
    assert.equal(resumedTask.status, "active");
    const resumedRelation = fixture.storage.business.db
      .prepare(
        "SELECT relation FROM execution_tasks WHERE execution_id = ? AND task_id = ?",
      )
      .get(resumed.execution.executionId, begun.taskId) as {
      relation: string;
    };
    assert.equal(resumedRelation.relation, "continues");
  } finally {
    fixture.storage.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cancelling a claimed or finished wake is rejected", () => {
  const fixture = createRoleStorage();
  try {
    const store = new AutonomyStore(fixture.storage.business.db, fixture.roleId);
    const wake = store.createWake({
      kind: "scheduled",
      scheduledAt: "2026-11-04T03:00:00.000Z",
      intent: "稍后整理书桌",
      now: "2026-11-04T02:00:00.000Z",
    });
    const begun = store.beginDueWake({
      windowId: fixture.autonomyWindowId,
      now: "2026-11-04T03:00:00.000Z",
    });
    assert.ok(begun);
    assert.throws(
      () => store.cancelWake(wake.wakeId, "2026-11-04T03:01:00.000Z"),
      (error: unknown) =>
        (error as { code?: string }).code === "AUTONOMY_WAKE_NOT_PENDING",
    );
  } finally {
    fixture.storage.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("wake times with offsets are normalized before ordering and due checks", () => {
  const fixture = createRoleStorage();
  try {
    const store = new AutonomyStore(
      fixture.storage.business.db,
      fixture.roleId,
      "Asia/Shanghai",
    );
    const first = store.createWake({
      kind: "scheduled",
      scheduledAt: "2026-11-04T11:00:01+08:00",
      intent: "带正时区偏移的安排",
      now: "2026-11-04T02:00:01.000Z",
    });
    assert.equal(first.scheduledAt, "2026-11-04T03:00:01.000Z");
    const sameInstant = store.createWake({
      kind: "scheduled",
      scheduledAt: "2026-11-03T22:00:01-05:00",
      intent: "同一瞬间的负时区写法",
      now: "2026-11-04T02:00:02.000Z",
    });
    assert.equal(sameInstant.scheduledAt, "2026-11-04T03:00:01.000Z");
    const crossDay = store.createWake({
      kind: "scheduled",
      scheduledAt: "2026-11-04T23:30:00-05:00",
      intent: "跨日安排",
      now: "2026-11-04T02:00:03.000Z",
    });
    assert.equal(crossDay.scheduledAt, "2026-11-05T04:30:00.000Z");

    assert.equal(store.listDueWakes("2026-11-04T03:00:00.999Z").length, 0);
    assert.deepEqual(
      store
        .listDueWakes("2026-11-04T03:00:01.000Z")
        .map((wake) => wake.wakeId),
      [first.wakeId, sameInstant.wakeId],
    );
    assert.equal(store.nextPendingWake()?.wakeId, first.wakeId);
    assert.equal(store.listDueWakes("2026-11-05T04:29:59.999Z").length, 2);
    assert.equal(store.listDueWakes("2026-11-05T04:30:00.000Z").length, 3);
  } finally {
    fixture.storage.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a due budget resume is cancelled instead of creating a task after the origin task ended", () => {
  const fixture = createRoleStorage();
  try {
    const store = new AutonomyStore(
      fixture.storage.business.db,
      fixture.roleId,
      "Asia/Shanghai",
    );
    store.createWake({
      kind: "scheduled",
      scheduledAt: "2026-11-04T03:00:00.000Z",
      intent: "原自主任务",
      now: "2026-11-04T02:00:00.000Z",
    });
    const begun = store.beginDueWake({
      windowId: fixture.autonomyWindowId,
      now: "2026-11-04T03:00:00.000Z",
    });
    assert.ok(begun);
    const roleRow = fixture.storage.business.db
      .prepare("SELECT state_version FROM roles WHERE role_id = ?")
      .get(fixture.roleId) as { state_version: number };
    fixture.storage.business.commitExecution({
      roleId: fixture.roleId,
      executionId: begun.execution.executionId,
      stateVersionCommitted: roleRow.state_version,
    });
    fixture.storage.business.pauseTask({
      roleId: fixture.roleId,
      taskId: begun.taskId,
      endReason: "AUTONOMY_BUDGET_EXHAUSTED",
    });
    const resume = store.createWake({
      kind: "budget_resume",
      scheduledAt: "2026-11-04T16:00:00.000Z",
      intent: "额度恢复后重新评估",
      taskId: begun.taskId,
      now: "2026-11-04T03:05:00.000Z",
    });
    fixture.storage.business.finishTask({
      roleId: fixture.roleId,
      taskId: begun.taskId,
      status: "completed",
      endReason: "用户明确结束原任务",
    });

    const next = store.beginDueWake({
      windowId: fixture.autonomyWindowId,
      now: "2026-11-04T16:00:00.000Z",
    });
    assert.equal(next, null);
    const cancelled = store.getWake(resume.wakeId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.lastErrorCode, "AUTONOMY_RESUME_TASK_ENDED");
    assert.equal(fixture.storage.business.listTasks(fixture.roleId).length, 1);
    assert.equal(cancelled.activityId, null);
  } finally {
    fixture.storage.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
