import assert from "node:assert/strict";
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
  caseName: "c01",
  scriptName: "c01",
});

try {
  const seed = seedRoleAndInput(runtime.store);
  let finalText = "";
  await checks.check("execution completes with a final reply", async () => {
    const result = (await runtime.graph.invoke(
      { executionId: seed.executionId },
      { configurable: { thread_id: seed.executionId } },
    )) as { finalText?: string };
    finalText = result.finalText ?? "";
    assert.equal(finalText, "工具状态=success。");
    return { finalText };
  });

  const snapshot = runtime.store.snapshot();
  const roles = snapshot.roles as Array<{
    state: Record<string, unknown>;
    state_version: number;
  }>;
  const executions = snapshot.executions as Array<{
    id: string;
    status: string;
    updated_at: string;
  }>;
  const messages = snapshot.messages as Array<{
    sender: string;
    content: string;
    status: string;
  }>;
  const tasks = snapshot.tasks as Array<{ status: string }>;
  const toolCalls = snapshot.toolCalls as Array<{
    id: string;
    status: string;
    execution_id: string;
  }>;
  const toolResults = snapshot.toolResults as Array<{
    tool_call_id: string;
    status: string;
    saved_at: string;
  }>;
  const decisions = snapshot.decisions as Array<unknown>;

  await checks.check("tool effect and call count are exactly one", () => {
    const counts = readEffectCounts(runtime.paths.workspace);
    assert.equal(counts.append_note, 1);
    assert.equal(readWorkspaceFile(runtime.paths.workspace, "note.md"), "P0-C01\n");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolResults.length, 1);
    return { counts, toolCalls: toolCalls.length };
  });

  await checks.check("business records are linked and committed", () => {
    assert.ok(roles[0]);
    assert.equal(roles[0].state.lastToolStatus, "success");
    assert.equal(roles[0].state.lastReply, "c01");
    assert.equal(roles[0].state_version, 2);

    assert.ok(executions[0]);
    assert.equal(executions[0].id, seed.executionId);
    assert.equal(executions[0].status, "completed");

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "completed");
    assert.equal(toolCalls[0]?.status, "success");
    assert.equal(toolResults[0]?.status, "success");
    assert.equal(decisions.length, 2);

    const userMessage = messages.find((message) => message.sender === "user");
    const assistantMessage = messages.find(
      (message) => message.sender === "assistant",
    );
    assert.equal(userMessage?.status, "received");
    assert.equal(assistantMessage?.status, "completed");
    assert.equal(assistantMessage?.content, "工具状态=success。");

    assert.ok(toolResults[0]);
    assert.ok(executions[0]);
    assert.ok(toolResults[0].saved_at <= executions[0].updated_at);
    return {
      stateVersion: roles[0].state_version,
      executionStatus: executions[0].status,
      assistantStatus: assistantMessage?.status,
    };
  });

  const report = writeCaseReport({
    caseName: "c01",
    checks,
    runtime,
    extra: { finalText, seed },
  });
  console.log(JSON.stringify({ case: "c01", ok: report.ok, checks: checks.items }, null, 2));
} finally {
  await runtime.close();
}

if (!checks.ok) {
  process.exitCode = 1;
}
