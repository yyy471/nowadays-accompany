import assert from "node:assert/strict";
import {
  CheckList,
  createRuntime,
  readEffectCounts,
  readWorkspaceFile,
  seedRoleAndInput,
  writeCaseReport,
  type CaseRuntime,
} from "./harness.js";

async function runMode(
  mode: "verify" | "unverifiable",
): Promise<{
  mode: string;
  report: Record<string, unknown>;
  checks: CheckList;
  runtime: CaseRuntime;
}> {
  const caseName = `c06-${mode}`;
  const checks = new CheckList();
  const runtime = await createRuntime({
    caseName,
    scriptName: "c06",
    timeoutMs: 2000,
    reconcileMode: mode,
  });

  const seed = seedRoleAndInput(runtime.store);
  const expectedStatus = mode === "verify" ? "success" : "unknown";

  await checks.check("model continues with the reconciled tool status", async () => {
    const result = (await runtime.graph.invoke(
      { executionId: seed.executionId },
      { configurable: { thread_id: seed.executionId } },
    )) as { finalText?: string };
    assert.equal(result.finalText, `工具核查状态=${expectedStatus}。`);
    return { finalText: result.finalText };
  });

  const snapshot = runtime.store.snapshot();
  const roles = snapshot.roles as Array<{ state: Record<string, unknown> }>;
  const toolCalls = snapshot.toolCalls as Array<{ status: string }>;
  const toolResults = snapshot.toolResults as Array<{
    status: string;
    result: unknown;
    error: unknown;
  }>;
  const executions = snapshot.executions as Array<{ status: string }>;

  await checks.check("unknown response is not treated as a failed retry", () => {
    const counts = readEffectCounts(runtime.paths.workspace);
    assert.equal(counts.append_note_then_hang, 1);
    assert.equal(
      readWorkspaceFile(runtime.paths.workspace, "note.md"),
      "P0-C06\n",
    );
    assert.equal(toolCalls.length, 1);
    assert.equal(toolResults.length, 1);
    assert.equal(toolCalls[0]?.status, expectedStatus);
    assert.equal(toolResults[0]?.status, expectedStatus);
    assert.equal(executions[0]?.status, "completed");
    assert.equal(roles[0]?.state.lastToolStatus, expectedStatus);
    return {
      effectCounts: counts,
      toolStatus: toolCalls[0]?.status,
      executionStatus: executions[0]?.status,
    };
  });

  await checks.check(
    mode === "verify"
      ? "readback confirms the saved side effect"
      : "unverifiable result remains unknown",
    () => {
      if (mode === "verify") {
        const result = toolResults[0]?.result as
          | { reconciled?: boolean; content?: string }
          | null;
        assert.equal(result?.reconciled, true);
        assert.equal(result?.content, "P0-C06\n");
        assert.equal(toolResults[0]?.error, null);
        return { result };
      }
      assert.equal(toolResults[0]?.result, null);
      const error = toolResults[0]?.error as { code?: string } | null;
      assert.equal(error?.code, "RECONCILE_UNAVAILABLE");
      return { error };
    },
  );

  const report = writeCaseReport({
    caseName,
    checks,
    runtime,
    extra: { seed, mode, expectedStatus },
  });

  return { mode, report, checks, runtime };
}

const results = [];
try {
  results.push(await runMode("verify"));
  results.push(await runMode("unverifiable"));
} finally {
  for (const result of results) {
    await result.runtime.close();
  }
}

const summary = {
  case: "c06",
  ok: results.every((result) => result.checks.ok),
  modes: results.map((result) => ({
    mode: result.mode,
    ok: result.report.ok,
    checks: result.checks.items,
  })),
};
console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) {
  process.exitCode = 1;
}
