import assert from "node:assert/strict";
import { serializeError } from "../domain/errors.js";
import type { RunEvent } from "../domain/runtime.js";
import {
  CheckList,
  createGraphFor,
  createRuntime,
  readEffectCounts,
  readWorkspaceFile,
  seedRoleAndInput,
  writeCaseReport,
} from "./harness.js";

const checks = new CheckList();
const runtime = await createRuntime({
  caseName: "c04",
  scriptName: "c04Old",
});

try {
  const seed = seedRoleAndInput(runtime.store);
  const windowId = "main";
  let oldStreamedText = "";
  let firstChunkSeen = false;
  let resolveFirstChunk: (() => void) | null = null;
  const firstChunk = new Promise<void>((resolve) => {
    resolveFirstChunk = resolve;
  });
  const lateChunks: string[] = [];

  const oldEmit = (event: RunEvent): void => {
    if (event.type === "delta") {
      const text = String(event.text ?? "");
      const execution = runtime.store.getExecution(seed.executionId);
      if (execution.status === "superseded") {
        lateChunks.push(text);
        runtime.store.recordLateOutput(seed.executionId, text);
        runtime.emit({ ...event, type: "late_delta" });
      } else {
        oldStreamedText += text;
        runtime.emit(event);
      }
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        resolveFirstChunk?.();
      }
      return;
    }
    runtime.emit(event);
  };

  const oldGraph = createGraphFor(runtime, "c04Old", oldEmit);
  let oldError: unknown = null;
  const oldDone = oldGraph
    .invoke(
      { executionId: seed.executionId },
      { configurable: { thread_id: seed.executionId } },
    )
    .then(
      () => null,
      (error) => {
        oldError = error;
        return error;
      },
    );

  await checks.check("old reply streams a prefix and blocks", async () => {
    await Promise.race([
      firstChunk,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("TIMEOUT_WAITING_FOR_FIRST_CHUNK")),
          15000,
        );
        timer.unref();
      }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oldStreamedText, "旧回复第一段。");
    assert.equal(runtime.barrier.waitingKeys.includes("c04-old-model"), true);
    return {
      oldStreamedText,
      waitingKeys: runtime.barrier.waitingKeys,
    };
  });

  const newUserMessageId = runtime.store.insertUserMessage({
    roleId: seed.role.id,
    windowId,
    content: "新消息：先回应这个。",
  }).id;
  const newExecution = runtime.store.createExecution({
    roleId: seed.role.id,
    windowId,
    triggerMessageId: newUserMessageId,
  });
  const superseded = runtime.store.markExecutionSuperseded(
    seed.executionId,
    oldStreamedText,
  );

  let newFinalText = "";
  await checks.check("new message runs a new decision to completion", async () => {
    const newGraph = createGraphFor(runtime, "c04New", runtime.emit);
    const result = (await newGraph.invoke(
      { executionId: newExecution.id },
      { configurable: { thread_id: newExecution.id } },
    )) as { finalText?: string };
    newFinalText = result.finalText ?? "";
    assert.equal(newFinalText, "新回复：已收到新消息。");
    return { newExecutionId: newExecution.id, newFinalText };
  });

  runtime.barrier.release("c04-old-model");
  await Promise.race([
    oldDone,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("TIMEOUT_WAITING_FOR_OLD_EXECUTION")),
        15000,
      );
      timer.unref();
    }),
  ]);

  await checks.check("old commit is rejected as superseded", () => {
    assert.ok(oldError, "old execution must fail after being superseded");
    assert.match(String(oldError), /EXECUTION_NOT_RUNNING|superseded/);
    const commitFailed = runtime.events.find(
      (event) =>
        event.type === "commit_failed" &&
        event.executionId === seed.executionId,
    );
    assert.ok(commitFailed);
    return {
      oldError: serializeError(oldError),
      commitFailed,
      lateChunks,
    };
  });

  const snapshot = runtime.store.snapshot();
  const executions = snapshot.executions as Array<{
    id: string;
    status: string;
  }>;
  const messages = snapshot.messages as Array<{
    sender: string;
    content: string;
    status: string;
    execution_id: string | null;
  }>;
  const roles = snapshot.roles as Array<{
    state: Record<string, unknown>;
    state_version: number;
  }>;
  const tasks = snapshot.tasks as Array<{ execution_id: string; status: string }>;
  const toolCalls = snapshot.toolCalls as Array<{
    execution_id: string;
    status: string;
  }>;
  const toolResults = snapshot.toolResults as Array<{ status: string }>;
  const lateOutputs = snapshot.lateOutputs as Array<{
    execution_id: string;
    text: string;
  }>;
  const decisions = snapshot.decisions as Array<{
    execution_id: string;
    turn: number;
    decision_json: string;
  }>;

  await checks.check("partial reply is kept with an interrupted marker", () => {
    assert.ok(superseded.messageId);
    assert.equal(executions.length, 2);
    const oldExecution = executions.find(
      (execution) => execution.id === seed.executionId,
    );
    const newExecutionRow = executions.find(
      (execution) => execution.id === newExecution.id,
    );
    assert.equal(oldExecution?.status, "superseded");
    assert.equal(newExecutionRow?.status, "completed");

    const partial = messages.find(
      (message) => message.execution_id === seed.executionId && message.sender === "assistant",
    );
    assert.equal(partial?.status, "interrupted");
    assert.equal(partial?.content, "旧回复第一段。");

    const completed = messages.find(
      (message) =>
        message.execution_id === newExecution.id &&
        message.sender === "assistant",
    );
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.content, "新回复：已收到新消息。");
    return {
      partial: partial?.content,
      partialStatus: partial?.status,
      completed: completed?.content,
    };
  });

  await checks.check("late output cannot overwrite the new reply or state", () => {
    assert.deepEqual(lateChunks, ["旧回复第二段。"]);
    assert.equal(lateOutputs.length, 1);
    assert.equal(lateOutputs[0]?.execution_id, seed.executionId);
    assert.equal(lateOutputs[0]?.text, "旧回复第二段。");
    const lateTextPersistedAsMessage = messages.some(
      (message) =>
        message.execution_id === seed.executionId &&
        message.content.includes("旧回复第二段。"),
    );
    assert.equal(lateTextPersistedAsMessage, false);
    assert.ok(roles[0]);
    assert.equal(roles[0].state.lastReply, "new");
    assert.equal(roles[0].state_version, 2);
    return {
      lateOutputs,
      lastReply: roles[0].state.lastReply,
      stateVersion: roles[0].state_version,
    };
  });

  await checks.check("already executed tool is not repeated on switch", () => {
    assert.equal(readEffectCounts(runtime.paths.workspace).append_note, 1);
    assert.equal(
      readWorkspaceFile(runtime.paths.workspace, "old-note.md"),
      "P0-C04-old-tool\n",
    );
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.execution_id, seed.executionId);
    assert.equal(toolCalls[0]?.status, "success");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0]?.status, "success");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.execution_id, seed.executionId);
    assert.equal(tasks[0]?.status, "paused");
    return {
      effectCounts: readEffectCounts(runtime.paths.workspace),
      toolCalls: toolCalls.length,
      taskStatus: tasks[0]?.status,
    };
  });

  await checks.check("decisions of both executions remain separate", () => {
    const oldDecisions = decisions.filter(
      (decision) => decision.execution_id === seed.executionId,
    );
    const newDecisions = decisions.filter(
      (decision) => decision.execution_id === newExecution.id,
    );
    assert.equal(oldDecisions.length, 2);
    assert.equal(newDecisions.length, 1);
    const oldFinal = JSON.parse(oldDecisions[1]?.decision_json ?? "{}") as {
      type?: string;
      text?: string;
    };
    assert.equal(oldFinal.type, "final");
    assert.equal(oldFinal.text, "旧回复第一段。旧回复第二段。");
    return {
      oldDecisions: oldDecisions.length,
      newDecisions: newDecisions.length,
      oldFinalText: oldFinal.text,
    };
  });

  const report = writeCaseReport({
    caseName: "c04",
    checks,
    runtime,
    extra: {
      seed,
      newExecution,
      superseded,
      newFinalText,
      oldError: serializeError(oldError),
      lateChunks,
    },
  });
  console.log(
    JSON.stringify({ case: "c04", ok: report.ok, checks: checks.items }, null, 2),
  );
} finally {
  await runtime.close();
}

if (!checks.ok) {
  process.exitCode = 1;
}
