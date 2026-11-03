import assert from "node:assert/strict";
import { Command } from "@langchain/langgraph";
import {
  CheckList,
  createRuntime,
  readEffectCounts,
  readWorkspaceFile,
  seedRoleAndInput,
  writeCaseReport,
} from "./harness.js";

const checks = new CheckList();
const runtime = await createRuntime({
  caseName: "c02",
  scriptName: "c02",
  pauseAfterTool: true,
});

try {
  const seed = seedRoleAndInput(runtime.store);
  let interruptPayload: unknown = null;

  await checks.check("pauses after the tool result is saved", async () => {
    const first = (await runtime.graph.invoke(
      { executionId: seed.executionId },
      { configurable: { thread_id: seed.executionId } },
    )) as { __interrupt__?: unknown };
    assert.ok(first.__interrupt__, "graph must pause at the pause gate");
    runtime.store.setExecutionStatus(seed.executionId, "paused");
    interruptPayload = first.__interrupt__;
    return { interrupt: first.__interrupt__ };
  });

  await checks.check("paused state keeps one real tool effect", () => {
    const counts = readEffectCounts(runtime.paths.workspace);
    assert.equal(counts.append_note, 1);
    assert.equal(
      readWorkspaceFile(runtime.paths.workspace, "note.md"),
      "P0-C02\n",
    );
    const snapshot = runtime.store.snapshot();
    const executions = snapshot.executions as Array<{ status: string }>;
    const toolCalls = snapshot.toolCalls as Array<{ status: string }>;
    const toolResults = snapshot.toolResults as Array<{ status: string }>;
    assert.equal(executions[0]?.status, "paused");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.status, "success");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0]?.status, "success");
    return { counts, executionStatus: executions[0]?.status };
  });

  await checks.check("resumes the same execution without repeating the tool", async () => {
    runtime.store.setExecutionStatus(seed.executionId, "running");
    const resumed = (await runtime.graph.invoke(
      new Command({ resume: "continue" }),
      { configurable: { thread_id: seed.executionId } },
    )) as { finalText?: string };
    assert.equal(resumed.finalText, "同次恢复后工具状态=success。");
    assert.equal(readEffectCounts(runtime.paths.workspace).append_note, 1);

    const snapshot = runtime.store.snapshot();
    const executions = snapshot.executions as Array<{
      id: string;
      status: string;
    }>;
    const toolCalls = snapshot.toolCalls as Array<{ status: string }>;
    const roles = snapshot.roles as Array<{ state: Record<string, unknown> }>;
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.id, seed.executionId);
    assert.equal(executions[0]?.status, "completed");
    assert.equal(toolCalls.length, 1);
    assert.equal(roles[0]?.state.lastToolStatus, "success");
    assert.equal(roles[0]?.state.lastReply, "c02");
    return {
      executionId: executions[0]?.id,
      executionStatus: executions[0]?.status,
      finalText: resumed.finalText,
      resumedEvents: runtime.events.filter((event) => event.type === "resumed"),
    };
  });

  const report = writeCaseReport({
    caseName: "c02",
    checks,
    runtime,
    extra: { seed, interruptPayload },
  });
  console.log(
    JSON.stringify({ case: "c02", ok: report.ok, checks: checks.items }, null, 2),
  );
} finally {
  await runtime.close();
}

if (!checks.ok) {
  process.exitCode = 1;
}
