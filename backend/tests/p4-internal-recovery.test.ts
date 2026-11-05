import assert from "node:assert/strict";
import test from "node:test";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { AgentGraphRunner } from "../src/application/agent-graph.js";
import { rolePaths } from "../src/bootstrap/config.js";
import type { ConversationTool } from "../src/domain/conversation.js";
import { AutonomyStore } from "../src/storage/autonomy-store.js";
import { ConversationStore } from "../src/storage/conversation-store.js";
import { RoleStorage } from "../src/storage/role-storage.js";
import { createFixtureWithModel, ScriptedChatModel } from "./p2-05-fixture.js";

const dispatchedAt = "2026-11-05T03:00:00.000Z";
const restartedAt = "2026-11-06T04:00:00.000Z";

function setup() {
  const fixture = createFixtureWithModel(new ScriptedChatModel([]));
  const storage = RoleStorage.openExisting(rolePaths(fixture.app.config.dataRoot, fixture.roleId));
  const store = new ConversationStore(storage.business.db, fixture.roleId);
  const autonomy = new AutonomyStore(storage.business.db, fixture.roleId, "Asia/Shanghai");
  const execution = storage.business.createExecution({ roleId: fixture.roleId, windowId: fixture.windowId, triggerType: "autonomous", stateVersionLoaded: 1 });
  const task = storage.business.createTask({ roleId: fixture.roleId, goal: "恢复内部操作", origin: "autonomous", initiatorExecutionId: execution.executionId });
  storage.business.linkExecutionTask({ roleId: fixture.roleId, executionId: execution.executionId, taskId: task.taskId, relation: "initiates" });
  const saver = SqliteSaver.fromConnString(storage.paths.executionDatabasePath);
  return { fixture, storage, store, autonomy, execution, task, saver, async close() { saver.db.close(); storage.close(); await fixture.close(); } };
}

for (const mode of ["saved", "unfinished", "threw"] as const) {
  test(mode === "unfinished" ? "an interrupted internal operation remains unknown without repeating its effect or point" : mode === "threw" ? "an internal error after a side effect stays unknown and is not repeated" : "a saved internal result is reused without a second diary or point", async () => {
    const f = setup();
    let calls = 0;
    try {
      const tool: ConversationTool = {
        name: "diary_write", source: "memory", description: "保存日记", inputSchema: { type: "object" },
        async execute() {
          calls++;
          const diary = f.fixture.app.services.memory.createDiary(f.fixture.roleId, { content: "只能出现一次的日记" });
          if (mode === "threw") throw new Error("AFTER_DIARY_EFFECT");
          return { status: "success", adaptedResult: diary };
        },
      };
      const stepKey = `tool:${f.execution.executionId}:1:0:diary_write`;
      if (mode === "unfinished") {
        f.autonomy.consumePoint({ now: dispatchedAt });
        f.store.saveInternalToolReceipt({ executionId: f.execution.executionId, windowId: f.fixture.windowId, taskId: f.task.taskId, stepKey, toolName: tool.name, purpose: "autonomous", counted: true, now: dispatchedAt });
        await tool.execute({}, { roleId: f.fixture.roleId, windowId: f.fixture.windowId, executionId: f.execution.executionId, taskId: f.task.taskId, signal: new AbortController().signal });
      }
      const runner = new AgentGraphRunner({
        store: f.store, roleStore: f.storage.business,
        resolveModel: () => { throw new Error("MODEL_NOT_EXPECTED"); },
        tools: [tool], systemPrompt: () => "恢复测试", signal: new AbortController().signal,
        checkRunning: () => {}, emitDelta: () => {}, ensureTask: () => f.task.taskId,
        now: () => new Date(dispatchedAt), purpose: "autonomous",
        meter: {
          consume: () => f.autonomy.consumePoint({ now: dispatchedAt }).counted,
          reserveTool: () => { throw new Error("EXTERNAL_TOOL_NOT_EXPECTED"); },
        },
      }, f.saver);
      const state = {
        executionId: f.execution.executionId, roleId: f.fixture.roleId, windowId: f.fixture.windowId,
        round: 1, messages: [], text: "", pendingCalls: [{ wireCallId: "diary", name: tool.name, arguments: {} }],
        statePatch: {}, rounds: [], taskId: f.task.taskId, modelCallId: null, wireMapping: {},
      };
      if (mode === "threw") await assert.rejects(runner.toolsNode(state), /AFTER_DIARY_EFFECT/);
      const first = await runner.toolsNode(state);
      const second = await runner.toolsNode(state);
      assert.equal(calls, 1);
      assert.equal(f.fixture.app.services.memory.listDiaries(f.fixture.roleId).length, 1);
      assert.equal(first.rounds?.[0]?.toolCalls[0]?.result.status, mode === "saved" ? "success" : "unknown");
      assert.equal(second.rounds?.[0]?.toolCalls[0]?.result.status, mode === "saved" ? "success" : "unknown");
      assert.equal(f.autonomy.getBudget(dispatchedAt).usedPoints, 1);
      const meter = f.storage.business.db.prepare("SELECT counted,created_at FROM call_metering WHERE call_id=?").all(stepKey) as Array<{ counted: number; created_at: string }>;
      assert.equal(meter.length, 1);
      assert.equal(meter[0]?.counted, 1);
      assert.equal(new Date(meter[0]!.created_at).toISOString(), dispatchedAt);
    } finally { await f.close(); }
  });
}

for (const backfill of [false, true]) {
  test(backfill ? "startup metering backfill keeps the original tool dispatch date" : "late tool results keep their original dispatch date", async () => {
    const f = setup();
    try {
      const call = f.storage.business.beginToolCall({ roleId: f.fixture.roleId, taskId: f.task.taskId, executionId: f.execution.executionId, stepKey: "crossday:1", toolName: "read", args: {} }).toolCall;
      f.autonomy.reserveToolPoint({ toolCallId: call.toolCallId, now: dispatchedAt });
      f.autonomy.commitToolReservation({ toolCallId: call.toolCallId, now: dispatchedAt });
      f.autonomy.getBudget(restartedAt);
      if (backfill) {
        f.autonomy.reconcileToolReservations(restartedAt);
        f.autonomy.reconcileToolReservations(restartedAt);
      } else {
        f.store.recordToolMetering({ executionId: f.execution.executionId, taskId: f.task.taskId, toolCallId: call.toolCallId, purpose: "autonomous", counted: true, now: restartedAt });
      }
      const rows = f.storage.business.db.prepare("SELECT created_at,counted FROM call_metering WHERE call_id=?").all(call.toolCallId) as Array<{ created_at: string; counted: number }>;
      assert.equal(rows.length, 1);
      assert.equal(new Date(rows[0]!.created_at).toISOString(), dispatchedAt);
      assert.equal(rows[0]!.counted, 1);
      assert.equal(f.autonomy.getBudget(restartedAt).usedPoints, 0);
    } finally { await f.close(); }
  });
}

test("resuming an interrupted model preserves its partial reply and starts a fresh output segment", async () => {
  const f = setup();
  try {
    const binding = f.fixture.app.services.resources.listBindings(f.fixture.roleId).find((b) => b.capability === "chat_model")!;
    f.store.startModelCall({ executionId: f.execution.executionId, resourceId: binding.resourceId, modelName: binding.modelName!, protocol: "openai-chat", now: dispatchedAt });
    f.store.appendMessageDelta({ executionId: f.execution.executionId, windowId: f.fixture.windowId, text: "旧的未完成片段", now: dispatchedAt });
    assert.equal(f.store.failRunningModelCalls(f.execution.executionId, dispatchedAt), 1);
    assert.equal(f.store.partialText(f.execution.executionId), "");
    f.store.appendMessageDelta({ executionId: f.execution.executionId, windowId: f.fixture.windowId, text: "新的完整回复", now: dispatchedAt });
    assert.equal(f.store.partialText(f.execution.executionId), "新的完整回复");
    f.store.commitConversation({ executionId: f.execution.executionId, content: "新的完整回复", statePatch: {}, countsAsConversationRound: false, now: dispatchedAt });
    const messages = f.storage.business.db.prepare("SELECT content,status FROM messages WHERE execution_id=? ORDER BY sequence").all(f.execution.executionId);
    assert.deepEqual(messages, [
      { content: "旧的未完成片段", status: "interrupted" },
      { content: "新的完整回复", status: "completed" },
    ]);
    assert.equal(f.store.failRunningModelCalls(f.execution.executionId, dispatchedAt), 0);
  } finally { await f.close(); }
});
