import assert from "node:assert/strict";
import { buildP0Graph } from "../graph/build.js";
import { createScriptedModel } from "../model/scripts.js";
import {
  CheckList,
  createRuntime,
  readEffectCounts,
  seedRoleAndInput,
  writeCaseReport,
  type CaseRuntime,
} from "./harness.js";

const checks = new CheckList();
const firstRuntime = await createRuntime({
  caseName: "c09",
  scriptName: "c01",
});
let currentRuntime: CaseRuntime | null = firstRuntime;

try {
  const seed = seedRoleAndInput(firstRuntime.store);
  const config = { configurable: { thread_id: seed.executionId } };

  await firstRuntime.graph.invoke(
    { executionId: seed.executionId },
    { ...config, interruptBefore: ["execute_tool"] },
  );
  const next = (await firstRuntime.graph.getState(config)).next;
  assert.ok(next.includes("execute_tool"));
  const before = firstRuntime.store.snapshot();
  const pendingCalls = before.toolCalls as Array<{
    id: string;
    status: string;
  }>;
  assert.equal(pendingCalls.length, 1);
  assert.equal(pendingCalls[0]?.status, "pending");
  const toolCallId = pendingCalls[0]?.id ?? "";
  firstRuntime.store.markToolCallRunning(toolCallId);
  await firstRuntime.close();
  currentRuntime = null;

  const resumedRuntime = await createRuntime({
    caseName: "c09",
    scriptName: "c01",
    prepare: false,
  });
  currentRuntime = resumedRuntime;
  const resumedGraph = buildP0Graph(
    {
      store: resumedRuntime.store,
      model: createScriptedModel("c01"),
      executor: resumedRuntime.executor,
      emit: resumedRuntime.emit,
      reconcile: async () => ({
        status: "unknown",
        error: {
          name: "RunningWithoutResult",
          message: "No result was saved for the running call",
          code: "PREVIOUS_ATTEMPT_RUNNING",
        },
      }),
    },
    resumedRuntime.saver,
  );

  await checks.check(
    "running call without a saved result is treated as unknown",
    async () => {
      await resumedGraph.invoke(null, config);
      const snapshot = resumedRuntime.store.snapshot();
      const executions = snapshot.executions as Array<{ status: string }>;
      const calls = snapshot.toolCalls as Array<{ status: string }>;
      const results = snapshot.toolResults as Array<{ status: string }>;
      const roles = snapshot.roles as Array<{ state: Record<string, unknown> }>;
      const messages = snapshot.messages as Array<{
        sender: string;
        content: string;
        status: string;
      }>;
      assert.equal(executions[0]?.status, "completed");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.status, "unknown");
      assert.equal(results.length, 1);
      assert.equal(results[0]?.status, "unknown");
      assert.equal(roles[0]?.state.lastToolStatus, "unknown");
      assert.equal(
        readEffectCounts(resumedRuntime.paths.workspace).append_note,
        undefined,
      );
      const reply = messages.find((message) => message.sender === "assistant");
      assert.equal(reply?.status, "completed");
      assert.equal(reply?.content, "工具状态=unknown。");
      return {
        nextBeforeResume: next,
        toolCallId,
        executionStatus: executions[0]?.status,
        toolStatus: calls[0]?.status,
        finalText: reply?.content,
      };
    },
  );

  const report = writeCaseReport({
    caseName: "c09",
    checks,
    runtime: resumedRuntime,
    extra: { seed, toolCallId },
  });
  console.log(
    JSON.stringify({ case: "c09", ok: report.ok, checks: checks.items }, null, 2),
  );
} finally {
  await currentRuntime?.close();
}

if (!checks.ok) {
  process.exitCode = 1;
}
