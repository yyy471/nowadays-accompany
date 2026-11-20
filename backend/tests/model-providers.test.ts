import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import { modelConfigSchema } from "../src/domain/resource.js";
import { MODEL_PROVIDERS, GOOGLE_VERTEX_EXPRESS_URL, type ModelProvider } from "../src/domain/model-providers.js";
import { modelServiceProbeSchema, modelServiceTestSchema, type ModelEvent, type ModelRequest } from "../src/domain/model.js";
import { HttpModelAdapter, serializeModelRequest } from "../src/model/protocols.js";
import { fingerprintOf } from "../src/application/model-service.js";
import { selectAgentContext } from "../src/application/agent-context.js";
import { createFixtureWithModel } from "./p2-05-fixture.js";

const request: ModelRequest = {
  modelName: "example-chat", sessionId: "role-a/window-1", system: "system",
  messages: [{ role: "user", content: "ping" }], tools: [],
};
const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const chatEnd = chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
async function collect(adapter: HttpModelAdapter, input = request) {
  const events: ModelEvent[] = [];
  for await (const event of adapter.stream(input)) events.push(event);
  return events;
}

const routes: Array<[ModelProvider, string, string]> = [
  ["opencode-go", "/v1/models", "/openai/v1/chat/completions"],
  ["deepseek", "/models", "/chat/completions"],
  ["openrouter", "/models/user", "/chat/completions"],
  ["xai", "/language-models", "/responses"],
  ["zai", "/models", "/chat/completions"],
  ["mimo", "/models", "/chat/completions"],
];

for (const [provider, listPath, streamPath] of routes) {
  test(`${provider} 获取当前目录、鉴权和生成使用所选资源地址`, async t => {
    const config = { provider, protocol: MODEL_PROVIDERS[provider].protocol, baseUrl: "https://proxy.example/custom/path" };
    const adapter = new HttpModelAdapter(config, "local-fixture-key");
    const sessions: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get(provider === "mimo" ? "api-key" : "authorization"), provider === "mimo" ? "local-fixture-key" : "Bearer local-fixture-key");
      assert.equal(headers.get(provider === "mimo" ? "authorization" : "api-key"), null);
      assert.equal(init.redirect, "manual");
      if (provider === "opencode-go") assert.equal(headers.get("user-agent"), "Nowadays");
      if (init.method === "GET") {
        assert.equal(String(url), config.baseUrl + listPath);
        const data = [{ id: "example-chat" }, { id: "newly-released" }];
        if (provider === "mimo") data.push({ id: "mimo-v2.5-tts-voiceclone" }, { id: "mimo-v2.5-asr" });
        return Response.json(provider === "xai" ? { models: [{ ...data[0], aliases: ["current-chat"] }, data[1]] } : { data });
      }
      assert.equal(String(url), config.baseUrl + streamPath);
      assert.equal(JSON.parse(String(init.body)).model, request.modelName);
      if (provider === "opencode-go") {
        const header = headers.get("x-opencode-session") ?? "";
        assert.match(header, /^ses_[a-f\d]+$/);
        sessions.push(header);
      }
      if (provider === "xai") {
        assert.equal(JSON.parse(String(init.body)).store, false);
        return new Response(chunk({ type: "response.output_text.delta", delta: "pong" }) +
          chunk({ type: "response.completed", response: { status: "completed", output: [{ type: "reasoning", encrypted_content: "signed" }] } }));
      }
      return new Response(chunk({ choices: [{ delta: { content: "pong" } }] }) + chatEnd);
    });
    assert.deepEqual(await adapter.listModels(), provider === "xai" ? ["example-chat", "current-chat", "newly-released"] : ["example-chat", "newly-released"]);
    const events = await collect(adapter);
    assert.deepEqual(events[0], { type: "text_delta", text: "pong" });
    assert.equal(events.at(-1)?.type, "completed");
    if (provider === "opencode-go") {
      await collect(new HttpModelAdapter(config, "local-fixture-key"));
      await collect(adapter, { ...request, sessionId: "role-a/window-2" });
      assert.equal(sessions[0], sessions[1]);
      assert.notEqual(sessions[0], sessions[2]);
    }
    if (provider === "xai") {
      const end = events.at(-1);
      assert.ok(end?.type === "completed" && end.continuation?.provider === "xai");
      const next = { ...request, messages: [{ role: "assistant" as const, content: "pong", continuation: end.continuation }] };
      assert.match(serializeModelRequest("openai-responses", config.baseUrl, next, "xai"), /signed/);
      assert.doesNotMatch(serializeModelRequest("openai-responses", config.baseUrl, next), /signed/);
    }
  });
}

test("Chat 工具续轮保留分片推理、签名与用量，切换服务商后隔离", async t => {
  const baseUrl = "https://proxy.example/v1";
  const delta = (value: unknown) => chunk({ choices: [{ delta: value }] });
  t.mock.method(globalThis, "fetch", async () => new Response(
    delta({ reasoning_content: "思", reasoning_details: [{ type: "reasoning.text", index: 0, text: "第" }] }) +
    delta({ reasoning_content: "考", reasoning_details: [{ type: "reasoning.text", index: 0, text: "一", signature: "signed" }] }) +
    delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{}" } }] }) +
    chunk({ choices: [{ finish_reason: "tool_calls" }], usage: { prompt_tokens: 8, prompt_cache_hit_tokens: 3 } }) + "data: [DONE]\n\n",
  ));
  for (const provider of ["openrouter", "deepseek", "mimo", "zai", "opencode-go"] as const) {
    const adapter = new HttpModelAdapter({ provider, protocol: "openai-chat", baseUrl }, undefined);
    const events = await collect(adapter);
    assert.ok(events.every(event => event.type !== "text_delta"));
    assert.deepEqual(events.find(e => e.type === "usage"), { type: "usage", inputTokens: 8, cachedTokens: 3 });
    const end = events.at(-1);
    assert.ok(end?.type === "completed" && end.continuation);
    const next: ModelRequest = { ...request, messages: [{
      role: "assistant", content: "", toolCalls: [{ name: "read", callId: "c1", arguments: {} }], continuation: end.continuation,
    }, { role: "tool", toolCallId: "c1", content: "ok" }] };
    const body = JSON.parse(serializeModelRequest("openai-chat", baseUrl, next, provider));
    assert.equal(body.messages[1].reasoning_content, "思考");
    const resumed = selectAgentContext({ request: next, protocol: "openai-chat", baseUrl, provider, resuming: true,
      evidenceQuery: "read", prompt: { required: next.system, optional: [] } });
    assert.equal(JSON.parse(serializeModelRequest("openai-chat", baseUrl, resumed, provider)).messages[1].reasoning_content, "思考");
    if (provider === "openrouter" || provider === "opencode-go") assert.deepEqual(body.messages[1].reasoning_details,
      [{ type: "reasoning.text", index: 0, text: "第一", signature: "signed" }]);
    assert.doesNotMatch(serializeModelRequest("openai-chat", baseUrl, next, provider === "mimo" ? "zai" : "mimo"), /思考|signed/);
    assert.doesNotMatch(serializeModelRequest("openai-chat", baseUrl, { ...next, modelName: "other" }, provider), /思考|signed/);
    if (provider === "deepseek" || provider === "mimo") {
      const history: ModelRequest = { ...request, tools: [{ name: "read", description: "读取", inputSchema: { type: "object" } }],
        messages: [{ role: "assistant", content: "历史文本" }, { role: "assistant", content: "上次回答", continuation: end.continuation }] };
      const messages = JSON.parse(serializeModelRequest("openai-chat", baseUrl, history, provider)).messages;
      assert.deepEqual(messages[1], { role: "user", content: '[角色先前的回复]\n{"sender":"assistant","text":"历史文本"}' });
      assert.equal(messages[2].reasoning_content, "思考");
    }
    const switched: ModelRequest = { ...next, resourceId: "other-account", messages: [{
      role: "assistant", content: "工具调用", toolCalls: [{ name: "read", callId: "c1", arguments: {} }],
      continuation: { ...end.continuation, resourceId: "first-account" },
    }, next.messages[1]!] };
    const isolated = selectAgentContext({ request: switched, protocol: "openai-chat", baseUrl, provider,
      resuming: false, evidenceQuery: "", prompt: { required: "", optional: [] } });
    assert.doesNotMatch(serializeModelRequest("openai-chat", baseUrl, isolated, provider), /思考|signed|tool_calls/);
    assert.doesNotMatch(serializeModelRequest("openai-chat", baseUrl, switched, provider), /思考|signed/);
  }
});

for (const provider of ["deepseek", "mimo", "openrouter"] as const) {
  test(`${provider} 角色正常对话连续调用两批工具时完整保留每批原生推理和结果`, async t => {
    const config = { provider, protocol: "openai-chat" as const, baseUrl: "https://offline.invalid/v1" };
    const fixture = createFixtureWithModel(new HttpModelAdapter(config, "local-fixture-key"));
    t.after(() => fixture.close());
    const { app, roleId, windowId } = fixture;
    assert.equal(app.services.activity.requestStop(roleId).confirmed, true);
    const resource = app.services.resources.create({ name: provider, kind: "model", config });
    app.services.resources.replaceBindings(roleId, [{
      capability: "chat_model", resourceId: resource.resourceId, modelName: request.modelName, enabled: true,
    }]);
    app.services.activity.resume(roleId);
    type WireMessage = {
      role: string; content: string | null; reasoning_content?: string; reasoning_details?: { signature?: string }[];
      tool_calls?: { id: string }[]; tool_call_id?: string;
    };
    const sent: WireMessage[][] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).messages);
      const round = sent.length;
      if (round > 2) return new Response(chunk({ choices: [{ delta: { content: "核对完毕" } }] }) + chatEnd);
      return new Response(chunk({ choices: [{ finish_reason: "tool_calls", delta: {
        content: `第${round}次核对`, reasoning_content: `original-${round}`,
        reasoning_details: [{ type: "reasoning.text", text: "trace", signature: `signature-${round}` }],
        tool_calls: [{ index: 0, id: `call-${round}`, function: {
          name: "history_lookup", arguments: JSON.stringify({ kind: "message", query: "核对" }),
        } }],
      } }] }) + "data: [DONE]\n\n");
    });
    const ask = async (content: string) => {
      app.conversation.submitMessage(roleId, windowId, { content, submissionId: randomUUID(), sourcePlatform: "nowadays" });
      await app.conversation.waitForIdle(roleId);
    };
    await ask("请连续核对两次。");
    assert.equal(sent.length, 3);
    for (const [index, messages] of sent.entries()) {
      const native = messages.filter(m => m.tool_calls || m.role === "tool");
      assert.equal(native.length, index * 2);
      for (let batch = 1; batch <= index; batch++) {
        const assistant = native[batch * 2 - 2]!;
        const result = native[batch * 2 - 1]!;
        assert.equal(assistant.reasoning_content, `original-${batch}`);
        assert.equal(assistant.tool_calls?.[0]?.id, `call-${batch}`);
        assert.equal(result.tool_call_id, `call-${batch}`);
        if (provider === "openrouter") assert.equal(assistant.reasoning_details?.[0]?.signature, `signature-${batch}`);
      }
    }
    await ask("收到。");
    assert.equal(sent.length, 4);
    if (provider !== "openrouter") {
      assert.ok(sent[3]!.some(m => m.role === "user" && m.content?.includes("[角色先前的回复]") && m.content.includes("核对完毕")));
      assert.ok(sent[3]!.some(m => m.content === '[用户先前的发言]\n{"sender":"user","text":"请连续核对两次。"}'));
      assert.equal(sent[3]!.at(-1)?.content, '[本轮用户消息]\n{"sender":"user","text":"收到。"}');
    }
  });
}

test("自定义 AI Studio 入口能续传 Google 签名，通用入口保持隔离", async t => {
  const config = { protocol: "google-gemini" as const, provider: "google-ai-studio" as const, baseUrl: "https://studio.example/v1beta" };
  t.mock.method(globalThis, "fetch", async () => new Response(chunk({
    candidates: [{ content: { role: "model", parts: [{ text: "pong", thoughtSignature: "signed-studio" }] }, finishReason: "STOP" }],
  })));
  const end = (await collect(new HttpModelAdapter(config, "offline"))).at(-1);
  assert.ok(end?.type === "completed" && end.continuation?.provider === config.provider);
  const next = { ...request, messages: [{ role: "assistant" as const, content: "pong", continuation: end.continuation }] };
  assert.match(serializeModelRequest(config.protocol, config.baseUrl, next, config.provider), /signed-studio/);
  assert.doesNotMatch(serializeModelRequest(config.protocol, config.baseUrl, next), /signed-studio/);
});

test("Vertex Express 直接提供预置，AI Studio 完整翻页，OpenRouter 无密钥读取公开目录", async t => {
  const urls: string[] = [];
  let invalid = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    if (String(url).endsWith("v1/models")) return Response.json({ data: [{ id: "open/public" }] });
    if (String(url).includes("pageToken=")) return Response.json({
      models: [{ name: "models/second" }], ...(invalid ? { nextPageToken: "next/1" } : {}),
    });
    return Response.json({ models: [{ name: "models/first" }], nextPageToken: "next/1" });
  });
  assert.deepEqual(await new HttpModelAdapter({ protocol: "google-gemini", baseUrl: GOOGLE_VERTEX_EXPRESS_URL }, undefined).listModels(), ["gemini-3.8-flash", "gemini-3.5-flash"]);
  assert.equal(urls.length, 0);
  const studio = new HttpModelAdapter({ protocol: "google-gemini", baseUrl: "https://studio.example/v1beta" }, "test-key");
  assert.deepEqual(await studio.listModels(), ["first", "second"]);
  assert.ok(urls[1]?.endsWith("pageToken=next%2F1"));
  invalid = true;
  await assert.rejects(() => studio.listModels(), { code: "MODEL_LIST_INCOMPATIBLE" });
  const router = new HttpModelAdapter({ provider: "openrouter", protocol: "openai-chat", baseUrl: MODEL_PROVIDERS.openrouter.baseUrl }, undefined);
  assert.deepEqual(await router.listModels(), ["open/public"]);
  assert.equal(urls.at(-1), "https://openrouter.ai/api/v1/models");
});

test("Z.AI 流式回复也可在一个工具块中返回完整参数对象", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(chunk({
    choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "read", arguments: { path: "note" } } }] }, finish_reason: "tool_calls" }],
  }) + "data: [DONE]\n\n"));
  const adapter = new HttpModelAdapter({ protocol: "openai-chat", provider: "zai", baseUrl: MODEL_PROVIDERS.zai.baseUrl }, "offline");
  assert.deepEqual((await collect(adapter)).find(event => event.type === "tool_call"), {
    type: "tool_call", callId: "c1", name: "read", arguments: { path: "note" },
  });
});

test("已保存的资源、探测与测试指纹区分共用协议和地址的服务商", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-providers-"));
  const app = createBackendApp(parseBackendConfig(["--app-root", root, "--port", "0"]));
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const legacy = { protocol: "openai-chat" as const, baseUrl: "https://proxy.example/v1" };
  const config = { ...legacy, provider: "mimo" as const };
  const key = "offline-fixture-key";
  const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("api-key"), key);
    return init.method === "GET" ? Response.json({ data: [{ id: "from-account" }] })
      : new Response(chunk({ choices: [{ delta: { content: "pong" } }] }) + chatEnd);
  });
  for (const schema of [modelConfigSchema, modelServiceProbeSchema, modelServiceTestSchema]) {
    const extra = schema === modelServiceTestSchema ? { model: "test" } : {};
    assert.ok(schema.safeParse({ ...legacy, ...extra }).success);
    assert.ok(!schema.safeParse({ ...config, protocol: "anthropic-messages", ...extra }).success);
    assert.ok(!schema.safeParse({ ...config, provider: "unknown", ...extra }).success);
  }
  const probe = await app.services.modelServices.test({ ...config, secret: key, model: "from-account" });
  assert.ok(probe.ok && probe.testCallId);
  const resource = app.services.resources.create({ kind: "model", name: "MiMo", config, secret: key, draftTestCallId: probe.testCallId });
  assert.equal(resource.config.provider, "mimo");
  assert.equal(resource.lastTest?.stale, false);
  assert.deepEqual(await app.services.modelServices.listModelsForResource(resource.resourceId), { models: ["from-account"] });
  const vertex = app.services.resources.create({ kind: "model", name: "Vertex Express", config: {
    protocol: "google-gemini", baseUrl: GOOGLE_VERTEX_EXPRESS_URL, credentialRef: "env:NOWADAYS_MISSING_PRESET_TEST_KEY",
  } });
  assert.deepEqual(await app.services.modelServices.listModelsForResource(vertex.resourceId), {
    models: ["gemini-3.8-flash", "gemini-3.5-flash"], source: "preset",
  });
  const changed = { ...legacy, provider: "zai" as const };
  assert.notEqual(fingerprintOf(changed, "salt"), fingerprintOf(config, "salt"));
  await assert.rejects(() => app.services.modelServices.listModels({ ...changed, resourceId: resource.resourceId }), { code: "RESOURCE_CREDENTIAL_STALE" });
  assert.throws(() => app.services.resources.update(resource.resourceId, { config: changed }), { code: "RESOURCE_CREDENTIAL_STALE" });
  assert.equal(fetch.mock.callCount(), 2);
});
