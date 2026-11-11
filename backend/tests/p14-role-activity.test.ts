import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { listen, createBackendApp } from "../src/bootstrap/app.js";
import { rolePaths } from "../src/bootstrap/config.js";
import { AppError } from "../src/domain/errors.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import { RoleActivityStore } from "../src/storage/role-activity-store.js";
import {
  addBinding,
  createFixture,
  createFixtureWithModel,
  deferred,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

/**
 * 252 第一包定向用例：角色活动状态、停止边界、配置写入保护与恢复语义。
 * 这里全部走真实 HTTP 接口，不使用 configFetch 测试替身，
 * 以便直接断言 409 拒绝结构与状态机跳转。
 */

interface ActivityView {
  roleId: string;
  state: "active" | "stopping" | "stopped";
  initStatus: string;
  running: boolean;
  requestedAt: string | null;
  confirmedAt: string | null;
  boundaryExecutionId: string | null;
}

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<ApiResult> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
  };
}

function errorOf(result: ApiResult): {
  code: string;
  details: Record<string, unknown> | undefined;
} {
  const error = result.body.error as
    | { code: string; details?: Record<string, unknown> }
    | undefined;
  assert.ok(error, `响应不是结构化错误：${JSON.stringify(result.body)}`);
  return { code: error.code, details: error.details };
}

async function start(fixture: Fixture): Promise<string> {
  const port = await listen(fixture.app.server, 0, "127.0.0.1");
  return `http://127.0.0.1:${port}`;
}

function rolePath(fixture: Fixture): string {
  return `/v1/roles/${fixture.roleId}`;
}

function activityOf(result: ApiResult): ActivityView {
  const activity = result.body.activity as ActivityView | undefined;
  assert.ok(activity, `响应缺少 activity：${JSON.stringify(result.body)}`);
  return activity;
}

function definitionWrite(): Record<string, unknown> {
  return { definition: { text: "停止后修订的设定" } };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(20);
  }
  throw new Error("WAIT_TIMEOUT");
}

test("活动状态独立返回，空闲停止立即确认，写入保护与恢复闭环", async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const role = rolePath(fixture);
    const resourceId = fixture.app.services.resources.list("model")[0]
      ?.resourceId;
    assert.ok(resourceId, "夹具应已创建一个模型服务");

    const listed = await api(base, "GET", "/v1/activities");
    assert.equal(listed.status, 200);
    const items = listed.body.items as ActivityView[];
    assert.equal(items.length, 1);
    assert.equal(items[0]?.state, "active");
    assert.equal(items[0]?.initStatus, "ready");
    assert.equal(items[0]?.running, false);
    assert.equal(items[0]?.requestedAt, null);
    assert.equal(items[0]?.boundaryExecutionId, null);

    const single = await api(base, "GET", `${role}/activity`);
    assert.equal(single.status, 200);
    assert.deepEqual(activityOf(single), items[0]);

    // 初始化状态与活动状态是两件事：ready 的角色仍须显式停止才能写配置。
    const blocked = await api(base, "PATCH", `${role}/definition`, definitionWrite());
    assert.equal(blocked.status, 409);
    assert.deepEqual(errorOf(blocked), {
      code: "ROLE_NOT_STOPPED",
      details: { roleId: fixture.roleId, state: "active", reason: "ACTIVE" },
    });

    const blockedGlobal = await api(
      base,
      "PATCH",
      `/v1/resources/${resourceId}`,
      { name: "不应改名" },
    );
    assert.equal(blockedGlobal.status, 409);
    const globalError = errorOf(blockedGlobal);
    assert.equal(globalError.code, "ROLES_NOT_STOPPED");
    assert.deepEqual(globalError.details?.roles, [
      { roleId: fixture.roleId, state: "active", running: false },
    ]);

    const stopped = await api(base, "POST", `${role}/activity/stop`);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.confirmed, true);
    const stoppedView = activityOf(stopped);
    assert.equal(stoppedView.state, "stopped");
    assert.equal(stoppedView.initStatus, "ready");
    assert.ok(stoppedView.confirmedAt);
    assert.equal(stoppedView.boundaryExecutionId, null);

    const saved = await api(base, "PATCH", `${role}/definition`, definitionWrite());
    assert.equal(saved.status, 200);
    assert.equal(saved.body.definitionRevision, 2);

    const renamed = await api(base, "PATCH", `/v1/resources/${resourceId}`, {
      name: "已停止后改名",
    });
    assert.equal(renamed.status, 200);

    // 已停止的角色不接受新的对话，也不接受新的自主唤醒。
    const blockedMessage = await api(
      base,
      "POST",
      `${role}/windows/${fixture.windowId}/messages`,
      { content: "你好", submissionId: randomUUID() },
    );
    assert.equal(blockedMessage.status, 409);
    assert.equal(errorOf(blockedMessage).code, "ROLE_ACTIVITY_STOPPED");

    const resumed = await api(base, "POST", `${role}/activity/resume`);
    assert.equal(resumed.status, 200);
    const resumedView = activityOf(resumed);
    assert.equal(resumedView.state, "active");
    assert.equal(resumedView.requestedAt, null);
    assert.equal(resumedView.confirmedAt, null);
    assert.equal(resumedView.boundaryExecutionId, null);

    // 恢复后保护继续生效，不会被一次写入永久放行。
    const blockedAgain = await api(
      base,
      "PATCH",
      `${role}/definition`,
      definitionWrite(),
    );
    assert.equal(blockedAgain.status, 409);
    assert.equal(errorOf(blockedAgain).code, "ROLE_NOT_STOPPED");
  } finally {
    await fixture.close();
  }
});

test("状态机拒绝非法跳转，配置写入租约期间拒绝停止与恢复", async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const role = rolePath(fixture);
    const activity = fixture.app.services.activity;

    await api(base, "POST", `${role}/activity/stop`);
    const first = await api(base, "POST", `${role}/activity/resume`);
    assert.equal(first.status, 200);
    assert.equal(activityOf(first).state, "active");

    const second = await api(base, "POST", `${role}/activity/resume`);
    assert.equal(second.status, 409);
    assert.deepEqual(errorOf(second), {
      code: "ROLE_ACTIVITY_CONFLICT",
      details: {
        roleId: fixture.roleId,
        state: "active",
        reason: "NOT_STOPPED",
      },
    });

    // 重复停止是幂等的，仍返回后端已确认的状态。
    const again = await api(base, "POST", `${role}/activity/stop`);
    assert.equal(again.status, 200);
    assert.equal(again.body.confirmed, true);
    assert.equal(activityOf(again).state, "stopped");
    const idempotent = await api(base, "POST", `${role}/activity/stop`);
    assert.equal(idempotent.status, 200);
    assert.equal(activityOf(idempotent).state, "stopped");

    // 角色租约：校验通过到写入完成之间，不允许恢复或重新请求停止。
    const roleGate = deferred<void>();
    const pending = activity.guardRole(fixture.roleId, () => roleGate.promise);
    assert.throws(
      () => activity.resume(fixture.roleId),
      (error: unknown) => {
        assert.ok(error instanceof AppError, String(error));
        assert.equal(error.code, "ROLE_ACTIVITY_CONFLICT");
        assert.deepEqual(error.details, {
          roleId: fixture.roleId,
          state: "stopped",
          reason: "CONFIG_WRITE_IN_PROGRESS",
        });
        return true;
      },
    );
    assert.throws(
      () => activity.requestStop(fixture.roleId),
      (error: unknown) => {
        assert.ok(error instanceof AppError, String(error));
        assert.equal(error.code, "ROLE_ACTIVITY_CONFLICT");
        return true;
      },
    );
    roleGate.resolve();
    await pending;

    // 全局租约：全局写入期间，任何角色都不能恢复。
    const globalGate = deferred<void>();
    const pendingGlobal = activity.guardAll(() => globalGate.promise);
    assert.throws(
      () => activity.resume(fixture.roleId),
      (error: unknown) => {
        assert.ok(error instanceof AppError, String(error));
        assert.equal(error.code, "ROLE_ACTIVITY_CONFLICT");
        assert.deepEqual(error.details, {
          roleId: fixture.roleId,
          state: "stopped",
          reason: "CONFIG_WRITE_IN_PROGRESS",
        });
        return true;
      },
    );
    globalGate.resolve();
    await pendingGlobal;

    const after = await api(base, "POST", `${role}/activity/resume`);
    assert.equal(after.status, 200);
    assert.equal(activityOf(after).state, "active");
  } finally {
    await fixture.close();
  }
});

/**
 * 第一轮先派发一个真实工具，建立任务链；第二轮停在模型节点，释放后报出
 * 下一个工具调用，让图在 toolsNode 入口撞上停止边界。这样暂停的是已存在的任务。
 */
class StopBoundaryModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  readonly started = deferred<void>();
  readonly release = deferred<void>();
  private calls = 0;

  private toolCall(callId: string): ModelEvent {
    return {
      type: "tool_call",
      callId,
      name: "memory_search",
      arguments: { query: "无匹配" },
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.calls += 1;
    if (this.calls === 1) {
      yield this.toolCall("wire-before-stop");
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (this.calls === 2) {
      yield { type: "text_delta", text: "旧" };
      this.started.resolve();
      await this.release.promise;
      yield this.toolCall("wire-after-stop");
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "停止后不应再启动" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("运行中的停止请求在可保存节点确认，执行与任务链记为 paused", { timeout: 40_000 }, async () => {
  const model = new StopBoundaryModel();
  const fixture = createFixtureWithModel(model);
  try {
    const base = await start(fixture);
    const role = rolePath(fixture);
    const messagesPath = `${role}/windows/${fixture.windowId}/messages`;

    const submitted = await api(base, "POST", messagesPath, {
      content: "你好",
      submissionId: randomUUID(),
    });
    assert.equal(submitted.status, 201);
    await model.started.promise;

    const stopping = await api(base, "POST", `${role}/activity/stop`);
    assert.equal(stopping.status, 200);
    assert.equal(stopping.body.confirmed, false);
    const stoppingView = activityOf(stopping);
    assert.equal(stoppingView.state, "stopping");
    assert.equal(stoppingView.running, true);
    assert.equal(stoppingView.confirmedAt, null);
    assert.ok(stoppingView.requestedAt);

    // stopping 还不是「已停止」，配置写入与新对话都必须拒绝。
    const blockedWrite = await api(
      base,
      "PATCH",
      `${role}/definition`,
      definitionWrite(),
    );
    assert.equal(blockedWrite.status, 409);
    assert.deepEqual(errorOf(blockedWrite), {
      code: "ROLE_NOT_STOPPED",
      details: {
        roleId: fixture.roleId,
        state: "stopping",
        reason: "STOPPING",
      },
    });
    const blockedMessage = await api(base, "POST", messagesPath, {
      content: "停止中不应接收",
      submissionId: randomUUID(),
    });
    assert.equal(blockedMessage.status, 409);
    assert.equal(errorOf(blockedMessage).code, "ROLE_ACTIVITY_STOPPED");

    model.release.resolve();
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const final = await api(base, "GET", `${role}/activity`);
    const finalView = activityOf(final);
    assert.equal(finalView.state, "stopped");
    assert.equal(finalView.running, false);
    assert.ok(finalView.confirmedAt);
    const executionId = finalView.boundaryExecutionId;
    assert.ok(executionId, "停止边界应记录命中的执行");

    const execution = await api(
      base,
      "GET",
      `${role}/executions/${executionId}`,
    );
    assert.equal(execution.status, 200);
    assert.equal(
      (execution.body.execution as { status: string }).status,
      "paused",
    );

    const tasks = await api(base, "GET", `${role}/tasks`);
    const paused = (tasks.body.items as Array<{
      status: string;
      endReason: string | null;
    }>).find((item) => item.status === "paused");
    assert.ok(
      paused,
      `任务链应停在 paused，而不是判失败或清空：${JSON.stringify(tasks.body.items)}`,
    );
    assert.equal(paused.endReason, "ROLE_STOP_REQUESTED");

    // 命中边界后没有第三轮模型调用，也没有派发停止边界上的那次工具。
    assert.equal(model.requests.length, 2);
    withStorage(fixture, (storage) => {
      const row = storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM tool_calls")
        .get() as { count: number };
      assert.equal(row.count, 0, "停止边界上的工具调用不得派发");
      const claimed = storage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE claimed_by_execution_id IS NOT NULL AND processed_by_execution_id IS NULL",
        )
        .get() as { count: number };
      assert.equal(claimed.count, 1, "用户消息应保持领取状态，供恢复后续行接手");
    });
  } finally {
    model.release.resolve();
    await fixture.close();
  }
});

test("恢复原样保留待办与自主额度，并重新允许活动", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const role = rolePath(fixture);

    // 自主额度属于角色配置写入：先由后端确认停止再改，改完恢复活动。
    const budgetStop = await api(base, "POST", `${role}/activity/stop`);
    assert.equal(activityOf(budgetStop).state, "stopped");
    const budget = await api(base, "PUT", `${role}/autonomy/budget`, {
      unlimited: false,
      dailyLimit: 3,
    });
    assert.equal(budget.status, 200);
    const budgetResume = await api(base, "POST", `${role}/activity/resume`);
    assert.equal(activityOf(budgetResume).state, "active");
    const wakeAt = new Date(Date.now() + 60_000).toISOString();
    const wake = await api(base, "POST", `${role}/autonomy/wakes`, {
      wakeAt,
      intent: "停止前排队的唤醒",
    });
    assert.equal(wake.status, 201);

    const beforeWakes = await api(base, "GET", `${role}/autonomy/wakes`);
    const beforeBudget = await api(base, "GET", `${role}/autonomy/budget`);

    const stopped = await api(base, "POST", `${role}/activity/stop`);
    assert.equal(stopped.status, 200);
    assert.equal(activityOf(stopped).state, "stopped");

    // 恢复不清理待办、不重置自主额度。
    const resumed = await api(base, "POST", `${role}/activity/resume`);
    assert.equal(resumed.status, 200);
    assert.equal(activityOf(resumed).state, "active");

    const afterWakes = await api(base, "GET", `${role}/autonomy/wakes`);
    assert.deepEqual(afterWakes.body.items, beforeWakes.body.items);
    const afterBudget = await api(base, "GET", `${role}/autonomy/budget`);
    assert.deepEqual(afterBudget.body, beforeBudget.body);

    // 恢复后重新允许提交消息（活动状态是粘滞的，只能显式改回）。
    const accepted = await api(
      base,
      "POST",
      `${role}/windows/${fixture.windowId}/messages`,
      { content: "恢复后的消息", submissionId: randomUUID() },
    );
    assert.equal(accepted.status, 201);
  } finally {
    await fixture.close();
  }
});

test("恢复后重新调度暂停的原任务，不需要再发用户消息", { timeout: 40_000 }, async () => {
  const model = new StopBoundaryModel();
  const fixture = createFixtureWithModel(model);
  try {
    const base = await start(fixture);
    const role = rolePath(fixture);
    const messagesPath = `${role}/windows/${fixture.windowId}/messages`;

    const submitted = await api(base, "POST", messagesPath, {
      content: "恢复原回复",
      submissionId: randomUUID(),
    });
    assert.equal(submitted.status, 201);
    await model.started.promise;
    assert.equal(
      activityOf(await api(base, "POST", `${role}/activity/stop`)).state,
      "stopping",
    );
    model.release.resolve();
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(
      activityOf(await api(base, "GET", `${role}/activity`)).state,
      "stopped",
    );

    const before = (await api(base, "GET", `${role}/tasks`)).body.items as Array<{
      status: string;
      endReason: string | null;
    }>;
    assert.ok(
      before.some(
        (item) =>
          item.status === "paused" &&
          item.endReason === "ROLE_STOP_REQUESTED",
      ),
      `恢复前应有因停止而暂停的任务：${JSON.stringify(before)}`,
    );

    const callsBeforeResume = model.requests.length;
    assert.equal(
      activityOf(await api(base, "POST", `${role}/activity/resume`)).state,
      "active",
    );
    // 恢复即重新调度原任务：没有再次提交用户消息也要继续调用模型。
    await waitUntil(() => model.requests.length > callsBeforeResume);
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const after = (await api(base, "GET", `${role}/tasks`)).body.items as Array<{
      status: string;
      endReason: string | null;
    }>;
    assert.deepEqual(
      after.map((item) => item.status),
      ["completed"],
      `恢复后原任务应继续到结束：${JSON.stringify(after)}`,
    );
    withStorage(fixture, (storage) => {
      const claimed = storage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE claimed_by_execution_id IS NOT NULL AND processed_by_execution_id IS NULL",
        )
        .get() as { count: number };
      assert.equal(claimed.count, 0, "恢复续行应接手并处理已领取的用户消息");
    });
  } finally {
    model.release.resolve();
    await fixture.close();
  }
});

/** 第一轮派发慢工具；工具转后台后，前台执行退出，只剩后台结算。 */
class BackgroundToolModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const last = request.messages.at(-1);
    if (last?.role === "user") {
      const tool = request.tools.find((candidate) =>
        candidate.name.includes("slow_op"),
      );
      assert.ok(tool, "慢工具应已注册");
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

function addSlowOpMcp(fixture: Fixture, dir: string): string {
  const backendRoot = path.resolve(import.meta.dirname, "..");
  const sdkRoot = path.join(
    backendRoot,
    "node_modules/@modelcontextprotocol/sdk/dist/esm/server",
  );
  const serverPath = path.join(dir, "slow-op.mjs");
  fs.writeFileSync(
    serverPath,
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      `import { McpServer } from ${JSON.stringify(pathToFileURL(path.join(sdkRoot, "mcp.js")).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.join(sdkRoot, "stdio.js")).href)};`,
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

test("后台工具结算后停止能收敛，且保留原调用记录", { timeout: 40_000 }, async () => {
  const model = new BackgroundToolModel();
  const fixture = createFixtureWithModel(model, { toolForegroundWaitMs: 800 });
  const workspace = rolePaths(
    fixture.app.config.dataRoot,
    fixture.roleId,
  ).workspaceDir;
  try {
    const base = await start(fixture);
    const role = rolePath(fixture);
    addSlowOpMcp(fixture, workspace);

    const submitted = await api(
      base,
      "POST",
      `${role}/windows/${fixture.windowId}/messages`,
      { content: "请执行慢操作", submissionId: randomUUID() },
    );
    assert.equal(submitted.status, 201);
    await waitUntil(() => fs.existsSync(path.join(workspace, "bg-started")));
    await waitUntil(() =>
      withStorage(fixture, (storage) => {
        const execution = storage.business.db
          .prepare(
            "SELECT status FROM executions ORDER BY rowid DESC LIMIT 1",
          )
          .get() as { status: string } | undefined;
        const tool = storage.business.db
          .prepare(
            "SELECT c.status, m.mode FROM tool_calls c JOIN tool_call_mode_events m ON c.tool_call_id = m.tool_call_id ORDER BY m.rowid DESC LIMIT 1",
          )
          .get() as { status: string; mode: string } | undefined;
        return (
          execution?.status === "superseded" &&
          tool?.status === "running" &&
          tool.mode === "background"
        );
      }),
    );
    await delay(100);

    // 前台执行已退出，只剩后台工具在途：停止只能等最后一个工具结算。
    const requested = await api(base, "POST", `${role}/activity/stop`);
    assert.equal(requested.status, 200);
    assert.equal(requested.body.confirmed, false);
    assert.equal(activityOf(requested).state, "stopping");
    assert.equal(activityOf(requested).running, true);

    fs.writeFileSync(path.join(workspace, "bg-release"), "");
    await waitUntil(() => !fixture.app.conversation.isRunning(fixture.roleId));

    const final = activityOf(await api(base, "GET", `${role}/activity`));
    assert.equal(final.state, "stopped", "后台工具结算后停止应收敛");
    assert.equal(final.running, false);
    assert.ok(final.confirmedAt);
    const write = await api(
      base,
      "PATCH",
      `${role}/definition`,
      definitionWrite(),
    );
    assert.equal(write.status, 200, "确认停止后配置写入应放行");
    withStorage(fixture, (storage) => {
      const calls = storage.business.db
        .prepare("SELECT status FROM tool_calls")
        .all() as Array<{ status: string }>;
      assert.deepEqual(calls, [{ status: "success" }], "原调用记录应保留");
    });
  } finally {
    fs.writeFileSync(path.join(workspace, "bg-release"), "");
    await fixture.close();
  }
});

test("自主额度写入纳入角色配置保护", { timeout: 40_000 }, async () => {
  const model = new StopBoundaryModel();
  const fixture = createFixtureWithModel(model);
  try {
    const base = await start(fixture);
    const role = rolePath(fixture);

    // 运行中：拒绝修改，额度保持原值。
    const active = await api(base, "PUT", `${role}/autonomy/budget`, {
      unlimited: false,
      dailyLimit: 7,
    });
    assert.equal(active.status, 409);
    assert.equal(errorOf(active).code, "ROLE_NOT_STOPPED");
    assert.equal(errorOf(active).details?.reason, "ACTIVE");
    const untouched = await api(base, "GET", `${role}/autonomy/budget`);
    assert.equal(
      (untouched.body as { dailyLimit: number }).dailyLimit,
      200,
      "拒绝后额度不得被修改",
    );

    // 正在停止：仍拒绝。
    const submitted = await api(
      base,
      "POST",
      `${role}/windows/${fixture.windowId}/messages`,
      { content: "检查额度保护", submissionId: randomUUID() },
    );
    assert.equal(submitted.status, 201);
    await model.started.promise;
    assert.equal(
      activityOf(await api(base, "POST", `${role}/activity/stop`)).state,
      "stopping",
    );
    const stopping = await api(base, "PUT", `${role}/autonomy/budget`, {
      unlimited: false,
      dailyLimit: 7,
    });
    assert.equal(stopping.status, 409);
    assert.equal(errorOf(stopping).details?.reason, "STOPPING");

    // 后端确认停止后才允许修改。
    model.release.resolve();
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(
      activityOf(await api(base, "GET", `${role}/activity`)).state,
      "stopped",
    );
    const allowed = await api(base, "PUT", `${role}/autonomy/budget`, {
      unlimited: false,
      dailyLimit: 7,
    });
    assert.equal(allowed.status, 200);
    assert.equal((allowed.body as { dailyLimit: number }).dailyLimit, 7);
  } finally {
    model.release.resolve();
    await fixture.close();
  }
});

test("全局写入读完请求体后重验停止条件", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  let patch: http.ClientRequest | undefined;
  try {
    const base = await start(fixture);
    const role = rolePath(fixture);
    const resource = fixture.app.services.resources.list("model")[0];
    assert.ok(resource, "夹具应已创建一个模型服务");
    assert.equal(
      activityOf(await api(base, "POST", `${role}/activity/stop`)).state,
      "stopped",
    );

    // 请求体只发一半：全局写入已进入租约，但还没提交。
    const target = new URL(`${base}/v1/resources/${resource.resourceId}`);
    const response = new Promise<number>((resolve, reject) => {
      patch = http.request(
        target,
        { method: "PATCH", headers: { "content-type": "application/json" } },
        (incoming) => {
          incoming.resume();
          incoming.on("end", () => resolve(incoming.statusCode ?? 0));
        },
      );
      patch.on("error", reject);
      patch.write('{"name":');
    });
    void response.catch(() => {});

    await delay(100);
    const rejected = await (async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const resumed = await api(base, "POST", `${role}/activity/resume`);
        if (
          resumed.status === 409 &&
          errorOf(resumed).details?.reason === "CONFIG_WRITE_IN_PROGRESS"
        ) {
          return true;
        }
        if (resumed.status === 200) {
          throw new Error("全局租约尚未建立就允许恢复");
        }
        await delay(30);
      }
      return false;
    })();
    assert.equal(rejected, true, "全局写入期间应拒绝恢复");

    // 读体期间新建默认 active 的角色，提交时必须重验并拒绝。
    const created = await api(base, "POST", "/v1/roles", {
      displayName: "新增角色",
      definition: { text: "新增角色定义" },
    });
    assert.equal(created.status, 201);
    const roles = (await api(base, "GET", "/v1/activities")).body
      .items as ActivityView[];
    assert.ok(
      roles.some((item) => item.roleId !== fixture.roleId && item.state === "active"),
      "新建角色默认处于 active",
    );

    patch!.end('"changed during new role"}');
    assert.equal(await response, 409, "提交时应重验所有角色已停止");
    const after = await api(
      base,
      "GET",
      `/v1/resources/${resource.resourceId}`,
    );
    assert.notEqual(after.body.name, "changed during new role");
  } finally {
    patch?.destroy();
    await fixture.close();
  }
});

test("重启后收敛已无在途执行的停止请求", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  const config = fixture.app.config;
  try {
    // 模拟进程在写入 stopping 之后、确认停止之前退出。
    new RoleActivityStore(fixture.app.appStore.db).requestStop(
      fixture.roleId,
      new Date().toISOString(),
    );
    await fixture.app.close();

    const app = createBackendApp(config, {
      disableMemoryRuntime: true,
      modelPortFactory: () => fixture.model,
    });
    try {
      const base = `http://127.0.0.1:${await listen(app.server, 0, "127.0.0.1")}`;
      const role = `/v1/roles/${fixture.roleId}`;
      const view = activityOf(await api(base, "GET", `${role}/activity`));
      assert.equal(view.state, "stopped", "重启后已无在途执行的停止请求应收敛");
      assert.equal(view.running, false);
      assert.ok(view.confirmedAt);

      const write = await api(
        base,
        "PATCH",
        `${role}/definition`,
        definitionWrite(),
      );
      assert.equal(write.status, 200, "收敛后配置写入应放行");

      // 收敛结果与正常确认停止一致：粘滞到显式恢复。
      const resumed = await api(base, "POST", `${role}/activity/resume`);
      assert.equal(resumed.status, 200);
      assert.equal(activityOf(resumed).state, "active");
    } finally {
      await app.close();
    }
  } finally {
    await fixture.close();
  }
});
