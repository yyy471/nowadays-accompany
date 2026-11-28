import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DEFAULT_MAX_TOOL_ROUNDS } from "../../src/application/conversation/agent-graph.js";
import { createAdminTools, SELF_MODIFICATION_CODE } from "../../src/application/role/admin-tools.js";
import { loadAgentTools } from "../../src/application/conversation/agent-tools.js";
import { createBackendApp, listen } from "../../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../../src/bootstrap/config.js";
import { XIA_CHENG_BUILTIN_KEY } from "../../src/application/role/preset-assistant.js";
import { AppError, StorageError } from "../../src/domain/errors.js";
import type { ConversationTool, ConversationToolContext } from "../../src/domain/conversation.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../../src/domain/model.js";
import {
  addBinding,
  createFixtureWithModel,
  withStorage,
  type Fixture,
} from "../fixtures/conversation-fixture.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error("P20_WAIT_TIMEOUT");
}

function submit(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}

function toolNames(request: ModelRequest): string[] {
  return request.tools.map((tool) => tool.name);
}

function lastToolName(request: ModelRequest): string | null {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === "tool") {
      return message.toolName ?? null;
    }
  }
  return null;
}

/**
 * 本地 stdio MCP 样例：联网搜索（快）、桌面控制（慢，可放行）、必失败工具。
 * 用于离线验证工具发现、参数校验、调用保存、慢工具转后台与错误恢复。
 */
function writeSampleMcpServer(filePath: string, stateDir: string): void {
  const sdkDir = path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm");
  const serverUrl = pathToFileURL(path.join(sdkDir, "server/mcp.js")).href;
  const transportUrl = pathToFileURL(path.join(sdkDir, "server/stdio.js")).href;
  const code = `
    import fs from "node:fs";
    import path from "node:path";
    import { McpServer } from ${JSON.stringify(serverUrl)};
    import { StdioServerTransport } from ${JSON.stringify(transportUrl)};
    import { z } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/zod/index.js")).href)};
    const stateDir = ${JSON.stringify(stateDir)};
    const server = new McpServer({ name: "pack2-tools", version: "1.0.0" });
    server.registerTool(
      "search_web",
      { inputSchema: { query: z.string().optional() } },
      async ({ query }) => ({ content: [{ type: "text", text: "搜索结果：关于 " + String(query) + " 的摘要" }] }),
    );
    server.registerTool(
      "desktop_control",
      { inputSchema: { action: z.string().optional() } },
      async ({ action }) => {
        fs.writeFileSync(path.join(stateDir, "desktop-started"), String(action));
        const deadline = Date.now() + 20000;
        while (!fs.existsSync(path.join(stateDir, "desktop-release")) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { content: [{ type: "text", text: "桌面操作完成：" + String(action) }] };
      },
    );
    server.registerTool(
      "fail_tool",
      { inputSchema: {} },
      async () => {
        throw new Error("DESKTOP_PERMISSION_DENIED");
      },
    );
    await server.connect(new StdioServerTransport());
  `;
  fs.writeFileSync(filePath, code, "utf8");
}

function addSampleMcp(fixture: Fixture, stateDir: string): string {
  const serverPath = path.join(stateDir, "pack2-mcp.mjs");
  writeSampleMcpServer(serverPath, stateDir);
  const resource = fixture.app.services.resources.create({
    kind: "mcp",
    name: "pack2",
    config: { command: process.execPath, args: [serverPath], env: {} },
  });
  addBinding(fixture, "mcp", resource.resourceId);
  return resource.resourceId;
}

function executionsOf(fixture: Fixture): Array<{ status: string; trigger: string }> {
  return withStorage(fixture, (storage) =>
    storage.business.db
      .prepare(
        "SELECT status, trigger_type AS trigger FROM executions WHERE role_id = ? ORDER BY rowid ASC",
      )
      .all(fixture.roleId),
  ) as Array<{ status: string; trigger: string }>;
}

function assistantReplies(fixture: Fixture): number {
  return withStorage(fixture, (storage) => {
    const row = storage.business.db
      .prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE window_id = ? AND sender = 'assistant' AND status = 'completed'",
      )
      .get(fixture.windowId) as { count: number };
    return row.count;
  });
}

function toolCallCount(fixture: Fixture, taskId: string): number {
  return withStorage(fixture, (storage) => {
    const row = storage.business.db
      .prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE task_id = ?")
      .get(taskId) as { count: number };
    return row.count;
  });
}

test("包2：单段默认 15 轮，达到上限提交进度并自动续行，任务不失败也不拉黑窗口", { timeout: 60_000 }, async () => {
  assert.equal(DEFAULT_MAX_TOOL_ROUNDS, 15);
  let segmentPings = 0;
  const seen: ModelRequest[] = [];
  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      seen.push(request);
      const turn = request.turnContext ?? "";
      if (turn.includes("本段收尾")) {
        yield { type: "text_delta", text: "本段进度已保存，继续推进。" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      const finish = request.tools.find((tool) => tool.name === "task_finish");
      const ping = request.tools.find((tool) => tool.name.endsWith("_search_web"));
      assert.ok(finish && ping);
      const last = request.messages.at(-1);
      if (last?.role === "user") {
        segmentPings = 0;
        yield { type: "tool_call", callId: "wire-ping-0", name: ping.name, arguments: {} };
        yield { type: "completed", stopReason: "tool_calls" };
        return;
      }
      if (lastToolName(request) === "task_finish") {
        yield { type: "text_delta", text: "全部步骤已完成。" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      if (turn.includes("当前执行在继续原任务")) {
        if (segmentPings === 0) {
          segmentPings += 1;
          yield { type: "tool_call", callId: "wire-ping-c", name: ping.name, arguments: {} };
          yield { type: "completed", stopReason: "tool_calls" };
          return;
        }
        yield {
          type: "tool_call",
          callId: "wire-finish",
          name: finish.name,
          arguments: { status: "completed", endReason: "两步都已完成" },
        };
        yield { type: "completed", stopReason: "tool_calls" };
        return;
      }
      segmentPings += 1;
      yield {
        type: "tool_call",
        callId: `wire-ping-${segmentPings}`,
        name: ping.name,
        arguments: {},
      };
      yield { type: "completed", stopReason: "tool_calls" };
    },
  } as ModelPort;

  const fixture = createFixtureWithModel(model, { maxToolRounds: 4 });
  const stateDir = path.join(fixture.root, "mcp-state");
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    addSampleMcp(fixture, stateDir);
    submit(fixture, "分两段推进这个多步任务");
    await waitUntil(
      () => fixture.app.conversation.listTasks(fixture.roleId)[0]?.status === "completed",
      40_000,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const task = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
    assert.equal(task.status, "completed");
    const executions = executionsOf(fixture);
    assert.ok(executions.length >= 2, "应至少包含首段与自动续行两段");
    assert.ok(
      executions.every((row) => row.status !== "failed"),
      `不应因轮次上限失败：${JSON.stringify(executions)}`,
    );
    assert.ok(
      executions.some((row) => row.trigger === "tool_result"),
      "续行段应使用 tool_result 触发",
    );
    // 首段在 4 轮上限处停止派发：只保存实际执行过的 ping 调用。
    assert.ok(
      seen.some((request) => (request.turnContext ?? "").includes("本段收尾（round_limit）")),
      "达到上限时应进入无工具的收尾说明轮",
    );
    // 窗口没有被拉黑：完成后再发消息仍能得到新回复。
    const repliesBefore = assistantReplies(fixture);
    submit(fixture, "再确认一句");
    await waitUntil(() => assistantReplies(fixture) > repliesBefore);
  } finally {
    await fixture.close();
  }
});

test("包2：task_pause 立即停止同批派发，用户同窗回复自动接回原 taskId", { timeout: 60_000 }, async () => {
  let paused = false;
  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      const turn = request.turnContext ?? "";
      if (turn.includes("本段收尾（pause_requested）")) {
        paused = true;
        yield { type: "text_delta", text: "我先停一下，等你确认后再继续这份文件。" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      const ping = request.tools.find((tool) => tool.name.endsWith("_search_web"));
      const pause = request.tools.find((tool) => tool.name === "task_pause");
      const progress = request.tools.find((tool) => tool.name === "task_progress");
      const finish = request.tools.find((tool) => tool.name === "task_finish");
      assert.ok(ping && pause && progress && finish);
      if (lastToolName(request) === "task_finish") {
        yield { type: "text_delta", text: "按你说的继续，已经收尾。" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      if (turn.includes("当前执行在继续原任务")) {
        assert.match(turn, /任务目标/);
        // 接回原任务时应重放已保存的真实工具结果与笔记。
        assert.match(turn, /已读完上面材料/);
        assert.ok(
          request.messages.some(
            (message) =>
              message.role === "tool" &&
              String(message.content).includes("搜索结果"),
          ),
          "接回原任务需要重放已保存的工具结果",
        );
        yield {
          type: "tool_call",
          callId: "wire-finish",
          name: finish.name,
          arguments: { status: "completed", endReason: "用户答复后收尾" },
        };
        yield { type: "completed", stopReason: "tool_calls" };
        return;
      }
      const last = request.messages.at(-1);
      if (last?.role === "user" && !paused) {
        yield { type: "tool_call", callId: "wire-ping", name: ping.name, arguments: {} };
        yield { type: "completed", stopReason: "tool_calls" };
        return;
      }
      if (!paused) {
        // 同一批里先暂停，后面的进度笔记调用必须被跳过（不得派发）。
        yield {
          type: "tool_call",
          callId: "wire-pause",
          name: pause.name,
          arguments: { reason: "需要用户确认", note: "已读完上面材料" },
        };
        yield {
          type: "tool_call",
          callId: "wire-note",
          name: progress.name,
          arguments: { note: "这条笔记不应被写入" },
        };
        yield { type: "completed", stopReason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "等你答复。" };
      yield { type: "completed", stopReason: "stop" };
    },
  } as ModelPort;

  const fixture = createFixtureWithModel(model);
  const stateDir = path.join(fixture.root, "mcp-state");
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    addSampleMcp(fixture, stateDir);
    submit(fixture, "先读一段，然后停下来问我");
    await waitUntil(
      () => fixture.app.conversation.listTasks(fixture.roleId)[0]?.status === "paused",
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
    assert.equal(task.waitReason, "AWAITING_USER_INPUT");
    assert.equal(task.continuable, true);

    const notes = withStorage(fixture, (storage) =>
      storage.business.listTaskNotes(fixture.roleId, task.taskId),
    );
    assert.equal(notes.length, 1, "暂停后的同批笔记调用不应执行");
    assert.match(notes[0]!.note, /已读完上面材料/);

    // 用户在同一窗口回复：自动接回原任务，不新开任务链。
    submit(fixture, "可以继续了，按这个思路收尾");
    await waitUntil(
      () => fixture.app.conversation.getTask(fixture.roleId, task.taskId).status === "completed",
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(fixture.app.conversation.listTasks(fixture.roleId).length, 1);
    const relations = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT relation FROM execution_tasks WHERE task_id = ? ORDER BY rowid ASC",
        )
        .all(task.taskId),
    ) as Array<{ relation: string }>;
    assert.deepEqual(
      relations.map((row) => row.relation),
      ["initiates", "continues"],
      "同窗回复应以 continues 关系接回原任务",
    );
  } finally {
    await fixture.close();
  }
});

test("包2：同一工具连续失败 3 次触发熔断暂停并说明障碍", { timeout: 60_000 }, async () => {
  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      const turn = request.turnContext ?? "";
      if (turn.includes("本段收尾（circuit_breaker）")) {
        assert.match(turn, /熔断/);
        yield { type: "text_delta", text: "连续操作都被拒绝，我先停下来说明情况。" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      const fail = request.tools.find((tool) => tool.name.endsWith("_fail_tool"));
      assert.ok(fail);
      // 一批里连续调用 4 次：前 3 次失败后熔断，第 4 次不应派发。
      for (let index = 0; index < 4; index += 1) {
        yield {
          type: "tool_call",
          callId: `wire-fail-${index}`,
          name: fail.name,
          arguments: {},
        };
      }
      yield { type: "completed", stopReason: "tool_calls" };
    },
  } as ModelPort;

  const fixture = createFixtureWithModel(model);
  const stateDir = path.join(fixture.root, "mcp-state");
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    addSampleMcp(fixture, stateDir);
    submit(fixture, "反复尝试打开桌面应用");
    await waitUntil(
      () => fixture.app.conversation.listTasks(fixture.roleId)[0]?.status === "paused",
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
    assert.equal(task.endReason, "TASK_CIRCUIT_BREAKER");
    assert.equal(task.waitReason, "CIRCUIT_BREAKER");
    assert.equal(task.consecutiveFailures, 3);
    assert.equal(toolCallCount(fixture, task.taskId), 3, "熔断后同批第 4 次调用不应派发");
    const failureCodes = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT diagnostic_code AS code FROM tool_results tr JOIN tool_calls tc ON tc.tool_call_id = tr.tool_call_id WHERE tc.task_id = ? ORDER BY tr.rowid ASC",
        )
        .all(task.taskId),
    ) as Array<{ code: string | null }>;
    assert.equal(failureCodes.length, 3);
    const codes = new Set(failureCodes.map((row) => row.code));
    assert.equal(codes.size, 1, "同一错误码才计入连续失败");
  } finally {
    await fixture.close();
  }
});

test("包2：连续 3 段续行没有新工具结果与进度笔记时熔断暂停", { timeout: 90_000 }, async () => {
  let greetingSent = false;
  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      if ((request.turnContext ?? "").includes("本段收尾")) {
        yield { type: "text_delta", text: "这一段我先记下，稍后继续。" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      const ping = request.tools.find((tool) => tool.name.endsWith("_search_web"));
      const cont = request.tools.find((tool) => tool.name === "task_continue");
      assert.ok(ping && cont);
      const last = request.messages.at(-1);
      if (last?.role === "user" && !greetingSent) {
        greetingSent = true;
        yield { type: "tool_call", callId: "wire-ping", name: ping.name, arguments: {} };
        yield { type: "completed", stopReason: "tool_calls" };
        return;
      }
      // 之后每段只声明续行，不产生新工具结果也不写笔记：应累计无进展并熔断。
      const round = request.messages.length;
      yield {
        type: "tool_call",
        callId: `wire-cont-${round}`,
        name: cont.name,
        arguments: {},
      };
      yield { type: "completed", stopReason: "tool_calls" };
    },
  } as ModelPort;

  const fixture = createFixtureWithModel(model);
  const stateDir = path.join(fixture.root, "mcp-state");
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    addSampleMcp(fixture, stateDir);
    submit(fixture, "把这件事推进完");
    await waitUntil(
      () => fixture.app.conversation.listTasks(fixture.roleId)[0]?.status === "paused",
      70_000,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
    assert.equal(task.endReason, "TASK_CIRCUIT_BREAKER");
    assert.equal(task.waitReason, "CIRCUIT_BREAKER");
    assert.equal(task.consecutiveNoProgress, 3);
    const notices = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT content FROM messages WHERE window_id = ? AND sender = 'assistant' ORDER BY sequence ASC",
        )
        .all(fixture.windowId),
    ) as Array<{ content: string }>;
    assert.ok(
      notices.some((row) => row.content.includes("任务先暂停一下")),
      "无进展熔断应向当前窗口提交可见说明",
    );
  } finally {
    await fixture.close();
  }
});

function adminToolContext(): ConversationToolContext {
  return {
    roleId: "",
    windowId: "",
    executionId: "",
    taskId: null,
    signal: new AbortController().signal,
  };
}

async function callAdminTool(
  tools: readonly ConversationTool[],
  name: string,
  args: Record<string, unknown>,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `应存在管理工具 ${name}`);
  return tool.execute(args, adminToolContext());
}

test("包2：夏澄内部管理工具只挂载到内置助手，读写边界与自改红线生效", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p20-admin-"));
  const presetsDir = path.join(root, "presets");
  fs.mkdirSync(presetsDir, { recursive: true });
  const config = parseBackendConfig([
    "--app-root",
    path.join(root, "app"),
    "--preset-assets-dir",
    presetsDir,
    "--port",
    "0",
  ]);
  const app = createBackendApp(config, { disableMemoryRuntime: true });
  try {
    const builtinIndex = app.appStore.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY);
    assert.ok(builtinIndex);
    const builtinId = builtinIndex.roleId;
    const modelRes = app.services.resources.create({
      kind: "model",
      name: "管理测试模型",
      config: { protocol: "openai-chat", baseUrl: "http://offline.invalid/v1" },
    });
    const mcpRes = app.services.resources.create({
      kind: "mcp",
      name: "管理测试MCP",
      enabled: false,
      config: { command: process.execPath, args: ["-e", "process.exit(0)"], env: {} },
    });
    app.services.resources.replaceBindings(builtinId, [
      {
        capability: "chat_model",
        resourceId: modelRes.resourceId,
        modelName: "offline-chat",
        enabled: true,
      },
    ]);

    // 主角色换名后，普通同名角色仍然不能获得管理工具。
    app.services.roles.updateDefinition(builtinId, { displayName: "岚" });
    const ordinary = app.services.roles.createRole({
      displayName: "岚",
      definition: { text: "普通人设" },
    });
    const ordinaryCatalog = await loadAgentTools({
      roleId: ordinary.roleId,
      appStore: app.appStore,
      roleAccess: app.roleAccess,
      memory: app.services.memory,
      autonomy: app.services.autonomy,
      appRoot: config.appRoot,
      workspaceDir: rolePaths(config.dataRoot, ordinary.roleId).workspaceDir,
      admin: {
        roles: app.services.roles,
        activity: app.services.activity,
        messages: app.services.messages,
        memory: app.services.memory,
        autonomy: app.services.autonomy,
        resources: app.services.resources,
        modelServices: app.services.modelServices,
        voiceServices: app.services.voiceServices,
        imageServices: app.services.imageServices,
        now: () => new Date(),
      },
    });
    try {
      assert.ok(
        !ordinaryCatalog.tools.some((tool) => tool.name.startsWith("app_")),
        "普通角色不应挂载内部管理工具",
      );
    } finally {
      await ordinaryCatalog.close();
    }

    const tools = createAdminTools({
      builtinRoleId: builtinId,
      roles: app.services.roles,
      activity: app.services.activity,
      messages: app.services.messages,
      memory: app.services.memory,
      autonomy: app.services.autonomy,
      conversation: app.conversation,
      resources: app.services.resources,
      modelServices: app.services.modelServices,
      voiceServices: app.services.voiceServices,
      imageServices: app.services.imageServices,
      voice: app.services.voice,
      sceneImageSettings: app.services.sceneImageSettings,
      now: () => new Date(),
    });

    const rolesList = await callAdminTool(tools, "app_roles_list", {});
    assert.equal(rolesList.status, "success");
    const listed = rolesList.adaptedResult as Array<Record<string, unknown>>;
    assert.ok(listed.some((role) => role.isBuiltin === true));
    assert.ok(listed.some((role) => role.roleId === ordinary.roleId));

    const media = await callAdminTool(tools, "app_media_services_list", {});
    assert.equal(media.status, "success");
    assert.ok(Array.isArray((media.adaptedResult as { voice: unknown[] }).voice));

    // DL-159 方案 A：主角色运行中可直接自改热生效的轻量偏好，且不影响活动态。
    app.services.activity.resume(builtinId);
    assert.equal(app.services.activity.view(builtinId).state, "active");

    const budget = await callAdminTool(tools, "app_role_autonomy_set", {
      roleId: builtinId,
      unlimited: false,
      dailyLimit: 7,
    });
    assert.equal(budget.status, "success");
    const savedBudget = app.services.autonomy.getBudget(builtinId);
    assert.equal(savedBudget.unlimited, false);
    assert.equal(savedBudget.dailyLimit, 7);
    assert.equal(app.services.activity.view(builtinId).state, "active");

    const originalBooks = app.services.roles.getWorldbooks(builtinId);
    const savedBooks = await callAdminTool(tools, "app_role_worldbooks_set", {
      roleId: builtinId,
      expectedRevision: String(originalBooks.revision),
      books: [
        {
          id: "wb-self",
          name: "自改世界书",
          enabled: true,
          entries: [
            {
              id: "entry-self",
              title: "自改条目",
              keywords: ["自改"],
              content: "主角色在对话中写入的世界书条目。",
              enabled: true,
              visibility: "known",
            },
          ],
        },
      ],
    });
    assert.equal(savedBooks.status, "success");
    assert.equal(app.services.activity.view(builtinId).state, "active");
    const worldbooksQuery = await callAdminTool(tools, "app_role_records_query", {
      roleId: builtinId,
      kind: "worldbooks",
    });
    assert.equal(worldbooksQuery.status, "success");
    const bookSnapshot = worldbooksQuery.adaptedResult as {
      revision: number;
      books: Array<{ id: string }>;
    };
    assert.ok(bookSnapshot.books.some((book) => book.id === "wb-self"));
    assert.equal(app.services.activity.view(builtinId).state, "active");

    app.services.voice.saveVoice(builtinId, { baseUrl: "http://127.0.0.1:1" });
    assert.equal(app.services.voice.getVoice(builtinId).voice?.enabled, true);
    const voiceToggle = await callAdminTool(tools, "app_role_voice_toggle", {
      roleId: builtinId,
      enabled: false,
    });
    assert.equal(voiceToggle.status, "success");
    assert.equal(app.services.voice.getVoice(builtinId).voice?.enabled, false);
    assert.equal(app.services.activity.view(builtinId).state, "active");
    const voiceQuery = await callAdminTool(tools, "app_role_records_query", {
      roleId: builtinId,
      kind: "voice",
    });
    assert.equal(voiceQuery.status, "success");
    const voiceView = voiceQuery.adaptedResult as {
      voice: { enabled: boolean } | null;
    };
    assert.equal(voiceView.voice?.enabled, false);
    assert.equal(app.services.activity.view(builtinId).state, "active");

    const imageService = app.services.imageServices.create({
      name: "管理测试生图",
      config: { protocol: "comfyui", baseUrl: "http://127.0.0.1:1" },
    });
    const sceneImageSet = await callAdminTool(tools, "app_role_scene_image_set", {
      roleId: builtinId,
      serviceId: imageService.serviceId,
      modelType: "text2img",
      modelPath: "offline.safetensors",
      sampler: "er_sde",
      scheduler: "simple",
    });
    assert.equal(sceneImageSet.status, "success");
    assert.equal(app.services.activity.view(builtinId).state, "active");
    const sceneImageQuery = await callAdminTool(tools, "app_role_records_query", {
      roleId: builtinId,
      kind: "scene_image",
    });
    assert.equal(sceneImageQuery.status, "success");
    const sceneView = sceneImageQuery.adaptedResult as {
      settings: { serviceId: string } | null;
      configured: boolean;
    };
    assert.equal(sceneView.settings?.serviceId, imageService.serviceId);
    assert.equal(sceneView.configured, true);
    assert.equal(app.services.activity.view(builtinId).state, "active");

    // 普通角色运行中改设定：先停到确认停止，写入后按原状态恢复。
    app.services.activity.resume(ordinary.roleId);
    const updated = await callAdminTool(tools, "app_role_update", {
      roleId: ordinary.roleId,
      definitionText: "更新后的普通人设",
    });
    assert.equal(updated.status, "success");
    assert.equal(app.services.roles.getRole(ordinary.roleId).definition.text, "更新后的普通人设");
    assert.equal(app.services.activity.view(ordinary.roleId).state, "active");

    // 自改红线：改自己人设／绑定、停自己、改自己正在用的模型连接都必须引导去设置页。
    for (const [name, args] of [
      ["app_role_update", { roleId: builtinId, definitionText: "自改" }],
      ["app_role_bindings_set", { roleId: builtinId, bindings: [] }],
      ["app_role_activity", { roleId: builtinId, action: "stop" }],
      ["app_resource_update", { resourceId: modelRes.resourceId, name: "换个名字" }],
      ["app_resource_delete", { resourceId: modelRes.resourceId }],
    ] as const) {
      const rejected = await callAdminTool(tools, name, args as Record<string, unknown>);
      assert.equal(rejected.status, "failed", `${name} 应被拒绝`);
      assert.equal(rejected.diagnosticCode, SELF_MODIFICATION_CODE);
    }
    assert.equal(app.services.roles.getRole(builtinId).displayName, "岚");
    assert.equal(app.services.resources.getView(modelRes.resourceId).name, "管理测试模型");
    assert.equal(app.services.activity.view(builtinId).state, "active");

    // 全局 MCP 只切换开关，不需要停止角色。
    const toggled = await callAdminTool(tools, "app_resource_toggle", {
      resourceId: mcpRes.resourceId,
      enabled: true,
    });
    assert.equal(toggled.status, "success");
    assert.equal(app.services.resources.getView(mcpRes.resourceId).enabled, true);

    const created = await callAdminTool(tools, "app_role_create", {
      displayName: "新助手",
      definitionText: "新建角色人设",
    });
    assert.equal(created.status, "success");
    const newRoleId = (created.adaptedResult as { roleId: string }).roleId;
    assert.equal(app.services.activity.view(newRoleId).state, "stopped");
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("包2 R04：管理工具写入失败后恢复角色活动态并在错误回执中带出恢复结果", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p20-r04-"));
  const presetsDir = path.join(root, "presets");
  fs.mkdirSync(presetsDir, { recursive: true });
  const config = parseBackendConfig([
    "--app-root",
    path.join(root, "app"),
    "--preset-assets-dir",
    presetsDir,
    "--port",
    "0",
  ]);
  const app = createBackendApp(config, { disableMemoryRuntime: true });
  try {
    const builtinIndex = app.appStore.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY);
    assert.ok(builtinIndex);
    const tools = createAdminTools({
      builtinRoleId: builtinIndex.roleId,
      roles: app.services.roles,
      activity: app.services.activity,
      messages: app.services.messages,
      memory: app.services.memory,
      autonomy: app.services.autonomy,
      conversation: app.conversation,
      resources: app.services.resources,
      modelServices: app.services.modelServices,
      voiceServices: app.services.voiceServices,
      imageServices: app.services.imageServices,
      now: () => new Date(),
    });

    const ordinary = app.services.roles.createRole({
      displayName: "R04 普通角色",
      definition: { text: "R04 人设" },
    });
    const model = app.services.resources.create({
      kind: "model",
      name: "R04 模型",
      config: { protocol: "openai-chat", baseUrl: "http://offline.invalid/v1" },
    });
    // 先成功建立 chat_model 绑定，供后续资源维护暂停场景使用。
    const bound = await callAdminTool(tools, "app_role_bindings_set", {
      roleId: ordinary.roleId,
      bindings: [
        {
          capability: "chat_model",
          resourceId: model.resourceId,
          modelName: "offline-chat",
          enabled: true,
        },
      ],
    });
    assert.equal(bound.status, "success");
    const ensureActive = (): void => {
      try {
        app.services.activity.resume(ordinary.roleId);
      } catch {
        // 已是 active 时忽略冲突。
      }
    };
    const stateOf = (): string => app.services.activity.view(ordinary.roleId).state;
    const detailsOf = (outcome: { adaptedResult?: unknown }): Record<string, unknown> =>
      (outcome.adaptedResult as { error: { details: Record<string, unknown> } }).error.details;

    // A. 过期 expectedRevision → BINDING_REVISION_CONFLICT，角色恢复 active。
    ensureActive();
    assert.equal(stateOf(), "active");
    const stale = await callAdminTool(tools, "app_role_bindings_set", {
      roleId: ordinary.roleId,
      bindings: [],
      expectedRevision: "00000000-0000-0000-0000-000000000000",
    });
    assert.equal(stale.status, "failed");
    assert.equal(stale.diagnosticCode, "BINDING_REVISION_CONFLICT");
    assert.equal(detailsOf(stale).roleStopped, true);
    assert.equal(detailsOf(stale).resumed, true);
    assert.equal(stateOf(), "active", "版本冲突失败后角色应恢复 active");

    // B. chat_model 缺 modelName → INVALID_BINDING，角色恢复 active。
    ensureActive();
    const invalid = await callAdminTool(tools, "app_role_bindings_set", {
      roleId: ordinary.roleId,
      bindings: [{ capability: "chat_model", resourceId: model.resourceId }],
    });
    assert.equal(invalid.status, "failed");
    assert.equal(invalid.diagnosticCode, "INVALID_BINDING");
    assert.equal(detailsOf(invalid).roleStopped, true);
    assert.equal(detailsOf(invalid).resumed, true);
    assert.equal(stateOf(), "active", "无效绑定失败后角色应恢复 active");

    // C. app_role_update 真实写入抛错，角色恢复 active，details 带恢复结果。
    ensureActive();
    const rolesService = app.services.roles;
    const originalUpdateDefinition = rolesService.updateDefinition;
    rolesService.updateDefinition = () => {
      throw new StorageError("INJECTED_ROLE_UPDATE_FAILURE");
    };
    try {
      const failed = await callAdminTool(tools, "app_role_update", {
        roleId: ordinary.roleId,
        displayName: "改名失败",
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.diagnosticCode, "STORAGE_ERROR");
      assert.equal(detailsOf(failed).roleStopped, true);
      assert.equal(detailsOf(failed).resumed, true);
      assert.equal(stateOf(), "active", "设定写入失败后角色应恢复 active");
    } finally {
      rolesService.updateDefinition = originalUpdateDefinition;
    }

    // D. 资源连接变更暂停角色后写入失败 → 回滚已暂停角色。
    ensureActive();
    const resourcesService = app.services.resources;
    const originalResourceUpdate = resourcesService.update;
    resourcesService.update = () => {
      throw new StorageError("INJECTED_RESOURCE_UPDATE_FAILURE");
    };
    try {
      const failed = await callAdminTool(tools, "app_resource_update", {
        resourceId: model.resourceId,
        config: { protocol: "openai-chat", baseUrl: "http://changed.invalid/v1" },
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.diagnosticCode, "STORAGE_ERROR");
      const paused = detailsOf(failed).pausedRoleIds as string[];
      const rolledBack = detailsOf(failed).rolledBackRoleIds as string[];
      assert.ok(paused.includes(ordinary.roleId), "连接变更应暂停依赖角色");
      assert.ok(rolledBack.includes(ordinary.roleId), "写入失败应回滚被暂停角色");
      assert.equal(stateOf(), "active", "资源写入失败后已暂停角色应恢复 active");
    } finally {
      resourcesService.update = originalResourceUpdate;
    }

    ensureActive();
    const originalPause = resourcesService.pauseRoles;
    Object.defineProperty(resourcesService, "pauseRoles", { configurable: true, value: async () => {
      app.services.activity.requestStop(ordinary.roleId);
      throw new AppError(409, "ROLES_NOT_STOPPED", "partial", { pausedRoleIds: [ordinary.roleId] });
    }});
    try {
      const failed = await callAdminTool(tools, "app_resource_update", {
        resourceId: model.resourceId,
        config: { protocol: "openai-chat", baseUrl: "http://changed.invalid/v1" },
      });
      assert.equal(failed.diagnosticCode, "ROLES_NOT_STOPPED");
      assert.deepEqual(detailsOf(failed).rolledBackRoleIds, [ordinary.roleId]);
      assert.equal(stateOf(), "active");
    } finally {
      Object.defineProperty(resourcesService, "pauseRoles", { configurable: true, value: originalPause });
    }

  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("包2：本地样例 MCP 完成搜索／桌面控制发现、慢工具转后台与结果回收", { timeout: 90_000 }, async () => {
  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      const names = toolNames(request);
      const search = request.tools.find((tool) => tool.name.endsWith("_search_web"));
      const desktop = request.tools.find((tool) => tool.name.endsWith("_desktop_control"));
      assert.ok(search && desktop, `应发现样例工具：${names.join(",")}`);
      const last = request.messages.at(-1);
      if (last?.role === "user") {
        assert.equal(request.tools[0]?.inputSchema !== undefined, true);
        yield {
          type: "tool_call",
          callId: "wire-search",
          name: search.name,
          arguments: { query: "夏澄是谁" },
        };
        yield { type: "completed", stopReason: "tool_calls" };
        return;
      }
      if (
        last?.role === "tool" &&
        String(last.content).includes("搜索结果")
      ) {
        yield {
          type: "tool_call",
          callId: "wire-desktop",
          name: desktop.name,
          arguments: { action: "open_browser" },
        };
        yield { type: "completed", stopReason: "tool_calls" };
        return;
      }
      if (last?.role === "tool" && String(last.content).includes("桌面操作完成")) {
        yield { type: "text_delta", text: "搜索与桌面操作都完成了。" };
        yield { type: "completed", stopReason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "等待后台结果。" };
      yield { type: "completed", stopReason: "stop" };
    },
  } as ModelPort;

  const fixture = createFixtureWithModel(model, { toolForegroundWaitMs: 400 });
  const stateDir = path.join(fixture.root, "mcp-state");
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    addSampleMcp(fixture, stateDir);
    submit(fixture, "帮我搜一下再调桌面");
    await waitUntil(() => fs.existsSync(path.join(stateDir, "desktop-started")));
    // 越过前台等待窗口后再放行，确保慢工具转后台结算，真实结果回到原任务。
    await delay(800);
    fs.writeFileSync(path.join(stateDir, "desktop-release"), "");
    await waitUntil(
      () => fixture.app.conversation.listTasks(fixture.roleId)[0]?.status === "completed",
      60_000,
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const events = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT event_type FROM execution_stream_events WHERE role_id = ? ORDER BY stream_event_id ASC",
        )
        .all(fixture.roleId),
    ) as Array<{ event_type: string }>;
    assert.ok(
      events.some((event) => event.event_type === "tool_backgrounded"),
      "慢工具应转后台",
    );
    const results = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT tc.tool_name AS name, tr.adapted_result_json AS result
             FROM tool_results tr JOIN tool_calls tc ON tc.tool_call_id = tr.tool_call_id
            ORDER BY tr.rowid ASC`,
        )
        .all(),
    ) as Array<{ name: string; result: string }>;
    const search = results.find((row) => row.name.endsWith("search_web"));
    const desktop = results.find((row) => row.name.endsWith("desktop_control"));
    assert.ok(search && search.result.includes("搜索结果"), "搜索调用结果应保存");
    assert.ok(desktop && desktop.result.includes("桌面操作完成"), "桌面调用真实结果应保存");
  } finally {
    await fixture.close();
  }
});
