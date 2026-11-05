import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import { HttpMemoryModel } from "../src/application/memory-runtime.js";
import { rolePaths } from "../src/bootstrap/config.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { ScriptedChatModel, createFixture, createFixtureWithModel, addBinding, seedEvent, withStorage, type Fixture } from "../tests/p2-05-fixture.js";

// 只检查公开服务链路和本地 MCP；每项保留观测，不使用真实模型或用户文件。
const root = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p2-05-independent-20261104");
fs.mkdirSync(root, { recursive: true });
const reports: Array<{ id: string; contractPassed: boolean; observed: unknown }> = [];
const keepAlive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("REVIEW_WATCHDOG_TIMEOUT"); process.exit(2); }, 60_000);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await pause(20);
  }
  return condition();
}
async function probe(id: string, action: () => Promise<{ contractPassed: boolean; observed: unknown }>): Promise<void> {
  try { reports.push({ id, ...await action() }); }
  catch (error) { reports.push({ id, contractPassed: false, observed: { probeError: String(error) } }); }
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(reports, null, 2));
}
function submit(fixture: Fixture, content = "继续处理"): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, { content, submissionId: randomUUID(), sourcePlatform: "nowadays" });
}
function workspace(fixture: Fixture): string { return rolePaths(fixture.app.config.dataRoot, fixture.roleId).workspaceDir; }
function bindMcp(fixture: Fixture, env: Record<string, string> = {}) {
  const resource = fixture.app.services.resources.create({ kind: "mcp", name: "review", config: {
    command: process.execPath,
    args: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.resolve("src/mcp/local-server.ts")).href)})`],
    env: { NOWADAYS_WORKSPACE: workspace(fixture), ...env },
  } });
  addBinding(fixture, "mcp", resource.resourceId);
  return resource;
}

await probe("R04-state-update-result", async () => {
  const fixture = createFixture([
    [{ type: "tool_call", callId: "state-wire", name: "state_update", arguments: { patch: { mood: "开心" } } }, { type: "completed", stopReason: "tool_calls" }],
    [{ type: "text_delta", text: "记录完毕" }, { type: "completed", stopReason: "stop" }],
  ]);
  try {
    submit(fixture);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    if (!(fixture.model instanceof ScriptedChatModel)) throw new Error("SCRIPTED_MODEL_REQUIRED");
    const requests = fixture.model.requests;
    const result = requests[1]?.messages.find((message) => message.role === "tool");
    const state = fixture.app.services.roles.getState(fixture.roleId);
    const status = result ? JSON.parse(result.content).status : null;
    return { contractPassed: status === "success", observed: { toolReply: result, role: state } };
  } finally { await fixture.close(); }
});

await probe("R03-chat-explicit-incomplete", async () => {
  const fixture = createFixture([[{ type: "text_delta", text: "尚未完成的半句话" }, { type: "completed", stopReason: "length", incomplete: true }]]);
  try {
    submit(fixture);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const rows = withStorage(fixture, (storage) => ({ executions: storage.business.db.prepare("SELECT status, decision_round FROM executions").all(), replies: storage.business.db.prepare("SELECT content, status FROM messages WHERE sender='assistant'").all() }));
    return { contractPassed: !(rows.executions as Array<{ status: string }>).some((row) => row.status === "completed"), observed: rows };
  } finally { await fixture.close(); }
});

await probe("R02-model-config-refresh", async () => {
  const observed: string[] = [];
  let fixture: Fixture;
  let rounds = 0;
  fixture = createFixtureWithModel({ async *stream() {} }, { modelPortFactory(binding) {
    return { async *stream(): AsyncIterable<ModelEvent> {
      observed.push(binding.config.baseUrl);
      rounds += 1;
      if (rounds === 1) {
        fixture.app.services.resources.update(binding.resourceId, { config: { ...binding.config, baseUrl: "http://new-config.invalid/v1" } });
        yield { type: "tool_call", callId: "refresh", name: "memory_search", arguments: { query: "无匹配" } };
        yield { type: "completed", stopReason: "tool_calls" };
      } else { yield { type: "text_delta", text: "完成" }; yield { type: "completed", stopReason: "stop" }; }
    } };
  } });
  try {
    submit(fixture);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    return { contractPassed: observed.length === 2 && observed[1] === "http://new-config.invalid/v1", observed };
  } finally { await fixture.close(); }
});

await probe("R06-agent-memory-capabilities", async () => {
  const fixture = createFixture([[{ type: "text_delta", text: "说明工具" }, { type: "completed", stopReason: "stop" }]]);
  try {
    submit(fixture);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    if (!(fixture.model instanceof ScriptedChatModel)) throw new Error("SCRIPTED_MODEL_REQUIRED");
    const requests = fixture.model.requests;
    const tools = requests[0]?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    // 名称可变，核对实际 schema 是否暴露版本纠错或来源范围读取入口。
    const schemas = JSON.stringify(tools);
    const correction = schemas.includes("expectedVersion") && /correct|纠错|修正/.test(schemas);
    const rangeRead = schemas.includes("fromSequence") || schemas.includes("from_sequence");
    return { contractPassed: correction && rangeRead, observed: { names, correction, rangeRead, tools } };
  } finally { await fixture.close(); }
});

const memoryInput = { roleId: randomUUID(), batchId: randomUUID(), currentRound: 0, evidence: [], relatedEvents: [], refineCandidates: [], summaryCandidates: [] };
const binding = { capability: "memory_model" as const, resourceId: randomUUID(), modelName: "offline-memory", config: { protocol: "openai-chat" as const, baseUrl: "http://offline.invalid/v1" } };
await probe("R03-memory-explicit-incomplete", async () => {
  const model: ModelPort = { async *stream() { yield { type: "text_delta", text: '{"operations":[]}' }; yield { type: "completed", stopReason: "length", incomplete: true }; } };
  let rejected = false;
  let result: unknown;
  try { result = await new HttpMemoryModel(model, binding).form(memoryInput); } catch { rejected = true; }
  return { contractPassed: rejected, observed: { rejected, result } };
});

await probe("R05-memory-output-contract", async () => {
  let request: ModelRequest | undefined;
  const model: ModelPort = { async *stream(value) { request = value; yield { type: "text_delta", text: '{"operations":[]}' }; yield { type: "completed", stopReason: "stop" }; } };
  await new HttpMemoryModel(model, binding).form(memoryInput);
  const sent = JSON.stringify(request);
  const fields = ["create_event", "update_event", "refine_event", "expectedVersion", "evidenceIds", "experienceDate"];
  return { contractPassed: fields.every((field) => sent.includes(field)), observed: { request, missingContractFields: fields.filter((field) => !sent.includes(field)) } };
});

await probe("R07-refinement-without-pending-evidence", async () => {
  let calls = 0;
  const fixture = createFixtureWithModel({ async *stream() {} }, { disableMemoryRuntime: false, memoryModelFactory: () => ({ async form() { calls += 1; return { operations: [] }; } }) });
  try {
    seedEvent(fixture, { content: "已整理旧事", title: "旧事", summary: "日常旧事", occurredAt: "2026-10-01T01:00:00.000Z" });
    const candidates = withStorage(fixture, (storage) => {
      storage.business.db.prepare("UPDATE evidence_processing SET status='processed'").run();
      storage.business.db.prepare("UPDATE executions SET decision_round=100 WHERE status='completed'").run();
      return new MemoryStore(storage.business.db).listRefineCandidates(fixture.roleId, 100);
    });
    await fixture.app.conversation.runMemoryPending(fixture.roleId);
    return { contractPassed: candidates.length > 0 && calls > 0, observed: { candidates, modelCalls: calls } };
  } finally { await fixture.close(); }
});

await probe("R01-new-message-during-inflight-tool", async () => {
  let requests = 0;
  const model: ModelPort = { async *stream(request) {
    requests += 1;
    if (requests === 1) {
      const tool = request.tools.find((tool) => tool.name.includes("command_run"));
      if (!tool) throw new Error("MCP_TOOL_MISSING");
      yield { type: "text_delta", text: "正在处理原任务" };
      yield { type: "tool_call", callId: "slow-wire", name: tool.name, arguments: { command: process.execPath, args: ["-e", "const fs=require('node:fs');fs.writeFileSync('started','');const t=setInterval(()=>{if(fs.existsSync('release')){clearInterval(t);console.log('finished')}},20);setTimeout(()=>{clearInterval(t)},4000)"], timeoutMs: 6000 } };
      yield { type: "completed", stopReason: "tool_calls" };
    } else { yield { type: "text_delta", text: "回应新消息" }; yield { type: "completed", stopReason: "stop" }; }
  } };
  const fixture = createFixtureWithModel(model);
  try {
    bindMcp(fixture);
    submit(fixture, "请处理一个慢任务");
    if (!await until(() => fs.existsSync(path.join(workspace(fixture), "started")))) throw new Error("TOOL_NOT_STARTED");
    submit(fixture, "先回答这条消息");
    await pause(500);
    const beforeRelease = requests;
    fs.writeFileSync(path.join(workspace(fixture), "release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    return { contractPassed: beforeRelease >= 2 && tasks.every((task) => task.endReason !== "EXECUTION_SUPERSEDED"), observed: { modelCallsBeforeToolRelease: beforeRelease, tasks } };
  } finally {
    fs.writeFileSync(path.join(workspace(fixture), "release"), "");
    await fixture.close();
  }
});

await probe("R02-mcp-config-refresh", async () => {
  let fixture: Fixture;
  let resource: ReturnType<typeof bindMcp>;
  let requests = 0;
  const model: ModelPort = { async *stream(request) {
    requests += 1;
    if (requests <= 2) {
      if (requests === 2) fixture.app.services.resources.update(resource.resourceId, { config: { ...resource.config, env: { ...(resource.config.env as object), REVIEW_VALUE: "new" } } });
      const tool = request.tools.find((tool) => tool.name.includes("command_run"));
      if (!tool) throw new Error("MCP_TOOL_MISSING");
      yield { type: "tool_call", callId: `wire-${requests}`, name: tool.name, arguments: { command: process.execPath, args: ["-e", "console.log(process.env.REVIEW_VALUE)"] } };
      yield { type: "completed", stopReason: "tool_calls" };
    } else { yield { type: "text_delta", text: "配置测试完成" }; yield { type: "completed", stopReason: "stop" }; }
  } };
  fixture = createFixtureWithModel(model);
  try {
    resource = bindMcp(fixture, { REVIEW_VALUE: "old" });
    submit(fixture);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const results = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT adapted_result_json FROM tool_results ORDER BY rowid ASC").all()) as Array<{ adapted_result_json: string }>;
    return { contractPassed: results.length === 2 && results[1]!.adapted_result_json.includes("new"), observed: results };
  } finally { await fixture.close(); }
});

await probe("R08-ended-task-dispatch", async () => {
  let fixture: Fixture;
  let rounds = 0;
  const model: ModelPort = { async *stream(request) {
    rounds += 1;
    if (rounds === 2) {
      const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
      if (!task) throw new Error("TASK_MISSING");
      fixture.app.conversation.finishTask({ roleId: fixture.roleId, taskId: task.taskId, status: "completed", endReason: "用户结束原任务" });
    }
    if (rounds <= 2) {
      const tool = request.tools.find((tool) => tool.name.includes("workspace_write"));
      if (!tool) throw new Error("MCP_TOOL_MISSING");
      yield { type: "tool_call", callId: `end-wire-${rounds}`, name: tool.name, arguments: { path: `round-${rounds}.txt`, content: "actual side effect" } };
      yield { type: "completed", stopReason: "tool_calls" };
    } else { yield { type: "text_delta", text: "结束" }; yield { type: "completed", stopReason: "stop" }; }
  } };
  fixture = createFixtureWithModel(model);
  try {
    bindMcp(fixture);
    submit(fixture);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const wroteAfterFinish = fs.existsSync(path.join(workspace(fixture), "round-2.txt"));
    return { contractPassed: !wroteAfterFinish, observed: { wroteAfterFinish, tasks: fixture.app.conversation.listTasks(fixture.roleId) } };
  } finally { await fixture.close(); }
});

fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(reports, null, 2));
clearInterval(keepAlive);
clearTimeout(watchdog);
console.log(JSON.stringify(reports.map(({ id, contractPassed, observed }) => ({ id, contractPassed, ...(typeof observed === "object" && observed !== null && "probeError" in observed ? { observed } : {}) })), null, 2));
if (reports.some((report) => !report.contractPassed)) process.exitCode = 1;
