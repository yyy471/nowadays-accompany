import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { rolePaths } from "../src/bootstrap/config.js";
import { DEFAULT_TOOL_FOREGROUND_WAIT_MS } from "../src/application/conversation-service.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import {
  addBinding,
  createFixture,
  createFixtureWithModel,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 10_000,
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

function addSlowOpMcp(fixture: Fixture, dir: string): string {
  const serverPath = path.join(dir, "slow-op.mjs");
  fs.writeFileSync(
    serverPath,
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
      `const dir = ${JSON.stringify(dir)};`,
      "const server = new McpServer({ name: 'slow-op', version: '1' });",
      "server.registerTool('slow_op', { inputSchema: {} }, async () => {",
      "  fs.writeFileSync(path.join(dir, 'bg-started'), '');",
      "  const deadline = Date.now() + 20000;",
      "  while (!fs.existsSync(path.join(dir, 'bg-release')) && Date.now() < deadline) {",
      "    await new Promise((r) => setTimeout(r, 20));",
      "  }",
      "  return { content: [{ type: 'text', text: 'slow-result' }] };",
      "});",
      "await server.connect(new StdioServerTransport());",
    ].join("\n"),
    "utf8",
  );
  const resource = fixture.app.services.resources.create({
    kind: "mcp",
    name: "slow-op",
    config: { command: process.execPath, args: [serverPath], env: {} },
  });
  addBinding(fixture, "mcp", resource.resourceId);
  return resource.resourceId;
}

/** round1 调用慢工具；插话请求先回复新消息；工具结果在上下文里则收尾。 */
class BackgroundToolModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const last = request.messages.at(-1);
    if (last?.role === "user") {
      if (String(last.content) === "先回答这条消息") {
        yield { type: "text_delta", text: "先回应新消息" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      const tool = request.tools.find((candidate) =>
        candidate.name.includes("slow_op"),
      );
      assert.ok(tool);
      yield { type: "text_delta", text: "正在执行慢操作" };
      yield {
        type: "tool_call",
        callId: "wire-slow",
        name: tool.name,
        arguments: {},
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    assert.equal(last?.role, "tool");
    assert.match(String(last?.content ?? ""), /slow-result/);
    yield { type: "text_delta", text: "后台结果已收到" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("the default foreground wait window stays short and can be overridden", () => {
  assert.equal(DEFAULT_TOOL_FOREGROUND_WAIT_MS, 2_000);
});

test("a slow MCP tool moves to background, frees the role and returns the result to the original task", { timeout: 60_000 }, async () => {
  const model = new BackgroundToolModel();
  const fixture = createFixtureWithModel(model, {
    toolForegroundWaitMs: 600,
  });
  let workspace = "";
  try {
    workspace = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).workspaceDir;
    fs.mkdirSync(workspace, { recursive: true });
    addSlowOpMcp(fixture, workspace);
    submit(fixture, "请执行慢操作");
    await waitUntil(() => fs.existsSync(path.join(workspace, "bg-started")));

    // 等待窗口越过：执行转 superseded，角色空闲，任务仍活跃。
    await waitUntil(() => {
      const tasks = fixture.app.conversation.listTasks(fixture.roleId);
      return (
        tasks.length === 1 &&
        tasks[0]?.status === "active" &&
        withStorage(
          fixture,
          (storage) =>
            (
              storage.business.db
                .prepare(
                  "SELECT status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
                )
                .all(fixture.roleId) as Array<{ status: string }>
            ).every((row) => row.status !== "running"),
        )
      );
    });

    const backgrounded = withStorage(fixture, (storage) => {
      const executions = storage.business.db
        .prepare(
          "SELECT execution_id, status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{
        execution_id: string;
        status: string;
      }>;
      const calls = storage.business.db
        .prepare("SELECT tool_call_id, tool_name, status FROM tool_calls")
        .all() as Array<{
        tool_call_id: string;
        tool_name: string;
        status: string;
      }>;
      const events = storage.business.db
        .prepare(
          "SELECT event_type, payload_json FROM execution_stream_events WHERE execution_id = ? ORDER BY stream_event_id ASC",
        )
        .all(executions[0]?.execution_id ?? "") as Array<{
        event_type: string;
        payload_json: string;
      }>;
      return { executions, calls, events };
    });
    assert.deepEqual(
      backgrounded.executions.map((row) => row.status),
      ["superseded"],
    );
    assert.equal(backgrounded.calls.length, 1);
    assert.equal(backgrounded.calls[0]?.status, "running");
    const toolCallId = backgrounded.calls[0]!.tool_call_id;
    const backgroundEvent = backgrounded.events.find(
      (event) => event.event_type === "tool_backgrounded",
    );
    assert.ok(backgroundEvent, "应有 tool_backgrounded 流事件");
    assert.equal(
      (JSON.parse(backgroundEvent.payload_json) as { toolCallId?: string })
        .toolCallId,
      toolCallId,
    );
    const mode = withStorage(fixture, (storage) =>
      storage.business.getToolCall(fixture.roleId, toolCallId),
    );
    assert.equal(mode.mode, "background");

    // 决策位置已释放：同窗口新消息可以先得到回复。
    submit(fixture, "先回答这条消息");
    await waitUntil(() =>
      fixture.app.services.messages
        .list(fixture.roleId, fixture.windowId, 0, 20)
        .items.some(
          (message) =>
            message.sender === "assistant" &&
            message.status === "completed" &&
            message.content === "先回应新消息",
        ),
    );

    // 工具在后台返回：真实结果保存后交回原任务续行。
    fs.writeFileSync(path.join(workspace, "bg-release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const final = withStorage(fixture, (storage) => {
      const executions = storage.business.db
        .prepare(
          "SELECT status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{ status: string }>;
      const results = storage.business.db
        .prepare(
          "SELECT status FROM tool_results WHERE tool_call_id = ?",
        )
        .get(toolCallId) as { status: string };
      const metering = storage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM call_metering WHERE call_kind = 'tool' AND call_id = ?",
        )
        .get(toolCallId) as { count: number };
      const calls = storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM tool_calls")
        .get() as { count: number };
      return { executions, results, metering, calls };
    });
    assert.deepEqual(final.executions.map((row) => row.status), [
      "superseded",
      "completed",
      "completed",
    ]);
    assert.equal(final.results.status, "success");
    assert.equal(final.metering.count, 1, "同一次调用只计量一次");
    assert.equal(final.calls.count, 1, "同一次调用只派发一次");
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
    const finalRequests = model.requests.at(-1);
    assert.ok(finalRequests);
    assert.ok(
      finalRequests.messages.some(
        (message) =>
          message.role === "tool" &&
          String(message.content).includes("slow-result"),
      ),
      "续行应把真实工具结果带回模型上下文",
    );
  } finally {
    if (workspace.length > 0) {
      fs.writeFileSync(path.join(workspace, "bg-release"), "");
    }
    await fixture.close();
  }
});

test("a late background result after the task ended is recorded without reviving the task", { timeout: 60_000 }, async () => {
  const model = new BackgroundToolModel();
  const fixture = createFixtureWithModel(model, {
    toolForegroundWaitMs: 600,
  });
  let workspace = "";
  try {
    workspace = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).workspaceDir;
    fs.mkdirSync(workspace, { recursive: true });
    addSlowOpMcp(fixture, workspace);
    submit(fixture, "请执行慢操作");
    await waitUntil(() => fs.existsSync(path.join(workspace, "bg-started")));
    await waitUntil(() => {
      const tasks = fixture.app.conversation.listTasks(fixture.roleId);
      return (
        tasks.length === 1 &&
        tasks[0]?.status === "active" &&
        withStorage(
          fixture,
          (storage) =>
            (
              storage.business.db
                .prepare(
                  "SELECT status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
                )
                .all(fixture.roleId) as Array<{ status: string }>
            ).every((row) => row.status !== "running"),
        )
      );
    });
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
    fixture.app.conversation.finishTask({
      roleId: fixture.roleId,
      taskId: task.taskId,
      status: "completed",
      endReason: "用户提前结束",
    });
    fs.writeFileSync(path.join(workspace, "bg-release"), "");
    await waitUntil(() => {
      const result = withStorage(
        fixture,
        (storage) =>
          storage.business.db
            .prepare("SELECT status FROM tool_results LIMIT 1")
            .get() as { status: string } | undefined,
      );
      return result?.status === "success";
    });
    await delay(200);
    const final = withStorage(fixture, (storage) => {
      const executions = storage.business.db
        .prepare(
          "SELECT status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{ status: string }>;
      return { executions };
    });
    assert.deepEqual(final.executions.map((row) => row.status), ["superseded"]);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
    assert.equal(tasks[0]?.endReason, "用户提前结束");
  } finally {
    if (workspace.length > 0) {
      fs.writeFileSync(path.join(workspace, "bg-release"), "");
    }
    await fixture.close();
  }
});

test("a fast tool inside the window stays foreground without mode changes", { timeout: 30_000 }, async () => {
  const fixture = createFixture(
    [
      (request) => {
        const tool = request.tools.find((candidate) =>
          candidate.name.includes("workspace_read"),
        );
        assert.ok(tool);
        return [
          {
            type: "tool_call",
            callId: "wire-fast",
            name: tool.name,
            arguments: { path: "note.md" },
          },
          { type: "completed", stopReason: "tool_calls" },
        ];
      },
      [
        { type: "text_delta", text: "快速工具正常完成。" },
        { type: "completed", stopReason: "stop" },
      ],
    ],
    { toolForegroundWaitMs: 600 },
  );
  try {
    const workspace = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).workspaceDir;
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "note.md"), "快速内容", "utf8");
    const mcp = fixture.app.services.resources.create({
      kind: "mcp",
      name: "workspace",
      config: {
        command: process.execPath,
        args: [
          "--import",
          pathToFileURL(
            path.resolve("node_modules/tsx/dist/loader.mjs"),
          ).href,
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
    submit(fixture, "读一下 note.md");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const detail = withStorage(fixture, (storage) => {
      const executions = storage.business.db
        .prepare(
          "SELECT execution_id, status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{
        execution_id: string;
        status: string;
      }>;
      const call = storage.business.db
        .prepare("SELECT tool_call_id FROM tool_calls LIMIT 1")
        .get() as { tool_call_id: string };
      const events = storage.business.db
        .prepare(
          "SELECT event_type FROM execution_stream_events WHERE execution_id = ?",
        )
        .all(executions[0]?.execution_id ?? "") as Array<{
        event_type: string;
      }>;
      return { executions, call, events };
    });
    assert.deepEqual(detail.executions.map((row) => row.status), [
      "completed",
    ]);
    const record = withStorage(fixture, (storage) =>
      storage.business.getToolCall(fixture.roleId, detail.call.tool_call_id),
    );
    assert.equal(record.mode, "foreground");
    assert.equal(
      detail.events.some((event) => event.event_type === "tool_backgrounded"),
      false,
    );
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks[0]?.status, "completed");
    assert.equal(tasks[0]?.endReason, "回复完成");
  } finally {
    await fixture.close();
  }
});

function addDelayedHandshakeMcp(fixture: Fixture, dir: string): string {
  const serverPath = path.join(dir, "delayed-handshake.mjs");
  fs.writeFileSync(
    serverPath,
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
      `const dir = ${JSON.stringify(dir)};`,
      "const launchesPath = path.join(dir, 'launches');",
      "const launches = fs.existsSync(launchesPath) ? Number(fs.readFileSync(launchesPath, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(launchesPath, String(launches));",
      "if (launches === 2) {",
      "  fs.writeFileSync(path.join(dir, 'connecting'), '');",
      "  const deadline = Date.now() + 9000;",
      "  while (!fs.existsSync(path.join(dir, 'connect-release')) && Date.now() < deadline) await delay(20);",
      "}",
      "const server = new McpServer({ name: 'delayed-handshake', version: '1' });",
      "server.registerTool('probe_effect', { inputSchema: {} }, async () => {",
      "  fs.writeFileSync(path.join(dir, 'dispatched'), '');",
      "  return { content: [{ type: 'text', text: 'success' }] };",
      "});",
      "await server.connect(new StdioServerTransport());",
    ].join("\n"),
    "utf8",
  );
  const resource = fixture.app.services.resources.create({
    kind: "mcp",
    name: "delayed-handshake",
    config: { command: process.execPath, args: [serverPath], env: {} },
  });
  addBinding(fixture, "mcp", resource.resourceId);
  return resource.resourceId;
}

test("a slow MCP handshake that outlives the foreground window dispatches once after backgrounding", { timeout: 60_000 }, async () => {
  const fixture = createFixture(
    [
      (request) => {
        const tool = request.tools.find((candidate) =>
          candidate.name.includes("probe_effect"),
        );
        assert.ok(tool);
        return [
          {
            type: "tool_call",
            callId: "wire-delayed-handshake",
            name: tool.name,
            arguments: {},
          },
          { type: "completed", stopReason: "tool_calls" },
        ];
      },
      [
        { type: "text_delta", text: "慢连接任务已完成。" },
        { type: "completed", stopReason: "stop" },
      ],
    ],
    { toolForegroundWaitMs: 100 },
  );
  const release = path.join(fixture.root, "connect-release");
  try {
    addDelayedHandshakeMcp(fixture, fixture.root);
    submit(fixture, "执行连接较慢的本地操作");
    await waitUntil(() => fs.existsSync(path.join(fixture.root, "connecting")));
    await waitUntil(() =>
      withStorage(fixture, (storage) => {
        const row = storage.business.db
          .prepare(
            "SELECT COUNT(*) AS count FROM execution_stream_events WHERE event_type = 'tool_backgrounded'",
          )
          .get() as { count: number };
        return row.count === 1;
      }),
    );
    fs.writeFileSync(release, "", "utf8");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(fs.existsSync(path.join(fixture.root, "dispatched")), true);
    const detail = withStorage(fixture, (storage) => {
      const calls = storage.business.db
        .prepare(
          "SELECT tc.status, tr.diagnostic_code FROM tool_calls tc LEFT JOIN tool_results tr ON tr.tool_call_id = tc.tool_call_id ORDER BY tc.rowid ASC",
        )
        .all() as Array<{ status: string; diagnostic_code: string | null }>;
      const background = storage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM execution_stream_events WHERE event_type = 'tool_backgrounded'",
        )
        .get() as { count: number };
      return { calls, background: background.count };
    });
    assert.deepEqual(detail.calls, [{ status: "success", diagnostic_code: null }]);
    assert.equal(detail.background, 1);
  } finally {
    fs.writeFileSync(release, "", "utf8");
    await fixture.close();
  }
});

test("a task ended during a slow MCP handshake stays undispatched", { timeout: 60_000 }, async () => {
  const fixture = createFixture(
    [
      (request) => {
        const tool = request.tools.find((candidate) =>
          candidate.name.includes("probe_effect"),
        );
        assert.ok(tool);
        return [
          {
            type: "tool_call",
            callId: "wire-ended-handshake",
            name: tool.name,
            arguments: {},
          },
          { type: "completed", stopReason: "tool_calls" },
        ];
      },
    ],
    { toolForegroundWaitMs: 100 },
  );
  const release = path.join(fixture.root, "connect-release");
  try {
    addDelayedHandshakeMcp(fixture, fixture.root);
    submit(fixture, "执行连接较慢的本地操作");
    await waitUntil(() => fs.existsSync(path.join(fixture.root, "connecting")));
    await waitUntil(() =>
      withStorage(fixture, (storage) => {
        const row = storage.business.db
          .prepare(
            "SELECT COUNT(*) AS count FROM execution_stream_events WHERE event_type = 'tool_backgrounded'",
          )
          .get() as { count: number };
        return row.count === 1;
      }),
    );
    withStorage(fixture, (storage) => {
      const task = storage.business.listTasks(fixture.roleId)[0]!;
      storage.business.finishTask({
        roleId: fixture.roleId,
        taskId: task.taskId,
        status: "completed",
        endReason: "外部结束",
      });
    });
    fs.writeFileSync(release, "", "utf8");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(fs.existsSync(path.join(fixture.root, "dispatched")), false);
    const call = withStorage(fixture, (storage) => {
      const row = storage.business.db
        .prepare(
          "SELECT tc.status, tr.diagnostic_code FROM tool_calls tc LEFT JOIN tool_results tr ON tr.tool_call_id = tc.tool_call_id ORDER BY tc.rowid ASC LIMIT 1",
        )
        .get() as { status: string; diagnostic_code: string | null };
      return row;
    });
    assert.deepEqual(call, { status: "failed", diagnostic_code: "TASK_ENDED" });
  } finally {
    fs.writeFileSync(release, "", "utf8");
    await fixture.close();
  }
});
