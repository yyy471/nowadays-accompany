import assert from "node:assert/strict";
import {
  CheckList,
  createRuntime,
  readEffectCounts,
  seedRoleAndInput,
  writeCaseReport,
} from "./harness.js";

const checks = new CheckList();
const runtime = await createRuntime({
  caseName: "c08",
  scriptName: "c08",
});

try {
  const seed = seedRoleAndInput(runtime.store);

  await checks.check("explicit tool failure is recorded as failed", async () => {
    const result = (await runtime.graph.invoke(
      { executionId: seed.executionId },
      { configurable: { thread_id: seed.executionId } },
    )) as { finalText?: string };
    assert.equal(result.finalText, "工具状态=failed。");

    const snapshot = runtime.store.snapshot();
    const executions = snapshot.executions as Array<{ status: string }>;
    const roles = snapshot.roles as Array<{ state: Record<string, unknown> }>;
    const tasks = snapshot.tasks as Array<{ status: string }>;
    const toolCalls = snapshot.toolCalls as Array<{ status: string }>;
    const toolResults = snapshot.toolResults as Array<{
      status: string;
      error: unknown;
    }>;
    const decisions = snapshot.decisions as Array<unknown>;

    assert.equal(executions[0]?.status, "completed");
    assert.equal(roles[0]?.state.lastToolStatus, "failed");
    assert.equal(tasks[0]?.status, "completed");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.status, "failed");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0]?.status, "failed");
    assert.equal(decisions.length, 2);
    assert.match(
      JSON.stringify(toolResults[0]?.error),
      /PATH_OUTSIDE_WORKSPACE|MCP_TOOL_ERROR/,
    );
    assert.equal(readEffectCounts(runtime.paths.workspace).append_note, undefined);
    return {
      finalText: result.finalText,
      executionStatus: executions[0]?.status,
      toolStatus: toolCalls[0]?.status,
      error: toolResults[0]?.error,
    };
  });

  const report = writeCaseReport({
    caseName: "c08",
    checks,
    runtime,
    extra: { seed },
  });
  console.log(
    JSON.stringify({ case: "c08", ok: report.ok, checks: checks.items }, null, 2),
  );
} finally {
  await runtime.close();
}

if (!checks.ok) {
  process.exitCode = 1;
}
