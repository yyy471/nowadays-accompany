// 独立复核探针：只组合公开的小样接口，不修改实现；输出保存在独立 data 目录。
import fs from "node:fs";
import path from "node:path";
import { buildP0Graph } from "../src/graph/build.js";
import { createRuntime, seedRoleAndInput, readEffectCounts } from "../src/cases/harness.js";
import type { ChatModelPort } from "../src/domain/types.js";

const stamp = `review-${Date.now()}`;
const reports: Record<string, unknown>[] = [];
const err = (error: unknown) => error instanceof Error ? error.message : String(error);
const finalModel: ChatModelPort = { async decide() { return { type: "final", text: "完成", stateUpdate: { reviewed: true } }; } };

async function checkpointGap(eventType: "tool_result_saved" | "completed") {
  const caseName = `${stamp}-${eventType}`;
  let runtime = await createRuntime({ caseName, scriptName: "c01", prepare: false });
  const seed = seedRoleAndInput(runtime.store);
  const config = { configurable: { thread_id: seed.executionId } };
  let injected = false;
  const graph = buildP0Graph({
    store: runtime.store, executor: runtime.executor,
    model: { async decide(context) { return context.turn === 0
      ? { type: "tool", toolName: "append_note", args: { path: "note.md", text: "review-gap" } }
      : { type: "final", text: "完成", stateUpdate: { reviewed: true } }; } },
    emit(event) {
      runtime.emit(event);
      if (event.type === eventType && !injected) {
        injected = true;
        throw new Error(`REVIEW_FAULT_AFTER_${eventType}`);
      }
    },
  }, runtime.saver);
  let initialError: string | null = null;
  try { await graph.invoke({ executionId: seed.executionId }, config); } catch (error) { initialError = err(error); }
  const before = runtime.store.snapshot();
  const nextBefore = (await graph.getState(config)).next;
  await runtime.close();
  runtime = await createRuntime({ caseName, scriptName: "c01", prepare: false });
  let resumeError: string | null = null;
  try { await runtime.graph.invoke(null, config); } catch (error) { resumeError = err(error); }
  reports.push({ probe: eventType, paths: runtime.paths, initialError, nextBefore, before,
    resumeError, after: runtime.store.snapshot(), effects: readEffectCounts(runtime.paths.workspace),
    contractPassed: resumeError === null && runtime.store.getExecution(seed.executionId).status === "completed" });
  await runtime.close();
}

async function supersededTool() {
  const runtime = await createRuntime({ caseName: `${stamp}-superseded-tool`, scriptName: "c01", prepare: false });
  try {
    const seed = seedRoleAndInput(runtime.store);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const model: ChatModelPort = { async decide(context) {
      if (context.turn === 0) {
        entered(); await gate;
        return { type: "tool", toolName: "append_note", args: { path: "note.md", text: "superseded-side-effect" } };
      }
      return { type: "final", text: "旧回复" };
    } };
    const old = buildP0Graph({ store: runtime.store, executor: runtime.executor, model, emit: runtime.emit }, runtime.saver);
    const oldDone = old.invoke({ executionId: seed.executionId }, { configurable: { thread_id: seed.executionId } }).then(() => null, err);
    await ready;
    const message = runtime.store.insertUserMessage({ roleId: seed.role.id, windowId: "main", content: "新消息" });
    runtime.store.markExecutionSuperseded(seed.executionId, "");
    const fresh = runtime.store.createExecution({ roleId: seed.role.id, windowId: "main", triggerMessageId: message.id });
    await buildP0Graph({ store: runtime.store, executor: runtime.executor, model: finalModel, emit: runtime.emit }, runtime.saver)
      .invoke({ executionId: fresh.id }, { configurable: { thread_id: fresh.id } });
    release();
    const oldError = await oldDone;
    const effects = readEffectCounts(runtime.paths.workspace);
    reports.push({ probe: "superseded-tool", paths: runtime.paths, oldError, events: runtime.events,
      snapshot: runtime.store.snapshot(), effects, contractPassed: (effects.append_note ?? 0) === 0 });
  } finally { await runtime.close(); }
}

async function latestContext() {
  const caseName = `${stamp}-latest-context`;
  let runtime = await createRuntime({ caseName, scriptName: "c01", prepare: false });
  const seed = seedRoleAndInput(runtime.store);
  const config = { configurable: { thread_id: seed.executionId } };
  let observed: unknown = null;
  const model: ChatModelPort = { async decide(context) { observed = context; return { type: "final", text: `tone=${context.settings.tone}` }; } };
  let graph = buildP0Graph({ store: runtime.store, executor: runtime.executor, model, emit: runtime.emit }, runtime.saver);
  await graph.invoke({ executionId: seed.executionId }, { ...config, interruptBefore: ["model"] });
  const nextBefore = (await graph.getState(config)).next;
  const updated = runtime.store.patchRole({ roleId: seed.role.id, settingsPatch: { tone: "new-tone" }, statePatch: { mood: "new-mood" } });
  await runtime.close();
  runtime = await createRuntime({ caseName, scriptName: "c01", prepare: false });
  graph = buildP0Graph({ store: runtime.store, executor: runtime.executor, model, emit: runtime.emit }, runtime.saver);
  await graph.invoke(null, config);
  reports.push({ probe: "latest-context", paths: runtime.paths, nextBefore, updated, observed,
    snapshot: runtime.store.snapshot(), contractPassed: (observed as { stateVersion: number }).stateVersion === updated.stateVersion });
  await runtime.close();
}

async function connectionLoss() {
  const runtime = await createRuntime({ caseName: `${stamp}-connection-loss`, scriptName: "c06", prepare: false, timeoutMs: 20000 });
  try {
    const seed = seedRoleAndInput(runtime.store);
    let reconcileCalls = 0;
    const graph = buildP0Graph({ store: runtime.store, executor: runtime.executor,
      model: { async decide(context) { return context.turn === 0
        ? { type: "tool", toolName: "append_note_then_hang", args: { path: "note.md", text: "effect-before-disconnect" } }
        : { type: "final", text: `status=${context.toolResults.at(-1)?.status}` }; } },
      emit: runtime.emit, reconcile: async () => { reconcileCalls++; return { status: "unknown", error: "unverifiable" }; },
    }, runtime.saver);
    const watcher = (async () => {
      const deadline = Date.now() + 10000;
      const note = path.join(runtime.paths.workspace, "note.md");
      while (!fs.existsSync(note)) {
        if (Date.now() > deadline) throw new Error("REVIEW_WAIT_FOR_EFFECT_TIMEOUT");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      // 在服务器已执行副作用但尚未应答时断开真实 stdio 连接。
      await runtime.executor.close();
    })();
    await Promise.all([watcher, graph.invoke({ executionId: seed.executionId }, { configurable: { thread_id: seed.executionId } })]);
    const results = runtime.store.getToolResults(seed.executionId);
    reports.push({ probe: "connection-loss", paths: runtime.paths, reconcileCalls, results,
      effects: readEffectCounts(runtime.paths.workspace), snapshot: runtime.store.snapshot(),
      contractPassed: reconcileCalls === 1 && results[0]?.status === "unknown" });
  } finally { await runtime.close(); }
}

await checkpointGap("tool_result_saved");
await checkpointGap("completed");
await supersededTool();
await latestContext();
await connectionLoss();
const reportPath = path.resolve("test-results", "review-20261103", `${stamp}.json`);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), node: process.version, reports }, null, 2));
console.log(JSON.stringify({ reportPath, reports: reports.map(({ probe, contractPassed, resumeError, oldError, effects, reconcileCalls, results, updated, observed }) => ({ probe, contractPassed, resumeError, oldError, effects, reconcileCalls, results, updated, observed })) }, null, 2));
