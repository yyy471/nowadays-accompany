import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createBackendApp } from "../src/bootstrap/app.js";
import { rolePaths } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import { RoleStorage } from "../src/storage/role-storage.js";
import { RoleStore } from "../src/storage/role-store.js";
import {
  addBinding,
  createFixture,
  createFixtureWithModel,
  ScriptedChatModel,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await delay(20);
  }
  throw new Error("WAIT_TIMEOUT");
}

function submit(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}

function addWorkspaceMcp(fixture: Fixture): string {
  const workspace = rolePaths(
    fixture.app.config.dataRoot,
    fixture.roleId,
  ).workspaceDir;
  fs.mkdirSync(workspace, { recursive: true });
  const mcp = fixture.app.services.resources.create({
    kind: "mcp",
    name: "workspace",
    config: {
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(
          pathToFileURL(path.resolve("src/mcp/local-server.ts")).href,
        )})`,
      ],
      env: { NOWADAYS_WORKSPACE: workspace },
    },
  });
  addBinding(fixture, "mcp", mcp.resourceId);
  return workspace;
}

/**
 * 两段阅读场景（GAP-02 验收例）：
 * round1 读文件（建任务）；round2 携带任务编号安排唤醒；
 * round3 task_pause 暂停；round4 先回复。
 * 唤醒接回原链后：任务上下文里有已保存结果与笔记 → task_finish 结束。
 */
class TwoPhaseReadingModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const round = this.requests.length;
    if (round === 1) {
      const read = request.tools.find((candidate) =>
        candidate.name.includes("workspace_read"),
      );
      assert.ok(read);
      yield {
        type: "tool_call",
        callId: "wire-read-first",
        name: read.name,
        arguments: { path: "material.md" },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (round === 2) {
      // 任务编号来自系统提示中的任务简报。
      const match = /taskId=([0-9a-f-]{36})/.exec(request.system);
      assert.ok(match, "系统提示应包含当前任务编号");
      const schedule = request.tools.find(
        (candidate) => candidate.name === "autonomy_schedule",
      );
      assert.ok(schedule);
      yield {
        type: "tool_call",
        callId: "wire-schedule",
        name: schedule.name,
        arguments: {
          wakeAt: new Date(Date.now() + 1500).toISOString(),
          intent: "继续阅读剩余部分",
          taskId: match[1],
        },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (round === 3) {
      const pause = request.tools.find(
        (candidate) => candidate.name === "task_pause",
      );
      assert.ok(pause);
      yield {
        type: "tool_call",
        callId: "wire-pause",
        name: pause.name,
        arguments: {
          reason: "分两次阅读",
          note: "已读完前半部分",
        },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (round === 4) {
      yield { type: "text_delta", text: "先读到这里，稍后继续。" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    if (round === 5) {
      // 唤醒接回原链：上下文已重放读取结果与进度笔记。
      const toolMessages = request.messages.filter(
        (message) => message.role === "tool",
      );
      assert.ok(
        toolMessages.some((message) =>
          String(message.content).includes("前半部分内容"),
        ),
        "接回原链时应重放已保存的工具结果",
      );
      assert.match(request.system, /已读完前半部分/);
      const finish = request.tools.find(
        (candidate) => candidate.name === "task_finish",
      );
      assert.ok(finish);
      yield {
        type: "tool_call",
        callId: "wire-finish",
        name: finish.name,
        arguments: {
          status: "completed",
          endReason: "阅读完成",
          note: "已读完后半部分",
        },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "全部读完。" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("task_pause keeps the original task and a task-carrying wake resumes the same chain", { timeout: 60_000 }, async () => {
  const model = new TwoPhaseReadingModel();
  const fixture = createFixtureWithModel(model);
  try {
    const workspace = addWorkspaceMcp(fixture);
    fs.writeFileSync(
      path.join(workspace, "material.md"),
      "前半部分内容\n后半部分内容",
      "utf8",
    );
    submit(fixture, "分两次读完这份资料，先读前半");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const paused = withStorage(fixture, (storage) => {
      const tasks = storage.business.listTasks(fixture.roleId);
      const notes = storage.business.db
        .prepare("SELECT note FROM task_notes ORDER BY rowid ASC")
        .all() as Array<{ note: string }>;
      const continuations = storage.business.db
        .prepare(
          "SELECT resource_id FROM task_resource_continuations WHERE ended_at IS NULL",
        )
        .all() as Array<{ resource_id: string }>;
      const executions = storage.business.db
        .prepare("SELECT status FROM executions ORDER BY rowid ASC")
        .all() as Array<{ status: string }>;
      return { tasks, notes, continuations, executions };
    });
    assert.equal(paused.tasks.length, 1);
    assert.equal(paused.tasks[0]?.status, "paused");
    assert.equal(paused.tasks[0]?.endReason, "分两次阅读");
    assert.ok(paused.notes.some((row) => row.note === "已读完前半部分"));
    assert.ok(paused.continuations.length > 0, "暂停应保留资源延续");
    assert.deepEqual(paused.executions.map((row) => row.status), [
      "completed",
    ]);
    const taskId = paused.tasks[0]!.taskId;
    const wake = fixture.app.services.autonomy
      .listWakes(fixture.roleId)
      .find((item) => item.taskId === taskId);
    assert.ok(wake, "唤醒应携带原任务编号");

    await waitUntil(() => {
      const task = fixture.app.conversation.getTask(fixture.roleId, taskId);
      return task.status === "completed";
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const final = withStorage(fixture, (storage) => {
      const links = storage.business.db
        .prepare(
          "SELECT relation FROM execution_tasks ORDER BY created_at ASC, rowid ASC",
        )
        .all() as Array<{ relation: string }>;
      const executions = storage.business.db
        .prepare("SELECT status FROM executions ORDER BY rowid ASC")
        .all() as Array<{ status: string }>;
      const continuations = storage.business.db
        .prepare(
          "SELECT resource_id FROM task_resource_continuations WHERE ended_at IS NULL",
        )
        .all() as Array<{ resource_id: string }>;
      return { links, executions, continuations };
    });
    assert.equal(
      fixture.app.conversation.getTask(fixture.roleId, taskId).endReason,
      "阅读完成",
    );
    assert.deepEqual(final.links.map((row) => row.relation), [
      "initiates",
      "continues",
    ]);
    assert.deepEqual(final.executions.map((row) => row.status), [
      "completed",
      "completed",
    ]);
    assert.equal(final.continuations.length, 0, "任务真实结束后释放资源延续");
  } finally {
    await fixture.close();
  }
});

test("a normal reply without task tools still completes the task with the default reason", { timeout: 30_000 }, async () => {
  const fixture = createFixture([
    (request) => {
      const read = request.tools.find((candidate) =>
        candidate.name.includes("workspace_read"),
      );
      assert.ok(read);
      return [
        {
          type: "tool_call",
          callId: "wire-read",
          name: read.name,
          arguments: { path: "material.md" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    [
      { type: "text_delta", text: "读完了。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const workspace = addWorkspaceMcp(fixture);
    fs.writeFileSync(path.join(workspace, "material.md"), "全文内容", "utf8");
    submit(fixture, "读完这份资料");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
    assert.equal(tasks[0]?.endReason, "回复完成");
  } finally {
    await fixture.close();
  }
});

test("task_finish ends the task with the declared status and reason", { timeout: 30_000 }, async () => {
  const fixture = createFixture([
    (request) => {
      const read = request.tools.find((candidate) =>
        candidate.name.includes("workspace_read"),
      );
      assert.ok(read);
      return [
        {
          type: "tool_call",
          callId: "wire-read-finish",
          name: read.name,
          arguments: { path: "material.md" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      const finish = request.tools.find(
        (candidate) => candidate.name === "task_finish",
      );
      assert.ok(finish);
      return [
        {
          type: "tool_call",
          callId: "wire-finish",
          name: finish.name,
          arguments: {
            status: "failed",
            endReason: "资料缺失无法完成",
          },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    [
      { type: "text_delta", text: "任务按失败结束。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const workspace = addWorkspaceMcp(fixture);
    fs.writeFileSync(path.join(workspace, "material.md"), "不完整的内容", "utf8");
    submit(fixture, "读完这份资料并收尾");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "failed");
    assert.equal(tasks[0]?.endReason, "资料缺失无法完成");
  } finally {
    await fixture.close();
  }
});

test("task tools require an active task and reject a mismatched taskId on scheduling", { timeout: 30_000 }, async () => {
  const fixture = createFixture([
    (request) => {
      const pause = request.tools.find(
        (candidate) => candidate.name === "task_pause",
      );
      assert.ok(pause);
      return [
        {
          type: "tool_call",
          callId: "wire-pause-no-task",
          name: pause.name,
          arguments: { reason: "没有任务" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    [
      { type: "text_delta", text: "没有任务可暂停。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    submit(fixture, "试试暂停");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.equal(messages.items.at(-1)?.content, "没有任务可暂停。");
    assert.equal(fixture.app.conversation.listTasks(fixture.roleId).length, 0);
  } finally {
    await fixture.close();
  }
});

test("a pause decision survives a failed post-commit write and resumes the same task after restart", { timeout: 60_000 }, async () => {
  const clock = { now: new Date("2026-11-06T01:00:00.000Z") };
  const fixture = createFixture(
    [
      (request) => {
        const read = request.tools.find((candidate) =>
          candidate.name.includes("workspace_read"),
        );
        assert.ok(read);
        return [
          {
            type: "tool_call",
            callId: "wire-read-before-pause",
            name: read.name,
            arguments: { path: "material.md" },
          },
          { type: "completed", stopReason: "tool_calls" },
        ];
      },
      (request) => {
        const pause = request.tools.find(
          (candidate) => candidate.name === "task_pause",
        );
        assert.ok(pause);
        return [
          {
            type: "tool_call",
            callId: "wire-pause-crash",
            name: pause.name,
            arguments: { reason: "等下一次继续", note: "已完成一半" },
          },
          { type: "completed", stopReason: "tool_calls" },
        ];
      },
      [
        { type: "text_delta", text: "先休息一下。" },
        { type: "completed", stopReason: "stop" },
      ],
    ],
    { now: () => clock.now },
  );
  let restarted: ReturnType<typeof createBackendApp> | undefined;
  const originalPause = RoleStore.prototype.pauseTask;
  try {
    const workspace = addWorkspaceMcp(fixture);
    fs.writeFileSync(path.join(workspace, "material.md"), "资料内容", "utf8");
    RoleStore.prototype.pauseTask = function (input) {
      if (input.endReason === "等下一次继续") {
        throw new Error("PAUSE_WRITE_FAILED");
      }
      return originalPause.call(this, input);
    };
    submit(fixture, "做一半先停");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    RoleStore.prototype.pauseTask = originalPause;

    const before = withStorage(fixture, (storage) => {
      const task = storage.business.listTasks(fixture.roleId)[0]!;
      const execution = storage.business.db
        .prepare(
          "SELECT status, task_decision_json FROM executions ORDER BY rowid DESC LIMIT 1",
        )
        .get() as { status: string; task_decision_json: string | null };
      const continuations = storage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM task_resource_continuations WHERE ended_at IS NULL",
        )
        .get() as { count: number };
      return { task, execution, openContinuations: continuations.count };
    });
    assert.equal(before.task.status, "active", "故障后任务仍是原状态");
    assert.equal(before.execution.status, "completed");
    assert.match(
      before.execution.task_decision_json ?? "",
      /"kind":"pause"/,
      "暂停决定应随回复提交持久化",
    );
    assert.ok(before.openContinuations > 0, "暂停决定不应提前释放资源");

    // 模拟进程重启：启动收尾应按已保存的暂停决定执行。
    await fixture.app.close();
    restarted = createBackendApp(fixture.app.config, {
      disableMemoryRuntime: true,
      now: () => clock.now,
      modelPortFactory: () =>
        new ScriptedChatModel([
          [
            { type: "text_delta", text: "继续完成。" },
            { type: "completed", stopReason: "stop" },
          ],
        ]),
    });
    const restored = restarted.conversation.getTask(
      fixture.roleId,
      before.task.taskId,
    );
    assert.equal(restored.status, "paused");
    assert.equal(restored.endReason, "等下一次继续");

    const resourceStorage = RoleStorage.openExisting(
      rolePaths(restarted.config.dataRoot, fixture.roleId),
    );
    try {
      const open = resourceStorage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM task_resource_continuations WHERE ended_at IS NULL",
        )
        .get() as { count: number };
      assert.ok(open.count > 0, "重启恢复暂停后仍保留资源续行");
    } finally {
      resourceStorage.close();
    }

    // 唤醒携带原任务编号接回同一条链；用户任务在自主额度耗尽时仍可继续。
    restarted.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 1,
      unlimited: false,
    });
    restarted.services.autonomy.consumePoint(fixture.roleId);
    restarted.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: new Date(clock.now.getTime() + 1_000).toISOString(),
      intent: restored.goal,
      taskId: restored.taskId,
    });
    clock.now = new Date(clock.now.getTime() + 2_000);
    assert.equal(restarted.conversation.runDueAutonomy(fixture.roleId), true);
    await restarted.conversation.waitForIdle(fixture.roleId);
    const completed = restarted.conversation.getTask(
      fixture.roleId,
      before.task.taskId,
    );
    assert.equal(completed.status, "completed");
    const after = RoleStorage.openExisting(
      rolePaths(restarted.config.dataRoot, fixture.roleId),
    );
    try {
      const links = after.business.db
        .prepare(
          "SELECT relation FROM execution_tasks WHERE task_id = ? ORDER BY rowid ASC",
        )
        .all(before.task.taskId) as Array<{ relation: string }>;
      assert.deepEqual(links.map((row) => row.relation), [
        "initiates",
        "continues",
      ]);
      const metering = after.business.db
        .prepare("SELECT purpose, counted FROM call_metering ORDER BY rowid ASC")
        .all() as Array<{ purpose: string; counted: number }>;
      assert.ok(metering.length > 0);
      assert.ok(
        metering.every((row) => row.purpose === "user_chat" && row.counted === 0),
        "用户任务续行不应按自主活动计量",
      );
    } finally {
      after.close();
    }
    assert.equal(
      restarted.services.autonomy.getBudget(fixture.roleId).usedPoints,
      1,
      "用户任务续行不增加自主点数",
    );
  } finally {
    RoleStore.prototype.pauseTask = originalPause;
    await restarted?.close();
    await fixture.close();
  }
});

test("restart applies the latest unapplied task decision after a pause and continuation", { timeout: 60_000 }, async () => {
  const clock = { now: new Date("2026-11-06T01:00:00.000Z") };
  const tool = (
    name: string,
    callId: string,
    args: Record<string, unknown>,
  ): ModelEvent[] => [
    { type: "tool_call", callId, name, arguments: args },
    { type: "completed", stopReason: "tool_calls" },
  ];
  const reply = (text: string): ModelEvent[] => [
    { type: "text_delta", text },
    { type: "completed", stopReason: "stop" },
  ];
  const fixture = createFixture(
    [
      tool("task_pause", "wire-first-pause", { reason: "第一轮暂缓" }),
      reply("稍后接回原任务"),
      tool("task_finish", "wire-second-finish", {
        status: "failed",
        endReason: "第二轮确认无法完成",
      }),
      reply("这次确认无法完成"),
    ],
    { now: () => clock.now },
  );
  let restarted: ReturnType<typeof createBackendApp> | undefined;
  let restartedAgain: ReturnType<typeof createBackendApp> | undefined;
  const originalFinish = RoleStore.prototype.finishTask;
  try {
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-06T02:00:00.000Z",
      intent: "需要两次决策的任务",
    });
    clock.now = new Date("2026-11-06T02:00:00.000Z");
    assert.equal(
      fixture.app.conversation.runDueAutonomy(fixture.roleId),
      true,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const first = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
    assert.equal(first.status, "paused");
    assert.equal(first.endReason, "第一轮暂缓");

    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-06T03:00:00.000Z",
      intent: first.goal,
      taskId: first.taskId,
    });
    let faults = 0;
    RoleStore.prototype.finishTask = function (input) {
      if (input.endReason === "第二轮确认无法完成") {
        faults += 1;
        throw new Error("ISOLATED_FINISH_WRITE_FAILURE");
      }
      return originalFinish.call(this, input);
    };
    clock.now = new Date("2026-11-06T03:00:00.000Z");
    assert.equal(
      fixture.app.conversation.runDueAutonomy(fixture.roleId),
      true,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    RoleStore.prototype.finishTask = originalFinish;
    assert.equal(faults, 1);

    const before = withStorage(fixture, (storage) => {
      const task = storage.business.getTask(fixture.roleId, first.taskId);
      const decisions = storage.business.db
        .prepare("SELECT task_decision_json FROM executions ORDER BY rowid ASC")
        .all() as Array<{ task_decision_json: string | null }>;
      const open = storage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM task_resource_continuations WHERE ended_at IS NULL",
        )
        .get() as { count: number };
      return { task, decisions, open: open.count };
    });
    assert.equal(before.task.status, "active");
    assert.equal(before.decisions.length, 2);
    assert.match(before.decisions[0]?.task_decision_json ?? "", /"kind":"pause"/);
    assert.match(
      before.decisions[1]?.task_decision_json ?? "",
      /"kind":"finish".*"status":"failed".*第二轮确认无法完成/u,
    );
    assert.ok(before.open > 0);

    // 第一次重启只应落实第二轮已提交但未写入的失败终态。
    await fixture.app.close();
    restarted = createBackendApp(fixture.app.config, {
      disableMemoryRuntime: true,
      now: () => clock.now,
      modelPortFactory: () => new ScriptedChatModel([]),
    });
    const after = restarted.conversation.getTask(
      fixture.roleId,
      first.taskId,
    );
    assert.equal(after.status, "failed");
    assert.equal(after.endReason, "第二轮确认无法完成");
    const cleanup = RoleStorage.openExisting(
      rolePaths(restarted.config.dataRoot, fixture.roleId),
    );
    try {
      const open = cleanup.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM task_resource_continuations WHERE ended_at IS NULL",
        )
        .get() as { count: number };
      assert.equal(open.count, 0, "恢复终态后应释放资源延续");
      const links = cleanup.business.db
        .prepare(
          "SELECT task_id, relation FROM execution_tasks ORDER BY rowid ASC",
        )
        .all() as Array<{ task_id: string; relation: string }>;
      assert.ok(links.every((row) => row.task_id === first.taskId));
      assert.deepEqual(links.map((row) => row.relation), [
        "initiates",
        "continues",
      ]);
    } finally {
      cleanup.close();
    }

    // 再次重启保持同一结果，不被旧暂停记录覆盖。
    await restarted.close();
    restarted = undefined;
    restartedAgain = createBackendApp(fixture.app.config, {
      disableMemoryRuntime: true,
      now: () => clock.now,
      modelPortFactory: () => new ScriptedChatModel([]),
    });
    const again = restartedAgain.conversation.getTask(
      fixture.roleId,
      first.taskId,
    );
    assert.equal(again.status, "failed");
    assert.equal(again.endReason, "第二轮确认无法完成");
  } finally {
    RoleStore.prototype.finishTask = originalFinish;
    await restarted?.close();
    await restartedAgain?.close();
    await fixture.close();
  }
});

test("an interrupted continuation before commit keeps the task active and resumes it after restart", { timeout: 60_000 }, async () => {
  const clock = { now: new Date("2026-11-06T01:00:00.000Z") };
  const tool = (
    name: string,
    callId: string,
    args: Record<string, unknown>,
  ): ModelEvent[] => [
    { type: "tool_call", callId, name, arguments: args },
    { type: "completed", stopReason: "tool_calls" },
  ];
  const reply = (text: string): ModelEvent[] => [
    { type: "text_delta", text },
    { type: "completed", stopReason: "stop" },
  ];
  const fixture = createFixture(
    [
      tool("task_pause", "wire-pause-before-crash", { reason: "第一轮暂缓" }),
      reply("先暂停，之后继续。"),
    ],
    { now: () => clock.now },
  );
  let restarted: ReturnType<typeof createBackendApp> | undefined;
  let restartedAgain: ReturnType<typeof createBackendApp> | undefined;
  try {
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-06T02:00:00.000Z",
      intent: "分两次处理",
    });
    clock.now = new Date("2026-11-06T02:00:00.000Z");
    assert.equal(
      fixture.app.conversation.runDueAutonomy(fixture.roleId),
      true,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const first = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
    assert.equal(first.status, "paused");
    assert.equal(first.endReason, "第一轮暂缓");

    // 第二轮唤醒接回原任务后、提交回复前进程被强杀：
    // 任务回到 active，续行执行停在 running 且没有任何检查点。
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-06T03:00:00.000Z",
      intent: first.goal,
      taskId: first.taskId,
    });
    clock.now = new Date("2026-11-06T03:00:00.000Z");
    const begun = fixture.app.services.autonomy.beginDueWake(
      fixture.roleId,
      fixture.windowId,
    );
    assert.ok(begun);
    assert.equal(
      fixture.app.conversation.getTask(fixture.roleId, first.taskId).status,
      "active",
    );
    const interrupted = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT status FROM executions ORDER BY rowid ASC",
        )
        .all() as Array<{ status: string }>,
    );
    assert.deepEqual(interrupted.map((row) => row.status), [
      "completed",
      "running",
    ]);

    // 重启先记录中断事实，再按原任务规则继续；已落实的旧暂停不得重放。
    await fixture.app.close();
    const model = new ScriptedChatModel([reply("已完成原任务。")]);
    restarted = createBackendApp(fixture.app.config, {
      disableMemoryRuntime: true,
      now: () => clock.now,
      modelPortFactory: () => model,
    });
    const immediate = restarted.conversation.getTask(
      fixture.roleId,
      first.taskId,
    );
    assert.equal(immediate.status, "active");
    await restarted.conversation.waitForIdle(fixture.roleId);
    const completed = restarted.conversation.getTask(
      fixture.roleId,
      first.taskId,
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.endReason, "回复完成");
    assert.equal(model.requests.length, 1, "中断续行应恢复为一次模型调用");

    const after = RoleStorage.openExisting(
      rolePaths(restarted.config.dataRoot, fixture.roleId),
    );
    try {
      const executions = after.business.db
        .prepare(
          "SELECT e.status, et.task_id, et.relation FROM executions e JOIN execution_tasks et USING(execution_id) ORDER BY e.rowid ASC",
        )
        .all() as Array<{
        status: string;
        task_id: string;
        relation: string;
      }>;
      assert.deepEqual(executions.map((row) => row.status), [
        "completed",
        "failed",
        "completed",
      ]);
      assert.ok(executions.every((row) => row.task_id === first.taskId));
      assert.deepEqual(executions.map((row) => row.relation), [
        "initiates",
        "continues",
        "continues",
      ]);
      const open = after.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM task_resource_continuations WHERE ended_at IS NULL",
        )
        .get() as { count: number };
      assert.equal(open.count, 0, "恢复完成终态后应释放资源延续");
    } finally {
      after.close();
    }

    // 再次重启保持完成态，不重放旧暂停也不新增执行。
    await restarted.close();
    restarted = undefined;
    const idle = new ScriptedChatModel([]);
    restartedAgain = createBackendApp(fixture.app.config, {
      disableMemoryRuntime: true,
      now: () => clock.now,
      modelPortFactory: () => idle,
    });
    const again = restartedAgain.conversation.getTask(
      fixture.roleId,
      first.taskId,
    );
    assert.equal(again.status, "completed");
    assert.equal(again.endReason, "回复完成");
    await restartedAgain.conversation.waitForIdle(fixture.roleId);
    assert.equal(idle.requests.length, 0, "已完结任务不应再次唤醒");
  } finally {
    await restarted?.close();
    await restartedAgain?.close();
    await fixture.close();
  }
});
