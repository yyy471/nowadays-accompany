import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { rolePaths } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelRequest } from "../src/domain/model.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import {
  ScriptedChatModel,
  addBinding,
  createFixtureWithModel,
  disableResourceDirect,
  updateResourceConfigDirect,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

interface Clock {
  value: Date;
}

function createAutonomyFixture(model: ScriptedChatModel, clock: Clock): Fixture {
  return createFixtureWithModel(model, {
    now: () => clock.value,
    timeZone: "Asia/Shanghai",
  });
}

function addWorkspaceMcp(fixture: Fixture): {
  resourceId: string;
  workspace: string;
} {
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
  return { resourceId: mcp.resourceId, workspace };
}

async function startScheduled(
  fixture: Fixture,
  clock: Clock,
  intent: string,
) {
  const wake = startScheduledNoWait(fixture, clock, intent);
  await fixture.app.conversation.waitForIdle(fixture.roleId);
  return wake;
}

function startScheduledNoWait(
  fixture: Fixture,
  clock: Clock,
  intent: string,
) {
  const wake = fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
    wakeAt: "2026-11-04T03:00:00.000Z",
    intent,
  });
  clock.value = new Date("2026-11-04T03:00:00.000Z");
  assert.equal(fixture.app.conversation.runDueAutonomy(fixture.roleId), true);
  return wake;
}

function done(text: string): ModelEvent[] {
  return [
    { type: "text_delta", text },
    { type: "completed", stopReason: "stop" },
  ];
}

function toolCall(name: string, args: unknown): ModelEvent[] {
  return [
    { type: "tool_call", callId: `wire-${name}`, name, arguments: args },
    { type: "completed", stopReason: "tool_calls" },
  ];
}

function toolNameOf(request: ModelRequest, fragment: string): string {
  const tool = request.tools.find((item) => item.name.includes(fragment));
  assert.ok(tool, `模型请求缺少工具 ${fragment}`);
  return tool.name;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      return;
    }
    await delay(20);
  }
  throw new Error(`WAIT_FILE_TIMEOUT:${file}`);
}

const mcpServerModule = pathToFileURL(
  path.resolve(
    "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js",
  ),
).href;
const mcpStdioModule = pathToFileURL(
  path.resolve(
    "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js",
  ),
).href;

function addMcpScript(
  fixture: Fixture,
  name: string,
  body: readonly string[],
): { resourceId: string; workspace: string } {
  const workspace = rolePaths(
    fixture.app.config.dataRoot,
    fixture.roleId,
  ).workspaceDir;
  const script = path.join(workspace, `${name}.mjs`);
  fs.writeFileSync(script, body.join("\n"));
  const resource = fixture.app.services.resources.create({
    kind: "mcp",
    name,
    config: { command: process.execPath, args: [script], env: {} },
  });
  addBinding(fixture, "mcp", resource.resourceId);
  return { resourceId: resource.resourceId, workspace };
}

function addGatedMcp(
  fixture: Fixture,
  name: string,
  toolName: string,
): { resourceId: string; workspace: string } {
  return addMcpScript(fixture, name, [
    "import fs from 'node:fs';",
    `import {McpServer} from ${JSON.stringify(mcpServerModule)};`,
    `import {StdioServerTransport} from ${JSON.stringify(mcpStdioModule)};`,
    "const launches = fs.existsSync('launches') ? Number(fs.readFileSync('launches', 'utf8')) + 1 : 1;",
    "fs.writeFileSync('launches', String(launches));",
    "if (launches > 1) {",
    "  fs.writeFileSync('connecting', '');",
    "  const deadline = Date.now() + 7000;",
    "  while (!fs.existsSync('release') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));",
    "}",
    `const server = new McpServer({name: ${JSON.stringify(name)}, version: '1'});`,
    `server.registerTool(${JSON.stringify(toolName)}, {inputSchema: {}}, async () => {`,
    "  fs.writeFileSync('dispatched', '');",
    "  return {content: [{type: 'text', text: 'saved'}]};",
    "});",
    "await server.connect(new StdioServerTransport());",
  ]);
}

function writeToolName(request: ModelRequest): string | null {
  return (
    request.tools.find((item) => item.name.includes("workspace_write"))?.name ??
    null
  );
}

test("the last model point pauses before diary and sharing tools execute", { timeout: 20_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    [
      {
        type: "tool_call",
        callId: "wire-diary",
        name: "diary_write",
        arguments: { content: "额度耗尽后仍然写出了这篇日记。" },
      },
      {
        type: "tool_call",
        callId: "wire-share",
        name: "autonomy_share",
        arguments: { content: "额度耗尽后仍向主窗口分享。" },
      },
      { type: "completed", stopReason: "tool_calls" },
    ],
  ]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 1,
      unlimited: false,
    });
    const started = await startScheduled(
      fixture,
      clock,
      "写一篇自主日记并分享",
    );

    assert.equal(
      fixture.app.services.memory.listDiaries(fixture.roleId).length,
      0,
    );
    assert.equal(
      fixture.app.services.messages.list(
        fixture.roleId,
        fixture.windowId,
        0,
        20,
      ).items.length,
      0,
    );
    const status = fixture.app.services.autonomy.getStatus(fixture.roleId);
    assert.equal(status.budget.usedPoints, 1);
    assert.equal(status.paused, true);
    assert.equal(status.activities[0]?.status, "paused");
    assert.equal(
      fixture.app.conversation.listTasks(fixture.roleId)[0]?.status,
      "paused",
    );
    assert.equal(
      fixture.app.services.autonomy
        .listWakes(fixture.roleId)
        .find((wake) => wake.wakeId === started.wakeId)?.lastErrorCode,
      "AUTONOMY_BUDGET_EXHAUSTED",
    );
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT call_kind, purpose, counted FROM call_metering")
        .all(),
    ) as Array<{ call_kind: string; purpose: string; counted: number }>;
    assert.deepEqual(metering, [
      { call_kind: "model", purpose: "autonomous", counted: 1 },
    ]);
    assert.equal(model.requests.length, 1);
  } finally {
    await fixture.close();
  }
});

test("a multi-tool request keeps executed results and pauses before the next tool", { timeout: 20_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    [
      {
        type: "tool_call",
        callId: "wire-diary",
        name: "diary_write",
        arguments: { content: "用最后一个点写下的日记。" },
      },
      {
        type: "tool_call",
        callId: "wire-share",
        name: "autonomy_share",
        arguments: { content: "余额边界之后不应分享。" },
      },
      { type: "completed", stopReason: "tool_calls" },
    ],
  ]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 2,
      unlimited: false,
    });
    await startScheduled(fixture, clock, "先写日记再分享");

    const diaries = fixture.app.services.memory.listDiaries(fixture.roleId);
    assert.equal(diaries.length, 1);
    assert.match(
      fixture.app.services.memory.getDiary(
        fixture.roleId,
        diaries[0]!.diaryId,
      ).content,
      /最后一个点/,
    );
    assert.equal(
      fixture.app.services.messages.list(
        fixture.roleId,
        fixture.windowId,
        0,
        20,
      ).items.length,
      0,
    );
    const status = fixture.app.services.autonomy.getStatus(fixture.roleId);
    assert.equal(status.budget.usedPoints, 2);
    assert.equal(status.paused, true);
    assert.equal(status.activities[0]?.status, "paused");
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT call_kind, counted FROM call_metering ORDER BY rowid ASC",
        )
        .all(),
    ) as Array<{ call_kind: string; counted: number }>;
    assert.deepEqual(metering, [
      { call_kind: "model", counted: 1 },
      { call_kind: "tool", counted: 1 },
    ]);
  } finally {
    await fixture.close();
  }
});

test("an offset ISO wake fires at its actual instant and stores canonical UTC", { timeout: 20_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([done("按实际时间到点醒来。")]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    const wake = fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-04T11:00:01+08:00",
      intent: "带时区的合法安排",
    });
    assert.equal(wake.scheduledAt, "2026-11-04T03:00:01.000Z");
    clock.value = new Date("2026-11-04T03:00:02.000Z");
    assert.equal(fixture.app.conversation.runDueAutonomy(fixture.roleId), true);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 1);
    const stored = fixture.app.services.autonomy
      .listWakes(fixture.roleId)
      .find((item) => item.wakeId === wake.wakeId);
    assert.equal(stored?.status, "completed");
    const activity = fixture.app.services.autonomy.listActivities(
      fixture.roleId,
    )[0];
    assert.equal(activity?.status, "completed");
    assert.equal(activity?.summary, "按实际时间到点醒来。");
  } finally {
    await fixture.close();
  }
});

for (const disabled of ["model", "mcp"] as const) {
  test(`a budget resume keeps the original task chain when the ${disabled} resource was disabled`, { timeout: 30_000 }, async () => {
    let toolOfferedAfterResume = false;
    const model = new ScriptedChatModel([
      (request: ModelRequest): ModelEvent[] => {
        const name = writeToolName(request);
        assert.ok(name, "首次执行应提供工作空间写入工具");
        return toolCall(name, {
          path: "resume.md",
          content: "原任务最终成果",
        });
      },
      (request: ModelRequest): ModelEvent[] => {
        const name = writeToolName(request);
        toolOfferedAfterResume = name !== null;
        return name === null
          ? done("原资源已丢失")
          : toolCall(name, {
              path: "resume.md",
              content: "原任务最终成果",
            });
      },
      done("原任务完成"),
    ]);
    const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
    const fixture = createAutonomyFixture(model, clock);
    try {
      const mcp = addWorkspaceMcp(fixture);
      fixture.app.services.autonomy.setBudget(fixture.roleId, {
        dailyLimit: 1,
        unlimited: false,
      });
      await startScheduled(fixture, clock, "继续完成原任务");
      const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
      assert.ok(task);
      assert.equal(task.status, "paused");

      const chatBinding = fixture.app.services.resources
        .listBindings(fixture.roleId)
        .find((item) => item.capability === "chat_model");
      assert.ok(chatBinding);
      // 236 §8：角色开启时全局关闭会被 API 拒绝，这里模拟资源被外部关闭。
      disableResourceDirect(
        fixture,
        disabled === "mcp" ? mcp.resourceId : chatBinding.resourceId,
      );
      fixture.app.services.autonomy.setBudget(fixture.roleId, {
        dailyLimit: 10,
        unlimited: false,
      });
      clock.value = new Date("2026-11-05T00:00:01.000Z");
      assert.equal(
        fixture.app.conversation.runDueAutonomy(fixture.roleId),
        true,
      );
      await fixture.app.conversation.waitForIdle(fixture.roleId);

      assert.equal(toolOfferedAfterResume, true);
      assert.equal(
        fs.readFileSync(path.join(mcp.workspace, "resume.md"), "utf8"),
        "原任务最终成果",
      );
      const resumedTask = fixture.app.conversation.getTask(
        fixture.roleId,
        task.taskId,
      );
      assert.equal(resumedTask.status, "completed");
      assert.equal(model.requests.length, 3);
      const activities = fixture.app.services.autonomy.listActivities(
        fixture.roleId,
      );
      assert.deepEqual(
        activities.map((activity) => activity.status),
        ["completed", "paused"],
      );
    } finally {
      await fixture.close();
    }
  });
}

test("ending a paused autonomous task cancels its resume wake without replacement work", { timeout: 20_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    toolCall("memory_search", { query: "原任务目标" }),
    toolCall("diary_write", { content: "已结束任务不应继续写日记。" }),
    done("不应执行到这里"),
  ]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 1,
      unlimited: false,
    });
    await startScheduled(fixture, clock, "执行原任务");
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
    assert.ok(task);
    fixture.app.conversation.finishTask({
      roleId: fixture.roleId,
      taskId: task.taskId,
      status: "completed",
      endReason: "用户明确结束原任务",
    });
    const callsBefore = model.requests.length;
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: false,
    });
    clock.value = new Date("2026-11-05T00:00:01.000Z");
    assert.equal(
      fixture.app.conversation.runDueAutonomy(fixture.roleId),
      false,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, callsBefore);
    assert.equal(
      fixture.app.services.memory.listDiaries(fixture.roleId).length,
      0,
    );
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
    const resume = fixture.app.services.autonomy
      .listWakes(fixture.roleId)
      .find((wake) => wake.kind === "budget_resume");
    assert.equal(resume?.status, "cancelled");
    assert.equal(resume?.lastErrorCode, "TASK_ENDED");
    assert.equal(
      withStorage(
        fixture,
        (storage) =>
          (
            storage.business.db
              .prepare("SELECT COUNT(*) AS count FROM executions")
              .get() as { count: number }
          ).count,
      ),
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("autonomous completion keeps the conversation round unchanged until a user reply", { timeout: 20_000 }, async () => {
  const model = new ScriptedChatModel([
    done("这只是自主活动，没有收到用户消息。"),
    done("收到你的消息了。"),
  ]);
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const fixture = createAutonomyFixture(model, clock);
  try {
    const roundOf = (): number =>
      withStorage(fixture, (storage) =>
        new MemoryStore(storage.business.db).getCurrentRound(fixture.roleId),
      );
    assert.equal(roundOf(), 0);
    await startScheduled(fixture, clock, "自主整理记忆");
    assert.equal(roundOf(), 0);
    const autonomous = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT trigger_type, decision_round FROM executions ORDER BY rowid ASC LIMIT 1",
        )
        .get(),
    ) as { trigger_type: string; decision_round: number | null };
    assert.equal(autonomous.trigger_type, "autonomous");
    assert.equal(autonomous.decision_round, null);
    assert.equal(
      withStorage(
        fixture,
        (storage) =>
          (
            storage.business.db
              .prepare(
                "SELECT COUNT(*) AS count FROM messages WHERE sender = 'user'",
              )
              .get() as { count: number }
          ).count,
      ),
      0,
    );

    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "我回来了。",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(roundOf(), 1);
    const userExecution = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT trigger_type, decision_round FROM executions ORDER BY rowid DESC LIMIT 1",
        )
        .get(),
    ) as { trigger_type: string; decision_round: number | null };
    assert.equal(userExecution.trigger_type, "user_message");
    assert.equal(userExecution.decision_round, 1);
  } finally {
    await fixture.close();
  }
});

test("status clears paused after a resumed task and its latest activity complete", { timeout: 20_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    toolCall("memory_search", { query: "待续目标" }),
    done("恢复后任务完成"),
  ]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 1,
      unlimited: false,
    });
    await startScheduled(fixture, clock, "暂停后恢复的任务");
    const paused = fixture.app.services.autonomy.getStatus(fixture.roleId);
    assert.equal(paused.paused, true);
    assert.deepEqual(
      paused.activities.map((activity) => activity.status),
      ["paused"],
    );

    clock.value = new Date("2026-11-05T00:00:01.000Z");
    assert.equal(fixture.app.conversation.runDueAutonomy(fixture.roleId), true);
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.ok(tasks.length > 0);
    assert.ok(tasks.every((task) => task.status === "completed"));
    const status = fixture.app.services.autonomy.getStatus(fixture.roleId);
    assert.equal(status.paused, false);
    assert.deepEqual(
      status.activities.map((activity) => activity.status),
      ["completed", "paused"],
    );
    assert.equal(status.nextWake, null);
    assert.equal(status.budget.usedPoints, 1);
  } finally {
    await fixture.close();
  }
});

test("a stateful MCP session survives a budget pause until the task ends", { timeout: 30_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    (request: ModelRequest): ModelEvent[] =>
      toolCall(toolNameOf(request, "advance"), {}),
    (request: ModelRequest): ModelEvent[] =>
      toolCall(toolNameOf(request, "advance"), {}),
    done("同一任务的两步操作完成"),
  ]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    addMcpScript(fixture, "counter", [
      `import {McpServer} from ${JSON.stringify(mcpServerModule)};`,
      `import {StdioServerTransport} from ${JSON.stringify(mcpStdioModule)};`,
      "const server = new McpServer({name: 'task-counter', version: '1'});",
      "let count = 0;",
      "server.registerTool('advance', {inputSchema: {}}, async () => ({content: [{type: 'text', text: String(++count)}]}));",
      "await server.connect(new StdioServerTransport());",
    ]);
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 2,
      unlimited: false,
    });
    await startScheduled(fixture, clock, "在同一服务会话里 advance 两次");
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
    assert.ok(task);
    assert.equal(task.status, "paused");

    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: false,
    });
    clock.value = new Date("2026-11-05T00:00:01.000Z");
    assert.equal(fixture.app.conversation.runDueAutonomy(fixture.roleId), true);
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const values = withStorage(fixture, (storage) =>
      (
        storage.business.db
          .prepare(
            `SELECT r.adapted_result_json
               FROM tool_results r
               JOIN tool_calls c ON c.tool_call_id = r.tool_call_id
              ORDER BY c.rowid`,
          )
          .all() as Array<{ adapted_result_json: string }>
      ).map((row) => JSON.parse(row.adapted_result_json)),
    );
    assert.deepEqual(values, ["1", "2"]);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
    const continuations = withStorage(fixture, (storage) =>
      storage.business.listResourceContinuations(fixture.roleId, task.taskId),
    );
    assert.ok(continuations.every((item) => item.endedAt !== null));
    assert.equal(
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      3,
    );
  } finally {
    await fixture.close();
  }
});

test("ending a task during MCP connect cancels the reserved tool point", { timeout: 30_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    (request: ModelRequest): ModelEvent[] =>
      toolCall(toolNameOf(request, "write_result"), {}),
  ]);
  const fixture = createAutonomyFixture(model, clock);
  let releasePath = "";
  try {
    const mcp = addMcpScript(fixture, "gated-connect", [
      "import fs from 'node:fs';",
      `import {McpServer} from ${JSON.stringify(mcpServerModule)};`,
      `import {StdioServerTransport} from ${JSON.stringify(mcpStdioModule)};`,
      "const launches = fs.existsSync('launches') ? Number(fs.readFileSync('launches', 'utf8')) + 1 : 1;",
      "fs.writeFileSync('launches', String(launches));",
      "if (launches > 1) {",
      "  fs.writeFileSync('connecting', '');",
      "  const deadline = Date.now() + 7000;",
      "  while (!fs.existsSync('release') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));",
      "}",
      "const server = new McpServer({name: 'gated', version: '1'});",
      "server.registerTool('write_result', {inputSchema: {}}, async () => {",
      "  fs.writeFileSync('dispatched', '');",
      "  return {content: [{type: 'text', text: 'saved'}]};",
      "});",
      "await server.connect(new StdioServerTransport());",
    ]);
    releasePath = path.join(mcp.workspace, "release");
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: false,
    });
    startScheduledNoWait(fixture, clock, "执行一个实际工具");
    await waitForFile(path.join(mcp.workspace, "connecting"));
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
    assert.ok(task);
    fixture.app.conversation.finishTask({
      roleId: fixture.roleId,
      taskId: task.taskId,
      status: "completed",
      endReason: "建连期间结束，尚未发送工具请求",
    });
    fs.writeFileSync(releasePath, "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(fs.existsSync(path.join(mcp.workspace, "dispatched")), false);
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT call_kind, counted FROM call_metering ORDER BY rowid")
        .all(),
    ) as Array<{ call_kind: string; counted: number }>;
    assert.equal(budget.usedPoints, 1);
    assert.deepEqual(metering, [{ call_kind: "model", counted: 1 }]);
    const results = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT status, diagnostic_code FROM tool_results ORDER BY rowid",
        )
        .all(),
    ) as Array<{ status: string; diagnostic_code: string | null }>;
    assert.deepEqual(results, [
      { status: "failed", diagnostic_code: "TASK_ENDED" },
    ]);
  } finally {
    if (releasePath.length > 0) {
      fs.writeFileSync(releasePath, "");
    }
    await fixture.close();
  }
});

test("an MCP connection failure releases the reserved tool point", { timeout: 30_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  let breakConfig: (() => void) | null = null;
  const model = new ScriptedChatModel([
    (request: ModelRequest): ModelEvent[] => {
      breakConfig?.();
      return toolCall(toolNameOf(request, "workspace_write"), {
        path: "unused.md",
        content: "不应写出",
      });
    },
    done("连接失败后正常收尾"),
  ]);
  const fixture = createAutonomyFixture(model, clock);
  try {
    const mcp = addWorkspaceMcp(fixture);
    breakConfig = () => {
      // 运行中改 MCP 会被 236 §8 拒绝；这里模拟外部故障（命令被卸载）。
      updateResourceConfigDirect(fixture, mcp.resourceId, {
        command: "nowadays-nonexistent-mcp-command",
        args: [],
        env: {},
      });
    };
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: false,
    });
    await startScheduled(fixture, clock, "调用一个连接会失败的工具");
    assert.equal(fs.existsSync(path.join(mcp.workspace, "unused.md")), false);
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    assert.equal(budget.usedPoints, 2);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT call_kind, counted FROM call_metering ORDER BY rowid")
        .all(),
    ) as Array<{ call_kind: string; counted: number }>;
    assert.deepEqual(metering, [
      { call_kind: "model", counted: 1 },
      { call_kind: "model", counted: 1 },
    ]);
    const results = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT status FROM tool_results ORDER BY rowid",
        )
        .all(),
    ) as Array<{ status: string }>;
    assert.equal(results.length, 1);
    assert.notEqual(results[0]?.status, "success");
  } finally {
    await fixture.close();
  }
});

for (const late of ["success", "failure"] as const) {
  test(`a dispatched MCP call keeps its point and late ${late} result`, { timeout: 30_000 }, async () => {
    const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
    const model = new ScriptedChatModel([
      (request: ModelRequest): ModelEvent[] =>
        toolCall(toolNameOf(request, "write_late"), {}),
    ]);
    const fixture = createAutonomyFixture(model, clock);
    let releasePath = "";
    try {
      const mcp = addMcpScript(fixture, "late-call", [
        "import fs from 'node:fs';",
        `import {McpServer} from ${JSON.stringify(mcpServerModule)};`,
        `import {StdioServerTransport} from ${JSON.stringify(mcpStdioModule)};`,
        "const server = new McpServer({name: 'late', version: '1'});",
        "server.registerTool('write_late', {inputSchema: {}}, async () => {",
        "  fs.writeFileSync('dispatched', '');",
        "  const deadline = Date.now() + 7000;",
        "  while (!fs.existsSync('release') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));",
        late === "success"
          ? "  return {content: [{type: 'text', text: 'late-ok'}]};"
          : "  return {isError: true, content: [{type: 'text', text: 'late-fail'}]};",
        "});",
        "await server.connect(new StdioServerTransport());",
      ]);
      releasePath = path.join(mcp.workspace, "release");
      fixture.app.services.autonomy.setBudget(fixture.roleId, {
        dailyLimit: 10,
        unlimited: false,
      });
      startScheduledNoWait(fixture, clock, "派发后等待结果");
      await waitForFile(path.join(mcp.workspace, "dispatched"));
      const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
      assert.ok(task);
      fixture.app.conversation.finishTask({
        roleId: fixture.roleId,
        taskId: task.taskId,
        status: "completed",
        endReason: "工具已派发后结束任务",
      });
      fs.writeFileSync(releasePath, "");
      await fixture.app.conversation.waitForIdle(fixture.roleId);

      const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
      assert.equal(budget.usedPoints, 2);
      const metering = withStorage(fixture, (storage) =>
        storage.business.db
          .prepare(
            "SELECT call_kind, counted FROM call_metering ORDER BY rowid",
          )
          .all(),
      ) as Array<{ call_kind: string; counted: number }>;
      assert.deepEqual(metering, [
        { call_kind: "model", counted: 1 },
        { call_kind: "tool", counted: 1 },
      ]);
      const results = withStorage(fixture, (storage) =>
        storage.business.db
          .prepare(
            "SELECT status, diagnostic_code FROM tool_results ORDER BY rowid",
          )
          .all(),
      ) as Array<{ status: string; diagnostic_code: string | null }>;
      assert.deepEqual(results, [
        late === "success"
          ? { status: "success", diagnostic_code: null }
          : { status: "failed", diagnostic_code: "MCP_TOOL_ERROR" },
      ]);
      const tasks = fixture.app.conversation.listTasks(fixture.roleId);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.status, "completed");
    } finally {
      if (releasePath.length > 0) {
        fs.writeFileSync(releasePath, "");
      }
      await fixture.close();
    }
  });
}

test("a user message during MCP connect cancels the autonomy tool reservation", { timeout: 30_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    (request: ModelRequest): ModelEvent[] =>
      toolCall(toolNameOf(request, "write_result"), {}),
    done("先回你：我在。"),
    done("接着完成原任务。"),
  ]);
  const fixture = createAutonomyFixture(model, clock);
  let releasePath = "";
  try {
    const mcp = addMcpScript(fixture, "gated-supersede", [
      "import fs from 'node:fs';",
      `import {McpServer} from ${JSON.stringify(mcpServerModule)};`,
      `import {StdioServerTransport} from ${JSON.stringify(mcpStdioModule)};`,
      "const launches = fs.existsSync('launches') ? Number(fs.readFileSync('launches', 'utf8')) + 1 : 1;",
      "fs.writeFileSync('launches', String(launches));",
      "if (launches > 1) {",
      "  fs.writeFileSync('connecting', '');",
      "  const deadline = Date.now() + 7000;",
      "  while (!fs.existsSync('release') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));",
      "}",
      "const server = new McpServer({name: 'gated-supersede', version: '1'});",
      "server.registerTool('write_result', {inputSchema: {}}, async () => {",
      "  fs.writeFileSync('dispatched', '');",
      "  return {content: [{type: 'text', text: 'saved'}]};",
      "});",
      "await server.connect(new StdioServerTransport());",
    ]);
    releasePath = path.join(mcp.workspace, "release");
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: false,
    });
    startScheduledNoWait(fixture, clock, "执行一个会被用户消息替代的工具");
    await waitForFile(path.join(mcp.workspace, "connecting"));
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "你在吗？",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await delay(50);
    fs.writeFileSync(releasePath, "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(fs.existsSync(path.join(mcp.workspace, "dispatched")), false);
    assert.ok(
      fixture.app.services.messages
        .list(fixture.roleId, fixture.windowId, 0, 100)
        .items.some(
          (message) =>
            message.sender === "assistant" &&
            message.content === "先回你：我在。",
        ),
    );
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT call_kind, purpose, counted FROM call_metering ORDER BY rowid",
        )
        .all(),
    ) as Array<{ call_kind: string; purpose: string; counted: number }>;
    const accounted = metering.reduce((total, row) => total + row.counted, 0);
    assert.equal(budget.usedPoints, 2);
    assert.equal(accounted, budget.usedPoints);
    assert.equal(
      metering.filter((row) => row.call_kind === "tool").length,
      0,
    );
    const results = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT status, diagnostic_code FROM tool_results ORDER BY rowid",
        )
        .all(),
    ) as Array<{ status: string; diagnostic_code: string | null }>;
    assert.deepEqual(results, [
      { status: "failed", diagnostic_code: "EXECUTION_SUPERSEDED" },
    ]);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
  } finally {
    if (releasePath.length > 0) {
      fs.writeFileSync(releasePath, "");
    }
    await fixture.close();
  }
});

test("a reservation committed after local midnight charges the new day", { timeout: 30_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T15:59:58.000Z") };
  const model = new ScriptedChatModel([
    (request: ModelRequest): ModelEvent[] =>
      toolCall(toolNameOf(request, "write_result"), {}),
    done("跨日派发已经完成"),
  ]);
  const fixture = createAutonomyFixture(model, clock);
  let releasePath = "";
  try {
    const mcp = addGatedMcp(fixture, "cross-day", "write_result");
    releasePath = path.join(mcp.workspace, "release");
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: false,
    });
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-04T15:59:59.000Z",
      intent: "在额度跨日前准备，跨日后才实际派发",
    });
    clock.value = new Date("2026-11-04T15:59:59.000Z");
    assert.equal(fixture.app.conversation.runDueAutonomy(fixture.roleId), true);
    await waitForFile(path.join(mcp.workspace, "connecting"));
    assert.equal(
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      2,
    );
    clock.value = new Date("2026-11-04T16:00:01.000Z");
    assert.equal(
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      0,
    );
    fs.writeFileSync(releasePath, "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(fs.existsSync(path.join(mcp.workspace, "dispatched")), true);
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT call_kind, counted, created_at FROM call_metering ORDER BY rowid",
        )
        .all(),
    ) as Array<{ call_kind: string; counted: number; created_at: string }>;
    const today = metering.filter(
      (row) => row.created_at >= "2026-11-04T16:00:00.000Z",
    );
    const countedToday = today.reduce((sum, row) => sum + row.counted, 0);
    assert.deepEqual(
      today.map((row) => [row.call_kind, row.counted]),
      [
        ["tool", 1],
        ["model", 1],
      ],
    );
    assert.equal(countedToday, 2);
    assert.equal(budget.usedPoints, countedToday);
    assert.equal(
      fixture.app.conversation.listTasks(fixture.roleId)[0]?.status,
      "completed",
    );
  } finally {
    if (releasePath.length > 0) {
      fs.writeFileSync(releasePath, "");
    }
    await fixture.close();
  }
});

test("a cross-day reservation does not dispatch when the new day is exhausted", { timeout: 30_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T15:59:58.000Z") };
  const model = new ScriptedChatModel([
    (request: ModelRequest): ModelEvent[] =>
      toolCall(toolNameOf(request, "write_result"), {}),
  ]);
  const fixture = createAutonomyFixture(model, clock);
  let releasePath = "";
  try {
    const mcp = addGatedMcp(fixture, "cross-day-exhausted", "write_result");
    releasePath = path.join(mcp.workspace, "release");
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: false,
    });
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: "2026-11-04T15:59:59.000Z",
      intent: "跨日后余额不足时不应派发",
    });
    clock.value = new Date("2026-11-04T15:59:59.000Z");
    assert.equal(fixture.app.conversation.runDueAutonomy(fixture.roleId), true);
    await waitForFile(path.join(mcp.workspace, "connecting"));
    clock.value = new Date("2026-11-04T16:00:01.000Z");
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 1,
      unlimited: false,
    });
    const used = fixture.app.services.autonomy.consumePoint(fixture.roleId);
    assert.equal(used.counted, true);
    fs.writeFileSync(releasePath, "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(fs.existsSync(path.join(mcp.workspace, "dispatched")), false);
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    assert.equal(budget.usedPoints, 1);
    const status = fixture.app.services.autonomy.getStatus(fixture.roleId);
    assert.equal(status.paused, true);
    assert.equal(status.activities[0]?.status, "paused");
    const results = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT status, diagnostic_code FROM tool_results ORDER BY rowid",
        )
        .all(),
    ) as Array<{ status: string; diagnostic_code: string | null }>;
    assert.deepEqual(results, [
      { status: "failed", diagnostic_code: "AUTONOMY_BUDGET_EXHAUSTED" },
    ]);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT call_kind, counted, created_at FROM call_metering ORDER BY rowid",
        )
        .all(),
    ) as Array<{ call_kind: string; counted: number; created_at: string }>;
    assert.equal(
      metering.filter(
        (row) => row.created_at >= "2026-11-04T16:00:00.000Z",
      ).length,
      0,
    );
  } finally {
    if (releasePath.length > 0) {
      fs.writeFileSync(releasePath, "");
    }
    await fixture.close();
  }
});

test("an uncounted reservation does not refund another call after mode switches", { timeout: 30_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  let switchUnlimited: (() => void) | null = null;
  const model = new ScriptedChatModel([
    (request: ModelRequest): ModelEvent[] => {
      switchUnlimited?.();
      return toolCall(toolNameOf(request, "write_result"), {});
    },
  ]);
  const fixture = createAutonomyFixture(model, clock);
  let releasePath = "";
  try {
    const mcp = addGatedMcp(fixture, "unlimited-cancel", "write_result");
    releasePath = path.join(mcp.workspace, "release");
    switchUnlimited = () => {
      fixture.app.services.autonomy.setBudget(fixture.roleId, {
        dailyLimit: 10,
        unlimited: true,
      });
    };
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: false,
    });
    await startScheduledNoWait(
      fixture,
      clock,
      "切换无限制时取消一个从未扣过点的预留",
    );
    await waitForFile(path.join(mcp.workspace, "connecting"));
    const whileUnlimited = fixture.app.services.autonomy.getBudget(
      fixture.roleId,
    );
    assert.equal(whileUnlimited.unlimited, true);
    assert.equal(whileUnlimited.usedPoints, 1);
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: false,
    });
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
    assert.ok(task);
    fixture.app.conversation.finishTask({
      roleId: fixture.roleId,
      taskId: task.taskId,
      status: "completed",
      endReason: "有限模式下结束尚未派发的无限制预留",
    });
    fs.writeFileSync(releasePath, "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(fs.existsSync(path.join(mcp.workspace, "dispatched")), false);
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    assert.equal(budget.usedPoints, 1);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT call_kind, counted FROM call_metering ORDER BY rowid")
        .all(),
    ) as Array<{ call_kind: string; counted: number }>;
    assert.deepEqual(metering, [{ call_kind: "model", counted: 1 }]);
  } finally {
    if (releasePath.length > 0) {
      fs.writeFileSync(releasePath, "");
    }
    await fixture.close();
  }
});

for (const mode of ["limited-to-unlimited", "unlimited-to-limited"] as const) {
  test(`a dispatched reservation settles correctly across ${mode}`, { timeout: 30_000 }, async () => {
    const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
    let switchMode: (() => void) | null = null;
    const model = new ScriptedChatModel([
      (request: ModelRequest): ModelEvent[] => {
        switchMode?.();
        return toolCall(toolNameOf(request, "write_result"), {});
      },
      done("模式切换后完成"),
    ]);
    const fixture = createAutonomyFixture(model, clock);
    let releasePath = "";
    try {
      const mcp = addGatedMcp(fixture, `mode-${mode}`, "write_result");
      releasePath = path.join(mcp.workspace, "release");
      switchMode = () => {
        fixture.app.services.autonomy.setBudget(fixture.roleId, {
          dailyLimit: 10,
          unlimited: mode === "limited-to-unlimited",
        });
      };
      fixture.app.services.autonomy.setBudget(fixture.roleId, {
        dailyLimit: 10,
        unlimited: mode === "unlimited-to-limited",
      });
      await startScheduledNoWait(fixture, clock, "模式切换后仍按实际派发结算");
      await waitForFile(path.join(mcp.workspace, "connecting"));
      fs.writeFileSync(releasePath, "");
      await fixture.app.conversation.waitForIdle(fixture.roleId);

      assert.equal(fs.existsSync(path.join(mcp.workspace, "dispatched")), true);
      const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
      const metering = withStorage(fixture, (storage) =>
        storage.business.db
          .prepare(
            "SELECT call_kind, counted FROM call_metering ORDER BY rowid",
          )
          .all(),
      ) as Array<{ call_kind: string; counted: number }>;
      const accounted = metering.reduce((sum, row) => sum + row.counted, 0);
      assert.equal(accounted, budget.usedPoints);
      assert.equal(
        budget.usedPoints,
        mode === "limited-to-unlimited" ? 1 : 2,
      );
      assert.equal(
        fixture.app.conversation.listTasks(fixture.roleId)[0]?.status,
        "completed",
      );
    } finally {
      if (releasePath.length > 0) {
        fs.writeFileSync(releasePath, "");
      }
      await fixture.close();
    }
  });
}

test("cancelling a counted reservation still releases it after switching to unlimited", { timeout: 30_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    (request: ModelRequest): ModelEvent[] =>
      toolCall(toolNameOf(request, "write_result"), {}),
  ]);
  const fixture = createAutonomyFixture(model, clock);
  let releasePath = "";
  try {
    const mcp = addGatedMcp(fixture, "counted-cancel", "write_result");
    releasePath = path.join(mcp.workspace, "release");
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: false,
    });
    await startScheduledNoWait(fixture, clock, "取消已扣点的预留");
    await waitForFile(path.join(mcp.workspace, "connecting"));
    assert.equal(
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      2,
    );
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: true,
    });
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
    assert.ok(task);
    fixture.app.conversation.finishTask({
      roleId: fixture.roleId,
      taskId: task.taskId,
      status: "completed",
      endReason: "切换无限制后取消尚未派发的预留",
    });
    fs.writeFileSync(releasePath, "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(fs.existsSync(path.join(mcp.workspace, "dispatched")), false);
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    assert.equal(budget.usedPoints, 1);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT call_kind, counted FROM call_metering ORDER BY rowid")
        .all(),
    ) as Array<{ call_kind: string; counted: number }>;
    assert.deepEqual(metering, [{ call_kind: "model", counted: 1 }]);
  } finally {
    if (releasePath.length > 0) {
      fs.writeFileSync(releasePath, "");
    }
    await fixture.close();
  }
});

test("a counted reservation stays charged when unlimited mode starts before dispatch", { timeout: 30_000 }, async () => {
  const clock: Clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    (request: ModelRequest): ModelEvent[] =>
      toolCall(toolNameOf(request, "write_result"), {}),
    done("已扣点预留后切无限制并完成"),
  ]);
  const fixture = createAutonomyFixture(model, clock);
  let releasePath = "";
  try {
    const mcp = addGatedMcp(fixture, "counted-unlimited-success", "write_result");
    releasePath = path.join(mcp.workspace, "release");
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: false,
    });
    await startScheduledNoWait(fixture, clock, "已扣点后切换无限制派发");
    await waitForFile(path.join(mcp.workspace, "connecting"));
    assert.equal(
      fixture.app.services.autonomy.getBudget(fixture.roleId).usedPoints,
      2,
    );
    fixture.app.services.autonomy.setBudget(fixture.roleId, {
      dailyLimit: 10,
      unlimited: true,
    });
    fs.writeFileSync(releasePath, "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(fs.existsSync(path.join(mcp.workspace, "dispatched")), true);
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    assert.equal(budget.usedPoints, 2);
    const metering = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT call_kind, counted FROM call_metering ORDER BY rowid")
        .all(),
    ) as Array<{ call_kind: string; counted: number }>;
    assert.deepEqual(metering, [
      { call_kind: "model", counted: 1 },
      { call_kind: "tool", counted: 1 },
      { call_kind: "model", counted: 0 },
    ]);
    assert.equal(
      fixture.app.conversation.listTasks(fixture.roleId)[0]?.status,
      "completed",
    );
  } finally {
    if (releasePath.length > 0) {
      fs.writeFileSync(releasePath, "");
    }
    await fixture.close();
  }
});
