import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ExtensionHost } from "../../src/application/extensions/extension-host.js";
import { setTimeout as delay } from "node:timers/promises";
import { listen } from "../../src/bootstrap/app.js";
import type { ModelEvent, ModelRequest } from "../../src/domain/model.js";
import { createFixtureWithModel, deferred, ScriptedChatModel } from "../fixtures/conversation-fixture.js";
import { seedLegacyPresetAssistant } from "../fixtures/legacy-role-fixture.js";

const event = (name: string, args: object): ModelEvent[] => [
  { type: "tool_call", callId: randomUUID(), name, arguments: args }, { type: "completed", stopReason: "stop" },
];
const say = (text: string): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
const result = (r: ModelRequest) => r.messages.filter(m => m.role === "tool").at(-1)?.content ?? "";
test("草稿与发布目录隔离，拒绝穿越与 Windows junction 并保留已启用版本", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const host: ExtensionHost = f.app.services.extensions;
  try {
    assert.throws(() => host.work.workspace("../outside"));
    const dir = host.work.workspace("project");
    assert.equal(dir, fs.realpathSync.native(path.join(f.app.config.appRoot, "extensions-work/project")));
    const files = { "manifest.json": JSON.stringify({ version: "v1", entry: "entry.mjs" }), "entry.mjs": "export default () => {}" };
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    await host.publishWork("project");
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: "v2", entry: "entry.mjs" }));
    fs.mkdirSync(path.join(f.root, "outside"));
    fs.symlinkSync(path.join(f.root, "outside"), path.join(dir, "ui"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => host.publishWork("project"), { code: "EXTENSION_PATH_INVALID" });
    assert.equal(host.get("project").version, "v1");
    assert.equal(host.get("project").status, "enabled");
    fs.symlinkSync(dir, path.join(f.root, "extensions-work", "linked"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => host.work.workspace("linked"), { code: "EXTENSION_PATH_INVALID" });
  } finally { await f.close(); }
});

const shell = process.platform === "win32" ? "powershell" : "bash";

test("Pi SDK 后台首测失败、局部修复、前台并发、主角色热发布与逐次记账", async () => {
  const gate = deferred<void>();
  const reached = deferred<void>();
  const finished = deferred<void>();
  const mockKey = "offline-probe-key-" + randomUUID();
  const manifest = { version: "v1", entry: "entry.mjs", ui: [] };
  const entry = 'export const label = "wrong";\nexport default (_ctx, api) => api.tools.register({name:"label",description:"标签",scope:"all_roles",inputSchema:{type:"object"}}, () => label);';
  // 第三个文件既验证工具业务逻辑，也检查在 Pi 内实际可见的进程环境与独立配置目录。
  const check = `import assert from "node:assert/strict";import fs from "node:fs";import path from "node:path";import { label } from "./entry.mjs";
assert.equal(process.env.NOWADAYS_PI_TEST_CREDENTIAL, undefined);assert.ok(Object.values(process.env).every(v=>!v.includes("offline-probe-key-")));
for(const f of fs.readdirSync(process.env.PI_CODING_AGENT_DIR,{recursive:true})) {
const p=path.join(process.env.PI_CODING_AGENT_DIR,f); if(fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p).includes("offline-probe-key")); }
assert.equal(label,"verified-label","FIRST_TEST_FAILED");console.log("MOD_TEST_PASSED");`;
  const requestBodies: string[] = [];
  const toolOutputs: string[] = [];
  const attempts: string[] = [];
  const errors: string[] = [];
  const plan = [
    ["write", { path: "manifest.json", content: JSON.stringify(manifest) }],
    ["write", { path: "entry.mjs", content: entry }],
    ["write", { path: "test.mjs", content: check }],
    [shell, { command: "node test.mjs" }],
    ["read", { path: "entry.mjs" }],
    ["edit", { path: "entry.mjs", edits: [{ oldText: '"wrong"', newText: '"verified-label"' }] }],
    [shell, { command: "node test.mjs" }],
  ] as const;
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      attempts.push(req.url!);
      assert.equal(req.headers.authorization, "Bearer " + mockKey);
      assert.equal(body.model, "offline-pi");
      if (attempts.length === 1) { res.writeHead(503).end(); return; }
      toolOutputs.push(JSON.stringify(body.messages.at(-1)));
      const i = requestBodies.push(JSON.stringify(body)) - 1;
      if (!i) { reached.resolve(); await gate.promise; }
      const call = plan[i];
      const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "call_" + i, type: "function",
        function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { role: "assistant", content: "工程复测完成" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? "tool_calls" : "stop" }]) {
        res.write("data: " + JSON.stringify({ id: "offline", model: body.model, choices: [{ index: 0, ...choice }],
          usage: { prompt_tokens: 13, completion_tokens: 7 } }) + "\n\n");
      }
      res.end("data: [DONE]\n\n");
      if (!call) finished.resolve();
    } catch (error) { errors.push(String(error)); res.writeHead(500).end(); }
  });
  process.env.NOWADAYS_PI_TEST_CREDENTIAL = mockKey;
  const upstreamPort = await listen(upstream, 0, "127.0.0.1");
  let jobId = "";
  let inspected = "";
  let phase: "result" | "inspect" | "published" | "tested" | "ordinary" | "done" = "result";
  function finish(request: ModelRequest): ModelEvent[] {
    switch (phase) {
      case "result": phase = "inspect"; return event("pi_task_result", { jobId });
      case "inspect": {
        inspected = result(request);
        if (inspected.includes('"state":"running"')) { phase = "result"; return say("工程还在收尾"); }
        phase = "published";
        return event("app_extension_publish_work", { extId: "sample" });
      }
      case "published": phase = "tested"; return event("ext_sample__label", {});
      case "tested": phase = "ordinary"; return say("已发布");
      case "ordinary": phase = "done"; return event("ext_sample__label", {});
      case "done": return say("已收到");
    }
  }
  const scripts: ConstructorParameters<typeof ScriptedChatModel>[0] = [
    event("pi_task_start", { extId: "sample", prompt: "制作标签扩展并运行测试。" }),
    r => { inspected = result(r); jobId = inspected.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] ?? ""; return say("工程已接单"); },
    say("前台仍可交谈"),
    ...Array.from({ length: 60 }, () => finish),
  ];
  const model = new ScriptedChatModel(scripts);
  const f = createFixtureWithModel(model);
  const { app } = f;
  async function send(role: string, window: string, content: string) {
    app.conversation.submitMessage(role, window, { content, sourcePlatform: "nowadays", submissionId: randomUUID() });
    await app.conversation.waitForIdle(role, 30000);
  }
  try {
    await listen(app.server, 0, "127.0.0.1");
    seedLegacyPresetAssistant(app.config);
    const id = app.appStore.getRoleIndexByBuiltinKey("xiacheng")!.roleId;
    const window = app.services.roles.initializeRole(id).defaultWindowId;
    const resource = app.services.resources.create({ kind: "model", name: "离线 Pi", secret: mockKey,
      config: { baseUrl: "http://127.0.0.1:" + upstreamPort + "/v1", protocol: "openai-chat" } });
    const mcp = app.services.resources.create({ kind: "mcp", name: "Pi", config: { command: "nowadays-pi", args: [], env: {} } });
    app.services.resources.replaceBindings(id, [
      { resourceId: resource.resourceId, capability: "chat_model", enabled: true, modelName: "offline-pi" },
      { resourceId: mcp.resourceId, capability: "mcp", enabled: true },
    ]);
    app.services.activity.resume(id);
    await send(id, window, "开发并测试标签工具");
    assert.ok(jobId && inspected.includes("running"), inspected);
    const timeout = (ms: number) => delay(ms, false, { ref: false });
    assert.ok(await Promise.race([reached.promise.then(() => true), timeout(25000)]), "Pi 未到达模拟模型：" + errors.join());
    await send(id, window, "聊点别的");
    assert.equal(model.requests.length, 3);
    assert.ok(app.services.messages.list(id, window, null, 20).items.some(m => m.content === "前台仍可交谈"));
    gate.resolve();
    assert.ok(await Promise.race([finished.promise.then(() => true), timeout(30000)]), "Pi 调试未结束，轮数 " + requestBodies.length);
    assert.match(requestBodies[0]!, /Nowadays Mod 工程规范/);
    assert.match(toolOutputs[4]!, /FIRST_TEST_FAILED/);
    assert.match(toolOutputs[7]!, /MOD_TEST_PASSED/);
    assert.deepEqual(fs.readdirSync(path.join(f.root, "extensions-work/sample")).sort(), ["entry.mjs", "manifest.json", "test.mjs"]);
    for (let i = 0; i < 20; i++) {
      await send(id, window, "读取结果，完成后发布并试用");
      if (!inspected.includes('"state":"running"')) break;
      await delay(50);
    }
    assert.match(inspected, /completed/);
    assert.ok(model.requests.at(-2)!.tools.some(t => t.name === "ext_sample__label"));
    assert.match(result(model.requests.at(-1)!), /verified-label/);
    app.services.activity.requestStop(id);
    await send(f.roleId, f.windowId, "使用公开标签");
    assert.ok(!model.requests.at(-2)!.tools.some(t => t.name === "app_extension_publish_work"));
    assert.match(result(model.requests.at(-1)!), /verified-label/);
    const rows = app.appStore.db.prepare("SELECT * FROM token_usage_records WHERE source_call_id LIKE 'pi:%'").all() as
      { status: string; input_tokens: number; output_tokens: number; role_id: string }[];
    assert.equal(attempts.length, 9);
    assert.equal(rows.length, attempts.length);
    assert.equal(rows.filter(r => r.status === "succeeded").length, 8);
    assert.equal(rows.filter(r => r.status === "failed").length, 1);
    assert.ok(rows.filter(r => r.status === "succeeded").every(r => Number(r.input_tokens) === 13 && Number(r.output_tokens) === 7 && r.role_id === id));
    assert.deepEqual(errors, []);
  } finally { delete process.env.NOWADAYS_PI_TEST_CREDENTIAL; gate.resolve(); await f.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
