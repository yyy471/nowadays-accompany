import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { listen } from "../../src/bootstrap/app.js";
import { vertexRouteFingerprint } from "../../src/application/resources/model-service.js";
import { GOOGLE_VERTEX_EXPRESS_URL } from "../../src/domain/model-providers.js";
import { McpToolClient, managedPiCommand, type PiReceipt } from "../../src/mcp/client.js";
import { piApiFlavor } from "../../src/mcp/model-proxy.js";
import { createFixtureWithModel, deferred, ScriptedChatModel } from "../fixtures/conversation-fixture.js";

const modelName = "fixture-model";
const text = "回放完成";

function replay(anthropic: boolean) {
  const events = anthropic ? [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: modelName, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ] : [
    { candidates: [{ content: { role: "model", parts: [{ text }] }, index: 0 }],
      usageMetadata: { promptTokenCount: 18, cachedContentTokenCount: 3, thoughtsTokenCount: 2 } },
    { candidates: [{ finishReason: "STOP", index: 0 }], usageMetadata: { candidatesTokenCount: 7 } },
  ];
  return events.map(event => ("type" in event ? "event: " + event.type + "\r\n" : "") +
    "data: " + JSON.stringify(event) + "\r\n\r\n").join("");
}

for (const flavor of ["anthropic-messages", "google-generative-ai", "google-vertex"] as const) {
  test("Pi SDK 实际线协议、鉴权、已验证路由与分帧用量 " + flavor, async () => {
    const anthropic = flavor === "anthropic-messages";
    const vertex = flavor === "google-vertex";
    const savedModel = (anthropic ? "" : vertex ? "models/" : "publishers/google/models/") + modelName;
    const sdkPath = anthropic ? "/v1/messages?beta=true" :
      (vertex ? "/publishers/google" : "") + "/models/" + modelName + ":streamGenerateContent?alt=sse";
    const sourcePath = vertex ? "/v1/projects/mock/locations/global" + sdkPath : (anthropic ? "" : "/v1beta") + sdkPath;
    const header = anthropic ? "x-api-key" : "x-goog-api-key";
    const frames = replay(anthropic);
    const hits: { path: string; key: unknown; body: Record<string, unknown> }[] = [];
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(part);
      hits.push({ path: req.url!, key: req.headers[header], body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 分割一个 UTF-8 汉字，验证宿主以原始字节转发并能正确解码统计。
      const bytes = Buffer.from(frames);
      const split = bytes.indexOf(Buffer.from(text)) + 1;
      res.write(bytes.subarray(0, split)); res.end(bytes.subarray(split));
    });
    const port = await listen(upstream, 0, "127.0.0.1");
    const local = "http://127.0.0.1:" + port;
    const f = createFixtureWithModel(new ScriptedChatModel([]));
    const saved = process.env.PI_PROTOCOL_TEST_KEY;
    const key = "host-only-" + randomUUID();
    process.env.PI_PROTOCOL_TEST_KEY = key;
    try {
      const config = { protocol: anthropic ? "anthropic-messages" as const : "google-gemini" as const,
        credentialRef: "env:PI_PROTOCOL_TEST_KEY", ...(vertex && { vertexSafety: "high" as const }), baseUrl: vertex ? GOOGLE_VERTEX_EXPRESS_URL : local + (anthropic ? "/v1" : "/v1beta") };
      const { resourceId } = f.app.services.resources.create({ kind: "model", name: flavor, config });
      if (vertex) {
        const now = new Date().toISOString();
        const call = f.app.appStore.saveModelTestCall({ resourceId, modelName: savedModel, protocol: config.protocol, status: "succeeded",
          startedAt: now, finishedAt: now, errorCode: null, configFingerprint: null, usageJson: null });
        f.app.appStore.saveVertexTestRoute(call, vertexRouteFingerprint(config, "reference:env:PI_PROTOCOL_TEST_KEY"),
          local + "/v1/projects/mock/locations/global/publishers/google");
      }
      const host = "http://127.0.0.1:" + await listen(f.app.server, 0, "127.0.0.1");
      const baseUrl = host + "/v1/internal/model-proxy";
      const expiresAt = Date.now() + 45_000;
      const binding = { resourceId, modelName: savedModel, config };
      const lease = f.app.services.modelProxy.issue(f.roleId, binding, false, expiresAt);
      const post = (url: string, headers: Record<string, string>, body = {}) => fetch(url, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const auth = { [header]: lease };
      assert.equal((await post(baseUrl + sdkPath, { authorization: "Bearer " + lease })).status, 403);
      assert.equal((await post(baseUrl + "/release", auth)).status, 403);
      assert.equal((await post(host + "/v1/internal/tool-proxy/list", auth)).status, 403);
      if (anthropic) assert.equal((await post(baseUrl + sdkPath, auth, { model: "other" })).status, 403);
      else {
        assert.equal((await post(baseUrl + sdkPath.replace(modelName, "other"), auth)).status, 403);
        assert.equal((await post(baseUrl + sdkPath.replace("streamGenerateContent", "generateContent"), auth)).status, 403);
        assert.equal((await post(baseUrl + sdkPath.replace("?alt=sse", ""), auth)).status, 403);
      }
      assert.equal(hits.length, 0);
      const raw = await post(baseUrl + sdkPath, auth, anthropic ? { model: modelName, stream: true } : { contents: [] });
      assert.equal(await raw.text(), frames);
      const done = deferred<PiReceipt>();
      const client = await McpToolClient.connect({ command: managedPiCommand, args: [], env: {} }, { onPiTerminal: done.resolve });
      try {
        const jobId = randomUUID();
        const start = await client.callTool("pi_task_start", { extId: "probe", prompt: text }, { meta: { nowadays: {
          jobId, baseUrl, lease, expiresAt, modelName: savedModel, apiFlavor: piApiFlavor(config), cwd: f.app.services.extensions.work.workspace("probe"),
        } } });
        assert.equal(start.isError, false);
        const receipt = await done.promise;
        assert.equal(receipt.state, "completed", JSON.stringify({ receipt, hits }));
        assert.equal(receipt.summary, text);
      } finally { await client.close(); }
      assert.equal(hits.length, 2);
      for (const hit of hits) {
        assert.equal(hit.key, key);
        assert.equal(hit.path, sourcePath);
        if (vertex) assert.deepEqual((hit.body.safetySettings as { threshold: string }[]).map(x => x.threshold), Array(4).fill("BLOCK_LOW_AND_ABOVE"));
      }
      assert.ok(anthropic ? hits[1]!.body.messages : hits[1]!.body.contents);
      const rows = f.app.appStore.db.prepare("SELECT model_name,status,input_tokens,cached_tokens,cache_creation_tokens,output_tokens FROM token_usage_records WHERE source_call_id LIKE 'pi:%'").all();
      assert.deepEqual(rows, Array(2).fill({ model_name: savedModel, status: "succeeded", input_tokens: 18, cached_tokens: 3,
        cache_creation_tokens: anthropic ? 4 : 0, output_tokens: 9 }));
    } finally {
      if (saved === undefined) delete process.env.PI_PROTOCOL_TEST_KEY;
      else process.env.PI_PROTOCOL_TEST_KEY = saved;
      await f.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
}

test("Pi 领取模型调用后从同一版配置取址取密，故障保存部分用量，下游断开与撤约不冷却", async t => {
  const key = "rotated-" + randomUUID();
  const oldHits: string[] = [], hits: string[] = [];
  const old = http.createServer((req, res) => { oldHits.push(req.url!); res.writeHead(500).end(); });
  const oldPort = await listen(old, 0, "127.0.0.1");
  const next = http.createServer((req, res) => {
    hits.push(String(req.headers.authorization));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"usage":{"prompt_tokens":17},"choices":[]}\n\n');
    if (hits.length === 3) res.end(); // 缺少实际终态，已经报告的 17 个输入 token 仍须入账。
  });
  const port = await listen(next, 0, "127.0.0.1");
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const saved = process.env.PI_ROTATED_TEST_KEY;
  process.env.PI_ROTATED_TEST_KEY = key;
  try {
    const host = "http://127.0.0.1:" + await listen(f.app.server, 0, "127.0.0.1");
    const config = { protocol: "openai-chat" as const, baseUrl: "http://127.0.0.1:" + oldPort };
    const { resourceId } = f.app.services.resources.create({ kind: "model", name: "轮换", config });
    const lease = () => f.app.services.modelProxy.issue(f.roleId, { resourceId, modelName, config }, false, Date.now() + 10_000);
    const first = lease();
    const claim = f.app.services.resources.claimModelCall.bind(f.app.services.resources);
    const claims = t.mock.method(f.app.services.resources, "claimModelCall", (...args: Parameters<typeof claim>) => {
      const slot = claim(...args);
      f.app.appStore.updateResource({ resourceId, config: { ...config, baseUrl: "http://127.0.0.1:" + port,
        credentialRef: "env:PI_ROTATED_TEST_KEY" } });
      return slot;
    });
    const failures = t.mock.method(f.app.services.engineeringPool, "reportFailure");
    const post = (token: string, signal?: AbortSignal) => fetch(host + "/v1/internal/model-proxy/chat/completions", {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ model: modelName, stream: true }), ...(signal && { signal }),
    });
    const controller = new AbortController();
    const firstResponse = await post(first, controller.signal);
    assert.equal(firstResponse.status, 200);
    controller.abort();
    await firstResponse.text().catch(() => undefined);
    assert.equal(await f.app.services.resources.waitForRoleInflightIdle(f.roleId, 3000), true);
    f.app.services.modelProxy.revoke(first);
    const second = lease();
    const secondResponse = await post(second);
    f.app.services.modelProxy.revoke(second);
    await secondResponse.text().catch(() => undefined);
    assert.equal(await f.app.services.resources.waitForRoleInflightIdle(f.roleId, 3000), true);
    assert.equal(failures.mock.callCount(), 0);
    await (await post(lease())).text();
    assert.equal(failures.mock.callCount(), 1);
    assert.deepEqual(oldHits, []);
    assert.deepEqual(hits, Array(3).fill("Bearer " + key));
    assert.equal(claims.mock.callCount(), 3);
    const rows = f.app.appStore.db.prepare("SELECT input_tokens,status FROM token_usage_records WHERE source_call_id LIKE 'pi:%'").all();
    assert.deepEqual(rows, Array(3).fill({ status: "failed", input_tokens: 17 }));
  } finally {
    if (saved === undefined) delete process.env.PI_ROTATED_TEST_KEY;
    else process.env.PI_ROTATED_TEST_KEY = saved;
    await f.close();
    for (const source of [old, next]) {
      source.closeAllConnections();
      await new Promise<void>(resolve => source.close(() => resolve()));
    }
  }
});
