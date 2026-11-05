import assert from "node:assert/strict";
import test from "node:test";
import { createBackendApp, type BackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import { AutonomyStore } from "../src/storage/autonomy-store.js";
import { ConversationStore } from "../src/storage/conversation-store.js";
import { createFixtureWithModel, ScriptedChatModel, withStorage, type Fixture } from "./p2-05-fixture.js";

const dispatchedAt = "2026-11-05T03:00:00.000Z";
const restartedAt = "2026-11-06T04:00:00.000Z";

function seed(f: Fixture, origin: "user" | "autonomous" = "autonomous", unlimited = false, paused = false) {
  return withStorage(f, (s) => {
    const store = new ConversationStore(s.business.db, f.roleId);
    const auto = new AutonomyStore(s.business.db, f.roleId, "Asia/Shanghai");
    auto.setBudget({ dailyLimit: 200, unlimited, now: dispatchedAt });
    const execution = s.business.createExecution({ roleId: f.roleId, windowId: f.windowId, triggerType: origin === "user" ? "user_message" : "autonomous" });
    const task = s.business.createTask({ roleId: f.roleId, goal: "只补实际记录，不重做日记", origin, initiatorExecutionId: execution.executionId });
    s.business.linkExecutionTask({ roleId: f.roleId, executionId: execution.executionId, taskId: task.taskId, relation: "initiates" });
    const counted = origin === "autonomous" ? auto.consumePoint({ now: dispatchedAt }).counted : false;
    const stepKey = `tool:${execution.executionId}:1:0:diary_write`;
    store.saveInternalToolReceipt({ executionId: execution.executionId, windowId: f.windowId, taskId: task.taskId, stepKey, toolName: "diary_write", purpose: origin === "autonomous" ? "autonomous" : "user_chat", counted, now: dispatchedAt });
    f.app.services.memory.createDiary(f.roleId, { content: "重启前确已保存，不能重写的日记" });
    s.business.db.prepare("UPDATE executions SET status=? WHERE execution_id=?").run(paused ? "paused" : "failed", execution.executionId);
    if (paused) s.business.pauseTask({ roleId: f.roleId, taskId: task.taskId, endReason: "AUTONOMY_BUDGET_EXHAUSTED" });
    else s.business.finishTask({ roleId: f.roleId, taskId: task.taskId, status: "failed", endReason: "P4_RECEIPT_WRITE_FAULT" });
    return { executionId: execution.executionId, taskId: task.taskId, stepKey };
  });
}

test("startup settles a terminal legacy internal intent once without reviving it or charging the new day", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  let app: BackendApp | undefined;
  try {
    const original = seed(f);
    // 兼容既有业务事件：旧凭据没有新增的 purpose／taskId 字段。
    withStorage(f, (s) => s.business.db.exec("UPDATE execution_stream_events SET payload_json=json_remove(payload_json,'$.purpose','$.taskId') WHERE event_type='tool_started'"));
    await f.app.close();
    for (let pass = 0; pass < 2; pass++) {
      const model = new ScriptedChatModel([]);
      app = createBackendApp(parseBackendConfig(["--app-root", f.root, "--port", "0"]), { now: () => new Date(restartedAt), timeZone: "Asia/Shanghai", disableMemoryRuntime: true, modelPortFactory: () => model });
      assert.equal(model.requests.length, 0);
      assert.equal(app.conversation.getTask(f.roleId, original.taskId).status, "failed");
      assert.equal(app.services.memory.listDiaries(f.roleId).length, 1);
      assert.equal(app.services.autonomy.getStatus(f.roleId).budget.usedPoints, 0);
      withStorage(f, (s) => {
        const store = new ConversationStore(s.business.db, f.roleId);
        assert.equal(store.getInternalToolReceipt(original.executionId, original.stepKey)?.outcome?.status, "unknown");
        assert.equal(store.listTaskInternalToolFacts(original.taskId).length, 1);
        const rows = s.business.db.prepare("SELECT counted,created_at FROM call_metering WHERE call_id=?").all(original.stepKey) as Array<{ counted: number; created_at: string }>;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.counted, 1);
        assert.equal(new Date(rows[0]!.created_at).toISOString(), dispatchedAt);
        assert.equal((s.business.db.prepare("SELECT COUNT(*) AS n FROM execution_stream_events WHERE event_type='tool_result_saved' AND json_extract(payload_json,'$.internalStepKey')=?").get(original.stepKey) as { n: number }).n, 1);
      });
      await app.close(); app = undefined;
    }
  } finally { await app?.close(); await f.close(); }
});

for (const origin of ["user", "autonomous"] as const) {
  test(origin === "user" ? "internal startup reconciliation preserves user-task budget exemption" : "internal startup reconciliation preserves unlimited autonomous metering", async () => {
    const f = createFixtureWithModel(new ScriptedChatModel([]));
    try {
      const original = seed(f, origin, true);
      withStorage(f, (s) => {
        const store = new ConversationStore(s.business.db, f.roleId);
        assert.equal(store.reconcileInterruptedInternalTools(dispatchedAt), 1);
        assert.equal(store.reconcileInterruptedInternalTools(dispatchedAt), 0);
        const rows = s.business.db.prepare("SELECT counted FROM call_metering WHERE call_id=?").all(original.stepKey) as Array<{ counted: number }>;
        assert.equal(rows.length, origin === "user" ? 0 : 1);
        if (origin === "autonomous") assert.equal(rows[0]!.counted, 0);
        assert.equal(new AutonomyStore(s.business.db, f.roleId, "Asia/Shanghai").getBudget(dispatchedAt).usedPoints, 0);
      });
    } finally { await f.close(); }
  });
}

test("internal startup reconciliation rolls back on metering failure and can retry without duplicate facts", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const original = seed(f);
    withStorage(f, (s) => {
      const store = new ConversationStore(s.business.db, f.roleId);
      s.business.db.exec("CREATE TRIGGER p4_retry_fault BEFORE INSERT ON call_metering WHEN NEW.call_kind='tool' BEGIN SELECT RAISE(ABORT,'P4_RETRY_FAULT'); END");
      assert.throws(() => store.reconcileInterruptedInternalTools(dispatchedAt), /P4_RETRY_FAULT/);
      assert.equal(store.getInternalToolReceipt(original.executionId, original.stepKey)?.outcome, null);
      s.business.db.exec("DROP TRIGGER p4_retry_fault");
      assert.equal(store.reconcileInterruptedInternalTools(dispatchedAt), 1);
      assert.equal(store.reconcileInterruptedInternalTools(dispatchedAt), 0);
      s.business.db.exec("CREATE TRIGGER p4_settled_fault BEFORE INSERT ON call_metering WHEN NEW.call_kind='tool' BEGIN SELECT RAISE(ABORT,'SETTLED_MUST_NOT_INSERT'); END");
      assert.equal(store.reconcileInterruptedInternalTools(dispatchedAt), 0);
      assert.equal((s.business.db.prepare("SELECT COUNT(*) AS n FROM call_metering WHERE call_id=?").get(original.stepKey) as { n: number }).n, 1);
      assert.equal(new AutonomyStore(s.business.db, f.roleId, "Asia/Shanghai").getBudget(dispatchedAt).usedPoints, 1);
    });
  } finally { await f.close(); }
});

test("internal startup reconciliation leaves budget-paused progress untouched", async () => {
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const original = seed(f, "autonomous", false, true);
    withStorage(f, (s) => {
      const store = new ConversationStore(s.business.db, f.roleId);
      assert.equal(store.reconcileInterruptedInternalTools(restartedAt), 0);
      assert.equal(store.getInternalToolReceipt(original.executionId, original.stepKey)?.outcome, null);
      assert.equal(s.business.getTask(f.roleId, original.taskId).status, "paused");
      assert.equal((s.business.db.prepare("SELECT COUNT(*) AS n FROM call_metering WHERE call_id=?").get(original.stepKey) as { n: number }).n, 0);
    });
  } finally { await f.close(); }
});
