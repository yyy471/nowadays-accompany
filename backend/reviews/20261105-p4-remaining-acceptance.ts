import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createBackendApp, type BackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import { ConversationStore } from "../src/storage/conversation-store.js";
import { RoleStore } from "../src/storage/role-store.js";
import { MemoryQueryService } from "../src/application/memory-query-service.js";
import type { ModelEvent, ModelPort } from "../src/domain/model.js";
import { ScriptedChatModel, createFixtureWithModel, addBinding, seedEvent, withStorage, type Fixture } from "../tests/p2-05-fixture.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p4-remaining");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const done = (text: string): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
const tool = (name: string, args: unknown): ModelEvent[] => [{ type: "tool_call", callId: randomUUID(), name, arguments: args }, { type: "completed", stopReason: "tool_calls" }];
async function until(test: () => boolean, ms = 15_000) { const end = Date.now() + ms; while (!test()) { if (Date.now() > end) throw new Error("P4_REMAINING_TIMEOUT"); await pause(20); } }
function snap(f: Fixture) {
  return withStorage(f, (s) => ({
    executions: s.business.db.prepare("SELECT execution_id, trigger_type, status, state_version_loaded, state_version_committed FROM executions ORDER BY rowid").all(),
    tasks: s.business.db.prepare("SELECT task_id, status, origin FROM tasks ORDER BY rowid").all(),
    calls: s.business.db.prepare("SELECT tool_call_id, execution_id, task_id, status, tool_name FROM tool_calls ORDER BY rowid").all(),
    results: s.business.db.prepare("SELECT tool_call_id, status, diagnostic_code FROM tool_results ORDER BY rowid").all(),
    messages: s.business.db.prepare("SELECT message_id, execution_id, sender, status, content, processed_by_execution_id FROM messages ORDER BY sequence").all(),
    state: f.app.services.roles.getState(f.roleId),
    wakes: f.app.services.autonomy.listWakes(f.roleId),
    activities: f.app.services.autonomy.listActivities(f.roleId),
    budget: f.app.services.autonomy.getStatus(f.roleId).budget,
    metering: s.business.db.prepare("SELECT call_kind, purpose, counted, created_at FROM call_metering ORDER BY rowid").all() as Array<{ call_kind: string; purpose: string; counted: number; created_at: string }>,
    resources: s.business.db.prepare("SELECT task_id, resource_id, ended_at FROM task_resource_continuations").all(),
    diaries: f.app.services.memory.listDiaries(f.roleId),
    internalReceipts: s.business.db.prepare("SELECT event_type,payload_json FROM execution_stream_events WHERE execution_id IN (SELECT execution_id FROM executions WHERE role_id=?) AND json_extract(payload_json,'$.internalStepKey') IS NOT NULL ORDER BY stream_event_id").all(f.roleId) as Array<{ event_type: string; payload_json: string }>,
  }));
}
function stopAt(directory: string, boundary: string): never {
  fs.writeFileSync(path.join(directory, "boundary.json"), JSON.stringify({ boundary }));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("P4_STOP_RESUMED");
}
async function crashWorker(mode: string, directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  // waitForIdle 使用非保活计时器；故障使 MCP 关闭后仍须等到强杀边界。
  setInterval(() => {}, 1000);
  const clock = { value: new Date("2026-11-05T02:00:00.000Z") };
  let calls = 0;
  const model: ModelPort = { async *stream(request) {
    calls++;
    if (calls === 1) {
      const name = request.tools.find((t) => t.name.includes("append_once"))?.name;
      if (!name) throw new Error("P4_APPEND_TOOL_MISSING");
      if (["internal-diary", "internal-intent", "internal-intent-crossday", "internal-receipt-db-failure"].includes(mode)) {
        yield { type: "tool_call", callId: "diary-before-mcp", name: "diary_write", arguments: { content: "只应保存一次的检查点日记" } };
      }
      yield* tool(name, {});
    } else if (calls === 2 && mode === "partial-after-tool") {
      yield { type: "text_delta", text: "旧模型已输出的未完成片段" };
      stopAt(directory, mode);
    } else if (calls === 2) yield* tool("state_update", { patch: { mood: "检查点内的状态" } });
    else yield* done("原检查点中的最终回复");
  } };
  const f = createFixtureWithModel(model, { now: () => clock.value });
  const mcp = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href;
  const stdio = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href;
  const source = `import fs from 'node:fs';import {McpServer} from ${JSON.stringify(mcp)};import {StdioServerTransport} from ${JSON.stringify(stdio)};
    const server=new McpServer({name:'p4-boundary',version:'1'});process.stdin.on('end',()=>process.exit(0));fs.writeFileSync(${JSON.stringify(path.join(directory, "tool-pid.txt"))},String(process.pid));
    server.registerTool('append_once',{inputSchema:{}},async()=>{fs.appendFileSync(${JSON.stringify(path.join(directory, "effect.log"))},'effect\\n');return {content:[{type:'text',text:'saved'}]};});await server.connect(new StdioServerTransport());`;
  const resource = f.app.services.resources.create({ kind: "mcp", name: "P4 边界工具", config: { command: process.execPath, args: ["--input-type=module", "-e", source], env: {} } });
  addBinding(f, "mcp", resource.resourceId);
  fs.writeFileSync(path.join(directory, "fixture.json"), JSON.stringify({ root: f.root, roleId: f.roleId, windowId: f.windowId }));
  const originalRunning = RoleStore.prototype.markToolCallRunning;
  RoleStore.prototype.markToolCallRunning = function (roleId, callId) {
    if (mode === "before-dispatch") stopAt(directory, mode);
    return originalRunning.call(this, roleId, callId);
  };
  const originalResult = RoleStore.prototype.saveToolResult;
  RoleStore.prototype.saveToolResult = function (input) {
    const result = originalResult.call(this, input);
    if (["result-before-checkpoint", "internal-diary", "committed-crossday"].includes(mode) && input.status === "success") stopAt(directory, mode);
    return result;
  };
  const originalCommit = ConversationStore.prototype.commitConversation;
  ConversationStore.prototype.commitConversation = function (input) {
    if (mode === "checkpoint-before-commit") stopAt(directory, mode);
    const result = originalCommit.call(this, input);
    if (mode === "commit-before-task-finish") stopAt(directory, mode);
    return result;
  };
  const originalDiary = MemoryQueryService.prototype.createDiary;
  MemoryQueryService.prototype.createDiary = function (roleId, input) {
    const result = originalDiary.call(this, roleId, input);
    if (mode === "internal-intent" || mode === "internal-intent-crossday") stopAt(directory, mode);
    return result;
  };
  if (mode === "internal-receipt-db-failure") withStorage(f, (s) => s.business.db.exec("CREATE TRIGGER p4_internal_meter_fault BEFORE INSERT ON call_metering WHEN NEW.call_kind='tool' AND NEW.call_id LIKE 'tool:%' BEGIN SELECT RAISE(ABORT, 'P4_INTERNAL_METER_FAULT'); END"));
  if (mode === "result-db-failure") withStorage(f, (s) => s.business.db.exec("CREATE TRIGGER p4_result_fault BEFORE INSERT ON tool_results BEGIN SELECT RAISE(ABORT, 'P4_RESULT_WRITE_FAULT'); END"));
  f.app.services.autonomy.scheduleWake(f.roleId, { wakeAt: "2026-11-05T03:00:00.000Z", intent: "保留原执行检查点，避免重复实际操作" });
  clock.value = new Date("2026-11-05T03:00:00.000Z");
  f.app.conversation.runDueAutonomy(f.roleId);
  if (["result-db-failure", "internal-receipt-db-failure"].includes(mode)) { await f.app.conversation.waitForIdle(f.roleId); stopAt(directory, mode); }
}
async function correctionWorker(directory: string, name: string) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "fixture.json"), "utf8"));
  const app = createBackendApp(parseBackendConfig(["--app-root", metadata.root, "--port", "0"]), { disableMemoryRuntime: true, modelPortFactory: () => new ScriptedChatModel([]) });
  fs.writeFileSync(path.join(directory, `ready-${name}`), "ready");
  await until(() => fs.existsSync(path.join(directory, "go")));
  let result: unknown;
  try { result = { ok: true, value: app.services.memory.correctEvent(metadata.roleId, metadata.eventId, { expectedVersion: 1, patch: { title: `并发${name}`, summary: `胜出内容${name}`, tags: { place: [`地点${name}`] } } }) }; }
  catch (error) { result = { ok: false, code: error instanceof Error && "code" in error ? error.code : String(error) }; }
  fs.writeFileSync(path.join(directory, `result-${name}.json`), JSON.stringify(result));
  await app.close();
}
function launch(args: string[], directory: string) {
  const fd = fs.openSync(path.join(directory, `${args[0] ?? "worker"}-${args.at(-1)}.log`), "w");
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...args], { cwd: process.cwd(), env: process.env, stdio: ["ignore", fd, fd], windowsHide: true });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.once("error", (error) => { fs.writeFileSync(path.join(directory, "spawn-error.txt"), String(error)); });
  return { child, exited, fd };
}
async function stop(child: ChildProcess, exited: Promise<void>) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }

if (process.argv[2] === "--crash") await crashWorker(process.argv[4]!, process.argv[3]!);
else if (process.argv[2] === "--correct") await correctionWorker(process.argv[3]!, process.argv[4]!);
else {
  fs.mkdirSync(output, { recursive: true });
  const alive = setInterval(() => {}, 1000);
  const watchdog = setTimeout(() => { console.error("P4_REMAINING_WATCHDOG"); process.exit(2); }, 120_000);
  const results: Array<{ id: string; contractPassed: boolean; observed?: unknown; probeError?: string }> = [];
  async function probe(id: string, action: () => Promise<{ contractPassed: boolean; observed: unknown }>) {
    if (process.env.NOWADAYS_REVIEW_CASE && process.env.NOWADAYS_REVIEW_CASE !== id) return;
    try { results.push({ id, ...await action() }); }
    catch (error) { results.push({ id, contractPassed: false, probeError: error instanceof Error ? error.stack ?? error.message : String(error) }); }
    fs.writeFileSync(path.join(output, "p4-remaining-report.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ id: results.at(-1)?.id, passed: results.at(-1)?.contractPassed, error: results.at(-1)?.probeError }));
  }
  for (const mode of ["before-dispatch", "result-before-checkpoint", "checkpoint-before-commit", "commit-before-task-finish", "result-db-failure", "internal-diary", "committed-crossday", "partial-after-tool", "internal-intent", "internal-intent-crossday", "internal-receipt-db-failure"]) {
    await probe(mode, async () => {
      const directory = path.join(output, mode); fs.mkdirSync(directory, { recursive: true });
      const worker = launch(["--crash", directory, mode], directory);
      let app: BackendApp | undefined;
      let saver: SqliteSaver | undefined;
      try {
        await until(() => { if (worker.child.exitCode !== null) throw new Error(`P4_WORKER_EXIT:${worker.child.exitCode}`); return fs.existsSync(path.join(directory, "boundary.json")); });
        await stop(worker.child, worker.exited);
        if (fs.existsSync(path.join(directory, "tool-pid.txt"))) { try { process.kill(Number(fs.readFileSync(path.join(directory, "tool-pid.txt"), "utf8")), "SIGKILL"); } catch { /* 已随管道退出。 */ } }
        const meta = JSON.parse(fs.readFileSync(path.join(directory, "fixture.json"), "utf8")) as { root: string; roleId: string; windowId: string };
        // 此连接只取快照；不运行恢复，保证 before 是真正的进程强杀边界。
        const role = new RoleStore(rolePaths(path.join(meta.root, "data"), meta.roleId).businessDatabasePath, { create: false });
        const execution = role.db.prepare("SELECT execution_id FROM executions ORDER BY rowid LIMIT 1").get() as { execution_id: string };
        const before = { executions: role.db.prepare("SELECT execution_id, status FROM executions").all(), tasks: role.db.prepare("SELECT task_id,status FROM tasks").all(), results: role.db.prepare("SELECT tool_call_id,status FROM tool_results").all() };
        if (mode === "result-db-failure") role.db.exec("DROP TRIGGER p4_result_fault");
        if (mode === "internal-receipt-db-failure") role.db.exec("DROP TRIGGER p4_internal_meter_fault");
        role.close();
        saver = SqliteSaver.fromConnString(rolePaths(path.join(meta.root, "data"), meta.roleId).executionDatabasePath);
        const checkpoint = await saver.getTuple({ configurable: { thread_id: execution.execution_id } });
        const originalCheckpoint = checkpoint?.checkpoint.channel_values ?? null;
        saver.db.close(); saver = undefined;
        const model = new ScriptedChatModel([done("恢复后新执行另写的回复")]);
        const restartAt = mode.endsWith("crossday") ? "2026-11-06T04:00:00.000Z" : "2026-11-05T04:00:00.000Z";
        app = createBackendApp(parseBackendConfig(["--app-root", meta.root, "--port", "0"]), { now: () => new Date(restartAt), timeZone: "Asia/Shanghai", modelPortFactory: () => model, disableMemoryRuntime: true });
        const f = { ...meta, app } as Fixture;
        await pause(100);
        await app.conversation.waitForIdle(meta.roleId);
        const after = snap(f);
        const original = after.executions.find((e: any) => e.execution_id === execution.execution_id) as { status: string } | undefined;
        const effect = fs.existsSync(path.join(directory, "effect.log")) ? fs.readFileSync(path.join(directory, "effect.log"), "utf8") : "";
        let contractPassed: boolean;
        if (mode === "before-dispatch") contractPassed = effect === "" && after.results.some((r: any) => r.status === "failed" && r.diagnostic_code === "PROCESS_INTERRUPTED") && after.budget.usedPoints === after.metering.filter((m) => m.counted === 1).length;
        else if (mode === "result-before-checkpoint") contractPassed = original?.status === "completed" && after.executions.length === 1 && effect === "effect\n" && after.calls.length === 1;
        else if (mode === "checkpoint-before-commit") contractPassed = original?.status === "completed" && after.executions.length === 1 && model.requests.length === 0 && after.messages.some((m: any) => m.status === "completed" && m.content === "原检查点中的最终回复") && after.state.state.mood === "检查点内的状态";
        else if (mode === "commit-before-task-finish") contractPassed = original?.status === "completed" && model.requests.length === 0 && after.tasks.every((t: any) => t.status === "completed") && after.wakes.every((w) => w.status === "completed") && after.activities.every((a) => a.status === "completed");
        else if (mode.startsWith("internal-intent") || mode === "internal-receipt-db-failure") {
          const unknown = after.internalReceipts.find((r) => r.event_type === "tool_result_saved" && JSON.parse(r.payload_json).outcome?.status === "unknown");
          const seenByModel = unknown !== undefined && model.requests.some((r) => r.messages.some((m) => m.content.includes(JSON.parse(unknown.payload_json).internalStepKey) && m.content.includes('"status":"unknown"')));
          const dayMetering = after.metering.filter((m) => m.counted === 1 && m.created_at.startsWith(restartAt.slice(0, 10))).length;
          contractPassed = after.diaries.length === 1 && after.budget.usedPoints === dayMetering && unknown !== undefined && (mode.startsWith("internal-intent") ? seenByModel && after.tasks.every((t: any) => t.status === "completed") : model.requests.length === 0 && after.tasks.every((t: any) => t.status === "failed"));
        }
        else if (mode === "partial-after-tool") contractPassed = original?.status === "completed" && after.messages.some((m: any) => m.status === "interrupted" && m.content.includes("旧模型已输出的未完成片段")) && after.messages.some((m: any) => m.status === "completed" && m.content === "恢复后新执行另写的回复") && effect === "effect\n";
        else if (mode === "internal-diary") contractPassed = original?.status === "completed" && after.diaries.length === 1 && after.budget.usedPoints === after.metering.filter((m) => m.counted === 1).length && effect === "effect\n";
        else if (mode === "committed-crossday") contractPassed = original?.status === "completed" && after.budget.usedPoints === after.metering.filter((m) => m.counted === 1 && m.created_at.startsWith("2026-11-06")).length && effect === "effect\n";
        else contractPassed = effect === "effect\n" && after.results.some((r: any) => r.status === "unknown") && model.requests.length === 0;
        let secondRestart: unknown;
        if (mode.startsWith("internal-intent") || mode === "internal-receipt-db-failure") {
          await app.close();
          const quiet = new ScriptedChatModel([]);
          app = createBackendApp(parseBackendConfig(["--app-root", meta.root, "--port", "0"]), { now: () => new Date(restartAt), timeZone: "Asia/Shanghai", modelPortFactory: () => quiet, disableMemoryRuntime: true });
          const second = snap({ ...meta, app } as Fixture);
          contractPassed = contractPassed && quiet.requests.length === 0 && second.diaries.length === 1 && second.budget.usedPoints === after.budget.usedPoints && second.metering.length === after.metering.length && second.internalReceipts.length === after.internalReceipts.length;
          secondRestart = { state: second, modelCalls: quiet.requests.length };
        }
        return { contractPassed, observed: { pid: worker.child.pid, signal: worker.child.signalCode, before, originalExecutionId: execution.execution_id, originalCheckpoint, after, secondRestart, recoveryRequests: model.requests, effect } };
      } finally { await stop(worker.child, worker.exited); await app?.close(); saver?.db.close(); fs.closeSync(worker.fd); }
    });
  }
  await probe("commit-write-failure-rollback", async () => {
    const model = new ScriptedChatModel([done("这段回复的提交将被故障阻止"), done("故障解除后的正式回复")]);
    const f = createFixtureWithModel(model);
    try {
      withStorage(f, (s) => s.business.db.exec("CREATE TRIGGER p4_commit_fault BEFORE UPDATE OF state_json ON roles BEGIN SELECT RAISE(ABORT, 'P4_COMMIT_WRITE_FAULT'); END"));
      f.app.conversation.submitMessage(f.roleId, f.windowId, { content: "提交失败时不要丢失原输入", submissionId: randomUUID(), sourcePlatform: "nowadays" });
      await f.app.conversation.waitForIdle(f.roleId);
      const failed = snap(f);
      withStorage(f, (s) => s.business.db.exec("DROP TRIGGER p4_commit_fault"));
      f.app.conversation.submitMessage(f.roleId, f.windowId, { content: "故障解除，请重新评估", submissionId: randomUUID(), sourcePlatform: "nowadays" });
      await f.app.conversation.waitForIdle(f.roleId);
      const recovered = snap(f);
      return { contractPassed: failed.state.stateVersion === 1 && !failed.messages.some((m: any) => m.status === "completed") && failed.messages.filter((m: any) => m.sender === "user").every((m: any) => m.processed_by_execution_id === null) && recovered.messages.filter((m: any) => m.sender === "assistant" && m.status === "completed").length === 1,
        observed: { failed, recovered } };
    } finally { await f.close(); }
  });
  await probe("memory-index-write-failure-rollback", async () => {
    const f = createFixtureWithModel(new ScriptedChatModel([]));
    try {
      const event = seedEvent(f, { content: "原始证据不变", title: "原始事件", summary: "原始摘要", tags: { place: ["原地点"] }, occurredAt: "2026-11-05T02:00:00.000Z" });
      const before = f.app.services.memory.getEvent(f.roleId, event.eventId);
      withStorage(f, (s) => s.business.db.exec("CREATE TRIGGER p4_index_fault BEFORE UPDATE ON memory_search_documents BEGIN SELECT RAISE(ABORT, 'P4_INDEX_WRITE_FAULT'); END"));
      let code: unknown;
      try { f.app.services.memory.correctEvent(f.roleId, event.eventId, { expectedVersion: 1, patch: { title: "不应部分保存的事件", summary: "故障摘要", tags: { place: ["故障地点"] } } }); }
      catch (error) { code = error instanceof Error && "code" in error ? error.code : String(error); }
      const after = f.app.services.memory.getEvent(f.roleId, event.eventId);
      const docs = withStorage(f, (s) => s.business.db.prepare("SELECT title,body FROM memory_search_documents WHERE record_id=?").get(event.eventId));
      return { contractPassed: code !== undefined && JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(docs).includes("原始摘要") && !JSON.stringify(docs).includes("故障摘要"), observed: { code, before, after, docs } };
    } finally { await f.close(); }
  });
  await probe("two-process-memory-correction", async () => {
    const directory = path.join(output, "two-process-memory-correction"); fs.mkdirSync(directory, { recursive: true });
    const f = createFixtureWithModel(new ScriptedChatModel([]));
    const children: ReturnType<typeof launch>[] = [];
    let app: BackendApp | undefined;
    try {
      const event = seedEvent(f, { content: "并发纠错原始证据", title: "并发前事件", summary: "并发前摘要", occurredAt: "2026-11-05T02:00:00.000Z" });
      await f.app.close();
      fs.writeFileSync(path.join(directory, "fixture.json"), JSON.stringify({ root: f.root, roleId: f.roleId, eventId: event.eventId }));
      children.push(launch(["--correct", directory, "A"], directory), launch(["--correct", directory, "B"], directory));
      await until(() => ["A", "B"].every((name) => fs.existsSync(path.join(directory, `ready-${name}`))));
      fs.writeFileSync(path.join(directory, "go"), "go");
      await until(() => ["A", "B"].every((name) => fs.existsSync(path.join(directory, `result-${name}.json`))));
      await Promise.all(children.map((c) => c.exited));
      const replies = ["A", "B"].map((name) => JSON.parse(fs.readFileSync(path.join(directory, `result-${name}.json`), "utf8")));
      app = createBackendApp(parseBackendConfig(["--app-root", f.root, "--port", "0"]), { disableMemoryRuntime: true, modelPortFactory: () => new ScriptedChatModel([]) });
      const after = app.services.memory.getEvent(f.roleId, event.eventId);
      const winner = after.title.slice(-1);
      const search = app.services.memory.search(f.roleId, { query: `胜出内容${winner}`, places: [`地点${winner}`] });
      return { contractPassed: replies.filter((r) => r.ok).length === 1 && replies.filter((r) => !r.ok).length === 1 && after.version === 2 && search.items.some((i) => i.id === event.eventId) && app.services.memory.getEvidence(f.roleId, event.evidenceId).content === "并发纠错原始证据",
        observed: { replies, after, search } };
    } finally { await Promise.all(children.map((c) => stop(c.child, c.exited))); for (const c of children) fs.closeSync(c.fd); await app?.close(); await f.close(); }
  });
  clearTimeout(watchdog); clearInterval(alive);
  console.log(JSON.stringify({ total: results.length, passed: results.filter((r) => r.contractPassed).length, errors: results.filter((r) => r.probeError).length }));
  process.exitCode = results.some((r) => r.probeError) ? 2 : results.some((r) => !r.contractPassed) ? 1 : 0;
}
