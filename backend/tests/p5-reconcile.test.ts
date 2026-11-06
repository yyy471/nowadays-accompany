import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createFixtureWithModel, withStorage, type Fixture } from "./p2-05-fixture.js";
import type {
  ModelEvent,
  ModelPort,
  ModelRequest,
} from "../src/domain/model.js";

/** 按 useScriptedChatModel 语义逐轮消费脚本的队列模型（dispatcher 可复用同一模型）。 */
class QueueModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly queue: Array<
      ModelEvent[] | ((request: ModelRequest) => ModelEvent[])
    >,
  ) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error("SCRIPT_EXHAUSTED");
    }
    const events = typeof next === "function" ? next(request) : next;
    for (const event of events) {
      yield event;
    }
  }
}

function queueFixture(): {
  fixture: Fixture;
  queue: Array<ModelEvent[] | ((request: ModelRequest) => ModelEvent[])>;
  model: QueueModel;
} {
  const queue: Array<
    ModelEvent[] | ((request: ModelRequest) => ModelEvent[])
  > = [];
  const model = new QueueModel(queue);
  return { fixture: createFixtureWithModel(model), queue, model };
}

interface ReconcileCall {
  toolCallId: string;
  status: "success" | "failed";
  observation: string;
}

function reconcileRound(
  call: ReconcileCall,
): (request: ModelRequest) => ModelEvent[] {
  return (request) => {
    const tool = request.tools.find(
      (candidate) => candidate.name === "tool_reconcile",
    );
    assert.ok(tool, "tool_reconcile 应在工具目录中");
    return [
      {
        type: "tool_call",
        callId: `wire-reconcile-${randomUUID()}`,
        name: tool.name,
        arguments: {
          toolCallId: call.toolCallId,
          status: call.status,
          observation: call.observation,
        },
      },
      { type: "completed", stopReason: "tool_calls" },
    ];
  };
}

const finalRound: ModelEvent[] = [
  { type: "text_delta", text: "核查完成。" },
  { type: "completed", stopReason: "stop" },
];

function reconcileToolMessages(model: QueueModel): Array<{
  content: string;
}> {
  const messages: Array<{ content: string }> = [];
  for (const request of model.requests) {
    for (const message of request.messages) {
      if (message.role === "tool" && message.toolName === "tool_reconcile") {
        messages.push({ content: String(message.content) });
      }
    }
  }
  return messages;
}

function seedUnknownCall(
  fixture: Fixture,
  input: { toolName: string; args: Record<string, unknown> },
): { toolCallId: string } {
  return withStorage(fixture, (storage) => {
    const execution = storage.business.createExecution({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      triggerType: "user_message",
    });
    const task = storage.business.createTask({
      roleId: fixture.roleId,
      goal: "核查用种子任务",
      origin: "user",
      initiatorExecutionId: execution.executionId,
    });
    storage.business.linkExecutionTask({
      roleId: fixture.roleId,
      executionId: execution.executionId,
      taskId: task.taskId,
      relation: "initiates",
    });
    const begun = storage.business.beginToolCall({
      roleId: fixture.roleId,
      taskId: task.taskId,
      executionId: execution.executionId,
      stepKey: `seed:${randomUUID()}`,
      toolName: input.toolName,
      args: input.args,
    });
    storage.business.markToolCallRunning(
      fixture.roleId,
      begun.toolCall.toolCallId,
    );
    storage.business.saveToolResult({
      roleId: fixture.roleId,
      toolCallId: begun.toolCall.toolCallId,
      status: "unknown",
      adaptedResult: {
        error: {
          code: "PROCESS_INTERRUPTED",
          message: "进程中断，无法确认该调用是否已经执行及其结果",
        },
      },
      diagnosticCode: "PROCESS_INTERRUPTED",
      error: {
        code: "PROCESS_INTERRUPTED",
        message: "进程中断，无法确认该调用是否已经执行及其结果",
      },
    });
    // 种子执行保持终态，避免阻塞后续真实提交。
    storage.business.db
      .prepare(
        "UPDATE executions SET status = 'completed', state_version_committed = 1 WHERE execution_id = ?",
      )
      .run(execution.executionId);
    return { toolCallId: begun.toolCall.toolCallId };
  });
}

function readResult(fixture: Fixture, toolCallId: string) {
  return withStorage(fixture, (storage) => {
    const result = storage.business.getToolResult(fixture.roleId, toolCallId);
    const call = storage.business.getToolCall(fixture.roleId, toolCallId);
    return { result, call };
  });
}

test("tool_reconcile records the verified outcome under the original call keeping unknown history", { timeout: 30_000 }, async () => {
  const { fixture, queue, model } = queueFixture();
  try {
    const seeded = seedUnknownCall(fixture, {
      toolName: "workspace_write",
      args: { path: "out.txt", content: "断线前写入" },
    });
    const before = readResult(fixture, seeded.toolCallId);
    assert.equal(before.result.status, "unknown");
    assert.equal(before.result.reconciledAt, null);

    queue.push(
      reconcileRound({
        toolCallId: seeded.toolCallId,
        status: "success",
        observation: "重启后确认文件已存在于工作空间",
      }),
      finalRound,
    );
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "核查一下之前那次写入",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const after = readResult(fixture, seeded.toolCallId);
    assert.equal(after.result.status, "success");
    assert.equal(after.result.previousStatus, "unknown");
    assert.ok(after.result.reconciledAt !== null);
    assert.equal(after.call.status, "success");
    const adapted = after.result.adaptedResult as { observation?: string };
    assert.equal(adapted.observation, "重启后确认文件已存在于工作空间");
    const messages = reconcileToolMessages(
      model,
    );
    assert.match(messages[0]?.content ?? "", /"reconciled":true/);
  } finally {
    await fixture.close();
  }
});

test("a repeated reconcile with the same status is reported as duplicate without changes", { timeout: 30_000 }, async () => {
  const { fixture, queue, model } = queueFixture();
  try {
    const seeded = seedUnknownCall(fixture, {
      toolName: "workspace_write",
      args: { path: "dup.txt", content: "x" },
    });
    queue.push(
      reconcileRound({
        toolCallId: seeded.toolCallId,
        status: "success",
        observation: "第一次核查结论",
      }),
      reconcileRound({
        toolCallId: seeded.toolCallId,
        status: "success",
        observation: "第二次重复核查",
      }),
      finalRound,
    );
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "重复核查",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const messages = reconcileToolMessages(
      model,
    );
    assert.match(messages[0]?.content ?? "", /"reconciled":true/);
    assert.ok(messages.length >= 2, "第二次补录应产生工具消息");
    assert.match(messages.at(-1)?.content ?? "", /"reconciled":false/);
    const after = readResult(fixture, seeded.toolCallId);
    assert.equal(after.result.status, "success");
    const adapted = after.result.adaptedResult as { observation?: string };
    assert.equal(adapted.observation, "第一次核查结论");
  } finally {
    await fixture.close();
  }
});

test("a conflicting reconcile against a settled call fails and keeps the first record", { timeout: 30_000 }, async () => {
  const { fixture, queue, model } = queueFixture();
  try {
    const seeded = seedUnknownCall(fixture, {
      toolName: "workspace_write",
      args: { path: "conflict.txt", content: "x" },
    });
    withStorage(fixture, (storage) => {
      storage.business.saveToolResult({
        roleId: fixture.roleId,
        toolCallId: seeded.toolCallId,
        status: "failed",
        adaptedResult: { error: { code: "WRITE_FAILED" } },
        diagnosticCode: "WRITE_FAILED",
      });
    });
    queue.push(
      reconcileRound({
        toolCallId: seeded.toolCallId,
        status: "success",
        observation: "与既有失败结论冲突",
      }),
      finalRound,
    );
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "给出冲突结论",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const after = readResult(fixture, seeded.toolCallId);
    // 预保存的 failed 结论（unknown→failed）本身已是一次调和，
    // 记录保持失败状态与第一次核查的观察，冲突补录被 409 拒绝。
    assert.equal(after.result.status, "failed");
    assert.equal(after.result.previousStatus, "unknown");
    const adapted = after.result.adaptedResult as { error?: { code?: string } };
    assert.equal(adapted.error?.code, "WRITE_FAILED");
    const messages = reconcileToolMessages(
      model,
    );
    assert.match(messages.at(-1)?.content ?? "", /TOOL_RESULT_CONFLICT/);
  } finally {
    await fixture.close();
  }
});

function seedRunningCall(
  fixture: Fixture,
  input: { toolName: string; args: Record<string, unknown> },
): { toolCallId: string; taskId: string } {
  return withStorage(fixture, (storage) => {
    const execution = storage.business.createExecution({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      triggerType: "user_message",
    });
    const task = storage.business.createTask({
      roleId: fixture.roleId,
      goal: "在途调用种子任务",
      origin: "user",
      initiatorExecutionId: execution.executionId,
    });
    storage.business.linkExecutionTask({
      roleId: fixture.roleId,
      executionId: execution.executionId,
      taskId: task.taskId,
      relation: "initiates",
    });
    const begun = storage.business.beginToolCall({
      roleId: fixture.roleId,
      taskId: task.taskId,
      executionId: execution.executionId,
      stepKey: `seed-running:${randomUUID()}`,
      toolName: input.toolName,
      args: input.args,
    });
    storage.business.markToolCallRunning(
      fixture.roleId,
      begun.toolCall.toolCallId,
    );
    storage.business.db
      .prepare(
        "UPDATE executions SET status = 'superseded' WHERE execution_id = ?",
      )
      .run(execution.executionId);
    return { toolCallId: begun.toolCall.toolCallId, taskId: task.taskId };
  });
}

test("tool_reconcile cannot settle a pending or running call before it becomes unknown", { timeout: 30_000 }, async () => {
  const { fixture, queue, model } = queueFixture();
  try {
    const seeded = seedRunningCall(fixture, {
      toolName: "mcp_pending_effect",
      args: { action: "write" },
    });
    // 直接保存层：待派发与在途调用都必须拒绝补录。
    withStorage(fixture, (storage) => {
      const reconcile = () =>
        storage.business.saveToolResult({
          roleId: fixture.roleId,
          toolCallId: seeded.toolCallId,
          status: "success",
          adaptedResult: { observation: "仅凭模型陈述" },
          requireReconciledFromUnknown: true,
        });
      assert.throws(
        reconcile,
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "TOOL_CALL_STATUS_CONFLICT",
      );
      const pending = storage.business.beginToolCall({
        roleId: fixture.roleId,
        taskId: seeded.taskId,
        executionId: storage.business.getToolCall(
          fixture.roleId,
          seeded.toolCallId,
        ).executionId,
        stepKey: `pending:${randomUUID()}`,
        toolName: "mcp_pending_effect",
        args: {},
      });
      assert.throws(
        () =>
          storage.business.saveToolResult({
            roleId: fixture.roleId,
            toolCallId: pending.toolCall.toolCallId,
            status: "success",
            adaptedResult: { observation: "尚未派发" },
            requireReconciledFromUnknown: true,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "TOOL_CALL_STATUS_CONFLICT",
      );
    });

    queue.push(
      reconcileRound({
        toolCallId: seeded.toolCallId,
        status: "success",
        observation: "在途时直接定案",
      }),
      finalRound,
    );
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "核对在途操作",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const afterAttempt = withStorage(fixture, (storage) => {
      const call = storage.business.getToolCall(
        fixture.roleId,
        seeded.toolCallId,
      );
      const results = storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM tool_results WHERE tool_call_id = ?")
        .get(seeded.toolCallId) as { count: number };
      return { call, count: results.count };
    });
    assert.equal(afterAttempt.call.status, "running");
    assert.equal(afterAttempt.count, 0, "在途调用不应被提前写入结果");
    const messages = reconcileToolMessages(model);
    assert.match(messages.at(-1)?.content ?? "", /TOOL_CALL_STATUS_CONFLICT/);

    // 晚到的真实结果仍可正常保存，不受补录入口影响。
    withStorage(fixture, (storage) => {
      const saved = storage.business.saveToolResult({
        roleId: fixture.roleId,
        toolCallId: seeded.toolCallId,
        status: "failed",
        adaptedResult: { error: { code: "ACTUAL_WRITE_FAILED" } },
        diagnosticCode: "ACTUAL_WRITE_FAILED",
      });
      assert.equal(saved.result.status, "failed");
      assert.equal(saved.result.previousStatus, null);
    });
  } finally {
    await fixture.close();
  }
});

test("reconciling an unknown toolCallId fails with not found and the evidence stays untouched", { timeout: 30_000 }, async () => {
  const { fixture, queue, model } = queueFixture();
  try {
    queue.push(
      reconcileRound({
        toolCallId: randomUUID(),
        status: "success",
        observation: "不属于本角色的调用",
      }),
      finalRound,
    );
    fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
      content: "补录一个不存在的调用",
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const messages = reconcileToolMessages(
      model,
    );
    assert.match(messages.at(-1)?.content ?? "", /TOOL_CALL_NOT_FOUND/);
  } finally {
    await fixture.close();
  }
});
