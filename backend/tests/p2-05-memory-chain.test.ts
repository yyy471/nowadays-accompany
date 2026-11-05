import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { rolePaths } from "../src/bootstrap/config.js";
import { MemoryService } from "../src/application/memory-service.js";
import { HttpMemoryModel } from "../src/application/memory-runtime.js";
import type { ResolvedModelBinding } from "../src/application/model-binding-resolver.js";
import type { MemoryFormationInput } from "../src/domain/memory.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import { ScriptedMemoryModel } from "../src/model/offline-memory.js";
import { registerMessageEvidence } from "../src/storage/evidence.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { RoleStorage } from "../src/storage/role-storage.js";
import {
  ScriptedChatModel,
  addBinding,
  createFixture,
  createFixtureWithModel,
  seedEvent,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

class TwoTurnChatModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const recalled = request.system.includes("第一次逛杭州旧书店");
    const toolMessages = request.messages.filter(
      (message) => message.role === "tool",
    );
    if (!recalled) {
      assert.match(request.system, /自动召回没有命中/);
      yield { type: "text_delta", text: "我记住了，我们一起去了杭州旧书店。" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    if (toolMessages.length === 0) {
      const eventId = /id=([0-9a-f-]{36})/.exec(request.system)?.[1];
      assert.ok(eventId);
      yield {
        type: "tool_call",
        callId: "wire-event",
        name: "memory_event",
        arguments: { eventId },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (toolMessages.length === 1) {
      const evidenceId = /"evidenceId":"([0-9a-f-]{36})"/.exec(
        String(toolMessages[0]?.content ?? ""),
      )?.[1];
      assert.ok(evidenceId);
      yield {
        type: "tool_call",
        callId: "wire-evidence",
        name: "memory_evidence",
        arguments: { evidenceId },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    assert.match(String(toolMessages[1]?.content ?? ""), /杭州旧书店/);
    yield { type: "text_delta", text: "记得，那本旧诗集还在书架上。" };
    yield { type: "completed", stopReason: "stop" };
  }
}

function formedEvent(input: MemoryFormationInput): unknown {
  const item =
    input.evidence.find((evidence) => evidence.content.includes("杭州旧书店")) ??
    input.evidence[0];
  assert.ok(item);
  return {
    operations: [
      {
        op: "create_event",
        localKey: "bookstore-visit",
        title: "第一次逛杭州旧书店",
        summary: "和用户一起在杭州旧书店买了一本旧诗集。",
        occurredAtStart: item.occurredAt,
        experienceDate: item.localDate,
        evidenceIds: [item.evidenceId],
      },
    ],
  };
}

test("conversation-formed memory is recalled with original evidence in the next turn", { timeout: 20_000 }, async () => {
  const chat = new TwoTurnChatModel();
  const memoryModel = new ScriptedMemoryModel([
    formedEvent,
    { operations: [] },
    { operations: [] },
  ]);
  const fixture = createFixtureWithModel(chat, {
    disableMemoryRuntime: false,
    memoryModelFactory: () => memoryModel,
  });
  try {
    const modelResource = fixture.app.services.resources.list("model")[0];
    assert.ok(modelResource);
    addBinding(fixture, "memory_model", modelResource.resourceId);

    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "我们今天去了杭州旧书店，买到了一本旧诗集。",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    await fixture.app.conversation.runMemoryPending(fixture.roleId);

    const formed = withStorage(fixture, (storage) => {
      const store = new MemoryStore(storage.business.db);
      const events = store.listEvents(fixture.roleId);
      const evidence = storage.business.db
        .prepare(
          `SELECT er.evidence_id, COALESCE(m.content, '') AS content, ep.status
             FROM evidence_records er
             JOIN evidence_processing ep ON ep.evidence_id = er.evidence_id
             LEFT JOIN messages m
               ON m.message_id = er.source_id AND er.source_kind = 'message'
            WHERE er.role_id = ? ORDER BY er.role_sequence ASC`,
        )
        .all(fixture.roleId) as Array<{
        evidence_id: string;
        content: string;
        status: string;
      }>;
      const links = storage.business.db
        .prepare("SELECT event_id, evidence_id FROM memory_event_sources")
        .all() as Array<{ event_id: string; evidence_id: string }>;
      return { events, evidence, links };
    });
    assert.equal(formed.events.length, 1);
    const event = formed.events[0]!;
    assert.equal(event.title, "第一次逛杭州旧书店");
    assert.equal(event.summary, "和用户一起在杭州旧书店买了一本旧诗集。");
    assert.equal(formed.evidence.length, 2);
    assert.ok(formed.evidence.every((item) => item.status === "processed"));
    const linkedEvidence = formed.links
      .filter((link) => link.event_id === event.eventId)
      .map((link) => link.evidence_id);
    assert.equal(linkedEvidence.length, 1);
    assert.ok(
      formed.evidence.some(
        (item) =>
          item.evidence_id === linkedEvidence[0] &&
          item.content.includes("杭州旧书店"),
      ),
    );

    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "你还记得我们上次去的那家旧书店吗？",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(chat.requests.length, 4);
    assert.match(chat.requests[1]?.system ?? "", /第一次逛杭州旧书店/);
    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.equal(messages.items.at(-1)?.content, "记得，那本旧诗集还在书架上。");
    const recall = withStorage(fixture, (storage) => {
      const execution = storage.business.db
        .prepare(
          "SELECT execution_id FROM executions WHERE role_id = ? AND status = 'completed' ORDER BY rowid DESC LIMIT 1",
        )
        .get(fixture.roleId) as { execution_id: string };
      return storage.business.db
        .prepare(
          "SELECT record_id FROM memory_recalls WHERE execution_id = ? ORDER BY record_id",
        )
        .all(execution.execution_id) as Array<{ record_id: string }>;
    });
    assert.ok(recall.some((item) => item.record_id === event.eventId));

    await fixture.app.conversation.runMemoryPending(fixture.roleId);
  } finally {
    await fixture.close();
  }
});

test("30 pending messages form memory after the idle interval without a manual call", { timeout: 20_000 }, async () => {
  const memoryModel = new ScriptedMemoryModel([formedEvent]);
  const fixture = createFixtureWithModel(
    new ScriptedChatModel([
      [
        { type: "text_delta", text: "收到。" },
        { type: "completed", stopReason: "stop" },
      ],
    ]),
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => memoryModel,
      memoryIdleMs: 80,
    },
  );
  try {
    const modelResource = fixture.app.services.resources.list("model")[0];
    assert.ok(modelResource);
    addBinding(fixture, "memory_model", modelResource.resourceId);

    withStorage(fixture, (storage) => {
      for (let index = 0; index < 30; index += 1) {
        const submitted = storage.business.submitMessage(
          fixture.roleId,
          fixture.windowId,
          {
            content: `更早的消息 ${index + 1}`,
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
      }
    });
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "触发整理的最后一句",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const deadline = Date.now() + 5_000;
    let events: ReturnType<MemoryStore["listEvents"]> = [];
    while (Date.now() < deadline) {
      events = withStorage(fixture, (storage) =>
        new MemoryStore(storage.business.db).listEvents(fixture.roleId),
      );
      if (events.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(events.length, 1);
    assert.equal(memoryModel.requests.length, 1);
    assert.ok((memoryModel.requests[0]?.evidence.length ?? 0) >= 30);
  } finally {
    await fixture.close();
  }
});

const MEMORY_BINDING: ResolvedModelBinding = {
  capability: "memory_model",
  resourceId: "offline-memory-resource",
  modelName: "offline-memory",
  config: { protocol: "openai-chat", baseUrl: "http://offline.invalid/v1" },
};

async function withHttpMemoryService<T>(
  fixture: Fixture,
  model: ModelPort,
  action: (service: MemoryService, store: MemoryStore) => Promise<T>,
): Promise<T> {
  const storage = RoleStorage.openExisting(
    rolePaths(fixture.app.config.dataRoot, fixture.roleId),
  );
  try {
    const store = new MemoryStore(storage.business.db);
    const service = new MemoryService(
      store,
      new HttpMemoryModel(model, MEMORY_BINDING),
      { timeZone: "Asia/Shanghai" },
    );
    return await action(service, store);
  } finally {
    storage.close();
  }
}

function submitForMemory(
  fixture: Fixture,
  content = "我们今天去了杭州旧书店。",
): void {
  fixture.app.conversation.submitMessage(
    fixture.roleId,
    fixture.windowId,
    {
      content,
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    },
  );
}

test("default HttpMemoryModel sends the full output protocol and saves the operations", { timeout: 20_000 }, async () => {
  let captured: ModelRequest | undefined;
  const protocolModel: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      captured = request;
      for (const field of [
        "create_event",
        "update_event",
        "refine_event",
        "expectedVersion",
        "evidenceIds",
        "experienceDate",
        "person",
        "topic",
        "place",
        "emotion",
        "source",
      ]) {
        assert.match(request.system, new RegExp(field));
      }
      for (const plural of [
        '"people"',
        '"topics"',
        '"places"',
        '"emotions"',
        '"sources"',
      ]) {
        assert.equal(request.system.includes(plural), false);
      }
      const input = JSON.parse(
        request.messages[0]?.content ?? "{}",
      ) as MemoryFormationInput;
      const item = input.evidence[0];
      assert.ok(item);
      yield {
        type: "text_delta",
        text: JSON.stringify({
          operations: [
            {
              op: "create_event",
              localKey: "protocol-event",
              title: "协议生成事件",
              summary: "整理模型只依据请求中的协议生成。",
              occurredAtStart: item.occurredAt,
              experienceDate: item.localDate,
              tags: {
                person: ["用户"],
                topic: ["旧书店", "协议"],
                place: ["杭州"],
                emotion: ["平静"],
                source: ["对话"],
              },
              evidenceIds: [item.evidenceId],
            },
          ],
        }),
      };
      yield { type: "completed", stopReason: "stop" };
    },
  };
  const fixture = createFixture([
    [
      { type: "text_delta", text: "收到。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    submitForMemory(fixture);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const result = await withHttpMemoryService(
      fixture,
      protocolModel,
      (service) => service.runBatch(fixture.roleId, {}),
    );
    assert.equal(result.status, "completed");
    assert.equal(result.maintenance, false);
    const stored = withStorage(fixture, (storage) => {
      const store = new MemoryStore(storage.business.db);
      const events = store.listEvents(fixture.roleId);
      const eventId = events[0]?.eventId ?? "";
      return {
        events,
        evidence: store.listEvidence(fixture.roleId),
        tags: events[0] === undefined ? null : store.getTags(eventId),
        indexed: storage.business.db
          .prepare(
            `SELECT COUNT(*) AS count FROM memory_search_documents
              WHERE role_id = ? AND record_type = 'event' AND record_id = ?`,
          )
          .get(fixture.roleId, eventId) as { count: number },
      };
    });
    assert.equal(stored.events.length, 1);
    assert.equal(stored.events[0]?.title, "协议生成事件");
    assert.deepEqual(stored.tags, {
      person: ["用户"],
      topic: ["协议", "旧书店"],
      place: ["杭州"],
      emotion: ["平静"],
      source: ["对话"],
    });
    assert.ok(
      stored.evidence.every((item) => item.processingStatus === "processed"),
    );
    assert.equal(stored.indexed.count, 1);
    assert.ok(captured !== undefined);
  } finally {
    await fixture.close();
  }
});

test("memory formation rejects the old plural tag keys without advancing evidence", { timeout: 20_000 }, async () => {
  const pluralTagModel: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      const input = JSON.parse(
        request.messages[0]?.content ?? "{}",
      ) as MemoryFormationInput;
      const item = input.evidence[0];
      assert.ok(item);
      yield {
        type: "text_delta",
        text: JSON.stringify({
          operations: [
            {
              op: "create_event",
              localKey: "plural-tags-event",
              title: "未写入的复数标签事件",
              summary: "旧提示词使用复数标签键，保存契约应按失败处理。",
              occurredAtStart: item.occurredAt,
              experienceDate: item.localDate,
              tags: {
                people: ["用户"],
                topics: ["旧书店"],
                places: ["杭州"],
                emotions: ["平静"],
                sources: ["对话"],
              },
              evidenceIds: [item.evidenceId],
            },
          ],
        }),
      };
      yield { type: "completed", stopReason: "stop" };
    },
  };
  const fixture = createFixture([
    [
      { type: "text_delta", text: "收到。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    submitForMemory(fixture);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const result = await withHttpMemoryService(
      fixture,
      pluralTagModel,
      (service) => service.runBatch(fixture.roleId, {}),
    );
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "MEMORY_OPERATION_INVALID");
    const stored = withStorage(fixture, (storage) => {
      const store = new MemoryStore(storage.business.db);
      return {
        events: store.listEvents(fixture.roleId),
        evidence: store.listEvidence(fixture.roleId),
        batch: store.getBatch(fixture.roleId, result.batchId ?? ""),
      };
    });
    assert.equal(stored.events.length, 0);
    assert.ok(
      stored.evidence.every((item) => item.processingStatus !== "processed"),
    );
    assert.equal(stored.batch.status, "failed");
    assert.equal(stored.batch.attemptCount, 1);
  } finally {
    await fixture.close();
  }
});

for (const mode of ["incomplete", "max_tokens"] as const) {
  test(`memory formation rejects an explicitly incomplete response (${mode})`, { timeout: 20_000 }, async () => {
    const incompleteModel: ModelPort = {
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", text: '{"operations":[]}' };
        yield {
          type: "completed",
          stopReason: mode === "incomplete" ? "stop" : "max_tokens",
          ...(mode === "incomplete" ? { incomplete: true } : {}),
        };
      },
    };
    const fixture = createFixture([
      [
        { type: "text_delta", text: "收到。" },
        { type: "completed", stopReason: "stop" },
      ],
    ]);
    try {
      submitForMemory(fixture);
      await fixture.app.conversation.waitForIdle(fixture.roleId);
      const result = await withHttpMemoryService(
        fixture,
        incompleteModel,
        (service) => service.runBatch(fixture.roleId, {}),
      );
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "MEMORY_MODEL_FAILED");
      const stored = withStorage(fixture, (storage) => {
        const store = new MemoryStore(storage.business.db);
        return {
          events: store.listEvents(fixture.roleId),
          evidence: store.listEvidence(fixture.roleId),
          batch: store.getBatch(fixture.roleId, result.batchId ?? ""),
        };
      });
      assert.equal(stored.events.length, 0);
      assert.ok(
        stored.evidence.every((item) => item.processingStatus !== "processed"),
      );
      assert.equal(stored.batch.status, "failed");
      assert.equal(stored.batch.attemptCount, 1);
    } finally {
      await fixture.close();
    }
  });
}

function seedRefineCandidate(fixture: Fixture): { eventId: string } {
  const seeded = seedEvent(fixture, {
    content: "很久以前的一次散步。",
    title: "很久以前的散步",
    summary: "和用户沿河散步。",
    occurredAt: "2026-10-01T01:00:00.000Z",
  });
  withStorage(fixture, (storage) => {
    storage.business.db
      .prepare(
        "UPDATE evidence_processing SET status = 'processed' WHERE evidence_id IN (SELECT evidence_id FROM evidence_records WHERE role_id = ?)",
      )
      .run(fixture.roleId);
    storage.business.db
      .prepare("UPDATE executions SET decision_round = 100 WHERE role_id = ?")
      .run(fixture.roleId);
  });
  return { eventId: seeded.eventId };
}

test("refine candidates run in a maintenance batch without new evidence", { timeout: 20_000 }, async () => {
  const inputs: MemoryFormationInput[] = [];
  const fixture = createFixture([], {
    disableMemoryRuntime: false,
    memoryModelFactory: () => ({
      async form(input: MemoryFormationInput) {
        inputs.push(input);
        return { operations: [] };
      },
    }),
    memoryIdleMs: 60_000,
  });
  try {
    const seeded = seedRefineCandidate(fixture);
    await fixture.app.conversation.runMemoryPending(fixture.roleId);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.evidence.length, 0);
    assert.ok(
      inputs[0]?.refineCandidates.some(
        (candidate) => candidate.eventId === seeded.eventId,
      ),
    );
    const stored = withStorage(fixture, (storage) => {
      const store = new MemoryStore(storage.business.db);
      return {
        latest: store.latestMaintenanceBatch(fixture.roleId),
        events: store.listEvents(fixture.roleId),
        summaries: storage.business.db
          .prepare(
            "SELECT COUNT(*) AS count FROM daily_summaries WHERE role_id = ?",
          )
          .get(fixture.roleId) as { count: number },
      };
    });
    assert.equal(stored.latest?.status, "completed");
    assert.equal(stored.events[0]?.lifecycleStatus, "active");
    assert.equal(stored.summaries.count, 0);
  } finally {
    await fixture.close();
  }
});

test("a failed maintenance batch keeps the candidate and retries on the next run", { timeout: 20_000 }, async () => {
  let calls = 0;
  const fixture = createFixture([], {
    disableMemoryRuntime: false,
    memoryModelFactory: () => ({
      async form() {
        calls += 1;
        throw new Error("OFFLINE_MEMORY_FAILURE");
      },
    }),
    memoryIdleMs: 60_000,
  });
  try {
    const seeded = seedRefineCandidate(fixture);
    await fixture.app.conversation.runMemoryPending(fixture.roleId);
    assert.equal(calls, 1);
    const first = withStorage(fixture, (storage) => {
      const store = new MemoryStore(storage.business.db);
      return {
        latest: store.latestMaintenanceBatch(fixture.roleId),
        candidates: store.listRefineCandidates(fixture.roleId, 100),
        events: store.listEvents(fixture.roleId),
      };
    });
    assert.equal(first.latest?.status, "failed");
    assert.equal(first.latest?.attemptCount, 1);
    assert.equal(first.latest?.lastErrorCode, "MEMORY_MODEL_FAILED");
    assert.ok(
      first.candidates.some((candidate) => candidate.eventId === seeded.eventId),
    );
    assert.equal(first.events[0]?.lifecycleStatus, "active");

    await fixture.app.conversation.runMemoryPending(fixture.roleId);
    assert.equal(calls, 2);
    const second = withStorage(fixture, (storage) => {
      const store = new MemoryStore(storage.business.db);
      return {
        latest: store.latestMaintenanceBatch(fixture.roleId),
        batches: storage.business.db
          .prepare(
            "SELECT status FROM memory_batches WHERE role_id = ? AND input_from_sequence = 0 AND input_to_sequence = 0 ORDER BY created_at ASC, rowid ASC",
          )
          .all(fixture.roleId) as Array<{ status: string }>,
      };
    });
    assert.deepEqual(second.batches.map((batch) => batch.status), [
      "failed",
      "failed",
    ]);
    assert.equal(second.latest?.status, "failed");
    assert.equal(second.latest?.attemptCount, 2);
  } finally {
    await fixture.close();
  }
});

test("refine candidates enter automatic maintenance when the round threshold is reached", { timeout: 20_000 }, async () => {
  let calls = 0;
  const inputs: MemoryFormationInput[] = [];
  const fixture = createFixture(
    [
      [
        { type: "text_delta", text: "第100轮回复" },
        { type: "completed", stopReason: "stop" },
      ],
    ],
    {
      disableMemoryRuntime: false,
      memoryModelFactory: () => ({
        async form(input: MemoryFormationInput) {
          calls += 1;
          inputs.push(input);
          return { operations: [] };
        },
      }),
      memoryIdleMs: 60_000,
    },
  );
  try {
    const seeded = seedRefineCandidate(fixture);
    withStorage(fixture, (storage) => {
      storage.business.db
        .prepare("UPDATE executions SET decision_round = 99 WHERE status = 'completed'")
        .run();
    });
    submitForMemory(fixture, "继续聊天完成第 100 轮");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const deadline = Date.now() + 5_000;
    while (calls === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(calls, 1);
    assert.equal(inputs[0]?.evidence.length, 0);
    assert.ok(
      inputs[0]?.refineCandidates.some(
        (candidate) => candidate.eventId === seeded.eventId,
      ),
    );
    const stored = withStorage(fixture, (storage) => {
      const store = new MemoryStore(storage.business.db);
      return {
        latest: store.latestMaintenanceBatch(fixture.roleId),
        pendingEvidence: store
          .listEvidence(fixture.roleId)
          .filter((item) => item.processingStatus !== "processed").length,
      };
    });
    assert.equal(stored.latest?.status, "completed");
    assert.ok(stored.pendingEvidence >= 2);
  } finally {
    await fixture.close();
  }
});

test("pending evidence and refine candidates share one maintenance input", { timeout: 20_000 }, async () => {
  const memoryModel = new ScriptedMemoryModel([{ operations: [] }]);
  const fixture = createFixture([]);
  try {
    const seeded = seedRefineCandidate(fixture);
    withStorage(fixture, (storage) => {
      const submitted = storage.business.submitMessage(
        fixture.roleId,
        fixture.windowId,
        {
          content: "今天又经过那条河。",
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
    });
    const storage = RoleStorage.openExisting(
      rolePaths(fixture.app.config.dataRoot, fixture.roleId),
    );
    try {
      const service = new MemoryService(
        new MemoryStore(storage.business.db),
        memoryModel,
        { timeZone: "Asia/Shanghai" },
      );
      const result = await service.runBatch(fixture.roleId, {
        includeRefinement: true,
      });
      assert.equal(result.status, "completed");
    } finally {
      storage.close();
    }
    assert.equal(memoryModel.requests.length, 1);
    assert.ok((memoryModel.requests[0]?.evidence.length ?? 0) > 0);
    assert.ok(
      memoryModel.requests[0]?.refineCandidates.some(
        (candidate) => candidate.eventId === seeded.eventId,
      ),
    );
  } finally {
    await fixture.close();
  }
});
