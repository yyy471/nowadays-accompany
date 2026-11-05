import assert from "node:assert/strict";
import test from "node:test";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { AgentGraphRunner } from "../src/application/agent-graph.js";
import { createBackendApp, type BackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import type { ConversationTool } from "../src/domain/conversation.js";
import type { ModelEvent } from "../src/domain/model.js";
import { AutonomyStore } from "../src/storage/autonomy-store.js";
import { ConversationStore } from "../src/storage/conversation-store.js";
import { RoleStorage } from "../src/storage/role-storage.js";
import {
  ScriptedChatModel,
  createFixtureWithModel,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

const startAt = "2026-11-04T02:00:00.000Z";
const wakeAt = "2026-11-04T03:00:00.000Z";
const rewindAt = "2026-11-04T03:30:00.000Z";
const restartAt = "2026-11-04T04:00:00.000Z";
const crossDayStart = "2026-11-04T15:59:50.000Z";
const crossDayWake = "2026-11-04T15:59:58.000Z";
const afterMidnight = "2026-11-04T16:00:01.000Z";

const stateUpdateTool: ConversationTool = {
  name: "state_update",
  source: "state",
  description: "更新角色状态",
  inputSchema: { type: "object" },
  async execute(args) {
    return { status: "success", adaptedResult: args };
  },
};

function done(text: string): ModelEvent[] {
  return [
    { type: "text_delta", text },
    { type: "completed", stopReason: "stop" },
  ];
}

interface SeededAutonomy {
  taskId: string;
  executionId: string;
  windowId: string;
  wakeId: string;
  activityId: string;
  resourceId: string;
  modelName: string;
}

function seedAutonomy(
  fixture: Fixture,
  scheduledAt: string,
  dueAt: string,
  intent: string,
): SeededAutonomy {
  return withStorage(fixture, (storage) => {
    const autonomy = new AutonomyStore(
      storage.business.db,
      fixture.roleId,
      "Asia/Shanghai",
    );
    const wake = autonomy.createWake({
      kind: "scheduled",
      scheduledAt,
      intent,
      now: scheduledAt,
    });
    const window = storage.business.getOrCreateWindow({
      roleId: fixture.roleId,
      kind: "custom",
      source: "nowadays-autonomy",
    });
    const begun = autonomy.beginDueWake({
      windowId: window.windowId,
      now: dueAt,
    });
    assert.ok(begun);
    const binding = storage.business
      .listRoleBindings(fixture.roleId)
      .find((item) => item.capability === "chat_model");
    assert.ok(binding);
    return {
      taskId: begun.taskId,
      executionId: begun.execution.executionId,
      windowId: window.windowId,
      wakeId: wake.wakeId,
      activityId: begun.activity.activityId,
      resourceId: binding.resourceId,
      modelName: binding.modelName ?? "offline-chat",
    };
  });
}

async function runGraphToFinalCheckpoint(
  fixture: Fixture,
  seeded: SeededAutonomy,
  now: string,
): Promise<void> {
  const storage = RoleStorage.openExisting(
    rolePaths(fixture.app.config.dataRoot, fixture.roleId),
  );
  const store = new ConversationStore(
    storage.business.db,
    fixture.roleId,
    "Asia/Shanghai",
  );
  const model = new ScriptedChatModel([
    [
      { type: "text_delta", text: "先想一下。" },
      {
        type: "tool_call",
        callId: "checkpoint-state",
        name: "state_update",
        arguments: { patch: { mood: "检查点内的状态" } },
      },
      { type: "completed", stopReason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "原检查点中的最终回复" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const saver = SqliteSaver.fromConnString(
    storage.paths.executionDatabasePath,
  );
  try {
    const runner = new AgentGraphRunner(
      {
        store,
        roleStore: storage.business,
        resolveModel: () => ({
          model,
          resourceId: seeded.resourceId,
          modelName: seeded.modelName,
          protocol: "openai-chat",
        }),
        tools: [stateUpdateTool],
        systemPrompt: () => "检查点测试",
        signal: new AbortController().signal,
        checkRunning: () => {
          if (store.getExecution(seeded.executionId).status !== "running") {
            throw new Error("CHECKPOINT_EXECUTION_NOT_RUNNING");
          }
        },
        emitDelta: (text) => {
          store.appendMessageDelta({
            windowId: seeded.windowId,
            executionId: seeded.executionId,
            text,
            now,
          });
        },
        ensureTask: () => seeded.taskId,
        now: () => new Date(now),
        purpose: "autonomous",
        meter: null,
      },
      saver,
    );
    await runner.run({
      executionId: seeded.executionId,
      roleId: fixture.roleId,
      windowId: seeded.windowId,
      messages: [],
      taskId: seeded.taskId,
    });
  } finally {
    saver.db.close();
    storage.close();
  }
}

function reopen(
  fixture: Fixture,
  model: ScriptedChatModel,
  now: string,
): BackendApp {
  return createBackendApp(
    parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
    {
      now: () => new Date(now),
      timeZone: "Asia/Shanghai",
      modelPortFactory: () => model,
      disableMemoryRuntime: true,
    },
  );
}

function rows<T>(
  fixture: Fixture,
  sql: string,
  ...params: unknown[]
): T[] {
  return withStorage(fixture, (storage) =>
    storage.business.db.prepare(sql).all(...params),
  ) as T[];
}

test(
  "restart commits the completed graph checkpoint without another model call",
  { timeout: 20_000 },
  async () => {
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      now: () => new Date(startAt),
    });
    let restored: BackendApp | null = null;
    let repeated: BackendApp | null = null;
    try {
      const seeded = seedAutonomy(
        fixture,
        startAt,
        wakeAt,
        "验证原执行检查点恢复",
      );
      await runGraphToFinalCheckpoint(fixture, seeded, wakeAt);
      assert.equal(
        rows<{ status: string }>(
          fixture,
          "SELECT status FROM executions WHERE execution_id = ?",
          seeded.executionId,
        )[0]?.status,
        "running",
      );
      await fixture.app.close();

      const quiet = new ScriptedChatModel([]);
      restored = reopen(fixture, quiet, restartAt);
      await restored.conversation.waitForIdle(fixture.roleId);

      assert.equal(quiet.requests.length, 0);
      const execution = restored.conversation.getExecution(
        fixture.roleId,
        seeded.executionId,
      );
      assert.equal(execution.execution.status, "completed");
      assert.equal(
        rows<{ count: number }>(
          fixture,
          "SELECT COUNT(*) AS count FROM executions",
        )[0]?.count,
        1,
      );
      const replies = rows<{ content: string; status: string }>(
        fixture,
        `SELECT content, status FROM messages
          WHERE execution_id = ? AND sender = 'assistant'
          ORDER BY sequence ASC`,
        seeded.executionId,
      );
      assert.deepEqual(
        replies.map((reply) => [reply.content, reply.status]),
        [["先想一下。原检查点中的最终回复", "completed"]],
      );
      assert.equal(
        restored.services.roles.getState(fixture.roleId).state.mood,
        "检查点内的状态",
      );
      assert.equal(
        restored.services.autonomy.listActivities(fixture.roleId)[0]?.status,
        "completed",
      );
      assert.equal(
        restored.services.autonomy
          .listWakes(fixture.roleId)
          .find((wake) => wake.wakeId === seeded.wakeId)?.status,
        "completed",
      );
      assert.equal(
        restored.conversation.getTask(fixture.roleId, seeded.taskId).status,
        "completed",
      );
      await restored.close();
      restored = null;

      const quietAgain = new ScriptedChatModel([]);
      repeated = reopen(fixture, quietAgain, restartAt);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(quietAgain.requests.length, 0);
      assert.equal(
        rows<{ count: number }>(
          fixture,
          "SELECT COUNT(*) AS count FROM executions",
        )[0]?.count,
        1,
      );
      assert.equal(
        rows<{ count: number }>(
          fixture,
          `SELECT COUNT(*) AS count FROM messages
            WHERE execution_id = ? AND sender = 'assistant' AND status = 'completed'`,
          seeded.executionId,
        )[0]?.count,
        1,
      );
    } finally {
      await repeated?.close();
      await restored?.close();
      await fixture.close();
    }
  },
);

test(
  "a completed checkpoint with a stale state version is re-evaluated instead of committed",
  { timeout: 20_000 },
  async () => {
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      now: () => new Date(startAt),
    });
    let restored: BackendApp | null = null;
    try {
      const seeded = seedAutonomy(
        fixture,
        startAt,
        wakeAt,
        "状态版本变化后重新评估检查点",
      );
      await runGraphToFinalCheckpoint(fixture, seeded, wakeAt);
      fixture.app.services.roles.setState(fixture.roleId, {
        state: { mood: "重启前的新状态" },
      });
      await fixture.app.close();

      const model = new ScriptedChatModel([done("按最新状态重新判断。")]);
      restored = reopen(fixture, model, restartAt);
      await restored.conversation.waitForIdle(fixture.roleId);

      assert.equal(model.requests.length, 1);
      assert.match(model.requests[0]!.system, /重启前的新状态/);
      const original = restored.conversation.getExecution(
        fixture.roleId,
        seeded.executionId,
      );
      assert.equal(original.execution.status, "failed");
      const completed = rows<{ content: string }>(
        fixture,
        `SELECT content FROM messages
          WHERE sender = 'assistant' AND status = 'completed'
          ORDER BY sequence ASC`,
      );
      assert.deepEqual(
        completed.map((message) => message.content),
        ["按最新状态重新判断。"],
      );
      assert.equal(
        restored.services.roles.getState(fixture.roleId).state.mood,
        "重启前的新状态",
      );
    } finally {
      await restored?.close();
      await fixture.close();
    }
  },
);

test(
  "restart converges a committed reply whose task finish and activity settlement were lost",
  { timeout: 20_000 },
  async () => {
    const clock = { value: new Date(startAt) };
    const fixture = createFixtureWithModel(
      new ScriptedChatModel([done("自主活动已经完成。")]),
      { now: () => clock.value },
    );
    let restored: BackendApp | null = null;
    let repeated: BackendApp | null = null;
    try {
      const wake = fixture.app.services.autonomy.scheduleWake(
        fixture.roleId,
        { wakeAt, intent: "完成一次自主活动" },
      );
      clock.value = new Date(wakeAt);
      fixture.app.conversation.runDueAutonomy(fixture.roleId);
      await fixture.app.conversation.waitForIdle(fixture.roleId);
      const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
      assert.ok(task);
      assert.equal(task.status, "completed");

      withStorage(fixture, (storage) => {
        storage.business.db
          .prepare(
            "UPDATE tasks SET status = 'active', end_reason = NULL WHERE task_id = ?",
          )
          .run(task.taskId);
        storage.business.db
          .prepare(
            "UPDATE autonomy_activities SET status = 'running', summary = NULL, finished_at = NULL WHERE task_id = ?",
          )
          .run(task.taskId);
        storage.business.db
          .prepare(
            "UPDATE autonomy_wakes SET status = 'claimed', completed_at = NULL WHERE wake_id = ?",
          )
          .run(wake.wakeId);
        const binding = storage.business
          .listRoleBindings(fixture.roleId)
          .find((item) => item.capability === "chat_model");
        assert.ok(binding);
        storage.business.grantResourceContinuation({
          roleId: fixture.roleId,
          taskId: task.taskId,
          resourceId: binding.resourceId,
        });
      });
      await fixture.app.close();

      const quiet = new ScriptedChatModel([]);
      restored = reopen(fixture, quiet, restartAt);
      await restored.conversation.waitForIdle(fixture.roleId);

      assert.equal(quiet.requests.length, 0);
      assert.equal(
        restored.conversation.getTask(fixture.roleId, task.taskId).status,
        "completed",
      );
      assert.equal(
        restored.services.autonomy.listActivities(fixture.roleId)[0]?.status,
        "completed",
      );
      const settledWake = restored.services.autonomy
        .listWakes(fixture.roleId)
        .find((item) => item.wakeId === wake.wakeId);
      assert.equal(settledWake?.status, "completed");
      const continuations = withStorage(fixture, (storage) =>
        storage.business.listResourceContinuations(
          fixture.roleId,
          task.taskId,
        ),
      );
      assert.ok(continuations.length > 0);
      assert.ok(continuations.every((item) => item.endedAt !== null));
      assert.equal(
        rows<{ count: number }>(
          fixture,
          "SELECT COUNT(*) AS count FROM executions",
        )[0]?.count,
        1,
      );
      await restored.close();
      restored = null;

      const quietAgain = new ScriptedChatModel([]);
      repeated = reopen(fixture, quietAgain, restartAt);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(quietAgain.requests.length, 0);
      assert.equal(
        repeated.conversation.getTask(fixture.roleId, task.taskId).status,
        "completed",
      );
      assert.equal(
        rows<{ count: number }>(
          fixture,
          "SELECT COUNT(*) AS count FROM messages WHERE sender = 'assistant' AND status = 'completed'",
        )[0]?.count,
        1,
      );
    } finally {
      await repeated?.close();
      await restored?.close();
      await fixture.close();
    }
  },
);

test(
  "restart refunds an undispatched tool reservation and keeps the ledger consistent",
  { timeout: 20_000 },
  async () => {
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      now: () => new Date(startAt),
    });
    let restored: BackendApp | null = null;
    let repeated: BackendApp | null = null;
    try {
      const seeded = seedAutonomy(
        fixture,
        startAt,
        wakeAt,
        "验证未派发预留跨退出结算",
      );
      const callId = withStorage(fixture, (storage) => {
        const call = storage.business.beginToolCall({
          roleId: fixture.roleId,
          taskId: seeded.taskId,
          executionId: seeded.executionId,
          stepKey: "reservation:1",
          toolName: "workspace_write",
          args: { path: "effect.md" },
        });
        new ConversationStore(
          storage.business.db,
          fixture.roleId,
          "Asia/Shanghai",
        ).startModelCall({
          executionId: seeded.executionId,
          resourceId: seeded.resourceId,
          modelName: seeded.modelName,
          protocol: "openai-chat",
          purpose: "autonomous",
          counted: true,
          now: startAt,
        });
        return call.toolCall.toolCallId;
      });
      fixture.app.services.autonomy.consumePoint(fixture.roleId);
      const reserved = fixture.app.services.autonomy.reserveToolPoint(
        fixture.roleId,
        callId,
      );
      assert.equal(reserved.counted, true);
      assert.equal(
        fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
        2,
      );
      await fixture.app.close();

      const model = new ScriptedChatModel([done("未派发结果之后继续。")]);
      restored = reopen(fixture, model, restartAt);
      await restored.conversation.waitForIdle(fixture.roleId);

      assert.equal(model.requests.length, 1);
      const reservation = withStorage(fixture, (storage) =>
        new AutonomyStore(
          storage.business.db,
          fixture.roleId,
          "Asia/Shanghai",
        ).getToolReservation(callId),
      );
      assert.equal(reservation?.status, "released");
      const result = withStorage(fixture, (storage) =>
        storage.business.getToolResult(fixture.roleId, callId),
      );
      assert.equal(result.status, "failed");
      assert.equal(result.diagnosticCode, "PROCESS_INTERRUPTED");
      const metering = rows<{ counted: number }>(
        fixture,
        "SELECT counted FROM call_metering WHERE call_kind = 'model' OR call_kind = 'tool'",
      );
      const counted = metering.reduce((sum, row) => sum + row.counted, 0);
      assert.equal(
        restored.services.autonomy.getStatus(fixture.roleId).budget
          .usedPoints,
        counted,
      );
      assert.equal(counted, 2);
      await restored.close();
      restored = null;

      const quiet = new ScriptedChatModel([]);
      repeated = reopen(fixture, quiet, restartAt);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(quiet.requests.length, 0);
      assert.equal(
        repeated.services.autonomy.getStatus(fixture.roleId).budget
          .usedPoints,
        2,
      );
    } finally {
      await repeated?.close();
      await restored?.close();
      await fixture.close();
    }
  },
);

test(
  "a reservation released after midnight does not refund the previous day into the new budget",
  { timeout: 20_000 },
  async () => {
    const clock = { value: new Date(crossDayStart) };
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
      now: () => clock.value,
    });
    let restored: BackendApp | null = null;
    try {
      const seeded = seedAutonomy(
        fixture,
        crossDayStart,
        crossDayWake,
        "跨日结算未派发预留",
      );
      const callId = withStorage(fixture, (storage) => {
        const call = storage.business.beginToolCall({
          roleId: fixture.roleId,
          taskId: seeded.taskId,
          executionId: seeded.executionId,
          stepKey: "cross-day:1",
          toolName: "workspace_write",
          args: {},
        });
        new ConversationStore(
          storage.business.db,
          fixture.roleId,
          "Asia/Shanghai",
        ).startModelCall({
          executionId: seeded.executionId,
          resourceId: seeded.resourceId,
          modelName: seeded.modelName,
          protocol: "openai-chat",
          purpose: "autonomous",
          counted: true,
          now: crossDayStart,
        });
        return call.toolCall.toolCallId;
      });
      fixture.app.services.autonomy.consumePoint(fixture.roleId);
      fixture.app.services.autonomy.reserveToolPoint(fixture.roleId, callId);
      await fixture.app.close();

      const model = new ScriptedChatModel([done("跨日后的恢复回复。")]);
      restored = reopen(fixture, model, afterMidnight);
      await restored.conversation.waitForIdle(fixture.roleId);

      assert.equal(model.requests.length, 1);
      const budget = restored.services.autonomy.getStatus(fixture.roleId)
        .budget;
      assert.equal(budget.usedPoints, 1);
      const reservation = withStorage(fixture, (storage) =>
        new AutonomyStore(
          storage.business.db,
          fixture.roleId,
          "Asia/Shanghai",
        ).getToolReservation(callId),
      );
      assert.equal(reservation?.status, "released");
      const todayMetering = rows<{ counted: number }>(
        fixture,
        "SELECT counted FROM call_metering WHERE created_at >= ?",
        "2026-11-04T16:00:00.000Z",
      );
      assert.equal(
        todayMetering.reduce((sum, row) => sum + row.counted, 0),
        1,
      );
    } finally {
      await restored?.close();
      await fixture.close();
    }
  },
);
