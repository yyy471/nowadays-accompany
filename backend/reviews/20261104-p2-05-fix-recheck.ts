import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ModelEvent, ModelPort } from "../src/domain/model.js";
import { rolePaths } from "../src/bootstrap/config.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { createFixture, createFixtureWithModel, addBinding, seedEvent, withStorage, type Fixture } from "../tests/p2-05-fixture.js";

const root = path.resolve(
  process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p2-05-recheck-20261104",
);
fs.mkdirSync(root, { recursive: true });
const results: Array<{ id: string; contractPassed: boolean; observed: unknown }> = [];
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("RECHECK_TIMEOUT"); process.exit(2); }, 60_000);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function send(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, { content, submissionId: randomUUID(), sourcePlatform: "nowadays" });
}
function workspace(fixture: Fixture): string { return rolePaths(fixture.app.config.dataRoot, fixture.roleId).workspaceDir; }
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) throw new Error("PROBE_WAIT_TIMEOUT"); await delay(20); }
}
async function probe(id: string, action: () => Promise<{ contractPassed: boolean; observed: unknown }>): Promise<void> {
  try { results.push({ id, ...await action() }); }
  catch (error) { results.push({ id, contractPassed: false, observed: { probeError: String(error) } }); }
  fs.writeFileSync(path.join(root, "extended-report.json"), JSON.stringify(results, null, 2));
}
function bindLocal(fixture: Fixture): void {
  const resource = fixture.app.services.resources.create({ kind: "mcp", name: "review", config: {
    command: process.execPath,
    args: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.resolve("src/mcp/local-server.ts")).href)})`],
    env: { NOWADAYS_WORKSPACE: workspace(fixture) },
  } });
  addBinding(fixture, "mcp", resource.resourceId);
}

await probe("R01-original-task-progress-after-new-reply", async () => {
  let requests = 0;
  let continuationRequests = 0;
  const model: ModelPort = { async *stream(request) {
    requests += 1;
    if (requests === 1) {
      const tool = request.tools.find((tool) => tool.name.includes("command_run"));
      if (!tool) throw new Error("MCP_MISSING");
      yield { type: "text_delta", text: "先读取，再保存任务成果" };
      yield { type: "tool_call", callId: "original-read", name: tool.name, arguments: { command: process.execPath, args: ["-e", "const fs=require('node:fs');fs.writeFileSync('started','');const timeout=setTimeout(()=>process.exit(),6000);const poll=setInterval(()=>{if(fs.existsSync('release')){clearTimeout(timeout);clearInterval(poll);console.log('read-result')}},20)"], timeoutMs: 8000 } };
      yield { type: "completed", stopReason: "tool_calls" };
    } else if (request.messages.some((message) => message.role === "tool" && message.content.includes("read-result"))) {
      continuationRequests += 1;
      const tool = request.tools.find((tool) => tool.name.includes("workspace_write"));
      if (!tool) throw new Error("WRITE_TOOL_MISSING");
      if (request.messages.some((message) => message.role === "tool" && message.toolCallId === "original-write")) {
        yield { type: "text_delta", text: "原任务完成" }; yield { type: "completed", stopReason: "stop" };
      } else {
        yield { type: "tool_call", callId: "original-write", name: tool.name, arguments: { path: "task-result.md", content: "保存读取成果" } };
        yield { type: "completed", stopReason: "tool_calls" };
      }
    } else { yield { type: "text_delta", text: "先回应新消息" }; yield { type: "completed", stopReason: "stop" }; }
  } };
  const fixture = createFixtureWithModel(model);
  try {
    bindLocal(fixture);
    send(fixture, "读取后保存成果，完成两步任务");
    await until(() => fs.existsSync(path.join(workspace(fixture), "started")));
    send(fixture, "先回应这一句，然后继续原任务");
    await until(() => requests >= 2);
    fs.writeFileSync(path.join(workspace(fixture), "release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    await delay(150);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    const saved = fs.existsSync(path.join(workspace(fixture), "task-result.md"));
    const calls = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT t.status, c.tool_call_id FROM tool_calls c JOIN tasks t ON t.task_id=c.task_id").all());
    return { contractPassed: continuationRequests > 0 && saved, observed: { requests, continuationRequests, saved, tasks, calls } };
  } finally { fs.writeFileSync(path.join(workspace(fixture), "release"), ""); await fixture.close(); }
});

await probe("R02-mcp-session-survives-unchanged-config", async () => {
  let rounds = 0;
  const model: ModelPort = { async *stream(request) {
    rounds += 1;
    if (rounds <= 2) {
      const tool = request.tools.find((tool) => tool.name.includes("advance"));
      if (!tool) throw new Error("STATEFUL_TOOL_MISSING");
      yield { type: "tool_call", callId: `step-${rounds}`, name: tool.name, arguments: {} };
      yield { type: "completed", stopReason: "tool_calls" };
    } else { yield { type: "text_delta", text: "两次操作完成" }; yield { type: "completed", stopReason: "stop" }; }
  } };
  const fixture = createFixtureWithModel(model);
  try {
    const serverPath = path.join(workspace(fixture), "counter.mjs");
    fs.writeFileSync(serverPath, [
      `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
      "const server=new McpServer({name:'stateful-review',version:'1'});let counter=0;",
      "server.registerTool('advance',{inputSchema:{}},async()=>({content:[{type:'text',text:String(++counter)}]}));",
      "await server.connect(new StdioServerTransport());",
    ].join("\n"));
    const resource = fixture.app.services.resources.create({ kind: "mcp", name: "counter", config: { command: process.execPath, args: [serverPath], env: {} } });
    addBinding(fixture, "mcp", resource.resourceId);
    send(fixture, "对同一会话执行两次 advance");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const outputs = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT adapted_result_json FROM tool_results ORDER BY rowid").all()) as Array<{ adapted_result_json: string }>;
    const values = outputs.map((row) => JSON.parse(row.adapted_result_json));
    return { contractPassed: JSON.stringify(values) === JSON.stringify(["1", "2"]), observed: { values } };
  } finally { await fixture.close(); }
});

await probe("R07-automatic-candidate-maintenance", async () => {
  let calls = 0;
  const fixture = createFixture([[{ type: "text_delta", text: "第100轮回复" }, { type: "completed", stopReason: "stop" }]], { disableMemoryRuntime: false, memoryModelFactory: () => ({ async form() { calls += 1; return { operations: [] }; } }) });
  try {
    seedEvent(fixture, { content: "已经整理的旧事", title: "旧事", summary: "待精炼", occurredAt: "2026-10-01T01:00:00.000Z" });
    withStorage(fixture, (storage) => {
      storage.business.db.prepare("UPDATE evidence_processing SET status='processed'").run();
      storage.business.db.prepare("UPDATE executions SET decision_round=99 WHERE status='completed'").run();
    });
    send(fixture, "继续聊天");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    await delay(200);
    const observed = withStorage(fixture, (storage) => {
      const store = new MemoryStore(storage.business.db);
      return { currentRound: store.getCurrentRound(fixture.roleId), candidates: store.listRefineCandidates(fixture.roleId, 100).length, status: store.getMemoryStatus(fixture.roleId), batches: store.listBatches(fixture.roleId, 10), modelCalls: calls };
    });
    return { contractPassed: observed.candidates > 0 && calls > 0, observed };
  } finally { await fixture.close(); }
});

await probe("R08-task-end-during-mcp-connect", async () => {
  const model: ModelPort = { async *stream(request) {
    const tool = request.tools.find((tool) => tool.name.includes("write_result"));
    if (!tool) throw new Error("HANDSHAKE_TOOL_MISSING");
    if (request.messages.some((message) => message.role === "tool")) {
      yield { type: "text_delta", text: "收到结果" }; yield { type: "completed", stopReason: "stop" };
    } else {
      yield { type: "tool_call", callId: "handshake-wire", name: tool.name, arguments: {} };
      yield { type: "completed", stopReason: "tool_calls" };
    }
  } };
  const fixture = createFixtureWithModel(model);
  const dir = workspace(fixture);
  try {
    const serverPath = path.join(dir, "slow-connect.mjs");
    fs.writeFileSync(serverPath, [
      "import fs from 'node:fs';",
      `import { McpServer } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
      `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
      "const launches=fs.existsSync('launches')?Number(fs.readFileSync('launches','utf8'))+1:1;fs.writeFileSync('launches',String(launches));",
      "if(launches>1){fs.writeFileSync('connecting','');const deadline=Date.now()+7000;while(!fs.existsSync('connect-release')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));}",
      "const server=new McpServer({name:'connect-review',version:'1'});",
      "server.registerTool('write_result',{inputSchema:{}},async()=>{fs.writeFileSync('late-result.txt','actual side effect');return {content:[{type:'text',text:'written'}]};});",
      "await server.connect(new StdioServerTransport());",
    ].join("\n"));
    const resource = fixture.app.services.resources.create({ kind: "mcp", name: "handshake", config: { command: process.execPath, args: [serverPath], env: {} } });
    addBinding(fixture, "mcp", resource.resourceId);
    send(fixture, "执行一个工具");
    await until(() => fs.existsSync(path.join(dir, "connecting")));
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
    if (!task) throw new Error("HANDSHAKE_TASK_MISSING");
    fixture.app.conversation.finishTask({ roleId: fixture.roleId, taskId: task.taskId, status: "completed", endReason: "连接期间结束任务" });
    fs.writeFileSync(path.join(dir, "connect-release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const wroteAfterEnd = fs.existsSync(path.join(dir, "late-result.txt"));
    return { contractPassed: !wroteAfterEnd, observed: { wroteAfterEnd, task: fixture.app.conversation.getTask(fixture.roleId, task.taskId) } };
  } finally { fs.writeFileSync(path.join(dir, "connect-release"), ""); await fixture.close(); }
});

await probe("R07-consecutive-maintenance-failure-backoff", async () => {
  const fixture = createFixtureWithModel({ async *stream() {} }, { disableMemoryRuntime: false, memoryModelFactory: () => ({ async form() { throw new Error("OFFLINE_MAINTENANCE_FAILURE"); } }) });
  try {
    seedEvent(fixture, { content: "旧事", title: "旧事", summary: "待精炼", occurredAt: "2026-10-01T01:00:00.000Z" });
    withStorage(fixture, (storage) => {
      storage.business.db.prepare("UPDATE evidence_processing SET status='processed'").run();
      storage.business.db.prepare("UPDATE executions SET decision_round=100 WHERE status='completed'").run();
    });
    await fixture.app.conversation.runMemoryPending(fixture.roleId);
    await fixture.app.conversation.runMemoryPending(fixture.roleId);
    const batches = withStorage(fixture, (storage) => new MemoryStore(storage.business.db).listBatches(fixture.roleId, 10));
    return { contractPassed: batches.some((batch) => batch.attemptCount >= 2), observed: { batches } };
  } finally { await fixture.close(); }
});
clearInterval(alive);
clearTimeout(watchdog);
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.contractPassed)) process.exitCode = 1;
