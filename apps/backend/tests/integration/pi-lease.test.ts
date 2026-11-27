import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { McpToolClient, managedPiCommand } from "../../src/mcp/client.js";
import { listen } from "../../src/bootstrap/app.js";
import { seedEngineeringPool } from "../fixtures/engineering-pool.js";
import { addBinding, createFixtureWithModel, deferred, ScriptedChatModel, withStorage } from "../fixtures/conversation-fixture.js";

test("Responses 转发固定模型与鉴权，每次出站尝试单独计费，租约撤销与过期拒绝派发", async () => {
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    calls++;
    let data = "";
    for await (const part of req) data += part;
    if (req.url !== "/v1/responses" || JSON.parse(data).model !== "fixture" || req.headers.authorization !== "Bearer test-only") {
      res.writeHead(400).end(); return;
    }
    if (JSON.parse(data).stream === true) {
      const item = { id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "Responses 已验证", annotations: [] }] };
      const events = [
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Responses 已验证" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "r", status: "completed", output: [item],
          usage: { input_tokens: 100, output_tokens: 9, input_tokens_details: { cached_tokens: 3 } } } },
      ];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const data of events) res.write("event: " + data.type + "\ndata: " + JSON.stringify(data) + "\n\n");
      res.end(); return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "r", status: "completed", usage: { input_tokens: 100, output_tokens: 9, input_tokens_details: { cached_tokens: 3 } } }));
  });
  const port = await listen(upstream, 0, "127.0.0.1");
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const res = f.app.services.resources.create({ name: "Responses", kind: "model", secret: "test-only",
      config: { protocol: "openai-responses", baseUrl: "http://127.0.0.1:" + port + "/v1" } });
    const proxy = f.app.services.modelProxy;
    const binding = { capability: "chat_model" as const, resourceId: res.resourceId, modelName: "fixture",
      config: { protocol: "openai-responses" as const, baseUrl: "http://127.0.0.1:" + port + "/v1" } };
    const host = await listen(f.app.server, 0, "127.0.0.1");
    function post(token: string, route = "responses", extra = {}) {
      return fetch("http://127.0.0.1:" + host + "/v1/internal/model-proxy/" + route, { method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ model: "fixture", input: "hello", ...extra }) });
    }
    const token = proxy.issue(f.roleId, binding, false, Date.now() + 5000);
    assert.equal((await post(token, "chat/completions")).status, 403);
    assert.equal(calls, 0);
    assert.equal((await post(token)).status, 200);
    assert.equal((await post(token)).status, 200);
    proxy.revoke(token);
    assert.match(await (await post(token)).text(), /PI_LEASE_REVOKED/);
    const expired = proxy.issue(f.roleId, binding, false, Date.now() - 1);
    assert.match(await (await post(expired)).text(), /PI_LEASE_REVOKED/);
    const client = await McpToolClient.connect({ command: managedPiCommand, args: [], env: {} });
    const lease = proxy.issue(f.roleId, binding, false, Date.now() + 30000);
    try {
      const jobId = randomUUID();
      const baseUrl = "http://127.0.0.1:" + host + "/v1/internal/model-proxy";
      const start = await client.callTool("pi_task_start", { extId: "probe", prompt: "验证 Responses" }, { meta: { nowadays: {
        jobId, cwd: f.app.services.extensions.work.workspace("probe"), baseUrl, lease, modelName: "fixture",
        apiFlavor: "openai-responses", expiresAt: Date.now() + 30000,
      } } });
      assert.equal(start.isError, false);
      let view;
      for (let i = 0; i < 500; i++) {
        const receipt = await client.callTool("pi_task_result", { jobId });
        view = receipt.structuredContent as { state: string; result?: string; error?: string };
        if (view.state !== "running") break;
        await delay(30);
      }
      assert.equal(view?.state, "completed", JSON.stringify(view));
      assert.equal(view.result, "Responses 已验证");
      assert.match(await (await post(lease)).text(), /PI_LEASE_REVOKED/);
    } finally { await client.close(); }
    assert.equal(calls, 3);
    const rows = f.app.appStore.db.prepare("SELECT status, input_tokens, cached_tokens, output_tokens FROM token_usage_records WHERE source_call_id LIKE 'pi:%'").all();
    assert.deepEqual(rows, Array(3).fill({ status: "succeeded", input_tokens: 100, cached_tokens: 3, output_tokens: 9 }));
  } finally { await f.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); }
});

for (const mode of ["pi_task_cancel", "role_stop", "task_cancel", "task_finish"] as const) {
  test("工程任务撤销后拒绝新请求：" + mode, async t => {
    const model = new ScriptedChatModel([
      [{ type: "text_delta", text: "先等待用户。" }, { type: "completed", stopReason: "stop" }],
      [{ type: "tool_call", callId: "start", name: "pi_task_start", arguments: { extId: "cancel", prompt: "等待离线端点" } }, { type: "completed", stopReason: "stop" }],
      ...(mode === "task_finish" ? [[{ type: "tool_call" as const, callId: "finish", name: "task_finish", arguments: { status: "completed", endReason: "委派后结束父任务" } }, { type: "completed" as const, stopReason: "stop" }]] : []),
      [{ type: "text_delta", text: "后台已开始。" }, { type: "completed", stopReason: "stop" }],
      ...(mode === "pi_task_cancel" ? [() => [{ type: "tool_call" as const, callId: "cancel", name: "pi_task_cancel", arguments: { jobId } }, { type: "completed" as const, stopReason: "stop" }]] : []),
      [{ type: "text_delta", text: "已取消。" }, { type: "completed", stopReason: "stop" }],
      [{ type: "text_delta", text: "原工程收到取消回执。" }, { type: "completed", stopReason: "stop" }],
    ]);
    const connected = deferred<void>(), release = deferred<void>();
    let jobId = "";
    let count = 0;
    const upstream = http.createServer((_req, _res) => { count++; });
    const target = await listen(upstream, 0, "127.0.0.1");
    const f = createFixtureWithModel(model, { disablePresetAssistant: false, presetAssetsDir: "tests/fixtures" });
    try {
      const { app } = f;
      const roleId = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
      const windowId = app.services.roles.getRole(roleId).defaultWindowId;
      const port = await listen(app.server, 0, "127.0.0.1");
      const issued = t.mock.method(app.services.modelProxy, "issue");
      app.services.activity.requestStop(roleId);
      const resource = app.services.resources.create({ name: "模型", kind: "model", config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:" + target } });
      seedEngineeringPool(app, resource.resourceId, "test");
      const [mcp] = app.services.resources.listBindings(roleId);
      app.services.resources.replaceBindings(roleId, [{ resourceId: resource.resourceId, capability: "chat_model", enabled: true, modelName: "test" },
        { resourceId: mcp!.resourceId, capability: "mcp", enabled: true }]);
      const dispatches = path.join(f.root, "dispatches");
      const external = app.services.resources.create({ kind: "mcp", name: "offline", config: { command: process.execPath,
        args: [path.resolve("tests/fixtures/pi-shared-mcp.mjs"), "offline", dispatches], env: { API_KEY: "SECRET_PROBE_VALUE" } } });
      addBinding({ ...f, roleId }, "mcp", external.resourceId);
      app.services.activity.resume(roleId);
      await app.conversation.waitForIdle(roleId, 30000);
      assert.equal(app.services.autonomy.listWakes(roleId)[0]?.status, "completed");
      const send = async (content: string) => {
        app.conversation.submitMessage(roleId, windowId, { content, submissionId: randomUUID(), sourcePlatform: "nowadays" });
        await app.conversation.waitForIdle(roleId, 30000);
      };
      await send("启动后台工程");
      const message = model.requests[2]?.messages.find(m => m.role === "tool");
      assert.ok(message);
      jobId = JSON.parse(message.content).result.jobId;
      for (let i = 0; i < 500 && !count; i++) await delay(20);
      assert.equal(count, 1);
      const parent = app.conversation.listTasks(roleId).find(t=>t.goal==="启动后台工程")!;
      const before = model.requests.length;
      const url = `http://127.0.0.1:${port}/v1/internal/tool-proxy/`;
      const post = (route: string, body: object) => fetch(url + route, { method:"POST",
        headers:{authorization:"Bearer " + issued.mock.calls[0]!.result, "content-type":"application/json"}, body:JSON.stringify(body) });
      let pending: Promise<Response> | undefined;
      if (mode !== "task_finish") {
        const { tools } = await (await post("list", {})).json() as { tools: { name: string }[] };
        assert.equal(tools.length, 1);
        const connect = McpToolClient.connect.bind(McpToolClient);
        t.mock.method(McpToolClient, "connect", async (...args: Parameters<typeof connect>) => {
          const client = await connect(...args);
          if (args[1]?.isolatedEnv) { connected.resolve(); await release.promise; }
          return client;
        });
        pending = post("call", { name: tools[0]!.name, arguments: {} });
        await Promise.race([connected.promise, delay(10000, undefined, { ref:false }).then(() => { throw Error("MCP_CONNECT_TIMEOUT"); })]);
      }
      if (mode === "task_finish") {
        assert.equal(parent.status,"completed");
        await app.services.pi.cancel(jobId);
      } else if (mode === "role_stop") app.services.activity.requestStop(roleId);
      else if (mode === "pi_task_cancel") await send("取消工程");
      else {
        const task = app.conversation.listTasks(roleId).find(item => item.status === "paused");
        assert.ok(task);
        app.conversation.cancelTask({ roleId, taskId: task.taskId });
      }
      if (pending) {
        const rejected = await Promise.race([pending, delay(3000, undefined, {ref:false}).then(() => {
          throw Error("PI_REVOCATION_WAITED_FOR_CONNECTION");
        })]);
        assert.equal(rejected.status, 403);
        assert.match(await rejected.text(), /PI_LEASE_REVOKED/);
        assert.equal(fs.existsSync(dispatches), false);
      }
      release.resolve();
      const denied = await fetch("http://127.0.0.1:" + port + "/v1/internal/model-proxy/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + issued.mock.calls[0]!.result } });
      assert.equal(denied.status, 403);
      assert.match(await denied.text(), /PI_LEASE_REVOKED/);
      assert.equal(count, 1);
      for (let i=0;i<300 && app.services.pi.running().length;i++) await delay(20);
      const read = () => withStorage({...f,roleId}, ({business}) => business.db.prepare(
        "SELECT status,execution_id FROM engineering_jobs JOIN engineering_wakes USING(job_id) WHERE job_id=?").get(jobId)) as
        {status:string;execution_id:string|null};
      assert.equal(read().status,"cancelled");
      if (mode === "role_stop") {
        assert.equal(app.services.activity.view(roleId).state,"stopped");
        assert.equal(read().execution_id,null);
        assert.equal(model.requests.length,before);
        app.services.activity.resume(roleId);
      }
      await app.conversation.waitForIdle(roleId,30000);
      if (mode==="task_cancel" || mode==="task_finish") {
        assert.equal(read().execution_id,null);
        assert.equal(model.requests.length,before);
      } else {
        assert.ok(read().execution_id);
        assert.equal(app.conversation.listTasks(roleId).find(t=>t.taskId===parent.taskId)?.status,"completed");
        assert.ok(model.requests.at(-1)?.system.includes(jobId));
      }
    } finally { release.resolve(); await f.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); }
  });
}

test("宿主令牌统一保护 API，来源默认只放行桌面壳并支持显式白名单", async () => {
  const token = randomUUID();
  const previous = process.env.NOWADAYS_HOST_TOKEN;
  const previousOrigins = process.env.NOWADAYS_ALLOWED_ORIGINS;
  process.env.NOWADAYS_HOST_TOKEN = token;
  process.env.NOWADAYS_ALLOWED_ORIGINS = "http://localhost:5173";
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  if (previous === undefined) delete process.env.NOWADAYS_HOST_TOKEN;
  else process.env.NOWADAYS_HOST_TOKEN = previous;
  if (previousOrigins === undefined) delete process.env.NOWADAYS_ALLOWED_ORIGINS;
  else process.env.NOWADAYS_ALLOWED_ORIGINS = previousOrigins;
  try {
    const base = "http://127.0.0.1:" + await listen(f.app.server, 0, "127.0.0.1");
    const routes = [["GET", "/v1/roles"], ["GET", "/v1/engineering/settings"], ["PUT", "/v1/engineering/settings"], ["POST", "/v1/engineering/jobs/sample/cancel"],
      ["POST", "/v1/engineering-jobs/sample/cancel"], ["POST", "/v1/extensions/sample/ui-action"]];
    for (const [method, route] of routes) {
      for (const value of ["", randomUUID()]) assert.equal((await fetch(base + route, {
        method: method!, headers: value ? { "X-Nowadays-Host-Token": value } : {},
      })).status, 401);
    }
    for (const origin of ["desk://bundle", "app://bundle"]) {
      const roles = await fetch(base + "/v1/roles", { headers: { "X-Nowadays-Host-Token": token, origin } });
      assert.equal(roles.status, 200);
      assert.equal(roles.headers.get("access-control-allow-origin"), origin);
      const preflight = await fetch(base + "/v1/roles", { method: "OPTIONS", headers: { origin } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
      assert.match(preflight.headers.get("access-control-allow-headers")!, /x-nowadays-host-token/i);
    }
    // 显式白名单精确放行，但不放宽其他 localhost 端口。
    const allowedOrigin = "http://localhost:5173";
    const allowed = await fetch(base + "/v1/roles", { headers: { "X-Nowadays-Host-Token": token, origin: allowedOrigin } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), allowedOrigin);
    const headers = { "X-Nowadays-Host-Token": token, origin: "desk://bundle" };
    const cancel = await fetch(base + "/v1/engineering/jobs/sample/cancel", { method: "POST", headers });
    assert.equal(cancel.status, 409);
    assert.match(await cancel.text(), /PI_JOB_NOT_RUNNING/);
    for (const origin of ["http://localhost:9999", "http://127.0.0.1:1234", "file://", "https://evil.example"]) {
      for (const method of ["OPTIONS", "POST"]) {
        const denied = await fetch(base + "/v1/roles", { method, headers: { ...headers, origin } });
        assert.equal(denied.status, 403);
        assert.match(await denied.text(), /ORIGIN_DENIED/);
        assert.equal(denied.headers.get("access-control-allow-origin"), null);
      }
    }
    const leaseOnly = await fetch(base + "/v1/internal/tool-proxy/list", { method: "POST", headers });
    assert.match(await leaseOnly.text(), /PI_LEASE/);
  } finally { await f.close(); }
});
