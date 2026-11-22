import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createBackendApp, type BackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelPort } from "../src/domain/model.js";
import { ConversationStore } from "../src/storage/conversation-store.js";
import { AutonomyStore } from "../src/storage/autonomy-store.js";
import {
  ScriptedChatModel,
  createFixtureWithModel,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

const startAt = "2026-11-04T02:00:00.000Z";
const wakeAt = "2026-11-04T03:00:00.000Z";
const restartAt = "2026-11-04T04:00:00.000Z";

function done(text = "已依据当前资料重新评估，不补做离线经历。"): ModelEvent[] {
  return [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
}

interface SeededInterruption {
  taskId: string;
  executionId: string;
  windowId: string;
  wakeId: string;
  activityId: string;
  savedCallId: string | null;
  inFlightCallId: string | null;
  undispatchedCallId: string | null;
  effectPath: string | null;
}

function seedInterruptedAutonomy(
  fixture: Fixture,
  options: { saved?: boolean; inFlight?: boolean; undispatched?: boolean } = {},
): SeededInterruption {
  return withStorage(fixture, (storage) => {
    const roleId = fixture.roleId;
    const autonomy = new AutonomyStore(
      storage.business.db,
      roleId,
      "Asia/Shanghai",
    );
    const wake = autonomy.createWake({
      kind: "scheduled",
      scheduledAt: wakeAt,
      intent: "整理重启前的成果并继续未完成事项",
      now: startAt,
    });
    const window = storage.business.getOrCreateWindow({
      roleId,
      kind: "custom",
      source: "nowadays-autonomy",
    });
    const begun = autonomy.beginDueWake({
      windowId: window.windowId,
      now: wakeAt,
    });
    assert.ok(begun);
    const addCall = (
      stepKey: string,
      toolName: string,
      status: "success" | "running" | "pending",
    ): string => {
      const begunCall = storage.business.beginToolCall({
        roleId,
        taskId: begun.taskId,
        executionId: begun.execution.executionId,
        stepKey,
        toolName,
        args: { path: "effect.md" },
      });
      const toolCallId = begunCall.toolCall.toolCallId;
      if (status === "success") {
        storage.business.markToolCallRunning(roleId, toolCallId);
        storage.business.saveToolResult({
          roleId,
          toolCallId,
          status: "success",
          adaptedResult: { saved: true, path: "effect.md" },
          now: wakeAt,
        });
      } else if (status === "running") {
        storage.business.markToolCallRunning(roleId, toolCallId);
      }
      return toolCallId;
    };
    const savedCallId =
      options.saved === false ? null : addCall("recovery:1", "workspace_write", "success");
    const effectPath =
      savedCallId === null
        ? null
        : path.join(storage.paths.workspaceDir, "effect.md");
    if (effectPath !== null) {
      fs.writeFileSync(effectPath, "唯一的实际效果\n");
    }
    const inFlightCallId =
      options.inFlight === true
        ? addCall("recovery:2", "workspace_write", "running")
        : null;
    const undispatchedCallId =
      options.undispatched === true
        ? addCall("recovery:3", "workspace_write", "pending")
        : null;
    const binding = storage.business
      .listRoleBindings(roleId)
      .find((item) => item.capability === "chat_model");
    assert.ok(binding);
    new ConversationStore(
      storage.business.db,
      roleId,
      "Asia/Shanghai",
    ).startModelCall({
      executionId: begun.execution.executionId,
      resourceId: binding.resourceId,
      modelName: binding.modelName ?? "offline-chat",
      protocol: "openai-chat",
      purpose: "autonomous",
      now: "2026-11-04T03:01:00.000Z",
    });
    return {
      taskId: begun.taskId,
      executionId: begun.execution.executionId,
      windowId: window.windowId,
      wakeId: wake.wakeId,
      activityId: begun.activity.activityId,
      savedCallId,
      inFlightCallId,
      undispatchedCallId,
      effectPath,
    };
  });
}

interface SeededSuperseded {
  taskId: string;
  windowId: string;
  executionId: string;
  callId: string | null;
  effectPath: string | null;
}

function seedSupersededTask(
  fixture: Fixture,
  origin: "autonomous" | "user",
  options: { tool?: boolean } = {},
): SeededSuperseded {
  return withStorage(fixture, (storage) => {
    const roleId = fixture.roleId;
    const now = "2026-11-04T03:01:00.000Z";
    const addRunningCall = (taskId: string, executionId: string): string => {
      const call = storage.business.beginToolCall({
        roleId,
        taskId,
        executionId,
        stepKey: "superseded:1",
        toolName: "effect_then_wait",
        args: {},
      });
      storage.business.markToolCallRunning(roleId, call.toolCall.toolCallId);
      return call.toolCall.toolCallId;
    };
    let taskId: string;
    let windowId: string;
    let executionId: string;
    if (origin === "autonomous") {
      const autonomy = new AutonomyStore(
        storage.business.db,
        roleId,
        "Asia/Shanghai",
      );
      autonomy.createWake({
        kind: "scheduled",
        scheduledAt: wakeAt,
        intent: "产生一次效果后由新消息替代回复，原任务继续",
        now: startAt,
      });
      const window = storage.business.getOrCreateWindow({
        roleId,
        kind: "custom",
        source: "nowadays-autonomy",
      });
      const begun = autonomy.beginDueWake({
        windowId: window.windowId,
        now: wakeAt,
      });
      assert.ok(begun);
      taskId = begun.taskId;
      windowId = window.windowId;
      executionId = begun.execution.executionId;
    } else {
      const roleRow = storage.business.db
        .prepare("SELECT state_version FROM roles WHERE role_id = ?")
        .get(roleId) as { state_version: number };
      executionId = randomUUID();
      storage.business.db
        .prepare(
          `INSERT INTO executions
             (execution_id, role_id, window_id, trigger_type, trigger_message_id,
              status, state_version_loaded, state_version_committed, created_at, updated_at)
           VALUES (?, ?, ?, 'user_message', NULL, 'running', ?, NULL, ?, ?)`,
        )
        .run(
          executionId,
          roleId,
          fixture.windowId,
          roleRow.state_version,
          now,
          now,
        );
      const task = storage.business.createTask({
        roleId,
        goal: "被新消息替代回复，但原任务仍需继续",
        origin: "user",
        initiatorExecutionId: executionId,
      });
      storage.business.linkExecutionTask({
        roleId,
        executionId,
        taskId: task.taskId,
        relation: "initiates",
      });
      taskId = task.taskId;
      windowId = fixture.windowId;
    }
    const callId =
      options.tool === false ? null : addRunningCall(taskId, executionId);
    const effectPath =
      callId === null
        ? null
        : path.join(storage.paths.workspaceDir, "effect.md");
    if (effectPath !== null) {
      fs.writeFileSync(effectPath, "effect\n");
    }
    new ConversationStore(
      storage.business.db,
      roleId,
      "Asia/Shanghai",
    ).interruptExecution({
      executionId,
      partialText: "",
      status: "superseded",
      reason: "NEW_MESSAGE",
      now,
    });
    return { taskId, windowId, executionId, callId, effectPath };
  });
}

function reopen(fixture: Fixture, model: ModelPort): BackendApp {
  return createBackendApp(
    parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
    {
      now: () => new Date(restartAt),
      timeZone: "Asia/Shanghai",
      modelPortFactory: () => model,
      disableMemoryRuntime: true,
    },
  );
}

function rows<T>(fixture: Fixture, sql: string, ...params: unknown[]): T[] {
  return withStorage(fixture, (storage) =>
    storage.business.db.prepare(sql).all(...params),
  ) as T[];
}

test("restart resumes the same interrupted autonomous task with saved tool results", { timeout: 20_000 }, async () => {
  const model = new ScriptedChatModel([done()]);
  const fixture = createFixtureWithModel(model, {
    now: () => new Date(startAt),
  });
  let reopened: BackendApp | null = null;
  try {
    const seeded = seedInterruptedAutonomy(fixture, { saved: true });
    fixture.app.services.roles.updateDefinition(fixture.roleId, {
      definition: { text: "重启后的最新蓝色角色设定" },
    });
    fixture.app.services.roles.setState(fixture.roleId, {
      state: { mood: "重启后的最新状态" },
    });
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 7,
      unlimited: false,
    });
    const modelCallsAtKill = rows<{ count: number }>(
      fixture,
      "SELECT COUNT(*) AS count FROM tool_calls",
    )[0]!.count;
    await fixture.app.close();

    reopened = reopen(fixture, model);
    await reopened.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, 1);
    assert.match(model.requests[0]!.system, /重启后的最新蓝色角色设定/);
    assert.match(model.requests[0]!.system, /重启后的最新状态/);
    const toolMessage = model.requests[0]!.messages.find(
      (message) =>
        message.role === "tool" && message.toolCallId === seeded.savedCallId,
    );
    assert.ok(toolMessage);
    assert.match(toolMessage.content, /"status":"success"/);
    assert.match(toolMessage.content, /effect\.md/);

    const tasks = reopened.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.taskId, seeded.taskId);
    assert.equal(tasks[0]?.status, "completed");

    const executions = rows<{
      execution_id: string;
      task_id: string | null;
      status: string;
      trigger_type: string;
      relation: string | null;
    }>(
      fixture,
      `SELECT e.execution_id, et.task_id, e.status, e.trigger_type, et.relation
         FROM executions e LEFT JOIN execution_tasks et ON et.execution_id = e.execution_id
        ORDER BY e.created_at ASC, e.rowid ASC`,
    );
    assert.deepEqual(
      executions.map((item) => [
        item.execution_id === seeded.executionId ? "original" : "continuation",
        item.task_id,
        item.status,
        item.trigger_type,
        item.relation,
      ]),
      [
        ["original", seeded.taskId, "failed", "autonomous", "initiates"],
        ["continuation", seeded.taskId, "completed", "tool_result", "continues"],
      ],
    );
    assert.equal(
      rows<{ count: number }>(
        fixture,
        "SELECT COUNT(*) AS count FROM tool_calls",
      )[0]!.count,
      modelCallsAtKill,
    );
    assert.ok(seeded.effectPath);
    const effect = fs.readFileSync(seeded.effectPath, "utf8");
    assert.equal(effect, "唯一的实际效果\n");
    assert.equal(effect.split("唯一的实际效果").length - 1, 1);
    const savedResult = rows<{ status: string; adapted_result_json: string }>(
      fixture,
      "SELECT status, adapted_result_json FROM tool_results WHERE tool_call_id = ?",
      seeded.savedCallId,
    )[0];
    assert.equal(savedResult?.status, "success");
    assert.match(savedResult?.adapted_result_json ?? "", /effect\.md/);

    const activities = reopened.services.autonomy.listActivities(fixture.roleId);
    assert.equal(activities[0]?.status, "completed");
    const wake = reopened.services.autonomy
      .listWakes(fixture.roleId)
      .find((item) => item.wakeId === seeded.wakeId);
    assert.equal(wake?.status, "completed");
    const status = reopened.services.autonomy.getStatus(fixture.roleId);
    assert.equal(status.budget.dailyLimit, 7);
    assert.equal(status.budget.usedPoints, 1);
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test("restart records in-flight and undispatched tool calls distinctly, then resumes", { timeout: 20_000 }, async () => {
  const model = new ScriptedChatModel([done()]);
  const fixture = createFixtureWithModel(model);
  let first: BackendApp | null = null;
  let second: BackendApp | null = null;
  try {
    const seeded = seedInterruptedAutonomy(fixture, {
      saved: false,
      inFlight: true,
      undispatched: true,
    });
    await fixture.app.close();

    first = reopen(fixture, model);
    await first.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, 1);
    const inFlightMessage = model.requests[0]!.messages.find(
      (message) =>
        message.role === "tool" && message.toolCallId === seeded.inFlightCallId,
    );
    assert.ok(inFlightMessage);
    assert.match(inFlightMessage.content, /"status":"unknown"/);
    assert.match(inFlightMessage.content, /PROCESS_INTERRUPTED/);
    const undispatchedMessage = model.requests[0]!.messages.find(
      (message) =>
        message.role === "tool" &&
        message.toolCallId === seeded.undispatchedCallId,
    );
    assert.ok(undispatchedMessage);
    assert.match(undispatchedMessage.content, /"status":"failed"/);
    assert.match(undispatchedMessage.content, /尚未派发/);

    const calls = rows<{ tool_call_id: string; status: string }>(
      fixture,
      "SELECT tool_call_id, status FROM tool_calls ORDER BY created_at ASC, rowid ASC",
    );
    assert.deepEqual(
      calls.map((item) => [item.tool_call_id, item.status]),
      [
        [seeded.inFlightCallId, "unknown"],
        [seeded.undispatchedCallId, "failed"],
      ],
    );
    const results = rows<{
      tool_call_id: string;
      status: string;
      diagnostic_code: string | null;
    }>(
      fixture,
      "SELECT tool_call_id, status, diagnostic_code FROM tool_results ORDER BY saved_at ASC",
    );
    assert.deepEqual(
      results.map((item) => [
        item.tool_call_id,
        item.status,
        item.diagnostic_code,
      ]),
      [
        [seeded.inFlightCallId, "unknown", "PROCESS_INTERRUPTED"],
        [seeded.undispatchedCallId, "failed", "PROCESS_INTERRUPTED"],
      ],
    );
    assert.equal(first.conversation.listTasks(fixture.roleId)[0]?.status, "completed");

    await first.close();
    first = null;
    const quietModel = new ScriptedChatModel([]);
    second = reopen(fixture, quietModel);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(quietModel.requests.length, 0);
    assert.equal(
      rows<{ count: number }>(
        fixture,
        "SELECT COUNT(*) AS count FROM tool_results WHERE tool_call_id = ?",
        seeded.inFlightCallId,
      )[0]!.count,
      1,
    );
    assert.equal(
      rows<{ status: string }>(
        fixture,
        "SELECT status FROM tool_calls WHERE tool_call_id = ?",
        seeded.inFlightCallId,
      )[0]?.status,
      "unknown",
    );

    const reconciled = withStorage(fixture, (storage) =>
      storage.business.saveToolResult({
        roleId: fixture.roleId,
        toolCallId: seeded.inFlightCallId!,
        status: "success",
        adaptedResult: { verified: true, path: "effect.md" },
        now: "2026-11-04T04:10:00.000Z",
      }).result,
    );
    assert.equal(reconciled.status, "success");
    assert.equal(reconciled.previousStatus, "unknown");
    assert.ok(reconciled.reconciledAt);
    assert.equal(
      rows<{ status: string }>(
        fixture,
        "SELECT status FROM tool_calls WHERE tool_call_id = ?",
        seeded.inFlightCallId,
      )[0]?.status,
      "success",
    );
  } finally {
    await second?.close();
    await first?.close();
    await fixture.close();
  }
});

test("restart does not revive an interrupted autonomous task that already ended", { timeout: 20_000 }, async () => {
  const model = new ScriptedChatModel([]);
  const fixture = createFixtureWithModel(model);
  let reopened: BackendApp | null = null;
  try {
    const seeded = seedInterruptedAutonomy(fixture, {
      saved: true,
      inFlight: true,
    });
    fixture.app.conversation.finishTask({
      roleId: fixture.roleId,
      taskId: seeded.taskId,
      status: "completed",
      endReason: "用户明确结束",
    });
    await fixture.app.close();

    reopened = reopen(fixture, model);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(model.requests.length, 0);
    const tasks = reopened.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.taskId, seeded.taskId);
    assert.equal(tasks[0]?.status, "completed");
    assert.equal(
      rows<{ count: number }>(
        fixture,
        "SELECT COUNT(*) AS count FROM executions WHERE trigger_type = 'tool_result'",
      )[0]!.count,
      0,
    );
    assert.equal(
      rows<{ status: string }>(
        fixture,
        "SELECT status FROM tool_calls WHERE tool_call_id = ?",
        seeded.inFlightCallId,
      )[0]?.status,
      "unknown",
    );
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test("restart keeps an undispatched call of a budget-paused task pending", { timeout: 20_000 }, async () => {
  const model = new ScriptedChatModel([]);
  const fixture = createFixtureWithModel(model, {
    now: () => new Date(startAt),
  });
  let reopened: BackendApp | null = null;
  try {
    const seeded = withStorage(fixture, (storage) => {
      const roleId = fixture.roleId;
      const autonomy = new AutonomyStore(
        storage.business.db,
        roleId,
        "Asia/Shanghai",
      );
      autonomy.createWake({
        kind: "scheduled",
        scheduledAt: wakeAt,
        intent: "额度不足时暂停，恢复后继续原任务",
        now: startAt,
      });
      const window = storage.business.getOrCreateWindow({
        roleId,
        kind: "custom",
        source: "nowadays-autonomy",
      });
      const begun = autonomy.beginDueWake({
        windowId: window.windowId,
        now: wakeAt,
      });
      assert.ok(begun);
      const call = storage.business.beginToolCall({
        roleId,
        taskId: begun.taskId,
        executionId: begun.execution.executionId,
        stepKey: "budget-pause:1",
        toolName: "workspace_read",
        args: { path: "note.md" },
      });
      new ConversationStore(
        storage.business.db,
        roleId,
        "Asia/Shanghai",
      ).interruptExecution({
        executionId: begun.execution.executionId,
        partialText: "",
        status: "paused",
        reason: "AUTONOMY_BUDGET_EXHAUSTED",
        errorCode: "AUTONOMY_BUDGET_EXHAUSTED",
        now: "2026-11-04T03:01:00.000Z",
      });
      storage.business.pauseTask({
        roleId,
        taskId: begun.taskId,
        endReason: "AUTONOMY_BUDGET_EXHAUSTED",
      });
      autonomy.createWake({
        kind: "budget_resume",
        scheduledAt: "2026-11-05T16:00:00.000Z",
        intent: "额度恢复后继续原任务",
        taskId: begun.taskId,
        now: "2026-11-04T03:02:00.000Z",
      });
      return { taskId: begun.taskId, callId: call.toolCall.toolCallId };
    });
    await fixture.app.close();

    reopened = reopen(fixture, model);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(model.requests.length, 0);
    assert.equal(
      rows<{ status: string }>(
        fixture,
        "SELECT status FROM tool_calls WHERE tool_call_id = ?",
        seeded.callId,
      )[0]?.status,
      "pending",
    );
    assert.equal(
      rows<{ count: number }>(
        fixture,
        "SELECT COUNT(*) AS count FROM tool_results WHERE tool_call_id = ?",
        seeded.callId,
      )[0]!.count,
      0,
    );
    assert.equal(
      reopened.conversation.getTask(fixture.roleId, seeded.taskId).status,
      "paused",
    );
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test("restart continues a superseded autonomous task with an unresolved tool call", { timeout: 20_000 }, async () => {
  const model = new ScriptedChatModel([done()]);
  const fixture = createFixtureWithModel(model);
  let reopened: BackendApp | null = null;
  try {
    const seeded = seedSupersededTask(fixture, "autonomous");
    await fixture.app.close();

    reopened = reopen(fixture, model);
    await reopened.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, 1);
    const unknownMessage = model.requests[0]!.messages.find(
      (message) =>
        message.role === "tool" && message.toolCallId === seeded.callId,
    );
    assert.ok(unknownMessage);
    assert.match(unknownMessage.content, /"status":"unknown"/);
    assert.match(unknownMessage.content, /PROCESS_INTERRUPTED/);

    const tasks = reopened.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.taskId, seeded.taskId);
    assert.equal(tasks[0]?.status, "completed");
    assert.equal(
      rows<{ status: string }>(
        fixture,
        "SELECT status FROM tool_calls WHERE tool_call_id = ?",
        seeded.callId,
      )[0]?.status,
      "unknown",
    );
    assert.ok(seeded.effectPath);
    assert.equal(fs.readFileSync(seeded.effectPath, "utf8"), "effect\n");
    assert.equal(
      rows<{ count: number }>(fixture, "SELECT COUNT(*) AS count FROM tool_calls")[0]
        ?.count,
      1,
    );
    const activities = reopened.services.autonomy.listActivities(fixture.roleId);
    assert.equal(activities[0]?.status, "completed");
    const wake = reopened.services.autonomy
      .listWakes(fixture.roleId)
      .find((item) => item.status === "completed");
    assert.ok(wake);
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test("restart continues a superseded autonomous task even without tool calls", { timeout: 20_000 }, async () => {
  const model = new ScriptedChatModel([done()]);
  const fixture = createFixtureWithModel(model);
  let reopened: BackendApp | null = null;
  try {
    const seeded = seedSupersededTask(fixture, "autonomous", { tool: false });
    await fixture.app.close();

    reopened = reopen(fixture, model);
    await reopened.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, 1);
    const tasks = reopened.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.taskId, seeded.taskId);
    assert.equal(tasks[0]?.status, "completed");
    assert.equal(
      rows<{ count: number }>(fixture, "SELECT COUNT(*) AS count FROM tool_calls")[0]
        ?.count,
      0,
    );
    const activities = reopened.services.autonomy.listActivities(fixture.roleId);
    assert.equal(activities[0]?.status, "completed");
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test("restart continues a superseded user task when an unresolved tool call exists", { timeout: 20_000 }, async () => {
  const model = new ScriptedChatModel([done()]);
  const fixture = createFixtureWithModel(model);
  let reopened: BackendApp | null = null;
  try {
    const seeded = seedSupersededTask(fixture, "user");
    await fixture.app.close();

    reopened = reopen(fixture, model);
    await reopened.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, 1);
    const tasks = reopened.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.taskId, seeded.taskId);
    assert.equal(tasks[0]?.status, "completed");
    assert.equal(
      rows<{ status: string }>(
        fixture,
        "SELECT status FROM tool_calls WHERE tool_call_id = ?",
        seeded.callId,
      )[0]?.status,
      "unknown",
    );
    assert.equal(
      rows<{ count: number }>(fixture, "SELECT COUNT(*) AS count FROM tool_calls")[0]
        ?.count,
      1,
    );
    const continuation = rows<{
      execution_id: string;
      task_id: string;
      trigger_type: string;
    }>(
      fixture,
      `SELECT e.execution_id, et.task_id, e.trigger_type
         FROM executions e JOIN execution_tasks et ON et.execution_id = e.execution_id
        WHERE e.trigger_type = 'tool_result'`,
    )[0];
    assert.equal(continuation?.task_id, seeded.taskId);
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test("restart does not revive a superseded reply with no tool progress", { timeout: 20_000 }, async () => {
  const model = new ScriptedChatModel([]);
  const fixture = createFixtureWithModel(model);
  let reopened: BackendApp | null = null;
  try {
    const seeded = seedSupersededTask(fixture, "user", { tool: false });
    await fixture.app.close();

    reopened = reopen(fixture, model);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(model.requests.length, 0);
    const tasks = reopened.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.taskId, seeded.taskId);
    assert.equal(tasks[0]?.status, "active");
    assert.equal(
      rows<{ count: number }>(
        fixture,
        "SELECT COUNT(*) AS count FROM executions WHERE trigger_type = 'tool_result'",
      )[0]!.count,
      0,
    );
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});
