import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBackendApp, type BackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import { ScriptedChatModel, addBinding, createFixtureWithModel, seedEvent, withStorage, type Fixture } from "../tests/p2-05-fixture.js";

// 独立验收脚本只通过既有接口驱动业务；强杀点由模型／本地 MCP 样例提供。
const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p4-independent");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const done = (text = "已依据当前资料重新评估，不补做离线经历。"): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
const tool = (name: string, args: unknown): ModelEvent[] => [{ type: "tool_call", callId: randomUUID(), name, arguments: args }, { type: "completed", stopReason: "tool_calls" }];
const clockStart = "2026-11-04T02:00:00.000Z";
function localMcp(fixture: Fixture): string {
  const workspace = rolePaths(fixture.app.config.dataRoot, fixture.roleId).workspaceDir;
  const resource = fixture.app.services.resources.create({ kind: "mcp", name: "P4 本地工具", config: {
    command: process.execPath,
    args: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.resolve("src/mcp/local-server.ts")).href)})`],
    env: { NOWADAYS_WORKSPACE: workspace },
  } });
  addBinding(fixture, "mcp", resource.resourceId);
  return workspace;
}
function snapshot(fixture: Fixture) {
  return withStorage(fixture, (s) => ({
    tasks: s.business.db.prepare("SELECT task_id, status, origin FROM tasks").all(),
    executions: s.business.db.prepare("SELECT e.execution_id, x.task_id, e.status, e.trigger_type FROM executions e LEFT JOIN execution_tasks x ON x.execution_id = e.execution_id").all(),
    calls: s.business.db.prepare("SELECT tool_call_id, task_id, status, tool_name FROM tool_calls").all(),
    results: s.business.db.prepare("SELECT tool_call_id, status, diagnostic_code, adapted_result_json FROM tool_results").all(),
    messages: s.business.db.prepare("SELECT sender, status, content, execution_id FROM messages ORDER BY sequence").all(),
    wakes: fixture.app.services.autonomy.listWakes(fixture.roleId),
    activities: fixture.app.services.autonomy.listActivities(fixture.roleId),
    budget: fixture.app.services.autonomy.getStatus(fixture.roleId),
  }));
}
async function waitUntil(check: () => boolean, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("P4_BOUNDARY_TIMEOUT");
    await pause(20);
  }
}
function reopen(fixture: Fixture, model: ModelPort, now: () => Date): BackendApp {
  return createBackendApp(parseBackendConfig(["--app-root", fixture.root, "--port", "0"]), {
    now, timeZone: "Asia/Shanghai", modelPortFactory: () => model, disableMemoryRuntime: true,
  });
}

async function worker(mode: string, directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  const clock = { value: new Date(clockStart) };
  let calls = 0;
  const model: ModelPort = { async *stream(request) {
    calls++;
    if (mode === "superseded" && calls > 1) {
      yield* done("强杀前新消息的正式回复");
      return;
    }
    if (mode === "partial" || mode === "superseded") {
      yield { type: "text_delta", text: "强杀前已输出的半句话" };
    } else if (calls === 1) {
      const fragment = mode === "unknown" ? "effect_then_wait" : "workspace_write";
      const name = request.tools.find((t) => t.name.includes(fragment))?.name;
      if (!name) throw new Error(`P4_TOOL_MISSING:${fragment}`);
      yield* tool(name, mode === "unknown" ? {} : { path: "effect.md", content: "唯一的实际效果\n", append: true });
      return;
    }
    // 第二次模型调用发生前，工具结果已先保存到业务库。
    fs.writeFileSync(path.join(directory, mode === "superseded" ? "first.json" : "boundary.json"), JSON.stringify({ calls }));
    await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
  } };
  const fixture = createFixtureWithModel(model, { now: () => clock.value, timeZone: "Asia/Shanghai" });
  if (mode !== "partial" && mode !== "superseded") {
    if (mode === "unknown") {
      const mcp = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href;
      const stdio = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href;
      const source = `import fs from 'node:fs'; import {McpServer} from ${JSON.stringify(mcp)}; import {StdioServerTransport} from ${JSON.stringify(stdio)};
        const server=new McpServer({name:'p4-effect',version:'1'}); process.stdin.on('end',()=>process.exit(0));
        server.registerTool('effect_then_wait',{inputSchema:{}},async()=>{fs.appendFileSync(${JSON.stringify(path.join(directory, "effect.log"))},'effect\\n'); fs.writeFileSync(${JSON.stringify(path.join(directory, "tool-pid.txt"))},String(process.pid)); fs.writeFileSync(${JSON.stringify(path.join(directory, "boundary.json"))},JSON.stringify({effectOccurred:true,responseReturned:false})); return await new Promise(()=>{});});
        await server.connect(new StdioServerTransport());`;
      const resource = fixture.app.services.resources.create({ kind: "mcp", name: "产生效果后等待的本地工具", config: { command: process.execPath, args: ["--input-type=module", "-e", source], env: {} } });
      addBinding(fixture, "mcp", resource.resourceId);
    } else localMcp(fixture);
  }
  fixture.app.services.roles.updateDefinition(fixture.roleId, { definition: { text: "最新角色设定：喜欢蓝色，恢复时必须读最新资料。" } });
  fixture.app.services.roles.setState(fixture.roleId, { state: { mood: "重启前最新状态" } });
  fs.writeFileSync(path.join(directory, "fixture.json"), JSON.stringify({ root: fixture.root, roleId: fixture.roleId, windowId: fixture.windowId }));
  if (mode === "partial" || mode === "superseded") {
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, { content: "原消息", submissionId: randomUUID(), sourcePlatform: "nowadays" });
    if (mode === "superseded") {
      await waitUntil(() => fs.existsSync(path.join(directory, "first.json")));
      fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, { content: "新消息已替代旧回复", submissionId: randomUUID(), sourcePlatform: "nowadays" });
      await fixture.app.conversation.waitForIdle(fixture.roleId);
      fixture.app.services.roles.setState(fixture.roleId, { state: { mood: "新回复之后的最新状态" } });
      fs.writeFileSync(path.join(directory, "boundary.json"), JSON.stringify({ newReplyCommitted: true }));
    }
  } else {
    const wake = fixture.app.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: "2026-11-04T03:00:00.000Z", intent: "把本地成果保存后继续整理" });
    clock.value = new Date(wake.scheduledAt);
    fixture.app.conversation.runDueAutonomy(fixture.roleId);
  }
  setInterval(() => {}, 1000);
}

if (process.argv[2] === "--worker") {
  await worker(process.argv[3]!, process.argv[4]!);
} else {
  fs.mkdirSync(output, { recursive: true });
  const results: Array<{ id: string; contractPassed: boolean; observed?: unknown; probeError?: string }> = [];
  const alive = setInterval(() => {}, 1000);
  const watchdog = setTimeout(() => { console.error("P4_ACCEPTANCE_TIMEOUT"); process.exit(2); }, 120_000);
  async function probe(id: string, action: () => Promise<{ contractPassed: boolean; observed: unknown }>) {
    try { results.push({ id, ...await action() }); }
    catch (error) { results.push({ id, contractPassed: false, probeError: error instanceof Error ? error.stack ?? error.message : String(error) }); }
    fs.writeFileSync(path.join(output, "p4-report.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results.at(-1)));
  }

  await probe("A01-normal-close-overdue-wake-latest-context", async () => {
    const clock = { value: new Date(clockStart) };
    const fixture = createFixtureWithModel(new ScriptedChatModel([]), { now: () => clock.value });
    let restored: BackendApp | undefined;
    try {
      fixture.app.services.roles.updateDefinition(fixture.roleId, { definition: { text: "重启后的最新蓝色角色设定" } });
      fixture.app.services.roles.setState(fixture.roleId, { state: { mood: "期待重启" } });
      fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 7, unlimited: false });
      const wake = fixture.app.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: "2026-11-04T03:00:00.000Z", intent: "重新评估旧安排，不假装离线已完成" });
      await fixture.app.close();
      clock.value = new Date("2026-11-04T05:00:00.000Z");
      const model = new ScriptedChatModel([done()]);
      restored = reopen(fixture, model, () => clock.value);
      await waitUntil(() => model.requests.length > 0);
      await restored.conversation.waitForIdle(fixture.roleId);
      const status = restored.services.autonomy.getStatus(fixture.roleId);
      const savedWake = restored.services.autonomy.listWakes(fixture.roleId).find((w) => w.wakeId === wake.wakeId);
      const system = model.requests[0]?.system ?? "";
      return { contractPassed: model.requests.length === 1 && system.includes("最新蓝色角色设定") && system.includes("期待重启") && savedWake?.status === "completed" && status.budget.dailyLimit === 7 && status.budget.usedPoints === 1,
        observed: { calls: model.requests.length, latestDefinition: system.includes("最新蓝色角色设定"), latestState: system.includes("期待重启"), wake: savedWake, status } };
    } finally { await restored?.close(); await fixture.app.close(); }
  });

  await probe("A02-budget-pause-restart-disabled-original-chain", async () => {
    const clock = { value: new Date(clockStart) };
    const first = new ScriptedChatModel([tool("diary_write", { content: "额度暂停后继续原任务" })]);
    const fixture = createFixtureWithModel(first, { now: () => clock.value });
    let restored: BackendApp | undefined;
    try {
      fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 1, unlimited: false });
      fixture.app.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: "2026-11-04T03:00:00.000Z", intent: "同一任务在跨日后继续" });
      clock.value = new Date("2026-11-04T03:00:00.000Z");
      fixture.app.conversation.runDueAutonomy(fixture.roleId);
      await fixture.app.conversation.waitForIdle(fixture.roleId);
      const task = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
      const binding = fixture.app.services.resources.listBindings(fixture.roleId).find((b) => b.capability === "chat_model")!;
      fixture.app.services.resources.update(binding.resourceId, { enabled: false });
      fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 8, unlimited: false });
      await fixture.app.close();
      clock.value = new Date("2026-11-05T00:00:01.000Z");
      const model = new ScriptedChatModel([tool("diary_write", { content: "原任务恢复后只写一次" }), done()]);
      restored = reopen(fixture, model, () => clock.value);
      await waitUntil(() => model.requests.length > 0);
      await restored.conversation.waitForIdle(fixture.roleId);
      const after = restored.conversation.getTask(fixture.roleId, task.taskId);
      const diaries = restored.services.memory.listDiaries(fixture.roleId);
      const status = restored.services.autonomy.getStatus(fixture.roleId);
      restored.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: "2026-11-05T01:00:00.000Z", intent: "新任务不可借用旧任务已关闭的资源" });
      clock.value = new Date("2026-11-05T02:00:00.000Z");
      const newTaskStarted = restored.conversation.runDueAutonomy(fixture.roleId);
      await pause(50);
      return { contractPassed: after.status === "completed" && diaries.length === 1 && model.requests.length === 2 && status.budget.usedPoints === 3 && !newTaskStarted,
        observed: { originalTask: task, after, diaries, calls: model.requests.length, newTaskStarted, status } };
    } finally { await restored?.close(); await fixture.app.close(); }
  });

  for (const mode of ["saved", "unknown", "partial", "superseded"] as const) {
    await probe(`A0${mode === "saved" ? 3 : mode === "unknown" ? 4 : mode === "partial" ? 5 : 8}-force-kill-${mode}`, async () => {
      const directory = path.join(output, `kill-${mode}`);
      fs.mkdirSync(directory, { recursive: true });
      const log = fs.openSync(path.join(directory, "worker.log"), "w");
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--worker", mode, directory], { cwd: process.cwd(), env: process.env, stdio: ["ignore", log, log], windowsHide: true });
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      let restored: BackendApp | undefined;
      try {
        await waitUntil(() => {
          if (child.exitCode !== null) throw new Error(`P4_WORKER_EARLY_EXIT:${child.exitCode}`);
          return fs.existsSync(path.join(directory, "boundary.json"));
        });
        // 强制结束真实后端进程，未调用 app.close()。
        child.kill("SIGKILL");
        const exitCode = await exited;
        if (fs.existsSync(path.join(directory, "tool-pid.txt"))) {
          const pid = Number(fs.readFileSync(path.join(directory, "tool-pid.txt"), "utf8"));
          try { process.kill(pid, "SIGKILL"); } catch { /* 工具可能随 stdio 关闭已经退出。 */ }
        }
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, "fixture.json"), "utf8")) as { root: string; roleId: string; windowId: string };
        const model = new ScriptedChatModel([done("新消息的正式回复")]);
        const shell = { ...metadata } as Fixture;
        restored = reopen(shell, model, () => new Date("2026-11-04T04:00:00.000Z"));
        shell.app = restored;
        await pause(300);
        // 普通对话恢复后直接接收新消息；不额外触发旧的待回复输入。
        const conversationOnly = mode === "partial" || mode === "superseded";
        const manualStarted = conversationOnly ? false : restored.conversation.runDueAutonomy(metadata.roleId);
        if (!conversationOnly) await restored.conversation.waitForIdle(metadata.roleId);
        const beforeNewMessage = snapshot(shell);
        const recoveryRequests = model.requests.length;
        let contractPassed: boolean;
        if (mode === "partial") {
          restored.conversation.submitMessage(metadata.roleId, metadata.windowId, { content: "新的消息，请依据最新设定回复", submissionId: randomUUID(), sourcePlatform: "nowadays" });
          await restored.conversation.waitForIdle(metadata.roleId);
          const messages = restored.services.messages.list(metadata.roleId, metadata.windowId, 0, 100).items;
          contractPassed = recoveryRequests === 0 && messages.some((m) => m.status === "interrupted" && m.content === "强杀前已输出的半句话") && messages.filter((m) => m.sender === "assistant" && m.status === "completed").length === 1 && (model.requests[0]?.system.includes("最新角色设定") ?? false);
        } else if (mode === "superseded") {
          const state = restored.services.roles.getState(metadata.roleId);
          contractPassed = recoveryRequests === 0 && beforeNewMessage.messages.some((m: any) => m.status === "interrupted" && m.content === "强杀前已输出的半句话") && beforeNewMessage.messages.filter((m: any) => m.sender === "assistant" && m.status === "completed" && m.content === "强杀前新消息的正式回复").length === 1 && state.state.mood === "新回复之后的最新状态";
        } else if (mode === "saved") {
          contractPassed = recoveryRequests > 0 && beforeNewMessage.results.some((r: any) => r.status === "success");
        } else {
          contractPassed = beforeNewMessage.calls.some((c: any) => c.status === "unknown") && recoveryRequests > 0;
        }
        const workspace = rolePaths(restored.config.dataRoot, metadata.roleId).workspaceDir;
        const effectPath = mode === "unknown" ? path.join(directory, "effect.log") : path.join(workspace, "effect.md");
        return { contractPassed, observed: { killedPid: child.pid, exitCode, manualStarted, recoveryRequests, actualEffect: fs.existsSync(effectPath) ? fs.readFileSync(effectPath, "utf8") : null, beforeNewMessage, after: snapshot(shell), requests: model.requests } };
      } finally {
        if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
        await restored?.close();
        fs.closeSync(log);
      }
    });
  }

  await probe("A06-correction-stale-version-and-index-after-restart", async () => {
    const fixture = createFixtureWithModel(new ScriptedChatModel([]));
    let restored: BackendApp | undefined;
    try {
      const event = seedEvent(fixture, { content: "原文说旧地点", title: "旧记忆地点", summary: "旧摘要占位", occurredAt: clockStart, tags: { place: ["旧地点"] } });
      const before = fixture.app.services.memory.getEvent(fixture.roleId, event.eventId);
      fixture.app.services.memory.correctEvent(fixture.roleId, event.eventId, { expectedVersion: before.version, patch: { title: "新记忆地点", summary: "新摘要正确地点", tags: { place: ["新地点"] } }, reason: "用户更正地点" });
      await fixture.app.close();
      restored = reopen(fixture, new ScriptedChatModel([]), () => new Date("2026-11-04T04:00:00.000Z"));
      let conflict: unknown;
      try { restored.services.memory.correctEvent(fixture.roleId, event.eventId, { expectedVersion: before.version, patch: { summary: "过期处理不该覆盖" } }); }
      catch (error) { conflict = error instanceof Error && "code" in error ? error.code : String(error); }
      const after = restored.services.memory.getEvent(fixture.roleId, event.eventId);
      const search = restored.services.memory.search(fixture.roleId, { query: "正确地点", places: ["新地点"] });
      const oldSearch = restored.services.memory.search(fixture.roleId, { places: ["旧地点"] });
      const original = restored.services.memory.getEvidence(fixture.roleId, event.evidenceId);
      return { contractPassed: conflict === "MEMORY_VERSION_CONFLICT" && after.version === before.version + 1 && after.summary === "新摘要正确地点" && search.items.some((i) => i.id === event.eventId) && !oldSearch.items.some((i) => i.id === event.eventId) && original.content === "原文说旧地点",
        observed: { conflict, after, search: search.items, oldSearch: oldSearch.items, original } };
    } finally { await restored?.close(); await fixture.app.close(); }
  });

  await probe("A07-ended-budget-paused-task-stays-ended-after-restart", async () => {
    const clock = { value: new Date(clockStart) };
    const fixture = createFixtureWithModel(new ScriptedChatModel([tool("diary_write", { content: "不应写出的日记" })]), { now: () => clock.value });
    let restored: BackendApp | undefined;
    try {
      fixture.app.services.autonomy.setBudget(fixture.roleId, { dailyLimit: 1, unlimited: false });
      fixture.app.services.autonomy.scheduleWake(fixture.roleId, { wakeAt: "2026-11-04T03:00:00.000Z", intent: "暂停后明确结束" });
      clock.value = new Date("2026-11-04T03:00:00.000Z");
      fixture.app.conversation.runDueAutonomy(fixture.roleId);
      await fixture.app.conversation.waitForIdle(fixture.roleId);
      const original = fixture.app.conversation.listTasks(fixture.roleId)[0]!;
      fixture.app.conversation.finishTask({ roleId: fixture.roleId, taskId: original.taskId, status: "completed", endReason: "用户明确结束" });
      await fixture.app.close();
      clock.value = new Date("2026-11-05T03:00:00.000Z");
      const model = new ScriptedChatModel([]);
      restored = reopen(fixture, model, () => clock.value);
      await pause(100);
      restored.conversation.runDueAutonomy(fixture.roleId);
      const tasks = restored.conversation.listTasks(fixture.roleId);
      const wakes = restored.services.autonomy.listWakes(fixture.roleId);
      return { contractPassed: model.requests.length === 0 && tasks.length === 1 && tasks[0]?.taskId === original.taskId && tasks[0]?.status === "completed" && !wakes.some((w) => w.status === "pending" || w.status === "claimed"), observed: { tasks, wakes, calls: model.requests.length } };
    } finally { await restored?.close(); await fixture.app.close(); }
  });
  clearTimeout(watchdog);
  clearInterval(alive);
  console.log(JSON.stringify({ total: results.length, passed: results.filter((r) => r.contractPassed).length, errors: results.filter((r) => r.probeError).length }));
  process.exitCode = results.some((r) => r.probeError) ? 2 : results.some((r) => !r.contractPassed) ? 1 : 0;
}
