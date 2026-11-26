import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { McpToolClient, managedPiCommand } from "../../src/mcp/client.js";
import { listen } from "../../src/bootstrap/app.js";
import { createFixtureWithModel, ScriptedChatModel } from "../fixtures/conversation-fixture.js";

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
    function post(token: string, route = "responses") {
      return fetch("http://127.0.0.1:" + host + "/v1/internal/model-proxy/" + route, { method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ model: "override", input: "hello" }) });
    }
    const token = proxy.issue(f.roleId, binding, false, Date.now() + 5000);
    assert.equal((await post(token, "chat/completions")).status, 403);
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
        protocol: "openai-responses", expiresAt: Date.now() + 30000,
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

for (const mode of ["pi_task_cancel", "role_stop", "task_cancel"] as const) {
  test("工程任务撤销后拒绝新请求：" + mode, async t => {
    const model = new ScriptedChatModel([
      [{ type: "tool_call", callId: "start", name: "pi_task_start", arguments: { extId: "cancel", prompt: "等待离线端点" } }, { type: "completed", stopReason: "stop" }],
      ...(mode === "task_cancel" ? [[{ type: "tool_call" as const, callId: "pause", name: "task_pause", arguments: { reason: "工程尚在进行" } }, { type: "completed" as const, stopReason: "stop" }]] : []),
      [{ type: "text_delta", text: "后台已开始。" }, { type: "completed", stopReason: "stop" }],
      r => [{ type: "tool_call", callId: "cancel", name: "pi_task_cancel", arguments: { jobId } }, { type: "completed", stopReason: "stop" }],
      [{ type: "text_delta", text: "已取消。" }, { type: "completed", stopReason: "stop" }],
    ]);
    let jobId = "";
    let count = 0;
    const upstream = http.createServer((_req, _res) => { count++; });
    const target = await listen(upstream, 0, "127.0.0.1");
    const f = createFixtureWithModel(model);
    try {
      const { app, roleId, windowId } = f;
      const port = await listen(app.server, 0, "127.0.0.1");
      const issued = t.mock.method(app.services.modelProxy, "issue");
      app.services.activity.requestStop(roleId);
      const resource = app.services.resources.create({ name: "模型", kind: "model", config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:" + target } });
      const mcp = app.services.resources.create({ name: "工程", kind: "mcp", config: { command: "nowadays-pi", args: [], env: {} } });
      app.services.resources.replaceBindings(roleId, [{ resourceId: resource.resourceId, capability: "chat_model", enabled: true, modelName: "test" },
        { resourceId: mcp.resourceId, capability: "mcp", enabled: true }]);
      app.services.activity.resume(roleId);
      const send = async (content: string) => {
        app.conversation.submitMessage(roleId, windowId, { content, submissionId: randomUUID(), sourcePlatform: "nowadays" });
        await app.conversation.waitForIdle(roleId, 30000);
      };
      await send("启动后台工程");
      const message = model.requests[1]?.messages.find(m => m.role === "tool");
      assert.ok(message);
      jobId = JSON.parse(message.content).result.jobId;
      for (let i = 0; i < 500 && !count; i++) await delay(20);
      assert.equal(count, 1);
      if (mode === "role_stop") app.services.activity.requestStop(roleId);
      else if (mode === "pi_task_cancel") await send("取消工程");
      else {
        const task = app.conversation.listTasks(roleId).find(item => item.status === "paused");
        assert.ok(task);
        app.conversation.cancelTask({ roleId, taskId: task.taskId });
      }
      const denied = await fetch("http://127.0.0.1:" + port + "/v1/internal/model-proxy/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + issued.mock.calls[0]!.result } });
      assert.equal(denied.status, 403);
      assert.match(await denied.text(), /PI_LEASE_REVOKED/);
      assert.equal(count, 1);
    } finally { await f.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); }
  });
}
