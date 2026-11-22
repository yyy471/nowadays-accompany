import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelEvent, ModelRequest } from "../src/domain/model.js";
import { rolePaths } from "../src/bootstrap/config.js";
import { ScriptedChatModel, addBinding, createFixtureWithModel, withStorage } from "../tests/p2-05-fixture.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p3-fix-recheck-20261104");
fs.mkdirSync(output, { recursive: true });
const results: Array<{ id: string; contractPassed: boolean; observed?: unknown; probeError?: string }> = [];
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("P3_RECHECK_TIMEOUT"); process.exit(2); }, 60_000);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) throw new Error("PROBE_WAIT_TIMEOUT"); await delay(20); }
}
async function probe(id: string, action: () => Promise<{ contractPassed: boolean; observed: unknown }>) {
  try { results.push({ id, ...await action() }); }
  catch (error) { results.push({ id, contractPassed: false, probeError: error instanceof Error ? (error.stack ?? error.message) : String(error) }); }
  fs.writeFileSync(path.join(output, "p3-extended-report.json"), JSON.stringify(results, null, 2));
}
function call(request: ModelRequest, fragment: string, callId: string): ModelEvent[] {
  const tool = request.tools.find((item) => item.name.includes(fragment));
  if (!tool) throw new Error(`MISSING_TOOL:${fragment}`);
  return [{ type: "tool_call", callId, name: tool.name, arguments: {} }, { type: "completed", stopReason: "tool_calls" }];
}
const mcpImport = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href;
const transportImport = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href;

await probe("P3-R03-stateful-MCP-survives-budget-pause", async () => {
  const clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([
    (request) => call(request, "advance", "first"),
    (request) => call(request, "advance", "second"),
    [{ type: "text_delta", text: "同一任务的两步操作完成" }, { type: "completed", stopReason: "stop" }],
  ]);
  const fixture = createFixtureWithModel(model, { now: () => clock.value, timeZone: "Asia/Shanghai" });
  try {
    const workspace = rolePaths(fixture.app.config.dataRoot, fixture.roleId).workspaceDir;
    const script = path.join(workspace, "counter.mjs");
    fs.writeFileSync(script, [
      `import {McpServer} from ${JSON.stringify(mcpImport)};`,
      `import {StdioServerTransport} from ${JSON.stringify(transportImport)};`,
      "const server=new McpServer({name:'task-counter',version:'1'});let count=0;",
      "server.registerTool('advance',{inputSchema:{}},async()=>({content:[{type:'text',text:String(++count)}]}));",
      "await server.connect(new StdioServerTransport());",
    ].join("\n"));
    const resource = fixture.app.services.resources.create({ kind: "mcp", name: "stateful", config: { command: process.execPath, args: [script], env: {} } });
    addBinding(fixture, "mcp", resource.resourceId);
    fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 2, unlimited: false });
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: "2026-11-04T03:00:00.000Z", intent: "在同一服务会话里 advance 两次" });
    clock.value = new Date("2026-11-04T03:00:00.000Z");
    fixture.app.conversation.runDueAutonomy(fixture.roleId);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const paused = fixture.app.conversation.listTasks(fixture.roleId)[0];
    if (paused?.status !== "paused") throw new Error("FIRST_PHASE_DID_NOT_PAUSE");
    fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 10, unlimited: false });
    clock.value = new Date("2026-11-05T00:00:01.000Z");
    fixture.app.conversation.runDueAutonomy(fixture.roleId);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const data = withStorage(fixture, (storage) => ({
      results: storage.business.db.prepare("SELECT r.adapted_result_json, c.task_id FROM tool_results r JOIN tool_calls c ON c.tool_call_id=r.tool_call_id ORDER BY c.rowid").all() as Array<{ adapted_result_json: string; task_id: string }>,
      continuations: storage.business.listResourceContinuations(fixture.roleId, paused.taskId),
    }));
    const values = data.results.map((item) => JSON.parse(item.adapted_result_json));
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    return { contractPassed: JSON.stringify(values) === JSON.stringify(["1", "2"]) && tasks.length === 1 && tasks[0]?.status === "completed", observed: { values, tasks, calls: model.requests.length, ...data } };
  } finally { await fixture.close(); }
});

await probe("P3-R01-no-charge-for-ended-task-before-MCP-dispatch", async () => {
  const clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  const model = new ScriptedChatModel([(request) => call(request, "write_result", "pending-write")]);
  const fixture = createFixtureWithModel(model, { now: () => clock.value, timeZone: "Asia/Shanghai" });
  const workspace = rolePaths(fixture.app.config.dataRoot, fixture.roleId).workspaceDir;
  try {
    const script = path.join(workspace, "gated.mjs");
    fs.writeFileSync(script, [
      "import fs from 'node:fs';",
      `import {McpServer} from ${JSON.stringify(mcpImport)};`,
      `import {StdioServerTransport} from ${JSON.stringify(transportImport)};`,
      "const launches=fs.existsSync('launches')?Number(fs.readFileSync('launches','utf8'))+1:1;fs.writeFileSync('launches',String(launches));",
      "if(launches>1){fs.writeFileSync('connecting','');const deadline=Date.now()+7000;while(!fs.existsSync('release')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));}",
      "const server=new McpServer({name:'gated',version:'1'});",
      "server.registerTool('write_result',{inputSchema:{}},async()=>{fs.writeFileSync('dispatched','');return {content:[{type:'text',text:'saved'}]};});",
      "await server.connect(new StdioServerTransport());",
    ].join("\n"));
    const resource = fixture.app.services.resources.create({ kind: "mcp", name: "gated", config: { command: process.execPath, args: [script], env: {} } });
    addBinding(fixture, "mcp", resource.resourceId);
    fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 10, unlimited: false });
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: "2026-11-04T03:00:00.000Z", intent: "执行一个实际工具" });
    clock.value = new Date("2026-11-04T03:00:00.000Z");
    fixture.app.conversation.runDueAutonomy(fixture.roleId);
    await until(() => fs.existsSync(path.join(workspace, "connecting")));
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
    if (!task) throw new Error("TASK_MISSING");
    fixture.app.conversation.finishTask({ roleId: fixture.roleId, taskId: task.taskId, status: "completed", endReason: "建连期间结束，尚未发送工具请求" });
    fs.writeFileSync(path.join(workspace, "release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const dispatched = fs.existsSync(path.join(workspace, "dispatched"));
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    const data = withStorage(fixture, (storage) => ({
      metering: storage.business.db.prepare("SELECT call_kind, counted, call_id FROM call_metering ORDER BY rowid").all() as Array<{ call_kind: string; counted: number; call_id: string }>,
      results: storage.business.db.prepare("SELECT status, diagnostic_code FROM tool_results ORDER BY rowid").all(),
    }));
    const accountedPoints = data.metering.reduce((total, item) => total + item.counted, 0);
    return { contractPassed: !dispatched && budget.usedPoints === 1 && accountedPoints === budget.usedPoints, observed: { dispatched, budget, accountedPoints, modelCalls: model.requests.length, ...data } };
  } finally { fs.writeFileSync(path.join(workspace, "release"), ""); await fixture.close(); }
});

clearInterval(alive); clearTimeout(watchdog);
console.log(JSON.stringify(results, null, 2));
if (results.some((item) => !item.contractPassed)) process.exitCode = 1;
