import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { listen } from "../../src/bootstrap/app.js";
import { EngineeringJobs } from "../../src/storage/conversation/engineering-jobs.js";
import { loadAgentTools } from "../../src/application/conversation/agent-tools.js";
import { RoleAccess } from "../../src/application/role/role-access.js";
import { createFixtureWithModel, deferred, ScriptedChatModel, withStorage } from "../fixtures/conversation-fixture.js";

// 两条独立回环线路跑真实 Pi SDK。每次成功工程先写文件，再从同一模型取得终答。
async function endpoint(name: string) {
  const calls: string[] = [];
  const firstCall = deferred<void>();
  const release = deferred<void>();
  const state: { failure?: number | "disconnect"; hold: boolean } = { hold: false };
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    const prompt = body.messages.find((m: {role: string}) => m.role === "user")?.content;
    calls.push(JSON.stringify(prompt));
    firstCall.resolve();
    if (state.hold) await release.promise;
    if (state.failure === "disconnect") { res.destroy(); return; }
    if (state.failure) {
      res.writeHead(state.failure, state.failure === 429 ? { "retry-after": "480" } : {}).end();
      return;
    }
    const done = body.messages.at(-1).role === "tool";
    const delta = done ? { content: name + " 完成" } : { tool_calls: [{ index: 0, id: "write_one", type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: "note.txt", content: name }) } }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [{ delta: { role: "assistant", ...delta }, finish_reason: null },
      { delta: {}, finish_reason: done ? "stop" : "tool_calls" }]) {
      res.write("data: " + JSON.stringify({ id: "fixture", model: body.model, choices: [{ index: 0, ...choice }] }) + "\n\n");
    }
    res.end("data: [DONE]\n\n");
  });
  const port = await listen(server, 0, "127.0.0.1");
  return { name, baseUrl: "http://127.0.0.1:" + port, calls, firstCall, release, state,
    async close() { release.resolve(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function setup() {
  const chat = await endpoint("对话"), a = await endpoint("A"), b = await endpoint("B");
  const model = new ScriptedChatModel([[{ type: "text_delta", text: "就绪" }, { type: "completed", stopReason: "stop" }]]);
  const f = createFixtureWithModel(model, { disablePresetAssistant: false, presetAssetsDir: "tests/fixtures" });
  const { app } = f;
  const roleId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
  const windowId = app.services.roles.initializeRole(roleId).defaultWindowId;
  const main = { ...f, roleId, windowId };
  const resource = (source: typeof a) => app.services.resources.create({ kind: "model", name: source.name,
    config: { protocol: "openai-chat", baseUrl: source.baseUrl } }).resourceId;
  const chatId = resource(chat);
  const members = [a, b].map(source => ({ resourceId: resource(source), modelName: "engine", enabled: true }));
  const [pi] = app.services.resources.listBindings(roleId);
  app.services.resources.replaceBindings(roleId, [{ capability: "mcp", resourceId: pi!.resourceId },
    { capability: "chat_model", modelName: "dialogue", resourceId: chatId }]);
  await listen(app.server, 0, "127.0.0.1");
  app.services.activity.resume(roleId);
  await app.conversation.waitForIdle(roleId, 30000);
  const context = () => withStorage(main, ({ business }) => {
    const { executionId } = business.createExecution({ roleId, windowId, triggerType: "user_message" });
    const { taskId } = business.createTask({ roleId, goal: "工程", initiatorExecutionId: executionId });
    business.linkExecutionTask({ roleId, taskId, executionId, relation: "initiates" });
    return { roleId, windowId, taskId, executionId, signal: new AbortController().signal };
  });
  const start = async (prompt: string, ctx = context()) => {
    const catalog = await app.services.pi.tools(roleId, ctx.taskId);
    const tool = catalog.find(t => t.name === "pi_task_start");
    assert.ok(tool);
    return tool.execute({ extId: "sample", prompt }, ctx);
  };
  const terminal = async (outcome: Awaited<ReturnType<typeof start>>) => {
    assert.equal(outcome.status, "success", JSON.stringify(outcome));
    const { jobId } = outcome.adaptedResult as { jobId: string };
    for (let i = 0; i < 1200; i++) {
      const job = withStorage(main, ({ business }) => new EngineeringJobs(business.db).find(jobId));
      assert.ok(job);
      if (job.status !== "running") return job;
      await delay(30);
    }
    throw Error("PI_TEST_JOB_TIMEOUT");
  };
  return { app, main, roleId, context, start, terminal, members, a, b, model, chat,
    async close() { a.release.resolve(); b.release.resolve(); await f.close(); await Promise.all([a.close(), b.close(), chat.close()]); } };
}

test("空池隐藏工具；429 结束当前工程，下一任务才降级，全冷却仍返回可说明的诊断", async () => {
  const f = await setup();
  try {
    assert.ok(f.model.requests.length);
    assert.ok(f.model.requests.every(r => !r.tools.some(t => t.name.startsWith("pi_task_"))));
    assert.deepEqual(await f.app.services.pi.tools(f.roleId), []);
    f.app.services.engineeringPool.update({ members: f.members });
    f.a.state.failure = 429;
    const first = await f.terminal(await f.start("第一个工程"));
    assert.equal(first.status, "failed");
    assert.equal(first.summary, "PI_UPSTREAM_RATE_LIMITED");
    assert.deepEqual([f.a.calls.length, f.b.calls.length], [1, 0]);
    assert.equal((await f.terminal(await f.start("下一个工程"))).status, "completed");
    assert.deepEqual([f.a.calls.length, f.b.calls.length], [1, 2]);
    f.b.state.failure = 429;
    assert.equal((await f.terminal(await f.start("第二路也限额"))).status, "failed");
    const denied = await f.start("尝试冷却中的池");
    assert.equal(denied.diagnosticCode, "PI_ENGINEERING_POOL_EXHAUSTED");
    const { error } = denied.adaptedResult as { error: {details: {retryAfterSeconds: number; reasons: string[]}} };
    assert.ok(error.details.retryAfterSeconds > 180 && error.details.retryAfterSeconds <= 480);
    assert.deepEqual(error.details.reasons, ["cooldown"]);
    assert.deepEqual([f.a.calls.length, f.b.calls.length, f.chat.calls.length], [1, 3, 0]);
  } finally { await f.close(); }
});

test("400 结束当前工程后同一源可立即复用，源故障仍触发冷却", async () => {
  const f = await setup();
  try {
    const pool = f.app.services.engineeringPool;
    const member = f.members[0]!;
    pool.update({ members: [member] });
    f.a.state.failure = 400;
    const failed = await f.terminal(await f.start("请求格式错误"));
    assert.equal(failed.status, "failed");
    assert.equal(failed.summary, "PI_UPSTREAM_FAILED");
    const [afterFailure] = pool.settings().members;
    assert.equal(afterFailure?.state, "ready");
    assert.equal(afterFailure.retryAfterSeconds, null);

    delete f.a.state.failure;
    const next = await f.terminal(await f.start("下一工程"));
    assert.equal(next.status, "completed");
    assert.equal(next.modelResourceId, member.resourceId);
    assert.ok(f.a.calls.some(prompt => prompt.includes("下一工程")));

    for (const failure of [401, 402, 403, 503, "disconnect"] as const) {
      pool.update({ members: [{ ...member, modelName: `engine-${failure}` }] });
      f.a.state.failure = failure;
      assert.equal((await f.terminal(await f.start(String(failure)))).status, "failed");
      assert.equal(pool.settings().members[0]?.state, "cooldown", String(failure));
    }
  } finally { await f.close(); }
});

test("并发工程按任务轮询且全程粘性；清空池和关闭 Pi 后已签租约仍能完成", async () => {
  const f = await setup();
  try {
    f.app.services.engineeringPool.update({ mode: "round_robin", members: f.members });
    f.a.state.hold = f.b.state.hold = true;
    const tasks = [f.context(), f.context()] as const;
    const previousCatalog = await f.app.services.pi.tools(f.roleId);
    const started = await Promise.all([f.start("FIRST_JOB", tasks[0]), f.start("SECOND_JOB", tasks[1])]);
    await Promise.race([Promise.all([f.a.firstCall.promise, f.b.firstCall.promise]),
      delay(30000, undefined, { ref: false }).then(() => { throw Error("PI_TEST_ENDPOINT_TIMEOUT"); })]);
    f.app.services.engineeringPool.update({ enabled: false, members: [] });
    assert.deepEqual(await f.app.services.pi.tools(f.roleId), []);
    const status = previousCatalog.find(tool => tool.name === "pi_task_status")!;
    const firstJob = started[0]!.adaptedResult as { jobId: string };
    assert.equal((await status.execute({ jobId: firstJob.jobId }, tasks[0])).status, "success");
    assert.equal((await status.execute({ jobId: firstJob.jobId }, tasks[1])).diagnosticCode, "PI_JOB_UNAVAILABLE");
    for (const { resourceId } of f.members) {
      assert.ok(f.app.services.resources.references(resourceId).references.some(r => r.reason === "TASK_CHAIN"));
      assert.throws(() => f.app.services.resources.remove(resourceId), { code: "RESOURCE_IN_USE" });
    }
    f.a.release.resolve(); f.b.release.resolve();
    const jobs = await Promise.all(started.map(f.terminal));
    assert.deepEqual(jobs.map(j => j.status), ["completed", "completed"]);
    assert.equal(new Set(jobs.map(j => j.modelResourceId)).size, 2);
    assert.ok(jobs.every(j => j.modelName === "engine"));
    for (const [index, source] of [f.a, f.b].entries()) {
      const owner = jobs.find(job => job.modelResourceId === f.members[index]!.resourceId)!;
      const prompt = owner.taskId === tasks[0].taskId ? "FIRST_JOB" : "SECOND_JOB";
      assert.equal(source.calls.length, 2);
      assert.ok(source.calls.every(call => call.includes(prompt)));
      assert.ok((await f.app.services.pi.tools(f.roleId, owner.taskId)).length);
      withStorage(f.main, ({ business }) => assert.ok(!business.listResourceContinuations(f.roleId, owner.taskId)
        .some(r => r.resourceId === owner.modelResourceId)));
    }
    assert.deepEqual(f.chat.calls, []);
  } finally { await f.close(); }
});

test("复用父任务工具目录时重新检查工程取证，未分派过工程的旧链不能使用空池", async () => {
  const f = await setup();
  try {
    const { app, roleId } = f;
    const { taskId } = f.context();
    app.services.engineeringPool.update({ members: f.members });
    const catalog = await loadAgentTools({ roleId, taskId, appStore: app.appStore,
      roleAccess: app.roleAccess, memory: app.services.memory,
      workspaceDir: f.main.root, appRoot: app.config.appRoot, admin: { ...app.services, now: () => new Date() } });
    try {
      assert.ok(catalog.tools.some(tool => tool.name === "pi_task_start"));
      app.services.engineeringPool.update({ members: [] });
      await catalog.refreshEngineering!(taskId);
      assert.ok(!catalog.tools.some(tool => tool.name.startsWith("pi_task_")));
      assert.ok(catalog.tools.some(tool => tool.name === "history_lookup"));
      assert.deepEqual(f.chat.calls, []);
    } finally { await catalog.close(); }
  } finally { await f.close(); }
});
