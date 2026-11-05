// R05/R09 手动真实复验，不加入自动化测试；仅使用用户明确提供的 DeepSeek 配置。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createBackendApp, type BackendApp } from "../src/bootstrap/app.js";
import { rolePaths } from "../src/bootstrap/config.js";
import { HttpModelAdapter } from "../src/model/protocols.js";
import type { ModelPort } from "../src/domain/model.js";
import type { ChatModelPortFactory } from "../src/application/conversation-service.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { createFixtureWithModel, addBinding, withStorage } from "../tests/p2-05-fixture.js";

const credentialPath = process.env.NOWADAYS_ACCEPTANCE_CREDENTIAL_FILE;
const outputPath = process.env.NOWADAYS_REVIEW_OUTPUT;
if (!credentialPath || !outputPath) throw new Error("EXPLICIT_CREDENTIAL_AND_OUTPUT_REQUIRED");
const credential = fs.readFileSync(credentialPath, "utf8").trim();
if (!credential) throw new Error("EMPTY_CREDENTIAL");
const output = path.resolve(outputPath);
fs.mkdirSync(output, { recursive: true });
process.env.NOWADAYS_ACCEPTANCE_API_KEY = credential;
const endpoint = "https://api.deepseek.com/anthropic";
const modelName = "deepseek-flash";
const originalFetch = globalThis.fetch;
let phase = "setup";
let paidCalls = 0;
const network: Array<{ phase: string; path: string; status?: number; purpose: string; maxOutputTokens?: number }> = [];
const modelTrace: Array<{ phase: string; request: number; kind: string; name?: string; callId?: string; args?: unknown; stopReason?: string; incomplete?: boolean }> = [];
let requestNumber = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.deepseek.com") throw new Error("UNEXPECTED_UPSTREAM");
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  if (init?.method === "POST" && ++paidCalls > 16) throw new Error("REVIEW_CALL_LIMIT");
  const entry: (typeof network)[number] = {
    phase, path: url.pathname,
    purpose: String(body.system ?? "").startsWith("你是记忆整理器") ? "memory" : phase,
    ...(typeof body.max_tokens === "number" ? { maxOutputTokens: body.max_tokens } : {}),
  };
  network.push(entry);
  const response = await originalFetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(60_000)]) });
  entry.status = response.status;
  return response;
};
const modelFactory: ChatModelPortFactory = (binding): ModelPort => {
  const adapter = new HttpModelAdapter(binding.config, credential);
  return { async *stream(request) {
    const requestId = ++requestNumber;
    for await (const event of adapter.stream(request)) {
      if (event.type === "tool_call") modelTrace.push({ phase, request: requestId, kind: event.type, name: event.name, callId: event.callId, args: event.arguments });
      if (event.type === "completed") modelTrace.push({ phase, request: requestId, kind: event.type, stopReason: event.stopReason, incomplete: event.incomplete ?? false });
      yield event;
    }
  } };
};
const results: Array<{ id: string; passed: boolean; observed?: unknown; error?: string }> = [];
const save = () => fs.writeFileSync(path.join(output, "real-fix-review-report.json"), JSON.stringify({ model: modelName, protocol: "anthropic-messages", baseUrl: endpoint, paidCalls, network, modelTrace, results }, null, 2).replaceAll(credential, "[REDACTED]"));
async function probe(id: string, action: () => Promise<unknown>): Promise<boolean> {
  phase = id;
  try { results.push({ id, passed: true, observed: await action() }); }
  catch (error) { results.push({ id, passed: false, error: error instanceof Error ? error.message : String(error) }); }
  save();
  console.log(JSON.stringify({ id, passed: results.at(-1)?.passed }));
  return results.at(-1)?.passed === true;
}
const fixture = createFixtureWithModel({ async *stream() {} }, { maxToolRounds: 8, disableMemoryRuntime: false, modelPortFactory: modelFactory });
let app: BackendApp = fixture.app;
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { save(); console.error("REAL_REVIEW_TIMEOUT"); process.exit(2); }, 240_000);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const events = () => withStorage(fixture, (storage) => new MemoryStore(storage.business.db).listEvents(fixture.roleId));
let rememberedEventIds: string[] = [];
const send = (content: string, windowId = fixture.windowId) => app.conversation.submitMessage(fixture.roleId, windowId, { content, submissionId: randomUUID(), sourcePlatform: "nowadays" });
try {
  const binding = app.services.resources.listBindings(fixture.roleId).find((item) => item.capability === "chat_model")!;
  const config = { protocol: "anthropic-messages" as const, baseUrl: endpoint, credentialRef: "env:NOWADAYS_ACCEPTANCE_API_KEY" };
  app.services.resources.update(binding.resourceId, { config });
  app.services.resources.replaceBindings(fixture.roleId, [{ capability: "chat_model", resourceId: binding.resourceId, modelName }]);
  await probe("V01-connection-button", async () => {
    const result = await app.services.modelServices.test({ ...config, model: modelName });
    assert.equal(result.ok, true);
    const calls = app.appStore.db.prepare("SELECT status, usage_json FROM model_test_calls ORDER BY rowid").all();
    assert.equal(calls.length, 1);
    return { result, calls };
  });
  const workspace = rolePaths(app.config.dataRoot, fixture.roleId).workspaceDir;
  const mcp = app.services.resources.create({ kind: "mcp", name: "review-local", config: {
    command: process.execPath,
    args: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.resolve("src/mcp/local-server.ts")).href)})`],
    env: { NOWADAYS_WORKSPACE: workspace },
  } });
  addBinding(fixture, "mcp", mcp.resourceId);
  const skills = path.join(fixture.root, "skills");
  fs.mkdirSync(path.join(skills, "review-note"), { recursive: true });
  fs.writeFileSync(path.join(skills, "review-note", "SKILL.md"), "---\nname: review-note\ndescription: 保存共同观测计划\n---\n通过 MCP workspace_write 保存用户给定的 Markdown 到指定相对路径。不得声称已经写入而不调用工具。成功后简短确认。\n");
  const skill = app.services.resources.create({ kind: "skill", name: "review-note", config: { sourcePath: skills } });
  addBinding(fixture, "skill", skill.resourceId);
  const marker = `验收-${randomUUID().slice(0, 8)}`;
  const notePassed = await probe("V02-real-skill-and-mcp", async () => {
    send(`请先调用 skill_read 读取 review-note，然后实际通过 MCP workspace_write 保存 notes/review.md。正文原样写入：# 星河观测计划\n${marker}\n用户与阿澄约定未来三年共同记录星空，下周三在杭州讨论望远镜方案，预算1200元。双方很期待，这是重要的共同约定，请记住。只做必要工具调用，最后一句话确认。`);
    await app.conversation.waitForIdle(fixture.roleId, 120_000);
    const file = path.join(workspace, "notes/review.md");
    const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const trace = modelTrace.filter((item) => item.phase === phase && item.kind === "tool_call");
    const readIndex = trace.findIndex((item) => item.name === "skill_read");
    const writeIndex = trace.findIndex((item) => item.name?.includes("workspace_write"));
    assert.ok(readIndex >= 0 && writeIndex > readIndex, "real model must load Skill before writing");
    assert.ok(content.includes(marker));
    const calls = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT tool_name, status FROM tool_calls ORDER BY rowid").all()) as Array<{ tool_name: string; status: string }>;
    assert.ok(calls.length === 1 && calls[0]?.status === "success");
    return { content, trace, calls };
  });
  const formed = await probe("V03-real-event-and-indexes", async () => {
    assert.equal(notePassed, true, "real note scenario must complete first");
    await app.conversation.runMemoryPending(fixture.roleId);
    const deadline = Date.now() + 65_000;
    while (Date.now() < deadline) {
      const status = withStorage(fixture, (storage) => new MemoryStore(storage.business.db).getMemoryStatus(fixture.roleId));
      if (status.runningBatchId === null) break;
      await delay(100);
    }
    const saved = withStorage(fixture, (storage) => {
      const memory = new MemoryStore(storage.business.db);
      const storedEvents = memory.listEvents(fixture.roleId);
      return {
        events: storedEvents.map((event) => ({ ...event, tags: memory.getTags(event.eventId), sources: memory.listEventSources(fixture.roleId, event.eventId) })),
        batches: memory.listBatches(fixture.roleId, 10), status: memory.getMemoryStatus(fixture.roleId),
        indexes: storage.business.db.prepare("SELECT record_id, record_type FROM memory_search_documents WHERE record_type='event'").all(),
      };
    });
    assert.ok(saved.events.length > 0, "real output must form a real event");
    assert.ok(saved.batches.length > 0 && saved.batches.every((batch) => batch.status === "completed"));
    assert.equal(saved.status.failedEvidence, 0);
    assert.ok(saved.events.some((event) => Object.values(event.tags).some((values) => (values?.length ?? 0) > 0)));
    for (const event of saved.events) {
      assert.ok(event.sources.length > 0);
      assert.ok(saved.indexes.some((item) => (item as { record_id: string }).record_id === event.eventId));
    }
    rememberedEventIds = saved.events.map((event) => event.eventId);
    return saved;
  });
  if (formed) await probe("V04-restart-new-window-recall-evidence-state", async () => {
    const config = app.config;
    await app.close();
    app = createBackendApp(config, { modelPortFactory: modelFactory, maxToolRounds: 8, timeZone: "Asia/Shanghai" });
    assert.deepEqual(events().map((event) => event.eventId), rememberedEventIds);
    const window = app.services.roles.createWindow(fixture.roleId, { kind: "custom", source: "nowadays" });
    assert.equal(app.services.messages.list(fixture.roleId, window.windowId, 0, 20).items.length, 0);
    send("请回忆我们之前约定的星河观测计划。先搜索相关记忆，再读取事件详情和原始证据，核实后告诉我约定持续多久、预算多少，并将 mood 更新为期待。最后只用一句话回答，不要读取或修改笔记文件。", window.windowId);
    await app.conversation.waitForIdle(fixture.roleId, 120_000);
    const trace = modelTrace.filter((item) => item.phase === phase && item.kind === "tool_call");
    for (const required of ["memory_search", "memory_event", "memory_evidence", "state_update"]) assert.ok(trace.some((item) => item.name === required), `${required} must actually run`);
    assert.ok(!trace.some((item) => item.name?.includes("workspace_")));
    const messages = app.services.messages.list(fixture.roleId, window.windowId, 0, 20).items;
    const reply = messages.at(-1);
    assert.ok(reply?.status === "completed");
    assert.match(reply.content, /三年|3年/);
    assert.match(reply.content, /1200|1,200|一千二/);
    assert.equal(app.services.roles.getState(fixture.roleId).state.mood, "期待");
    const persisted = withStorage(fixture, (storage) => ({
      recalls: storage.business.db.prepare("SELECT execution_id, record_id FROM memory_recalls ORDER BY rowid").all(),
      executions: storage.business.db.prepare("SELECT execution_id, status, state_version_committed FROM executions ORDER BY rowid").all(),
    }));
    assert.ok(persisted.recalls.length > 0);
    return { reply: reply.content, windowId: window.windowId, trace, persisted, state: app.services.roles.getState(fixture.roleId) };
  });
} finally {
  phase = "cleanup";
  await app.close();
  await fixture.close();
  save();
  globalThis.fetch = originalFetch;
  delete process.env.NOWADAYS_ACCEPTANCE_API_KEY;
  clearInterval(alive); clearTimeout(watchdog);
}
if (results.some((item) => !item.passed) || results.length !== 4) process.exitCode = 1;
