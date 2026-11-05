import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { rolePaths } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import {
  ScriptedChatModel,
  addBinding,
  createFixtureWithModel,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 5_000,
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

function addWorkspaceMcp(
  fixture: Fixture,
  env: Record<string, string> = {},
): { workspace: string; resourceId: string } {
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
      env: { NOWADAYS_WORKSPACE: workspace, ...env },
    },
  });
  addBinding(fixture, "mcp", mcp.resourceId);
  return { workspace, resourceId: mcp.resourceId };
}

class ContinuationModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  disableMcp: (() => void) | null = null;

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const tool = request.tools.find((candidate) =>
      candidate.name.includes("workspace_read"),
    );
    const toolMessages = request.messages.filter(
      (message) => message.role === "tool",
    );
    if (this.requests.length === 1) {
      assert.ok(tool);
      yield {
        type: "tool_call",
        callId: "wire-before-disable",
        name: tool.name,
        arguments: { path: "note.md" },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (this.requests.length === 2) {
      assert.ok(tool);
      this.disableMcp?.();
      yield {
        type: "tool_call",
        callId: "wire-after-disable",
        name: tool.name,
        arguments: { path: "note.md" },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (this.requests.length === 3) {
      assert.match(String(toolMessages.at(-1)?.content ?? ""), /旧地图/);
      yield { type: "text_delta", text: "第一轮在开关关闭前继续完成。" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    assert.equal(tool, undefined);
    yield { type: "text_delta", text: "第二轮不再提供外部工具。" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("disabling an MCP resource keeps the running chain but excludes the next task", { timeout: 30_000 }, async () => {
  const model = new ContinuationModel();
  const fixture = createFixtureWithModel(model);
  try {
    const workspace = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).workspaceDir;
    fs.writeFileSync(
      path.join(workspace, "note.md"),
      "旧地图在书桌抽屉里。",
      "utf8",
    );
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
    model.disableMcp = () => {
      fixture.app.services.resources.update(mcp.resourceId, { enabled: false });
    };

    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "先读一次，再读一次",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const first = withStorage(fixture, (storage) => {
      const calls = storage.business.db
        .prepare("SELECT status FROM tool_calls ORDER BY rowid ASC")
        .all() as Array<{ status: string }>;
      const executions = storage.business.db
        .prepare("SELECT status FROM executions ORDER BY rowid ASC")
        .all() as Array<{ status: string }>;
      return { calls, executions };
    });
    assert.deepEqual(first.calls.map((call) => call.status), [
      "success",
      "success",
    ]);
    assert.deepEqual(first.executions.map((row) => row.status), ["completed"]);

    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "关掉后再来一轮",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 4);
    const afterSecond = withStorage(fixture, (storage) => {
      const calls = storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM tool_calls")
        .get() as { count: number };
      const executions = storage.business.db
        .prepare("SELECT status FROM executions ORDER BY rowid ASC")
        .all() as Array<{ status: string }>;
      return { calls, executions };
    });
    assert.equal(afterSecond.calls.count, 2);
    assert.deepEqual(afterSecond.executions.map((row) => row.status), [
      "completed",
      "completed",
    ]);
  } finally {
    await fixture.close();
  }
});

test("agent tool loop calls a real local MCP tool and persists the external call", { timeout: 30_000 }, async () => {
  const model = new ScriptedChatModel([
    (request) => {
      const tool = request.tools.find((candidate) =>
        candidate.name.includes("workspace_read"),
      );
      assert.ok(
        tool,
        `workspace_read tool missing: ${request.tools.map((item) => item.name).join(",")}`,
      );
      return [
        {
          type: "tool_call",
          callId: "wire-mcp-read",
          name: tool.name,
          arguments: { path: "note.md" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    [
      { type: "text_delta", text: "我看到抽屉里的旧地图了。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const fixture = createFixtureWithModel(model);
  try {
    const workspace = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).workspaceDir;
    fs.writeFileSync(
      path.join(workspace, "note.md"),
      "旧地图在书桌抽屉里。",
      "utf8",
    );
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

    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "帮我看看工作空间里的 note.md",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.equal(messages.items.at(-1)?.content, "我看到抽屉里的旧地图了。");
    assert.equal(model.requests.length, 2);
    const second = model.requests[1]!;
    const toolMessage = second.messages.find((message) => message.role === "tool");
    assert.ok(toolMessage);
    assert.match(String(toolMessage.content), /旧地图在书桌抽屉里/);
    assert.equal(toolMessage.toolCallId, "wire-mcp-read");

    const detail = withStorage(fixture, (storage) => {
      const execution = storage.business.db
        .prepare("SELECT execution_id FROM executions WHERE role_id = ? AND status = 'completed' ORDER BY rowid DESC LIMIT 1")
        .get(fixture.roleId) as { execution_id: string };
      const call = storage.business.db
        .prepare("SELECT * FROM tool_calls WHERE execution_id = ?")
        .get(execution.execution_id) as {
        tool_call_id: string;
        task_id: string;
        tool_name: string;
        status: string;
        step_key: string;
      };
      const result = storage.business.db
        .prepare("SELECT * FROM tool_results WHERE tool_call_id = ?")
        .get(call.tool_call_id) as {
        status: string;
        raw_response_json: string | null;
        adapted_result_json: string | null;
      };
      const task = storage.business.getTask(fixture.roleId, call.task_id);
      const taskOrigin = storage.business.db
        .prepare(
          "SELECT origin, initiator_execution_id FROM tasks WHERE task_id = ?",
        )
        .get(call.task_id) as {
        origin: string;
        initiator_execution_id: string | null;
      };
      const link = storage.business.db
        .prepare("SELECT relation FROM execution_tasks WHERE execution_id = ? AND task_id = ?")
        .get(execution.execution_id, call.task_id) as { relation: string };
      const metering = storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM call_metering WHERE execution_id = ? AND call_kind = 'tool' AND counted = 0")
        .get(execution.execution_id) as { count: number };
      const modelCall = storage.business.db
        .prepare("SELECT raw_response_json FROM model_calls WHERE execution_id = ? ORDER BY rowid ASC LIMIT 1")
        .get(execution.execution_id) as { raw_response_json: string };
      const evidence = storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM evidence_records WHERE role_id = ?")
        .get(fixture.roleId) as { count: number };
      return {
        execution,
        call,
        result,
        task,
        taskOrigin,
        link,
        metering,
        modelCall,
        evidence,
      };
    });
    assert.equal(detail.call.status, "success");
    assert.notEqual(detail.call.tool_call_id, "wire-mcp-read");
    assert.match(detail.call.tool_name, /workspace_read/);
    assert.equal(detail.result.status, "success");
    assert.match(detail.result.adapted_result_json ?? "", /旧地图在书桌抽屉里/);
    assert.equal(detail.task.status, "completed");
    assert.equal(detail.taskOrigin.origin, "user");
    assert.equal(
      detail.taskOrigin.initiator_execution_id,
      detail.execution.execution_id,
    );
    assert.equal(detail.link.relation, "initiates");
    assert.equal(detail.metering.count, 1);
    assert.deepEqual(
      (JSON.parse(detail.modelCall.raw_response_json) as {
        wireCallIds: Record<string, string>;
      }).wireCallIds,
      { "wire-mcp-read": detail.call.tool_call_id },
    );
    assert.equal(detail.evidence.count, 3);
  } finally {
    await fixture.close();
  }
});

function submit(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}

class NewReplyWhileToolRunsModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      const tool = request.tools.find((candidate) =>
        candidate.name.includes("command_run"),
      );
      assert.ok(tool);
      yield { type: "text_delta", text: "正在处理原任务" };
      yield {
        type: "tool_call",
        callId: "wire-slow-command",
        name: tool.name,
        arguments: {
          command: process.execPath,
          args: [
            "-e",
            "const fs=require('node:fs');fs.writeFileSync('started','');const t=setInterval(()=>{if(fs.existsSync('release')){clearInterval(t);console.log('finished')}},20);setTimeout(()=>{clearInterval(t)},4000)",
          ],
          timeoutMs: 6000,
        },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    const toolCompleted = request.messages.some(
      (message) =>
        message.role === "tool" &&
        String(message.content).includes("finished"),
    );
    if (toolCompleted) {
      yield { type: "text_delta", text: "原任务继续完成" };
    } else {
      yield { type: "text_delta", text: "先回应新消息" };
    }
    yield { type: "completed", stopReason: "stop" };
  }
}

test("a new message replies while an external tool keeps running and preserves the original task", { timeout: 30_000 }, async () => {
  const model = new NewReplyWhileToolRunsModel();
  const fixture = createFixtureWithModel(model);
  let workspace = "";
  try {
    ({ workspace } = addWorkspaceMcp(fixture));
    submit(fixture, "请处理一个慢任务");
    await waitUntil(() => fs.existsSync(path.join(workspace, "started")));
    submit(fixture, "先回答这条消息");
    await waitUntil(() => model.requests.length >= 2);
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

    fs.writeFileSync(path.join(workspace, "release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.deepEqual(
      messages.items.map((message) => [
        message.sender,
        message.status,
        message.content,
      ]),
      [
        ["user", "received", "请处理一个慢任务"],
        ["assistant", "interrupted", "正在处理原任务"],
        ["user", "received", "先回答这条消息"],
        ["assistant", "completed", "先回应新消息"],
        ["assistant", "completed", "原任务继续完成"],
      ],
    );
    assert.equal(model.requests.length, 3);
    const detail = withStorage(fixture, (storage) => {
      const executions = storage.business.db
        .prepare(
          "SELECT status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{ status: string }>;
      const calls = storage.business.db
        .prepare(
          "SELECT status FROM tool_calls ORDER BY rowid ASC",
        )
        .all() as Array<{ status: string }>;
      const results = storage.business.db
        .prepare("SELECT status FROM tool_results ORDER BY rowid ASC")
        .all() as Array<{ status: string }>;
      const links = storage.business.db
        .prepare(
          "SELECT relation FROM execution_tasks ORDER BY created_at ASC, rowid ASC",
        )
        .all() as Array<{ relation: string }>;
      return { executions, calls, results, links };
    });
    assert.deepEqual(detail.executions.map((row) => row.status), [
      "superseded",
      "completed",
      "completed",
    ]);
    assert.deepEqual(detail.calls.map((row) => row.status), ["success"]);
    assert.deepEqual(detail.results.map((row) => row.status), ["success"]);
    assert.deepEqual(detail.links.map((row) => row.relation), [
      "initiates",
      "continues",
    ]);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
    assert.equal(tasks[0]?.endReason, "回复完成");
  } finally {
    if (workspace.length > 0) {
      fs.writeFileSync(path.join(workspace, "release"), "");
    }
    await fixture.close();
  }
});

class TwoStepTaskModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  continuationRequests = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const toolMessages = request.messages.filter(
      (message) => message.role === "tool",
    );
    const readDone = toolMessages.some((message) =>
      String(message.content).includes("read-result"),
    );
    if (!readDone) {
      if (this.requests.length === 1) {
        const tool = request.tools.find((candidate) =>
          candidate.name.includes("command_run"),
        );
        assert.ok(tool);
        yield { type: "text_delta", text: "先读取，再保存任务成果" };
        yield {
          type: "tool_call",
          callId: "original-read",
          name: tool.name,
          arguments: {
            command: process.execPath,
            args: [
              "-e",
              "const fs=require('node:fs');fs.writeFileSync('started','');const timeout=setTimeout(()=>process.exit(),6000);const poll=setInterval(()=>{if(fs.existsSync('release')){clearTimeout(timeout);clearInterval(poll);console.log('read-result')}},20)",
            ],
            timeoutMs: 8000,
          },
        };
        yield { type: "completed", stopReason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "先回应新消息" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    this.continuationRequests += 1;
    const writeTool = request.tools.find((candidate) =>
      candidate.name.includes("workspace_write"),
    );
    assert.ok(writeTool);
    if (
      !toolMessages.some(
        (message) => message.toolCallId === "original-write",
      )
    ) {
      yield {
        type: "tool_call",
        callId: "original-write",
        name: writeTool.name,
        arguments: { path: "task-result.md", content: "保存读取成果" },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "原任务完成" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("the original two-step task continues after the new reply and completes", { timeout: 30_000 }, async () => {
  const model = new TwoStepTaskModel();
  const fixture = createFixtureWithModel(model);
  let workspace = "";
  try {
    ({ workspace } = addWorkspaceMcp(fixture));
    submit(fixture, "读取后保存成果，完成两步任务");
    await waitUntil(() => fs.existsSync(path.join(workspace, "started")));
    submit(fixture, "先回应这一句，然后继续原任务");
    await waitUntil(() => model.requests.length >= 2);
    fs.writeFileSync(path.join(workspace, "release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(
      fs.existsSync(path.join(workspace, "task-result.md")),
      true,
    );
    assert.ok(model.continuationRequests > 0);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
    const detail = withStorage(fixture, (storage) => {
      const executions = storage.business.db
        .prepare(
          "SELECT status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{ status: string }>;
      const calls = storage.business.db
        .prepare("SELECT status FROM tool_calls ORDER BY rowid ASC")
        .all() as Array<{ status: string }>;
      const links = storage.business.db
        .prepare(
          "SELECT relation FROM execution_tasks ORDER BY created_at ASC, rowid ASC",
        )
        .all() as Array<{ relation: string }>;
      return { executions, calls, links };
    });
    assert.deepEqual(detail.executions.map((row) => row.status), [
      "superseded",
      "completed",
      "completed",
    ]);
    assert.deepEqual(detail.calls.map((row) => row.status), [
      "success",
      "success",
    ]);
    assert.deepEqual(detail.links.map((row) => row.relation), [
      "initiates",
      "continues",
    ]);
  } finally {
    if (workspace.length > 0) {
      fs.writeFileSync(path.join(workspace, "release"), "");
    }
    await fixture.close();
  }
});

test("each MCP tool dispatch reads the resource's latest config", { timeout: 30_000 }, async () => {
  let fixture!: Fixture;
  let resourceId = "";
  const model = new ScriptedChatModel([
    (request) => {
      const tool = request.tools.find((candidate) =>
        candidate.name.includes("command_run"),
      );
      assert.ok(tool);
      return [
        {
          type: "tool_call",
          callId: "wire-env-old",
          name: tool.name,
          arguments: {
            command: process.execPath,
            args: ["-e", "console.log(process.env.REVIEW_VALUE ?? 'unset')"],
          },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      const tool = request.tools.find((candidate) =>
        candidate.name.includes("command_run"),
      );
      assert.ok(tool);
      const resource = fixture.app.services.resources.get(resourceId);
      fixture.app.services.resources.update(resourceId, {
        config: {
          ...resource.config,
          env: {
            ...(resource.config.env as Record<string, string>),
            REVIEW_VALUE: "new",
          },
        },
      });
      return [
        {
          type: "tool_call",
          callId: "wire-env-new",
          name: tool.name,
          arguments: {
            command: process.execPath,
            args: ["-e", "console.log(process.env.REVIEW_VALUE ?? 'unset')"],
          },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      const toolMessages = request.messages.filter(
        (message) => message.role === "tool",
      );
      assert.match(String(toolMessages[0]?.content ?? ""), /old/);
      assert.match(String(toolMessages[1]?.content ?? ""), /new/);
      return [
        { type: "text_delta", text: "配置测试完成" },
        { type: "completed", stopReason: "stop" },
      ];
    },
  ]);
  fixture = createFixtureWithModel(model);
  try {
    resourceId = addWorkspaceMcp(fixture, { REVIEW_VALUE: "old" }).resourceId;
    submit(fixture, "读取两次环境变量");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 3);
    const results = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT adapted_result_json FROM tool_results ORDER BY rowid ASC",
        )
        .all() as Array<{ adapted_result_json: string }>,
    );
    assert.equal(results.length, 2);
    assert.match(results[0]?.adapted_result_json ?? "", /old/);
    assert.match(results[1]?.adapted_result_json ?? "", /new/);
  } finally {
    await fixture.close();
  }
});

class FinishTaskBetweenRoundsModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly getFixture: () => Fixture) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length <= 2) {
      if (this.requests.length === 2) {
        const fixture = this.getFixture();
        const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
        assert.ok(task);
        fixture.app.conversation.finishTask({
          roleId: fixture.roleId,
          taskId: task.taskId,
          status: "completed",
          endReason: "用户结束原任务",
        });
      }
      const tool = request.tools.find((candidate) =>
        candidate.name.includes("workspace_write"),
      );
      assert.ok(tool);
      yield {
        type: "tool_call",
        callId: `wire-finish-${this.requests.length}`,
        name: tool.name,
        arguments: {
          path: `round-${this.requests.length}.txt`,
          content: "actual side effect",
        },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "结束" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("an ended task is not allowed to dispatch a new external tool", { timeout: 30_000 }, async () => {
  let fixture!: Fixture;
  const model = new FinishTaskBetweenRoundsModel(() => fixture);
  fixture = createFixtureWithModel(model);
  try {
    const { workspace } = addWorkspaceMcp(fixture);
    submit(fixture, "先写一个文件");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, 2);
    assert.equal(fs.existsSync(path.join(workspace, "round-1.txt")), true);
    assert.equal(fs.existsSync(path.join(workspace, "round-2.txt")), false);
    const detail = withStorage(fixture, (storage) => {
      const executions = storage.business.db
        .prepare(
          "SELECT execution_id, status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{
        execution_id: string;
        status: string;
      }>;
      const calls = storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM tool_calls")
        .get() as { count: number };
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
    assert.deepEqual(detail.executions.map((row) => row.status), ["failed"]);
    assert.equal(detail.calls.count, 1);
    const failure = detail.events.find(
      (event) => event.event_type === "execution_failed",
    );
    assert.ok(failure);
    assert.equal(
      (JSON.parse(failure.payload_json) as { errorCode?: string }).errorCode,
      "TASK_ENDED",
    );
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
  } finally {
    await fixture.close();
  }
});

class AdvanceTwiceModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length <= 2) {
      const tool = request.tools.find((candidate) =>
        candidate.name.includes("advance"),
      );
      assert.ok(tool);
      yield {
        type: "tool_call",
        callId: `wire-advance-${this.requests.length}`,
        name: tool.name,
        arguments: {},
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "两次操作完成" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("an unchanged MCP config keeps the same service session across calls", { timeout: 30_000 }, async () => {
  const fixture = createFixtureWithModel(new AdvanceTwiceModel());
  try {
    const workspace = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).workspaceDir;
    const serverPath = path.join(workspace, "counter.mjs");
    fs.writeFileSync(
      serverPath,
      [
        `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
        `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
        "const server=new McpServer({name:'stateful-review',version:'1'});let counter=0;",
        "server.registerTool('advance',{inputSchema:{}},async()=>({content:[{type:'text',text:String(++counter)}]}));",
        "await server.connect(new StdioServerTransport());",
      ].join("\n"),
      "utf8",
    );
    const resource = fixture.app.services.resources.create({
      kind: "mcp",
      name: "counter",
      config: { command: process.execPath, args: [serverPath], env: {} },
    });
    addBinding(fixture, "mcp", resource.resourceId);
    submit(fixture, "对同一会话执行两次 advance");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const outputs = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT adapted_result_json FROM tool_results ORDER BY rowid ASC",
        )
        .all() as Array<{ adapted_result_json: string }>,
    );
    assert.deepEqual(
      outputs.map((row) => JSON.parse(row.adapted_result_json)),
      ["1", "2"],
    );
  } finally {
    await fixture.close();
  }
});

class ChainSessionModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private releaseGate: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  release(): void {
    this.releaseGate?.();
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const tool = request.tools.find((candidate) =>
      candidate.name.includes("advance"),
    );
    const toolMessages = request.messages.filter(
      (message) => message.role === "tool",
    );
    if (this.requests.length === 1) {
      assert.ok(tool);
      yield {
        type: "tool_call",
        callId: "advance-first",
        name: tool.name,
        arguments: {},
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (this.requests.length === 2) {
      yield { type: "text_delta", text: "第一阶段完成" };
      await this.gate;
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    if (this.requests.length === 3) {
      yield { type: "text_delta", text: "先回应新消息" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    assert.ok(tool);
    if (
      !toolMessages.some(
        (message) => message.toolCallId === "advance-second",
      )
    ) {
      yield {
        type: "tool_call",
        callId: "advance-second",
        name: tool.name,
        arguments: {},
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "原任务完成" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("a task continuation keeps the MCP service session when config is unchanged", { timeout: 30_000 }, async () => {
  const model = new ChainSessionModel();
  const fixture = createFixtureWithModel(model);
  try {
    const workspace = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).workspaceDir;
    const serverPath = path.join(workspace, "chain-counter.mjs");
    fs.writeFileSync(
      serverPath,
      [
        `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
        `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
        "const server=new McpServer({name:'chain-stateful',version:'1'});let counter=0;",
        "server.registerTool('advance',{inputSchema:{}},async()=>({content:[{type:'text',text:String(++counter)}]}));",
        "await server.connect(new StdioServerTransport());",
      ].join("\n"),
      "utf8",
    );
    const resource = fixture.app.services.resources.create({
      kind: "mcp",
      name: "chain-counter",
      config: { command: process.execPath, args: [serverPath], env: {} },
    });
    addBinding(fixture, "mcp", resource.resourceId);
    submit(fixture, "先执行一次，再继续完成");
    await waitUntil(() => model.requests.length >= 2);
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
    model.release();
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const outputs = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT adapted_result_json FROM tool_results ORDER BY rowid ASC",
        )
        .all() as Array<{ adapted_result_json: string }>,
    );
    assert.deepEqual(
      outputs.map((row) => JSON.parse(row.adapted_result_json)),
      ["1", "2"],
    );
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
  } finally {
    model.release();
    await fixture.close();
  }
});

class DisabledChainModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  readonly mcpToolCounts: number[] = [];
  private releaseGate: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  release(): void {
    this.releaseGate?.();
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.mcpToolCounts.push(
      request.tools.filter((tool) => tool.name.startsWith("mcp_")).length,
    );
    if (this.requests.length === 1) {
      const read = request.tools.find((candidate) =>
        candidate.name.includes("workspace_read"),
      );
      assert.ok(read);
      yield {
        type: "tool_call",
        callId: "chain-read",
        name: read.name,
        arguments: { path: "note.md" },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (this.requests.length === 2) {
      yield { type: "text_delta", text: "读取完成" };
      await this.gate;
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    if (this.requests.length === 3) {
      yield { type: "text_delta", text: "先回应新消息" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    if (this.requests.length === 4) {
      const write = request.tools.find((candidate) =>
        candidate.name.includes("workspace_write"),
      );
      assert.ok(write);
      yield {
        type: "tool_call",
        callId: "chain-write",
        name: write.name,
        arguments: {
          path: "chain-result.md",
          content: "链内关闭后仍可写",
        },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (this.requests.length === 5) {
      yield { type: "text_delta", text: "原任务完成" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    assert.equal(this.mcpToolCounts.at(-1), 0);
    yield { type: "text_delta", text: "新一轮无外部工具" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("a disabled MCP resource still serves an active task chain and is released afterwards", { timeout: 30_000 }, async () => {
  const model = new DisabledChainModel();
  const fixture = createFixtureWithModel(model);
  try {
    const { workspace, resourceId } = addWorkspaceMcp(fixture);
    fs.writeFileSync(
      path.join(workspace, "note.md"),
      "旧地图在书桌抽屉里。",
      "utf8",
    );
    submit(fixture, "读取后继续保存成果");
    await waitUntil(() => model.requests.length >= 2);
    fixture.app.services.resources.update(resourceId, { enabled: false });
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
    model.release();
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(
      fs.readFileSync(path.join(workspace, "chain-result.md"), "utf8"),
      "链内关闭后仍可写",
    );
    assert.ok((model.mcpToolCounts[3] ?? 0) > 0);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");

    submit(fixture, "现在再来一轮");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.mcpToolCounts[5], 0);
  } finally {
    model.release();
    await fixture.close();
  }
});

for (const disable of ["resource", "binding"] as const) {
  test(`a task continuation retains its disabled model ${disable} without admitting new work`, { timeout: 30_000 }, async () => {
    const model = new DisabledChainModel();
    const modelConfigs: string[] = [];
    const fixture = createFixtureWithModel(model, {
      modelPortFactory: (binding) => {
        modelConfigs.push(binding.config.baseUrl);
        return model;
      },
    });
    try {
      const { workspace } = addWorkspaceMcp(fixture);
      fs.writeFileSync(path.join(workspace, "note.md"), "读取后还需保存成果");
      submit(fixture, "读取资料并保存结果");
      await waitUntil(() => model.requests.length === 2);
      submit(fixture, "先回答这条消息");
      await waitUntil(() => fixture.app.services.messages
        .list(fixture.roleId, fixture.windowId, 0, 20)
        .items.some((message) => message.status === "completed" && message.content === "先回应新消息"));
      const bindings = fixture.app.services.resources.listBindings(fixture.roleId);
      const chat = bindings.find((item) => item.capability === "chat_model");
      assert.ok(chat);
      if (disable === "resource") {
        fixture.app.services.resources.update(chat.resourceId, { enabled: false });
      } else {
        fixture.app.services.resources.replaceBindings(fixture.roleId, bindings.map((item) => ({
          capability: item.capability,
          resourceId: item.resourceId,
          ...(item.modelName === null ? {} : { modelName: item.modelName }),
          enabled: item.capability === "chat_model" ? false : item.enabled,
        })));
      }
      fixture.app.services.resources.update(chat.resourceId, {
        config: { protocol: "openai-chat", baseUrl: "http://updated.invalid/v1" },
      });
      // 未完成用户消息不能阻塞原任务，也不能借原任务获得关闭的模型。
      submit(fixture, "关闭模型后的新消息");
      model.release();
      await waitUntil(() => fixture.app.conversation.listTasks(fixture.roleId)[0]?.status === "completed");
      assert.equal(fs.readFileSync(path.join(workspace, "chain-result.md"), "utf8"), "链内关闭后仍可写");
      await delay(100);
      assert.equal(model.requests.length, 5);
      assert.deepEqual(modelConfigs.slice(3), ["http://updated.invalid/v1", "http://updated.invalid/v1"]);
      assert.equal(fixture.app.conversation.listTasks(fixture.roleId).length, 1);
      const pending = withStorage(fixture, (storage) => storage.business.db
        .prepare("SELECT processed_by_execution_id FROM messages WHERE content=?")
        .get("关闭模型后的新消息")) as { processed_by_execution_id: string | null };
      assert.equal(pending.processed_by_execution_id, null);
    } finally {
      model.release();
      await fixture.close();
    }
  });
}

class HandshakeToolModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.messages.some((message) => message.role === "tool")) {
      yield { type: "text_delta", text: "收到结果" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    const tool = request.tools.find((candidate) =>
      candidate.name.includes("write_result"),
    );
    assert.ok(tool);
    yield {
      type: "tool_call",
      callId: "handshake-wire",
      name: tool.name,
      arguments: {},
    };
    yield { type: "completed", stopReason: "tool_calls" };
  }
}

test("ending a task during MCP connect prevents the pending dispatch", { timeout: 30_000 }, async () => {
  const fixture = createFixtureWithModel(new HandshakeToolModel());
  const workspace = rolePaths(
    fixture.app.config.dataRoot,
    fixture.roleId,
  ).workspaceDir;
  try {
    const serverPath = path.join(workspace, "slow-connect.mjs");
    fs.writeFileSync(
      serverPath,
      [
        "import fs from 'node:fs';",
        `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
        `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
        "const launches=fs.existsSync('launches')?Number(fs.readFileSync('launches','utf8'))+1:1;fs.writeFileSync('launches',String(launches));",
        "if(launches>1){fs.writeFileSync('connecting','');const deadline=Date.now()+7000;while(!fs.existsSync('connect-release')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));}",
        "const server=new McpServer({name:'connect-review',version:'1'});",
        "server.registerTool('write_result',{inputSchema:{}},async()=>{fs.writeFileSync('late-result.txt','actual side effect');return {content:[{type:'text',text:'written'}]};});",
        "await server.connect(new StdioServerTransport());",
      ].join("\n"),
      "utf8",
    );
    const resource = fixture.app.services.resources.create({
      kind: "mcp",
      name: "handshake",
      config: { command: process.execPath, args: [serverPath], env: {} },
    });
    addBinding(fixture, "mcp", resource.resourceId);
    submit(fixture, "执行一个工具");
    await waitUntil(() => fs.existsSync(path.join(workspace, "connecting")));
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
    assert.ok(task);
    fixture.app.conversation.finishTask({
      roleId: fixture.roleId,
      taskId: task.taskId,
      status: "completed",
      endReason: "连接期间结束任务",
    });
    fs.writeFileSync(path.join(workspace, "connect-release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(
      fs.existsSync(path.join(workspace, "late-result.txt")),
      false,
    );
    const detail = withStorage(fixture, (storage) => {
      const executions = storage.business.db
        .prepare(
          "SELECT execution_id, status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{
        execution_id: string;
        status: string;
      }>;
      const results = storage.business.db
        .prepare(
          "SELECT status, diagnostic_code FROM tool_results ORDER BY rowid ASC",
        )
        .all() as Array<{
        status: string;
        diagnostic_code: string | null;
      }>;
      const events = storage.business.db
        .prepare(
          "SELECT event_type, payload_json FROM execution_stream_events WHERE execution_id = ? ORDER BY stream_event_id ASC",
        )
        .all(executions[0]?.execution_id ?? "") as Array<{
        event_type: string;
        payload_json: string;
      }>;
      return { executions, results, events };
    });
    assert.deepEqual(detail.executions.map((row) => row.status), ["failed"]);
    assert.deepEqual(
      detail.results.map((row) => [row.status, row.diagnostic_code]),
      [["failed", "TASK_ENDED"]],
    );
    const failure = detail.events.find(
      (event) => event.event_type === "execution_failed",
    );
    assert.ok(failure);
    assert.equal(
      (JSON.parse(failure.payload_json) as { errorCode?: string }).errorCode,
      "TASK_ENDED",
    );
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
  } finally {
    fs.writeFileSync(path.join(workspace, "connect-release"), "");
    await fixture.close();
  }
});

class SupersedeDuringConnectModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const toolMessages = request.messages.filter(
      (message) => message.role === "tool",
    );
    const tool = request.tools.find((candidate) =>
      candidate.name.includes("write_result"),
    );
    assert.ok(tool);
    if (
      toolMessages.some((message) => message.toolCallId === "retry-wire")
    ) {
      yield { type: "text_delta", text: "重试完成" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    if (
      toolMessages.some((message) =>
        String(message.content).includes("EXECUTION_SUPERSEDED"),
      )
    ) {
      yield {
        type: "tool_call",
        callId: "retry-wire",
        name: tool.name,
        arguments: {},
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (this.requests.length === 1) {
      yield {
        type: "tool_call",
        callId: "first-wire",
        name: tool.name,
        arguments: {},
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "先回应新消息" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("a new message during MCP connect abandons that dispatch and continues the task", { timeout: 30_000 }, async () => {
  const fixture = createFixtureWithModel(new SupersedeDuringConnectModel());
  const workspace = rolePaths(
    fixture.app.config.dataRoot,
    fixture.roleId,
  ).workspaceDir;
  try {
    const serverPath = path.join(workspace, "supersede-connect.mjs");
    fs.writeFileSync(
      serverPath,
      [
        "import fs from 'node:fs';",
        `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
        `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
        "const launches=fs.existsSync('launches')?Number(fs.readFileSync('launches','utf8'))+1:1;fs.writeFileSync('launches',String(launches));",
        "if(launches===2){fs.writeFileSync('connecting','');const deadline=Date.now()+7000;while(!fs.existsSync('connect-release')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));}",
        "const server=new McpServer({name:'supersede-connect',version:'1'});",
        "server.registerTool('write_result',{inputSchema:{}},async()=>{fs.writeFileSync('late-result.txt','actual side effect');return {content:[{type:'text',text:'written'}]};});",
        "await server.connect(new StdioServerTransport());",
      ].join("\n"),
      "utf8",
    );
    const resource = fixture.app.services.resources.create({
      kind: "mcp",
      name: "supersede-handshake",
      config: { command: process.execPath, args: [serverPath], env: {} },
    });
    addBinding(fixture, "mcp", resource.resourceId);
    submit(fixture, "执行一个工具");
    await waitUntil(() => fs.existsSync(path.join(workspace, "connecting")));
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
    fs.writeFileSync(path.join(workspace, "connect-release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(
      fs.existsSync(path.join(workspace, "late-result.txt")),
      true,
    );
    const detail = withStorage(fixture, (storage) => {
      const calls = storage.business.db
        .prepare(
          "SELECT c.status AS call_status, r.diagnostic_code FROM tool_calls c LEFT JOIN tool_results r ON r.tool_call_id = c.tool_call_id ORDER BY c.rowid ASC",
        )
        .all() as Array<{
        call_status: string;
        diagnostic_code: string | null;
      }>;
      const executions = storage.business.db
        .prepare(
          "SELECT status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{ status: string }>;
      return { calls, executions };
    });
    assert.deepEqual(
      detail.calls.map((row) => [row.call_status, row.diagnostic_code]),
      [
        ["failed", "EXECUTION_SUPERSEDED"],
        ["success", null],
      ],
    );
    assert.deepEqual(detail.executions.map((row) => row.status), [
      "superseded",
      "completed",
      "completed",
    ]);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
  } finally {
    fs.writeFileSync(path.join(workspace, "connect-release"), "");
    await fixture.close();
  }
});
