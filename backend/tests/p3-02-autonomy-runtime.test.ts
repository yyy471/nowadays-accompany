import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { rolePaths } from "../src/bootstrap/config.js";
import type {
  ModelEvent,
  ModelPort,
  ModelRequest,
} from "../src/domain/model.js";
import {
  ScriptedChatModel,
  addBinding,
  createFixtureWithModel,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";
import { ScriptedMemoryModel } from "../src/model/offline-memory.js";

interface Clock {
  value: Date;
}

function createAutonomyFixture(
  model: ModelPort,
  clock: Clock,
): Fixture {
  return createFixtureWithModel(model, {
    now: () => clock.value,
    timeZone: "Asia/Shanghai",
  });
}

function addWorkspaceMcp(fixture: Fixture): string {
  const workspace = rolePaths(
    fixture.app.config.dataRoot,
    fixture.roleId,
  ).workspaceDir;
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

function toolName(request: ModelRequest, fragment: string): string {
  const tool = request.tools.find((candidate) =>
    candidate.name.includes(fragment),
  );
  assert.ok(tool, `模型请求缺少工具 ${fragment}`);
  return tool.name;
}

function assistantMessage(
  fixture: Fixture,
  windowId: string,
): { messageId: string; content: string } {
  const messages = fixture.app.services.messages.list(
    fixture.roleId,
    windowId,
    0,
    100,
  );
  const message = messages.items
    .filter((item) => item.sender === "assistant")
    .at(-1);
  assert.ok(message);
  return { messageId: message.messageId, content: message.content };
}

test("an autonomous wake reads local material, shares to the main window and schedules the next wake", { timeout: 30_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    (request): ModelEvent[] => {
      assert.match(request.system, /自主活动/);
      assert.match(request.system, /整理书架上的旧地图/);
      assert.doesNotMatch(request.system, /当前执行在继续原任务/);
      assert.doesNotMatch(request.system, /本轮用户已发送的消息/);
      return [
        {
          type: "tool_call",
          callId: "wire-write",
          name: toolName(request, "workspace_write"),
          arguments: {
            path: "autonomy-note.md",
            content: "整理记录：旧地图在书架第二层。",
          },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request): ModelEvent[] => {
      assert.match(
        String(request.messages.filter((m) => m.role === "tool").at(-1)?.content),
        /autonomy-note\.md/,
      );
      return [
        {
          type: "tool_call",
          callId: "wire-read",
          name: toolName(request, "workspace_read"),
          arguments: { path: "autonomy-note.md" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request): ModelEvent[] => {
      assert.ok(
        request.tools.some((tool) => tool.name === "autonomy_share"),
        "自主执行应提供主动分享工具",
      );
      assert.match(
        String(request.messages.filter((m) => m.role === "tool").at(-1)?.content),
        /旧地图/,
      );
      return [
        {
          type: "tool_call",
          callId: "wire-share",
          name: "autonomy_share",
          arguments: { content: "我把书架上的旧地图找到了，等你回来一起看。" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request): ModelEvent[] => {
      assert.match(
        String(request.messages.filter((m) => m.role === "tool").at(-1)?.content),
        /messageId/,
      );
      return [
        {
          type: "tool_call",
          callId: "wire-next",
          name: "autonomy_schedule",
          arguments: {
            wakeAt: "2026-11-04T04:00:00.000Z",
            intent: "把旧地图的来历补进阅读笔记",
          },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request): ModelEvent[] => {
      assert.match(
        String(request.messages.filter((m) => m.role === "tool").at(-1)?.content),
        /wakeId/,
      );
      return [
        { type: "text_delta", text: "读完资料，把旧地图夹进了笔记。" },
        { type: "completed", stopReason: "stop" },
      ];
    },
  ]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    const workspace = addWorkspaceMcp(fixture);
    fs.writeFileSync(
      path.join(workspace, "note.md"),
      "旧地图在书架第二层。",
      "utf8",
    );
    const wake = fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-04T03:00:00.000Z",
      intent: "整理书架上的旧地图",
    });
    clock.value = new Date("2026-11-04T03:00:00.000Z");
    assert.equal(
      fixture.app.conversation.runDueAutonomy(fixture.roleId),
      true,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, 5);
    assert.equal(
      fs.readFileSync(path.join(workspace, "autonomy-note.md"), "utf8"),
      "整理记录：旧地图在书架第二层。",
    );
    const status = fixture.app.services.autonomy.getStatus(fixture.roleId);
    assert.equal(status.activities.length, 1);
    const activity = status.activities[0]!;
    assert.equal(activity.status, "completed");
    assert.equal(activity.summary, "读完资料，把旧地图夹进了笔记。");
    assert.ok(activity.sharedMessageId);

    const mainMessage = assistantMessage(fixture, fixture.windowId);
    assert.equal(mainMessage.content, "我把书架上的旧地图找到了，等你回来一起看。");
    assert.equal(activity.sharedMessageId, mainMessage.messageId);

    const windows = fixture.app.services.roles.listWindows(fixture.roleId);
    const autonomyWindow = windows.find(
      (window) => window.source === "nowadays-autonomy",
    );
    assert.ok(autonomyWindow);
    assert.equal(autonomyWindow.kind, "custom");
    assert.equal(
      assistantMessage(fixture, autonomyWindow.windowId).content,
      "读完资料，把旧地图夹进了笔记。",
    );

    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.origin, "autonomous");
    assert.equal(tasks[0]?.status, "completed");

    const wakes = fixture.app.services.autonomy.listWakes(fixture.roleId);
    assert.equal(wakes.length, 2);
    const original = wakes.find((item) => item.wakeId === wake.wakeId);
    assert.equal(original?.status, "completed");
    const next = wakes.find((item) => item.wakeId !== wake.wakeId);
    assert.equal(next?.status, "pending");
    assert.equal(next?.scheduledAt, "2026-11-04T04:00:00.000Z");
    assert.equal(next?.intent, "把旧地图的来历补进阅读笔记");

    const stored = withStorage(fixture, (storage) => {
      const execution = storage.business.db
        .prepare(
          "SELECT execution_id, trigger_type, status FROM executions WHERE role_id = ?",
        )
        .get(fixture.roleId) as {
        execution_id: string;
        trigger_type: string;
        status: string;
      };
      const metering = storage.business.db
        .prepare(
          `SELECT call_kind, purpose, counted FROM call_metering
            WHERE execution_id = ? ORDER BY call_kind ASC`,
        )
        .all(execution.execution_id) as Array<{
        call_kind: string;
        purpose: string;
        counted: number;
      }>;
      const evidence = storage.business.db
        .prepare(
          "SELECT source_id FROM evidence_records WHERE role_id = ? ORDER BY role_sequence ASC",
        )
        .all(fixture.roleId) as Array<{ source_id: string }>;
      return { execution, metering, evidence };
    });
    assert.equal(stored.execution.trigger_type, "autonomous");
    assert.equal(stored.execution.status, "completed");
    assert.equal(
      stored.metering.filter((row) => row.call_kind === "model").length,
      5,
    );
    assert.equal(
      stored.metering.filter((row) => row.call_kind === "tool").length,
      4,
    );
    assert.ok(
      stored.metering.every(
        (row) => row.purpose === "autonomous" && row.counted === 1,
      ),
    );
    assert.ok(
      stored.evidence.some((row) => row.source_id === mainMessage.messageId),
    );
  } finally {
    await fixture.close();
  }
});

test("unlimited autonomy records calls without counting points and never pauses", { timeout: 20_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    (request): ModelEvent[] => {
      assert.ok(
        request.tools.some((tool) => tool.name === "memory_search"),
      );
      return [
        {
          type: "tool_call",
          callId: "wire-memory",
          name: "memory_search",
          arguments: { query: "旧地图", limit: 3 },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (): ModelEvent[] => [
      { type: "text_delta", text: "今天先想到这里。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 1,
      unlimited: true,
    });
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-04T03:00:00.000Z",
      intent: "回想旧地图的事",
    });
    clock.value = new Date("2026-11-04T03:00:00.000Z");
    assert.equal(
      fixture.app.conversation.runDueAutonomy(fixture.roleId),
      true,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const status = fixture.app.services.autonomy.getStatus(fixture.roleId);
    assert.equal(status.budget.unlimited, true);
    assert.equal(status.budget.usedPoints, 0);
    assert.equal(status.paused, false);
    assert.equal(status.activities[0]?.status, "completed");
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT call_kind, counted FROM call_metering")
        .all(),
    ) as Array<{ call_kind: string; counted: number }>;
    assert.equal(metering.length, 3);
    assert.ok(metering.every((row) => row.counted === 0));
  } finally {
    await fixture.close();
  }
});

test("autonomous skill tool calls consume points and write metering", { timeout: 20_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const skillRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "nowadays-p3-skill-"),
  );
  fs.mkdirSync(path.join(skillRoot, "reading"), { recursive: true });
  fs.writeFileSync(
    path.join(skillRoot, "reading", "SKILL.md"),
    [
      "---",
      "name: reading",
      "description: 整理阅读笔记",
      "---",
      "",
      "先记录书名，再写一句感受。",
      "",
    ].join("\n"),
    "utf8",
  );
  const model = new ScriptedChatModel([
    (request): ModelEvent[] => {
      assert.ok(
        request.tools.some((tool) => tool.name === "skill_read"),
        "自主执行应提供已启用 Skill",
      );
      return [
        {
          type: "tool_call",
          callId: "wire-skill",
          name: "skill_read",
          arguments: { skill: "reading" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (): ModelEvent[] => [
      { type: "text_delta", text: "按 Skill 写好了阅读笔记。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    const skill = fixture.app.services.resources.create({
      kind: "skill",
      name: "reading",
      config: { sourcePath: skillRoot },
    });
    addBinding(fixture, "skill", skill.resourceId);
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-04T03:00:00.000Z",
      intent: "用阅读 Skill 整理笔记",
    });
    clock.value = new Date("2026-11-04T03:00:00.000Z");
    assert.equal(
      fixture.app.conversation.runDueAutonomy(fixture.roleId),
      true,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const status = fixture.app.services.autonomy.getStatus(fixture.roleId);
    assert.equal(status.activities[0]?.status, "completed");
    assert.equal(status.budget.usedPoints, 3);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT call_kind, purpose, counted FROM call_metering ORDER BY call_kind ASC",
        )
        .all(),
    ) as Array<{ call_kind: string; purpose: string; counted: number }>;
    assert.equal(metering.length, 3);
    assert.equal(
      metering.filter((row) => row.call_kind === "tool").length,
      1,
    );
    assert.ok(
      metering.every(
        (row) => row.purpose === "autonomous" && row.counted === 1,
      ),
    );
  } finally {
    await fixture.close();
    fs.rmSync(skillRoot, { recursive: true, force: true });
  }
});

test("autonomous activity messages enter the memory evidence pipeline", { timeout: 20_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    [
      { type: "text_delta", text: "今天把旧地图收进了抽屉。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const fixture = createFixtureWithModel(model, {
    now: () => clock.value,
    timeZone: "Asia/Shanghai",
    disableMemoryRuntime: false,
    memoryModelFactory: () =>
      new ScriptedMemoryModel([{ operations: [] }]),
  });
  try {
    const modelResource = fixture.app.services.resources.list("model")[0];
    assert.ok(modelResource);
    addBinding(fixture, "memory_model", modelResource.resourceId);
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-04T03:00:00.000Z",
      intent: "整理旧地图",
    });
    clock.value = new Date("2026-11-04T03:00:00.000Z");
    assert.equal(
      fixture.app.conversation.runDueAutonomy(fixture.roleId),
      true,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    await fixture.app.conversation.runMemoryPending(fixture.roleId);

    const evidence = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT er.source_kind, ep.status
             FROM evidence_records er
             LEFT JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
            WHERE er.role_id = ? ORDER BY er.role_sequence ASC`,
        )
        .all(fixture.roleId),
    ) as Array<{ source_kind: string; status: string | null }>;
    assert.ok(evidence.length >= 1);
    assert.ok(
      evidence.every(
        (row) => row.source_kind === "message" && row.status === "processed",
      ),
    );
    const batch = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT status FROM memory_batches WHERE role_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(fixture.roleId),
    ) as { status: string } | undefined;
    assert.equal(batch?.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("budget exhaustion pauses the activity and leaves the unexecuted tool request pending", { timeout: 30_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    (request): ModelEvent[] => [
      {
        type: "tool_call",
        callId: "wire-read",
        name: toolName(request, "workspace_read"),
        arguments: { path: "note.md" },
      },
      { type: "completed", stopReason: "tool_calls" },
    ],
    (request): ModelEvent[] => {
      assert.match(request.system, /额度恢复或中断后继续/);
      assert.match(request.system, /当前执行在继续原任务/);
      return [
        {
          type: "tool_call",
          callId: "wire-read-again",
          name: toolName(request, "workspace_read"),
          arguments: { path: "note.md" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (): ModelEvent[] => [
      { type: "text_delta", text: "恢复当天完成了阅读。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    const workspace = addWorkspaceMcp(fixture);
    fs.writeFileSync(
      path.join(workspace, "note.md"),
      "旧地图在书架第二层。",
      "utf8",
    );
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 1,
      unlimited: false,
    });
    const wake = fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-04T03:00:00.000Z",
      intent: "整理书架上的旧地图",
    });
    clock.value = new Date("2026-11-04T03:00:00.000Z");
    assert.equal(
      fixture.app.conversation.runDueAutonomy(fixture.roleId),
      true,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, 1);
    const status = fixture.app.services.autonomy.getStatus(fixture.roleId);
    assert.equal(status.budget.usedPoints, 1);
    assert.equal(status.activities.length, 1);
    assert.equal(status.activities[0]?.status, "paused");
    const pausedTask = fixture.app.conversation
      .listTasks(fixture.roleId)
      .at(0);
    assert.equal(pausedTask?.status, "paused");
    assert.equal(pausedTask?.endReason, "AUTONOMY_BUDGET_EXHAUSTED");
    const wakes = fixture.app.services.autonomy.listWakes(fixture.roleId);
    const original = wakes.find((item) => item.wakeId === wake.wakeId);
    assert.equal(original?.status, "completed");
    assert.equal(original?.lastErrorCode, "AUTONOMY_BUDGET_EXHAUSTED");
    const resume = wakes.find((item) => item.kind === "budget_resume");
    assert.equal(resume?.status, "pending");
    assert.equal(resume?.taskId, pausedTask?.taskId);
    assert.equal(resume?.scheduledAt, "2026-11-04T16:00:00.000Z");

    const stored = withStorage(fixture, (storage) => {
      const execution = storage.business.db
        .prepare(
          "SELECT execution_id, status FROM executions WHERE role_id = ?",
        )
        .get(fixture.roleId) as { execution_id: string; status: string };
      const pending = storage.business.db
        .prepare(
          "SELECT tool_name, status, started_at FROM tool_calls WHERE execution_id = ?",
        )
        .all(execution.execution_id) as Array<{
        tool_name: string;
        status: string;
        started_at: string | null;
      }>;
      return { execution, pending };
    });
    assert.equal(stored.execution.status, "paused");
    assert.equal(stored.pending.length, 1);
    assert.match(stored.pending[0]?.tool_name ?? "", /workspace_read/);
    assert.equal(stored.pending[0]?.status, "pending");
    assert.equal(stored.pending[0]?.started_at, null);
    assert.equal(
      fixture.app.services.messages.list(
        fixture.roleId,
        fixture.windowId,
        0,
        100,
      ).items.length,
      0,
    );

    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 5,
      unlimited: false,
    });
    clock.value = new Date("2026-11-04T16:00:00.000Z");
    assert.equal(
      fixture.app.conversation.runDueAutonomy(fixture.roleId),
      true,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const resumedStatus =
      fixture.app.services.autonomy.getStatus(fixture.roleId);
    assert.equal(resumedStatus.budget.localDate, "2026-11-05");
    assert.equal(resumedStatus.budget.usedPoints, 3);
    assert.equal(resumedStatus.activities.length, 2);
    assert.equal(resumedStatus.activities[0]?.status, "completed");
    assert.equal(
      resumedStatus.activities[0]?.summary,
      "恢复当天完成了阅读。",
    );
    const completedTask = fixture.app.conversation
      .listTasks(fixture.roleId)
      .at(0);
    assert.equal(completedTask?.status, "completed");
    const resumedWakes = fixture.app.services.autonomy.listWakes(
      fixture.roleId,
    );
    assert.equal(
      resumedWakes.find((item) => item.kind === "budget_resume")?.status,
      "completed",
    );
    const relation = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT et.relation FROM execution_tasks et
             JOIN executions e ON e.execution_id = et.execution_id
            WHERE e.execution_id = (
              SELECT execution_id FROM executions
               WHERE role_id = ? AND status = 'completed'
               ORDER BY created_at DESC LIMIT 1
            )`,
        )
        .get(fixture.roleId),
    ) as { relation: string };
    assert.equal(relation.relation, "continues");
  } finally {
    await fixture.close();
  }
});

test("user conversations can schedule later autonomy without spending autonomy points", { timeout: 20_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    (request): ModelEvent[] => {
      assert.ok(
        request.tools.some((tool) => tool.name === "autonomy_schedule"),
      );
      assert.ok(
        !request.tools.some((tool) => tool.name === "autonomy_share"),
        "普通对话不应提供主动分享工具",
      );
      return [
        {
          type: "tool_call",
          callId: "wire-schedule",
          name: "autonomy_schedule",
          arguments: {
            wakeAt: "2026-11-04T05:00:00.000Z",
            intent: "晚点整理今天聊到的旅行计划",
          },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (): ModelEvent[] => [
      { type: "text_delta", text: "好，我晚点自己整理一下。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "我们晚点再整理旅行计划吧。",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const wakes = fixture.app.services.autonomy.listWakes(fixture.roleId);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.scheduledAt, "2026-11-04T05:00:00.000Z");
    assert.equal(wakes[0]?.intent, "晚点整理今天聊到的旅行计划");
    assert.ok(wakes[0]?.sourceExecutionId);
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    assert.equal(budget.usedPoints, 0);
    const stored = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT purpose, counted FROM call_metering")
        .all(),
    ) as Array<{ purpose: string; counted: number }>;
    assert.ok(
      stored.every((row) => row.purpose === "user_chat" && row.counted === 0),
    );
  } finally {
    await fixture.close();
  }
});
