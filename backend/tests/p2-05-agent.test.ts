import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { rolePaths } from "../src/bootstrap/config.js";
import type { ModelEvent, ModelRequest } from "../src/domain/model.js";
import { registerMessageEvidence } from "../src/storage/evidence.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { RoleStorage } from "../src/storage/role-storage.js";
import {
  ScriptedChatModel,
  createFixture,
  createFixtureWithModel,
  seedEvent,
  withStorage,
} from "./p2-05-fixture.js";

test("user message runs a LangGraph decision and commits reply, state and stream events", { timeout: 15_000 }, async () => {
  const fixture = createFixture([
    [
      { type: "text_delta", text: "我记得" },
      { type: "text_delta", text: "那次旧书店。" },
      { type: "usage", inputTokens: 12, outputTokens: 8 },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const submitted = fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "你还记得杭州的旧书店吗？",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    assert.equal(submitted.duplicate, false);
    assert.equal(submitted.decisionScheduled, true);
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.equal(messages.items.length, 2);
    assert.equal(messages.items[0]?.sender, "user");
    assert.equal(messages.items[1]?.sender, "assistant");
    assert.equal(messages.items[1]?.status, "completed");
    assert.equal(messages.items[1]?.content, "我记得那次旧书店。");

    const detail = withStorage(fixture, (storage) => {
      const execution = storage.business.db
        .prepare("SELECT * FROM executions WHERE role_id = ?")
        .get(fixture.roleId) as {
        execution_id: string;
        status: string;
        decision_round: number;
        state_version_committed: number;
      };
      const role = storage.business.getRole(fixture.roleId);
      const events = storage.business.db
        .prepare(
          "SELECT event_type, payload_json FROM execution_stream_events WHERE execution_id = ? ORDER BY stream_event_id ASC",
        )
        .all(execution.execution_id) as Array<{
        event_type: string;
        payload_json: string;
      }>;
      const modelCall = storage.business.db
        .prepare("SELECT status, usage_json FROM model_calls WHERE execution_id = ?")
        .get(execution.execution_id) as {
        status: string;
        usage_json: string | null;
      };
      const metering = storage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM call_metering WHERE execution_id = ? AND call_kind = 'model' AND counted = 0",
        )
        .get(execution.execution_id) as { count: number };
      const evidence = storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM evidence_records WHERE role_id = ?")
        .get(fixture.roleId) as { count: number };
      const checkpoints = storage.checkpoint.db
        .prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE thread_id = ?")
        .get(execution.execution_id) as { count: number };
      return {
        execution,
        role,
        events,
        modelCall,
        metering,
        evidence,
        checkpoints,
      };
    });
    assert.equal(detail.execution.status, "completed");
    assert.equal(detail.execution.decision_round, 1);
    assert.equal(detail.execution.state_version_committed, 2);
    assert.equal(detail.role.stateVersion, 2);
    assert.deepEqual(detail.role.state, { mood: "平静" });
    assert.equal(detail.events[0]?.event_type, "execution_started");
    assert.ok(detail.events.some((event) => event.event_type === "message_delta"));
    assert.equal(detail.events.at(-1)?.event_type, "message_completed");
    assert.equal(detail.modelCall.status, "succeeded");
    assert.deepEqual(JSON.parse(detail.modelCall.usage_json ?? "{}"), {
      inputTokens: 12,
      outputTokens: 8,
    });
    assert.equal(detail.metering.count, 1);
    assert.equal(detail.evidence.count, 2);
    assert.ok(detail.checkpoints.count > 0);

    const model = fixture.model as unknown as { requests: Array<{ system: string; messages: Array<{ role: string }> }> };
    assert.equal(model.requests.length, 1);
    const request = model.requests[0]!;
    assert.match(request.system, /阿澄/);
    assert.match(request.system, /杭州|旧书店|当前状态/);
    assert.deepEqual(
      request.messages.map((message) => message.role),
      ["user"],
    );
  } finally {
    await fixture.close();
  }
});

test("agent tools correct events by version and read summary evidence within the role", { timeout: 20_000 }, async () => {
  const refs = { eventId: "", summaryId: "", otherEventId: "" };
  const model = new ScriptedChatModel([
    (): ModelEvent[] => [
      {
        type: "tool_call",
        callId: "wire-summary-evidence",
        name: "memory_summary_evidence",
        arguments: {
          summaryId: refs.summaryId,
          fromSequence: 1,
          toSequence: 1,
        },
      },
      { type: "completed", stopReason: "tool_calls" },
    ],
    (): ModelEvent[] => [
      {
        type: "tool_call",
        callId: "wire-correct",
        name: "memory_correct_event",
        arguments: {
          eventId: refs.eventId,
          expectedVersion: 2,
          patch: { summary: "修正后的经过" },
        },
      },
      { type: "completed", stopReason: "tool_calls" },
    ],
    (): ModelEvent[] => [
      {
        type: "tool_call",
        callId: "wire-conflict",
        name: "memory_correct_event",
        arguments: {
          eventId: refs.eventId,
          expectedVersion: 2,
          patch: { summary: "不应生效的旧版本" },
        },
      },
      { type: "completed", stopReason: "tool_calls" },
    ],
    (): ModelEvent[] => [
      {
        type: "tool_call",
        callId: "wire-isolation",
        name: "memory_correct_event",
        arguments: {
          eventId: refs.otherEventId,
          expectedVersion: 1,
          patch: { summary: "跨角色修改" },
        },
      },
      { type: "completed", stopReason: "tool_calls" },
    ],
    (request: ModelRequest): ModelEvent[] => {
      assert.equal(
        request.messages.filter((message) => message.role === "tool").length,
        4,
      );
      return [
        { type: "text_delta", text: "已核对记忆。" },
        { type: "completed", stopReason: "stop" },
      ];
    },
  ]);
  const fixture = createFixtureWithModel(model);
  try {
    const seeded = seedEvent(fixture, {
      content: "我们上次在杭州旧书店买了旧诗集。",
      title: "杭州旧书店",
      summary: "和用户一起逛旧书店。",
      occurredAt: "2026-11-02T03:00:00.000Z",
    });
    refs.eventId = seeded.eventId;
    const otherRole = fixture.app.services.roles.createRole({
      displayName: "另一个角色",
      definition: { text: "你是另一个角色。" },
      state: {},
    });
    const otherStorage = RoleStorage.openExisting(
      rolePaths(fixture.app.config.dataRoot, otherRole.roleId),
    );
    try {
      const submitted = otherStorage.business.submitMessage(
        otherRole.roleId,
        otherRole.defaultWindowId,
        {
          content: "另一个角色的经历。",
          submissionId: randomUUID(),
          sourcePlatform: "nowadays",
        },
      );
      registerMessageEvidence(otherStorage.business.db, {
        roleId: otherRole.roleId,
        messageIds: [submitted.message.messageId],
        executionId: null,
        timeZone: "Asia/Shanghai",
      });
      const otherStore = new MemoryStore(otherStorage.business.db);
      const otherEvidence = otherStore
        .listEvidence(otherRole.roleId)
        .find((item) => item.sourceId === submitted.message.messageId);
      assert.ok(otherEvidence);
      refs.otherEventId = otherStore.createEvent({
        roleId: otherRole.roleId,
        title: "别人的事件",
        summary: "不属于当前角色。",
        subjectiveExperience: "",
        occurredAtStart: "2026-11-02T03:00:00.000Z",
        occurredAtEnd: null,
        experienceDate: "2026-11-02",
        tags: {},
        evidenceIds: [otherEvidence.evidenceId],
        currentRound: 0,
        now: "2026-11-03T12:00:00.000Z",
      }).eventId;
    } finally {
      otherStorage.close();
    }

    const decoyWindow = fixture.app.services.roles.createWindow(
      fixture.roleId,
      { kind: "custom", source: "test" },
    );
    refs.summaryId = withStorage(fixture, (storage) => {
      const submitted = storage.business.submitMessage(
        fixture.roleId,
        decoyWindow.windowId,
        {
          content: "另一窗口的无关记录。",
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
      storage.business.db
        .prepare(
          "UPDATE messages SET processed_by_execution_id = (SELECT execution_id FROM executions WHERE role_id = ? ORDER BY rowid ASC LIMIT 1) WHERE message_id = ?",
        )
        .run(fixture.roleId, submitted.message.messageId);
      return new MemoryStore(storage.business.db).refineEvent({
        roleId: fixture.roleId,
        events: [{ eventId: seeded.eventId, expectedVersion: 1 }],
        summary: "那天我们一起去了旧书店。",
        topic: "旧书店",
        now: "2026-11-03T12:00:00.000Z",
      }).summary.summaryId;
    });

    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "回忆并核对一下旧书店这件事。",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, 5);
    const lastRequest = model.requests.at(-1);
    assert.ok(lastRequest);
    const toolMessages = new Map(
      lastRequest.messages
        .filter((message) => message.role === "tool")
        .map((message) => [
          message.toolCallId,
          JSON.parse(message.content) as {
            status: string;
            diagnosticCode?: string;
            result?: {
              items?: Array<{ windowId: string | null; content: string }>;
              version?: number;
            };
          },
        ]),
    );
    const evidenceReply = toolMessages.get("wire-summary-evidence");
    assert.equal(evidenceReply?.status, "success");
    const items = evidenceReply?.result?.items ?? [];
    assert.ok(items.some((item) => item.content.includes("杭州旧书店")));
    assert.ok(items.every((item) => item.windowId === fixture.windowId));
    assert.ok(items.every((item) => !item.content.includes("另一窗口")));
    assert.equal(toolMessages.get("wire-correct")?.result?.version, 3);
    assert.equal(toolMessages.get("wire-conflict")?.status, "failed");
    assert.equal(
      toolMessages.get("wire-conflict")?.diagnosticCode,
      "MEMORY_VERSION_CONFLICT",
    );
    assert.equal(toolMessages.get("wire-isolation")?.status, "failed");
    assert.equal(
      toolMessages.get("wire-isolation")?.diagnosticCode,
      "MEMORY_EVENT_NOT_FOUND",
    );

    const stored = withStorage(fixture, (storage) => {
      const store = new MemoryStore(storage.business.db);
      const event = store.getEvent(fixture.roleId, refs.eventId);
      const summary = store.getSummary(fixture.roleId, refs.summaryId);
      const original = storage.business.db
        .prepare(
          "SELECT content FROM messages WHERE message_id = ?",
        )
        .get(seeded.messageId) as { content: string };
      const recall = storage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_recalls WHERE role_id = ? AND record_type = 'daily_summary' AND record_id = ?",
        )
        .get(fixture.roleId, refs.summaryId) as { count: number };
      return { event, summary, original, recall };
    });
    assert.equal(stored.event.summary, "修正后的经过");
    assert.equal(stored.event.version, 3);
    assert.equal(stored.summary.summary, "那天我们一起去了旧书店。");
    assert.equal(stored.summary.version, 1);
    assert.equal(stored.original.content, "我们上次在杭州旧书店买了旧诗集。");
    assert.ok(stored.recall.count > 0);
  } finally {
    await fixture.close();
  }
});
