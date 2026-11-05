import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createBackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import type { MemoryFormationInput } from "../src/domain/memory.js";
import { ScriptedMemoryModel } from "../src/model/offline-memory.js";
import { ConversationStore } from "../src/storage/conversation-store.js";
import { registerMessageEvidence } from "../src/storage/evidence.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import {
  GatedChatModel,
  ScriptedChatModel,
  addBinding,
  createFixtureWithModel,
  withStorage,
} from "./p2-05-fixture.js";

function formedEvent(input: MemoryFormationInput): unknown {
  const item = input.evidence[0];
  assert.ok(item);
  return {
    operations: [
      {
        op: "create_event",
        localKey: "restart-bookstore",
        title: "重启后补上的书店经历",
        summary: "重启后从待处理证据补成事件。",
        occurredAtStart: item.occurredAt,
        experienceDate: item.localDate,
        evidenceIds: [item.evidenceId],
      },
    ],
  };
}

test("restart marks an abandoned execution failed and rebuilds its partial reply", { timeout: 20_000 }, async () => {
  const model = new GatedChatModel();
  const fixture = createFixtureWithModel(model);
  let reopened: ReturnType<typeof createBackendApp> | null = null;
  try {
    fixture.app.conversation.updateInputState({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      clientId: "client-before-restart",
      typing: true,
    });
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "说一半就好",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await model.started.promise;

    const closing = fixture.app.close();
    model.release.resolve(undefined);
    await closing;

    const abandoned = withStorage(fixture, (storage) => {
      const execution = storage.business.db
        .prepare(
          "SELECT execution_id FROM executions WHERE role_id = ? AND status = 'running'",
        )
        .get(fixture.roleId) as { execution_id: string };
      const store = new ConversationStore(
        storage.business.db,
        fixture.roleId,
        "Asia/Shanghai",
      );
      store.startModelCall({
        executionId: execution.execution_id,
        resourceId: randomUUID(),
        modelName: "offline-chat",
        protocol: "openai-chat",
      });
      const messages = storage.business.db
        .prepare(
          "SELECT sender, status, content, claimed_by_execution_id FROM messages WHERE window_id = ? ORDER BY sequence ASC",
        )
        .all(fixture.windowId) as Array<{
        sender: string;
        status: string;
        content: string;
        claimed_by_execution_id: string | null;
      }>;
      return { execution, messages };
    });
    assert.deepEqual(
      abandoned.messages.map((message) => [
        message.sender,
        message.status,
        message.content,
      ]),
      [
        ["user", "received", "说一半就好"],
        ["assistant", "generating", ""],
      ],
    );
    assert.ok(abandoned.messages[0]?.claimed_by_execution_id);

    reopened = createBackendApp(
      parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
      {
        typingMs: 1000,
        timeZone: "Asia/Shanghai",
        modelPortFactory: () =>
          new ScriptedChatModel([
            [
              { type: "text_delta", text: "这次说完。" },
              { type: "completed", stopReason: "stop" },
            ],
          ]),
        disableMemoryRuntime: true,
      },
    );

    const recovered = withStorage(fixture, (storage) => {
      const execution = storage.business.db
        .prepare(
          "SELECT status, decision_round FROM executions WHERE execution_id = ?",
        )
        .get(abandoned.execution.execution_id) as {
        status: string;
        decision_round: number | null;
      };
      const messages = storage.business.db
        .prepare(
          "SELECT sender, status, content, claimed_by_execution_id, processed_by_execution_id FROM messages WHERE window_id = ? ORDER BY sequence ASC",
        )
        .all(fixture.windowId) as Array<{
        sender: string;
        status: string;
        content: string;
        claimed_by_execution_id: string | null;
        processed_by_execution_id: string | null;
      }>;
      const modelCalls = storage.business.db
        .prepare(
          "SELECT status, error_code FROM model_calls WHERE execution_id = ? ORDER BY rowid ASC",
        )
        .all(abandoned.execution.execution_id) as Array<{
        status: string;
        error_code: string | null;
      }>;
      const events = storage.business.db
        .prepare(
          "SELECT event_type, payload_json FROM execution_stream_events WHERE execution_id = ? ORDER BY stream_event_id ASC",
        )
        .all(abandoned.execution.execution_id) as Array<{
        event_type: string;
        payload_json: string;
      }>;
      return { execution, messages, modelCalls, events };
    });
    assert.equal(recovered.execution.status, "failed");
    assert.equal(recovered.execution.decision_round, null);
    assert.deepEqual(
      recovered.messages.map((message) => [
        message.sender,
        message.status,
        message.content,
      ]),
      [
        ["user", "received", "说一半就好"],
        ["assistant", "interrupted", "旧"],
      ],
    );
    assert.equal(recovered.messages[0]?.claimed_by_execution_id, null);
    assert.equal(recovered.messages[0]?.processed_by_execution_id, null);
    assert.deepEqual(
      recovered.modelCalls.map((call) => [call.status, call.error_code]),
      [
        ["failed", "EXECUTION_SUPERSEDED"],
        ["failed", "PROCESS_INTERRUPTED"],
      ],
    );
    const failure = recovered.events.find(
      (event) => event.event_type === "execution_failed",
    );
    assert.ok(failure);
    assert.equal(
      (JSON.parse(failure.payload_json) as { errorCode?: string }).errorCode,
      "PROCESS_INTERRUPTED",
    );
    assert.deepEqual(reopened.conversation.inputStates.list(fixture.roleId), []);

    reopened.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "重新开始",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await reopened.conversation.waitForIdle(fixture.roleId);
    const afterRestart = reopened.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.deepEqual(
      afterRestart.items.map((message) => [
        message.sender,
        message.status,
        message.content,
      ]),
      [
        ["user", "received", "说一半就好"],
        ["assistant", "interrupted", "旧"],
        ["user", "received", "重新开始"],
        ["assistant", "completed", "这次说完。"],
      ],
    );
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test("restart fails an interrupted memory batch and retries the saved evidence", { timeout: 20_000 }, async () => {
  const memoryModel = new ScriptedMemoryModel([formedEvent]);
  const fixture = createFixtureWithModel(new ScriptedChatModel([]), {
    disableMemoryRuntime: false,
    memoryModelFactory: () => memoryModel,
  });
  let reopened: ReturnType<typeof createBackendApp> | null = null;
  try {
    const modelResource = fixture.app.services.resources.list("model")[0];
    assert.ok(modelResource);
    addBinding(fixture, "memory_model", modelResource.resourceId);

    const abandoned = withStorage(fixture, (storage) => {
      const submitted = storage.business.submitMessage(
        fixture.roleId,
        fixture.windowId,
        {
          content: "我们去了杭州旧书店，买了一本旧诗集。",
          submissionId: randomUUID(),
          sourcePlatform: "nowadays",
        },
      );
      registerMessageEvidence(storage.business.db, {
        roleId: fixture.roleId,
        messageIds: [submitted.message.messageId],
        executionId: null,
        timeZone: "Asia/Shanghai",
      });
      const store = new MemoryStore(storage.business.db);
      const started = store.startBatch({
        roleId: fixture.roleId,
        budgetChars: 60_000,
        outputReserveChars: 4_000,
      });
      assert.ok(started);
      return { batchId: started.batch.batchId };
    });
    await fixture.app.close();

    reopened = createBackendApp(
      parseBackendConfig(["--app-root", fixture.root, "--port", "0"]),
      {
        timeZone: "Asia/Shanghai",
        modelPortFactory: () => new ScriptedChatModel([]),
        memoryModelFactory: () => memoryModel,
        disableMemoryRuntime: false,
      },
    );

    const recovered = withStorage(fixture, (storage) => {
      const batch = storage.business.db
        .prepare(
          "SELECT status, last_error_code FROM memory_batches WHERE batch_id = ?",
        )
        .get(abandoned.batchId) as {
        status: string;
        last_error_code: string | null;
      };
      const evidence = storage.business.db
        .prepare(
          "SELECT status, next_retry_at, attempt_count FROM evidence_processing",
        )
        .get() as {
        status: string;
        next_retry_at: string | null;
        attempt_count: number;
      };
      const segments = storage.business.db
        .prepare(
          "SELECT status FROM memory_evidence_segments ORDER BY segment_index ASC",
        )
        .all() as Array<{ status: string }>;
      return { batch, evidence, segments };
    });
    assert.equal(recovered.batch.status, "failed");
    assert.equal(recovered.batch.last_error_code, "PROCESS_INTERRUPTED");
    assert.equal(recovered.evidence.status, "failed");
    assert.equal(recovered.evidence.attempt_count, 1);
    assert.ok(recovered.evidence.next_retry_at);
    assert.deepEqual(recovered.segments.map((segment) => segment.status), [
      "pending",
    ]);

    const deadline = Date.now() + 5_000;
    let formedEvents: unknown[] = [];
    while (Date.now() < deadline) {
      formedEvents = withStorage(fixture, (storage) =>
        new MemoryStore(storage.business.db).listEvents(fixture.roleId),
      );
      if (formedEvents.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const formed = withStorage(fixture, (storage) => {
      const events = new MemoryStore(storage.business.db).listEvents(
        fixture.roleId,
      );
      const evidence = storage.business.db
        .prepare("SELECT status FROM evidence_processing")
        .get() as { status: string };
      const batch = storage.business.db
        .prepare(
          "SELECT status FROM memory_batches WHERE batch_id = ?",
        )
        .get(abandoned.batchId) as { status: string };
      return { events, evidence, batch };
    });
    assert.equal(formed.events.length, 1);
    assert.equal(formed.events[0]?.title, "重启后补上的书店经历");
    assert.equal(formed.evidence.status, "processed");
    assert.equal(formed.batch.status, "failed");
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});
