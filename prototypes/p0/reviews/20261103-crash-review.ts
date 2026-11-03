// 独立复验：在业务写入后阻塞节点，由父进程强杀整棵测试进程树，再以新进程恢复。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildP0Graph } from "../src/graph/build.js";
import { createRuntime, seedRoleAndInput, readEffectCounts } from "../src/cases/harness.js";
import type { ChatModelPort } from "../src/domain/types.js";
import { p0Root } from "../src/config.js";

interface Config { caseName: string; executionId: string; boundary: string; mode: "crash" | "resume" }
const print = (value: unknown) => fs.writeSync(1, JSON.stringify(value) + "\n");
const model: ChatModelPort = { async decide(context) {
  return context.turn === 0
    ? { type: "tool", toolName: "append_note", args: { path: "note.md", text: "crash-review" } }
    : { type: "final", text: `status=${context.toolResults.at(-1)?.status}`, stateUpdate: { reviewed: true } };
} };

async function child(config: Config) {
  const runtime = await createRuntime({ caseName: config.caseName, scriptName: "c01", prepare: false });
  function stop(boundary: string) {
    if (config.mode === "crash" && boundary === config.boundary) {
      print({ event: "ready", boundary, snapshot: runtime.store.snapshot() });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw new Error("CRASH_CHILD_UNEXPECTEDLY_RESUMED");
    }
  }
  try {
    const graph = buildP0Graph({
      store: runtime.store, model,
      executor: {
        async callTool(name, args) {
          const result = await runtime.executor.callTool(name, args);
          stop("effect_before_result");
          return result;
        },
        async close() { await runtime.executor.close(); },
      },
      emit(event) { runtime.emit(event); stop(event.type); },
    }, runtime.saver);
    const graphConfig = { configurable: { thread_id: config.executionId } };
    const before = runtime.store.snapshot();
    const nextBefore = (await graph.getState(graphConfig)).next;
    await graph.invoke(config.mode === "crash" ? { executionId: config.executionId } : null, graphConfig);
    print({ event: "done", before, nextBefore, after: runtime.store.snapshot(),
      nextAfter: (await graph.getState(graphConfig)).next, effects: readEffectCounts(runtime.paths.workspace), events: runtime.events });
  } finally { await runtime.close(); }
}

function launch(config: Config) {
  const proc = spawn(process.execPath, [path.join(p0Root, "node_modules/tsx/dist/cli.mjs"), fileURLToPath(import.meta.url), JSON.stringify(config)], {
    cwd: p0Root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, P0_VERBOSE: "0" },
  });
  let stderr = "";
  proc.stderr.on("data", chunk => { stderr += chunk.toString(); });
  let resolveEvent!: (event: any) => void;
  let rejectEvent!: (error: Error) => void;
  const event = new Promise<any>((resolve, reject) => { resolveEvent = resolve; rejectEvent = reject; });
  const timer = setTimeout(() => rejectEvent(new Error(`CHILD_TIMEOUT:${stderr}`)), 20000);
  const closed = new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", code => { clearTimeout(timer); rejectEvent(new Error(`CHILD_CLOSED:${code}:${stderr}`)); resolve(code); });
  });
  readline.createInterface({ input: proc.stdout }).on("line", line => {
    try { const parsed = JSON.parse(line); clearTimeout(timer); resolveEvent(parsed); }
    catch (error) { rejectEvent(error as Error); }
  });
  return { proc, event, closed };
}

async function killTree(pid: number) {
  await new Promise<void>((resolve, reject) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    killer.once("error", reject);
    killer.once("close", code => code === 0 ? resolve() : reject(new Error(`TASKKILL_FAILED:${code}`)));
  });
}

async function parent() {
  const reports: any[] = [];
  const stamp = `crash-review-${Date.now()}`;
  for (const boundary of ["tool_registered", "tool_result_saved", "completed", "effect_before_result"]) {
    const caseName = `${stamp}-${boundary}`;
    const runtime = await createRuntime({ caseName, scriptName: "c01", prepare: false });
    const seed = seedRoleAndInput(runtime.store);
    const paths = runtime.paths;
    await runtime.close();
    const config = { caseName, executionId: seed.executionId, boundary };
    const crash = launch({ ...config, mode: "crash" });
    let killed = false;
    try {
      const ready = await crash.event;
      assert.equal(ready.event, "ready");
      await killTree(crash.proc.pid!); killed = true;
      await crash.closed;
      const resumed = launch({ ...config, mode: "resume" });
      let done: any;
      try { done = await resumed.event; assert.equal(await resumed.closed, 0); }
      finally { if (resumed.proc.exitCode === null && resumed.proc.signalCode === null) await killTree(resumed.proc.pid!); }
      assert.equal(done.event, "done");
      assert.equal(done.after.executions[0].status, "completed");
      assert.equal(done.after.toolCalls.length, 1);
      assert.equal(done.after.toolResults.length, 1);
      assert.equal(done.after.toolCalls[0].id, ready.snapshot.toolCalls[0].id);
      assert.equal(done.after.toolResults[0].status, boundary === "effect_before_result" ? "unknown" : "success");
      assert.equal(done.after.messages.filter((message: any) => message.sender === "assistant").length, 1);
      assert.equal(done.after.roles[0].state_version, 2);
      assert.equal(done.effects.append_note, 1);
      assert.deepEqual(done.nextAfter, []);
      reports.push({ boundary, paths, ready, done, contractPassed: true });
      console.log(`${boundary}: PASS (effect=1, call=1, reply=1, stateVersion=2)`);
    } finally {
      if (!killed && crash.proc.exitCode === null && crash.proc.signalCode === null) await killTree(crash.proc.pid!);
    }
  }
  const reportPath = path.join(p0Root, "test-results/re-review-20261103", `${stamp}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), node: process.version, reports }, null, 2));
  console.log(JSON.stringify({ reportPath, passed: reports.length }));
}

if (process.argv[2]) await child(JSON.parse(process.argv[2]) as Config);
else await parent();
