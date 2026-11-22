import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createBackendApp, type BackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import { ConversationStore } from "../src/storage/conversation-store.js";
import {
  ScriptedChatModel,
  createFixtureWithModel,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

function interruptedUserTask(fixture: Fixture) {
  return withStorage(fixture, (storage) => {
    const input = storage.business.submitMessage(fixture.roleId, fixture.windowId, {
      content: "请保存资料，完成后告诉我结果",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    const store = new ConversationStore(storage.business.db, fixture.roleId);
    const begun = store.beginExecution({ windowId: fixture.windowId });
    assert.ok(begun);
    const task = storage.business.createTask({
      roleId: fixture.roleId,
      goal: input.message.content,
      origin: "user",
      initiatorExecutionId: begun.execution.executionId,
    });
    storage.business.linkExecutionTask({
      roleId: fixture.roleId,
      executionId: begun.execution.executionId,
      taskId: task.taskId,
      relation: "initiates",
    });
    const call = storage.business.beginToolCall({
      roleId: fixture.roleId,
      taskId: task.taskId,
      executionId: begun.execution.executionId,
      stepKey: "user-work:1",
      toolName: "workspace_write",
      args: { path: "note.md", content: "实际结果尚待核查" },
    });
    storage.business.markToolCallRunning(fixture.roleId, call.toolCall.toolCallId);
    return {
      taskId: task.taskId,
      executionId: begun.execution.executionId,
      messageId: input.message.messageId,
      toolCallId: call.toolCall.toolCallId,
    };
  });
}

function reopen(fixture: Fixture, model: ScriptedChatModel): BackendApp {
  return createBackendApp(
    parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
    { modelPortFactory: () => model, disableMemoryRuntime: true },
  );
}

test("restart joins an interrupted user request to its original task and processes it once", async () => {
  const fixture = createFixtureWithModel(new ScriptedChatModel([]));
  let restored: BackendApp | undefined;
  try {
    const original = interruptedUserTask(fixture);
    await fixture.app.close();
    const model = new ScriptedChatModel([[
      { type: "text_delta", text: "操作结果未知，保留原记录等待核查。" },
      { type: "completed", stopReason: "stop" },
    ]]);
    restored = reopen(fixture, model);
    await restored.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 1);
    const unknown = model.requests[0]!.messages.find(
      (message) => message.role === "tool" && message.toolCallId === original.toolCallId,
    );
    assert.ok(unknown);
    assert.match(unknown.content, /"status":"unknown"/);
    const tasks = restored.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.taskId, original.taskId);
    assert.equal(tasks[0]!.status, "completed");
    const result = withStorage(fixture, (storage) => ({
      executions: storage.business.db.prepare(
        "SELECT e.execution_id, e.status, et.task_id, et.relation FROM executions e JOIN execution_tasks et ON et.execution_id=e.execution_id ORDER BY e.rowid",
      ).all() as Array<{ execution_id: string; status: string; task_id: string; relation: string }>,
      message: storage.business.db.prepare(
        "SELECT processed_by_execution_id, claimed_by_execution_id FROM messages WHERE message_id=?",
      ).get(original.messageId) as { processed_by_execution_id: string | null; claimed_by_execution_id: string | null },
      callCount: (storage.business.db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get() as { n: number }).n,
    }));
    assert.equal(result.executions.length, 2);
    assert.deepEqual(result.executions.map((e) => [e.task_id, e.status, e.relation]), [
      [original.taskId, "failed", "initiates"],
      [original.taskId, "completed", "continues"],
    ]);
    assert.equal(result.message.processed_by_execution_id, result.executions[1]!.execution_id);
    assert.equal(result.message.claimed_by_execution_id, null);
    assert.equal(result.callCount, 1);
    assert.equal(restored.services.autonomy.getStatus(fixture.roleId).budget.usedPoints, 0);
    await restored.close();
    const quiet = new ScriptedChatModel([]);
    restored = reopen(fixture, quiet);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(quiet.requests.length, 0);
  } finally {
    await restored?.close();
    await fixture.close();
  }
});

test("restart records an ended user task's unknown result without reviving its reply", async () => {
  const fixture = createFixtureWithModel(new ScriptedChatModel([]));
  let restored: BackendApp | undefined;
  try {
    const original = interruptedUserTask(fixture);
    fixture.app.conversation.finishTask({ roleId: fixture.roleId, taskId: original.taskId, status: "completed", endReason: "用户明确结束" });
    await fixture.app.close();
    const model = new ScriptedChatModel([]);
    restored = reopen(fixture, model);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(model.requests.length, 0);
    assert.equal(restored.conversation.getTask(fixture.roleId, original.taskId).status, "completed");
    const result = withStorage(fixture, (s) => s.business.getToolResult(fixture.roleId, original.toolCallId));
    assert.equal(result.status, "unknown");
    assert.equal(result.diagnosticCode, "PROCESS_INTERRUPTED");
  } finally {
    await restored?.close();
    await fixture.close();
  }
});
