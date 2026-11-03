import assert from "node:assert/strict";
import { serializeError } from "../domain/errors.js";
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
  caseName: "c07",
  scriptName: "c07",
  faultMode: "commit_fail",
});

try {
  const seed = seedRoleAndInput(runtime.store);
  let commitError: unknown = null;

  await checks.check("formal commit fails and is reported as failed", async () => {
    try {
      await runtime.graph.invoke(
        { executionId: seed.executionId },
        { configurable: { thread_id: seed.executionId } },
      );
    } catch (error) {
      commitError = error;
    }
    assert.ok(commitError, "commit failure must reject the execution");
    assert.match(String(commitError), /INJECTED_COMMIT_FAILURE/);
    const commitFailed = runtime.events.find(
      (event) =>
        event.type === "commit_failed" &&
        event.executionId === seed.executionId,
    );
    assert.ok(commitFailed);
    return {
      error: serializeError(commitError),
      commitFailed,
      streamedDeltas: runtime.events.filter((event) => event.type === "delta")
        .length,
    };
  });

  const snapshotBefore = runtime.store.snapshot();
  const executions = snapshotBefore.executions as Array<{ status: string }>;
  const messages = snapshotBefore.messages as Array<{
    sender: string;
    status: string;
  }>;
  const roles = snapshotBefore.roles as Array<{
    state: Record<string, unknown>;
    state_version: number;
  }>;
  const tasks = snapshotBefore.tasks as Array<{ status: string }>;
  const toolCalls = snapshotBefore.toolCalls as Array<{ status: string }>;
  const toolResults = snapshotBefore.toolResults as Array<{ status: string }>;
  const decisions = snapshotBefore.decisions as Array<unknown>;

  await checks.check("no half-committed reply or state remains", () => {
    assert.equal(executions[0]?.status, "running");
    assert.equal(
      messages.filter((message) => message.sender === "assistant").length,
      0,
    );
    assert.ok(roles[0]);
    assert.equal(roles[0].state_version, 1);
    assert.equal(roles[0].state.mood, "neutral");
    assert.equal(roles[0].state.lastReply, undefined);
    assert.equal(tasks[0]?.status, "active");
    assert.equal(decisions.length, 2);
    return {
      executionStatus: executions[0]?.status,
      assistantMessages: messages.filter(
        (message) => message.sender === "assistant",
      ).length,
      stateVersion: roles[0].state_version,
      taskStatus: tasks[0]?.status,
    };
  });

  await checks.check("real tool result survives the failed commit", () => {
    assert.equal(readEffectCounts(runtime.paths.workspace).append_note, 1);
    assert.equal(
      readWorkspaceFile(runtime.paths.workspace, "note.md"),
      "P0-C07\n",
    );
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.status, "success");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0]?.status, "success");
    return {
      effectCounts: readEffectCounts(runtime.paths.workspace),
      toolCalls: toolCalls.length,
      toolResults: toolResults.length,
    };
  });

  runtime.store.setExecutionStatus(seed.executionId, "failed");

  const report = writeCaseReport({
    caseName: "c07",
    checks,
    runtime,
    extra: {
      seed,
      commitError: serializeError(commitError),
      streamedDeltas: runtime.events.filter((event) => event.type === "delta")
        .length,
    },
  });
  console.log(
    JSON.stringify({ case: "c07", ok: report.ok, checks: checks.items }, null, 2),
  );
} finally {
  await runtime.close();
}

if (!checks.ok) {
  process.exitCode = 1;
}
