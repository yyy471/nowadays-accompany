import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBackendApp, type BackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import { createFixtureWithModel, addBinding, withStorage, type Fixture } from "../tests/p2-05-fixture.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p4-recovery-recheck");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const done = (text: string): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
const tool = (name: string): ModelEvent[] => [{ type: "tool_call", callId: randomUUID(), name, arguments: {} }, { type: "completed", stopReason: "tool_calls" }];
async function waitFor(check: () => boolean, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error("P4_RECHECK_BOUNDARY_TIMEOUT"); await pause(20); }
}
function inspect(fixture: Fixture) {
  return withStorage(fixture, (s) => ({
    executions: s.business.db.prepare("SELECT execution_id, trigger_type, status FROM executions ORDER BY rowid").all(),
    tasks: s.business.db.prepare("SELECT task_id, origin, status FROM tasks ORDER BY rowid").all(),
    calls: s.business.db.prepare("SELECT tool_call_id, task_id, execution_id, tool_name, status FROM tool_calls ORDER BY rowid").all(),
    results: s.business.db.prepare("SELECT tool_call_id, status, diagnostic_code, adapted_result_json FROM tool_results ORDER BY rowid").all(),
    messages: s.business.db.prepare("SELECT sender, content, status FROM messages ORDER BY sequence").all(),
    wakes: fixture.app.services.autonomy.listWakes(fixture.roleId),
    activities: fixture.app.services.autonomy.listActivities(fixture.roleId),
    budget: fixture.app.services.autonomy.getStatus(fixture.roleId),
  }));
}

async function worker(mode: string, directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  const clock = { value: new Date("2026-11-04T02:00:00.000Z") };
  let calls = 0;
  const model: ModelPort = { async *stream(request) {
    calls++;
    if (calls > 1) { yield* done("新消息已经回复，不取消原任务"); return; }
    const name = request.tools.find((t) => t.name.includes("effect_then_wait"))?.name;
    if (!name) throw new Error("P4_EFFECT_TOOL_MISSING");
    yield* tool(name);
  } };
  const fixture = createFixtureWithModel(model, { now: () => clock.value });
  const mcp = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href;
  const stdio = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href;
  const effect = path.join(directory, "effect.log");
  const source = `import fs from 'node:fs'; import {McpServer} from ${JSON.stringify(mcp)}; import {StdioServerTransport} from ${JSON.stringify(stdio)};
    const server=new McpServer({name:'p4-switch',version:'1'}); process.stdin.on('end',()=>process.exit(0));
    server.registerTool('effect_then_wait',{inputSchema:{}},async()=>{fs.appendFileSync(${JSON.stringify(effect)},'effect\\n');fs.writeFileSync(${JSON.stringify(path.join(directory, "tool-pid.txt"))},String(process.pid));return await new Promise(()=>{});});
    server.registerTool('effect_status',{inputSchema:{}},async()=>{const content=fs.existsSync(${JSON.stringify(effect)})?fs.readFileSync(${JSON.stringify(effect)},'utf8'):'missing';fs.appendFileSync(${JSON.stringify(path.join(directory, "checks.log"))},'checked\\n');return {content:[{type:'text',text:content}]};});
    await server.connect(new StdioServerTransport());`;
  const resource = fixture.app.services.resources.create({ kind: "mcp", name: "P4 切换核查样例", config: { command: process.execPath, args: ["--input-type=module", "-e", source], env: {} } });
  addBinding(fixture, "mcp", resource.resourceId);
  if (mode.startsWith("user-")) {
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, { content: "请执行原任务", submissionId: randomUUID(), sourcePlatform: "nowadays" });
  } else {
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: "2026-11-04T03:00:00.000Z", intent: "原自主任务产生一次效果后等待" });
    clock.value = new Date("2026-11-04T03:00:00.000Z");
    fixture.app.conversation.runDueAutonomy(fixture.roleId);
  }
  await waitFor(() => fs.existsSync(path.join(directory, "tool-pid.txt")));
  const original = inspect(fixture);
  if (mode.includes("superseded")) {
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, { content: "先回复这条消息，原任务继续保留", submissionId: randomUUID(), sourcePlatform: "nowadays" });
    await waitFor(() => withStorage(fixture, (s) => Boolean(s.business.db.prepare("SELECT 1 FROM executions WHERE trigger_type='user_message' AND status='completed'").get())));
  } else if (mode === "ended") {
    const task = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
    fixture.app.conversation.finishTask({ roleId: fixture.roleId, taskId: task.taskId, status: "completed", endReason: "明确结束，仍保存晚到或未知结果" });
  }
  if (mode.endsWith("disabled")) {
    for (const binding of fixture.app.services.resources.listBindings(fixture.roleId)) {
      fixture.app.services.resources.update(binding.resourceId, { enabled: false });
    }
  }
  fs.writeFileSync(path.join(directory, "fixture.json"), JSON.stringify({ root: fixture.root, roleId: fixture.roleId, windowId: fixture.windowId }));
  fs.writeFileSync(path.join(directory, "before-kill.json"), JSON.stringify({ original, afterSwitch: inspect(fixture) }, null, 2));
  fs.writeFileSync(path.join(directory, "boundary.json"), JSON.stringify({ mode, calls }));
  setInterval(() => {}, 1000);
}

if (process.argv[2] === "--worker") {
  await worker(process.argv[3]!, process.argv[4]!);
} else {
  fs.mkdirSync(output, { recursive: true });
  const alive = setInterval(() => {}, 1000);
  const watchdog = setTimeout(() => { console.error("P4_RECHECK_TIMEOUT"); process.exit(2); }, 90_000);
  const results: Array<{ id: string; contractPassed: boolean; observed?: unknown; probeError?: string }> = [];
  for (const mode of ["autonomous-superseded", "user-superseded", "ended", "check-unknown", "user-running", "user-superseded-disabled"] as const) {
    const directory = path.join(output, mode);
    fs.mkdirSync(directory, { recursive: true });
    const log = fs.openSync(path.join(directory, "worker.log"), "w");
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--worker", mode, directory], { cwd: process.cwd(), env: process.env, stdio: ["ignore", log, log], windowsHide: true });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let app: BackendApp | undefined;
    let toolStopped = false;
    try {
      await waitFor(() => { if (child.exitCode !== null) throw new Error(`P4_WORKER_EARLY_EXIT:${child.exitCode}`); return fs.existsSync(path.join(directory, "boundary.json")); });
      child.kill("SIGKILL");
      await exited;
      const pid = Number(fs.readFileSync(path.join(directory, "tool-pid.txt"), "utf8"));
      try { process.kill(pid, "SIGKILL"); } catch { /* 已随 stdio 退出。 */ }
      toolStopped = true;
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, "fixture.json"), "utf8")) as { root: string; roleId: string; windowId: string };
      const requests: ModelRequest[] = [];
      const model: ModelPort = { async *stream(request) {
        requests.push(request);
        if ((mode === "check-unknown" || mode.endsWith("disabled")) && requests.length === 1) {
          const name = request.tools.find((t) => t.name.includes("effect_status"))?.name;
          if (!name) throw new Error("P4_STATUS_TOOL_MISSING");
          yield* tool(name);
        } else yield* done("依据实际状态完成核查，不重做原来的操作");
      } };
      app = createBackendApp(parseBackendConfig(["--app-root", metadata.root, "--port", "0"]), { now: () => new Date("2026-11-04T04:00:00.000Z"), timeZone: "Asia/Shanghai", disableMemoryRuntime: true, modelPortFactory: () => model });
      const fixture = { ...metadata, app } as Fixture;
      await pause(200);
      if (mode === "user-running") await waitFor(() => requests.length > 0);
      const startupRequests = requests.length;
      app.conversation.runDueAutonomy(metadata.roleId);
      await app.conversation.waitForIdle(metadata.roleId);
      const after = inspect(fixture);
      const before = JSON.parse(fs.readFileSync(path.join(directory, "before-kill.json"), "utf8"));
      const originalCall = before.original.calls[0] as { tool_call_id: string; task_id: string };
      const recovered = after.calls.find((c: any) => c.tool_call_id === originalCall.tool_call_id) as { status: string } | undefined;
      const effect = fs.readFileSync(path.join(directory, "effect.log"), "utf8");
      const checks = fs.existsSync(path.join(directory, "checks.log")) ? fs.readFileSync(path.join(directory, "checks.log"), "utf8") : "";
      const task = app.conversation.getTask(metadata.roleId, originalCall.task_id);
      let newTaskBlocked = true;
      if (mode.endsWith("disabled")) {
        const callCount = requests.length;
        const submitted = app.conversation.submitMessage(metadata.roleId, metadata.windowId, { content: "新任务不应借用原链的关闭资源", submissionId: randomUUID(), sourcePlatform: "nowadays" });
        await pause(30);
        newTaskBlocked = !submitted.decisionScheduled && requests.length === callCount;
      }
      const requiresCheck = mode === "check-unknown" || mode.endsWith("disabled");
      const contractPassed = recovered?.status === "unknown" && effect === "effect\n" && newTaskBlocked && (mode === "ended" ? requests.length === 0 && task.status === "completed" : requiresCheck ? requests.length === 2 && checks === "checked\n" && task.status === "completed" && requests[0]!.messages.some((m) => m.role === "tool" && m.toolCallId === originalCall.tool_call_id && m.content.includes('"status":"unknown"')) : requests.length > 0 && task.status === "completed" && (mode !== "user-running" || startupRequests > 0));
      results.push({ id: mode, contractPassed, observed: { killedPid: child.pid, signal: child.signalCode, before, after, requests, startupRequests, newTaskBlocked, effect, checks } });
    } catch (error) {
      results.push({ id: mode, contractPassed: false, probeError: error instanceof Error ? error.stack ?? error.message : String(error) });
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      if (!toolStopped && fs.existsSync(path.join(directory, "tool-pid.txt"))) { try { process.kill(Number(fs.readFileSync(path.join(directory, "tool-pid.txt"), "utf8")), "SIGKILL"); } catch { /* 仅清理本次样例进程。 */ } }
      await app?.close();
      fs.closeSync(log);
    }
    fs.writeFileSync(path.join(output, "p4-recovery-recheck-report.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ id: results.at(-1)?.id, passed: results.at(-1)?.contractPassed, error: results.at(-1)?.probeError }));
  }
  clearTimeout(watchdog);
  clearInterval(alive);
  process.exitCode = results.some((r) => r.probeError) ? 2 : results.some((r) => !r.contractPassed) ? 1 : 0;
}
