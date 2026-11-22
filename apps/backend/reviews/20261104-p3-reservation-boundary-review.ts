import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelEvent, ModelRequest } from "../src/domain/model.js";
import { rolePaths } from "../src/bootstrap/config.js";
import { ScriptedChatModel, addBinding, createFixtureWithModel, withStorage, type Fixture } from "../tests/p2-05-fixture.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p3-reservation-review-20261104");
fs.mkdirSync(output, { recursive: true });
const results: Array<{ id: string; contractPassed: boolean; observed?: unknown; probeError?: string }> = [];
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("RESERVATION_REVIEW_TIMEOUT"); process.exit(2); }, 60_000);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) throw new Error("PROBE_WAIT_TIMEOUT"); await delay(20); }
}
async function probe(id: string, action: () => Promise<{ contractPassed: boolean; observed: unknown }>) {
  try { results.push({ id, ...await action() }); }
  catch (error) { results.push({ id, contractPassed: false, probeError: error instanceof Error ? (error.stack ?? error.message) : String(error) }); }
  fs.writeFileSync(path.join(output, "reservation-boundary-report.json"), JSON.stringify(results, null, 2));
}
function bindGatedMcp(fixture: Fixture): string {
  const workspace = rolePaths(fixture.app.config.dataRoot, fixture.roleId).workspaceDir;
  const script = path.join(workspace, "gated.mjs");
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    `import {McpServer} from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href)};`,
    `import {StdioServerTransport} from ${JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href)};`,
    "const launches=fs.existsSync('launches')?Number(fs.readFileSync('launches','utf8'))+1:1;fs.writeFileSync('launches',String(launches));",
    "if(launches>1){fs.writeFileSync('connecting','');const deadline=Date.now()+7000;while(!fs.existsSync('release')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));}",
    "const server=new McpServer({name:'reservation-review',version:'1'});",
    "server.registerTool('write_result',{inputSchema:{}},async()=>{fs.writeFileSync('dispatched','');return {content:[{type:'text',text:'saved'}]};});",
    "await server.connect(new StdioServerTransport());",
  ].join("\n"));
  const resource = fixture.app.services.resources.create({ kind: "mcp", name: "gated", config: { command: process.execPath, args: [script], env: {} } });
  addBinding(fixture, "mcp", resource.resourceId);
  return workspace;
}
function toolRequest(request: ModelRequest): ModelEvent[] {
  const tool = request.tools.find((item) => item.name.includes("write_result"));
  if (!tool) throw new Error("MCP_TOOL_MISSING");
  return [{ type: "tool_call", callId: "write", name: tool.name, arguments: {} }, { type: "completed", stopReason: "tool_calls" }];
}
const complete: ModelEvent[] = [{ type: "text_delta", text: "实际写入已经完成" }, { type: "completed", stopReason: "stop" }];

await probe("P3-R01-reservation-committed-after-local-midnight", async () => {
  const clock = { value: new Date("2026-11-04T15:59:58.000Z") };
  const model = new ScriptedChatModel([toolRequest, complete]);
  const fixture = createFixtureWithModel(model, { now: () => clock.value, timeZone: "Asia/Shanghai" });
  const workspace = bindGatedMcp(fixture);
  try {
    fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 10, unlimited: false });
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: "2026-11-04T15:59:59.000Z", intent: "在额度跨日前准备，跨日后才实际派发" });
    clock.value = new Date("2026-11-04T15:59:59.000Z");
    fixture.app.conversation.runDueAutonomy(fixture.roleId);
    await until(() => fs.existsSync(path.join(workspace, "connecting")));
    const reservedBeforeMidnight = fixture.app.services.autonomy.getBudget(fixture.roleId);
    clock.value = new Date("2026-11-04T16:00:01.000Z");
    const afterResetBeforeDispatch = fixture.app.services.autonomy.getBudget(fixture.roleId);
    fs.writeFileSync(path.join(workspace, "release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    const metering = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT call_kind, counted, created_at FROM call_metering ORDER BY rowid").all()) as Array<{ call_kind: string; counted: number; created_at: string }>;
    const today = metering.filter((item) => item.created_at >= "2026-11-04T16:00:00.000Z");
    const countedToday = today.reduce((sum, item) => sum + item.counted, 0);
    const dispatched = fs.existsSync(path.join(workspace, "dispatched"));
    return { contractPassed: dispatched && countedToday === 2 && budget.usedPoints === countedToday, observed: { reservedBeforeMidnight, afterResetBeforeDispatch, dispatched, budget, countedToday, metering } };
  } finally { fs.writeFileSync(path.join(workspace, "release"), ""); await fixture.close(); }
});

await probe("P3-R01-unlimited-reservation-cancel-must-not-refund-other-call", async () => {
  const clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  let fixture: Fixture;
  const model = new ScriptedChatModel([(request) => {
    // 模型调用已按有限模式扣点；模拟用户在模型返回工具请求前切换为无限制。
    fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 10, unlimited: true });
    return toolRequest(request);
  }]);
  fixture = createFixtureWithModel(model, { now: () => clock.value, timeZone: "Asia/Shanghai" });
  const workspace = bindGatedMcp(fixture);
  try {
    fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 10, unlimited: false });
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: "2026-11-04T03:00:00.000Z", intent: "切换无限制时取消一个从未扣过点的预留" });
    clock.value = new Date("2026-11-04T03:00:00.000Z");
    fixture.app.conversation.runDueAutonomy(fixture.roleId);
    await until(() => fs.existsSync(path.join(workspace, "connecting")));
    const whileUnlimited = fixture.app.services.autonomy.getBudget(fixture.roleId);
    fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 10, unlimited: false });
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0];
    if (!task) throw new Error("TASK_MISSING");
    fixture.app.conversation.finishTask({ roleId: fixture.roleId, taskId: task.taskId, status: "completed", endReason: "有限模式下结束尚未派发的无限制预留" });
    fs.writeFileSync(path.join(workspace, "release"), "");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const budget = fixture.app.services.autonomy.getBudget(fixture.roleId);
    const metering = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT call_kind, counted FROM call_metering ORDER BY rowid").all()) as Array<{ call_kind: string; counted: number }>;
    const counted = metering.reduce((sum, item) => sum + item.counted, 0);
    const dispatched = fs.existsSync(path.join(workspace, "dispatched"));
    return { contractPassed: !dispatched && budget.usedPoints === 1 && budget.usedPoints === counted, observed: { whileUnlimited, dispatched, budget, counted, modelCalls: model.requests.length, metering } };
  } finally { fs.writeFileSync(path.join(workspace, "release"), ""); await fixture.close(); }
});

clearInterval(alive); clearTimeout(watchdog);
console.log(JSON.stringify(results, null, 2));
if (results.some((item) => !item.contractPassed)) process.exitCode = 1;
