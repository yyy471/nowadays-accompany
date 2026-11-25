import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { MemoryService } from "../../src/application/memory/memory-service.js";
import { rebuildTransferMemorySearch } from "../../src/application/transfer/role-transfer-data.js";
import { localDateFromIso, registerMessageEvidence } from "../../src/storage/memory/evidence.js";
import { MemoryStore } from "../../src/storage/memory/memory-store.js";
import { RoleStore } from "../../src/storage/role/role-store.js";
import { BUSINESS_SCHEMA_VERSION, BUSINESS_SCHEMA_V1_SQL } from "../../src/storage/core/schema.js";
import { ScriptedMemoryModel } from "../../src/model/offline-memory.js";
import type { MemoryFormationInput } from "../../src/domain/memory.js";

interface RoleFixture {
  root: string;
  store: RoleStore;
  roleId: string;
  windowId: string;
}

function createRole(): RoleFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-02-"));
  const store = new RoleStore(path.join(root, "business.sqlite"), {
    timeZone: "Asia/Shanghai",
  });
  const created = store.createRoleRecord({
    roleId: randomUUID(),
    displayName: "记忆验证角色",
    definitionText: "一个会记录经历的角色。",
    definitionPayload: {},
    initialState: {},
  });
  return {
    root,
    store,
    roleId: created.role.roleId,
    windowId: created.window.windowId,
  };
}

function addMessage(
  fixture: RoleFixture,
  content: string,
  createdAt: string,
  windowId = fixture.windowId,
): string {
  const result = fixture.store.submitMessage(
    fixture.roleId,
    windowId,
    {
      content,
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    },
  );
  fixture.store.db
    .prepare("UPDATE messages SET created_at = ?, updated_at = ? WHERE message_id = ?")
    .run(createdAt, createdAt, result.message.messageId);
  return result.message.messageId;
}

function registerMessages(
  fixture: RoleFixture,
  messageIds: readonly string[],
): void {
  registerMessageEvidence(fixture.store.db, {
    roleId: fixture.roleId,
    messageIds,
    executionId: null,
    timeZone: "Asia/Shanghai",
  });
}

function createService(
  fixture: RoleFixture,
  scripts: unknown[],
  options: {
    now?: () => Date;
    budgetChars?: number;
    retryDelaysMs?: readonly number[];
  } = {},
): { service: MemoryService; model: ScriptedMemoryModel; memory: MemoryStore } {
  const memory = new MemoryStore(fixture.store.db);
  const model = new ScriptedMemoryModel(scripts);
  const service = new MemoryService(memory, model, {
    timeZone: "Asia/Shanghai",
    budgetChars: options.budgetChars ?? 1000,
    outputReserveChars: 100,
    retryDelaysMs: options.retryDelaysMs ?? [1000],
    now: options.now ?? (() => new Date("2026-11-03T10:00:00.000Z")),
  });
  return { service, model, memory };
}

function createEventFromInput(input: MemoryFormationInput): unknown {
  const item = input.evidence[0];
  if (!item) {
    throw new Error("NO_EVIDENCE");
  }
  return {
    operations: [
      {
        op: "create_event",
        localKey: `event-${item.evidenceId.slice(0, 8)}`,
        title: `事件 ${item.evidenceId.slice(0, 8)}`,
        summary: `记录内容 ${item.evidenceId.slice(0, 8)}`,
        occurredAtStart: item.occurredAt,
        experienceDate: item.localDate,
        evidenceIds: [item.evidenceId],
      },
    ],
  };
}

test("v1 business database migrates to the current schema and backfills evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-02-migrate-"));
  const dbPath = path.join(root, "business.sqlite");
  const roleId = randomUUID();
  const windowId = randomUUID();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const db = new Database(dbPath);
  db.exec(BUSINESS_SCHEMA_V1_SQL);
  db.pragma("user_version = 1");
  const now = "2026-10-28T01:10:00.000Z";
  db.prepare(
    `INSERT INTO roles
     (role_id, display_name, definition_text, definition_payload_json,
      definition_revision, state_json, state_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, '{}', 1, ?, ?)`,
  ).run(roleId, "旧角色", "旧设定", "{}", now, now);
  db.prepare(
    `INSERT INTO windows (window_id, role_id, kind, source, created_at, updated_at)
     VALUES (?, ?, 'main', 'nowadays', ?, ?)`,
  ).run(windowId, roleId, now, now);
  db.prepare(
    `INSERT INTO messages
     (message_id, window_id, sender, content, source_platform, status, sequence,
      submission_id, submission_hash, created_at, updated_at)
     VALUES (?, ?, 'user', ?, 'nowadays', 'received', 1, ?, 'hash-user', ?, ?)`,
  ).run(userMessageId, windowId, "上周六去了杭州旧书店。", randomUUID(), now, now);
  db.prepare(
    `INSERT INTO messages
     (message_id, window_id, sender, content, source_platform, status, sequence,
      submission_id, submission_hash, created_at, updated_at)
     VALUES (?, ?, 'assistant', ?, 'nowadays', 'completed', 2, NULL, NULL, ?, ?)`,
  ).run(assistantMessageId, windowId, "你买到了那本植物书。", now, now);
  db.close();

  const store = new RoleStore(dbPath, {
    create: false,
    timeZone: "Asia/Shanghai",
  });
  try {
    assert.equal(store.schemaVersion, BUSINESS_SCHEMA_VERSION);
    const autonomyTables = store.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN
            ('autonomy_budget', 'autonomy_wakes', 'autonomy_activities',
             'autonomy_tool_reservations')
          ORDER BY name ASC`,
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(autonomyTables.map((row) => row.name), [
      "autonomy_activities",
      "autonomy_budget",
      "autonomy_tool_reservations",
      "autonomy_wakes",
    ]);
    const evidence = store.db
      .prepare(
        "SELECT source_id, source_status, local_date, role_sequence FROM evidence_records WHERE role_id = ? ORDER BY role_sequence ASC",
      )
      .all(roleId) as Array<{
      source_id: string;
      source_status: string;
      local_date: string;
      role_sequence: number;
    }>;
    assert.equal(evidence.length, 2);
    assert.deepEqual(
      evidence.map((row) => row.source_id),
      [userMessageId, assistantMessageId],
    );
    assert.deepEqual(
      evidence.map((row) => row.source_status),
      ["received", "completed"],
    );
    assert.deepEqual(
      evidence.map((row) => row.role_sequence),
      [1, 2],
    );
    assert.equal(evidence[0]?.local_date, "2026-10-28");
    const processing = store.db
      .prepare("SELECT status FROM evidence_processing ORDER BY evidence_id")
      .all() as Array<{ status: string }>;
    assert.deepEqual(processing.map((row) => row.status), ["pending", "pending"]);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migration rolls back when the search index cannot be validated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-02-fail-"));
  const dbPath = path.join(root, "business.sqlite");
  const db = new Database(dbPath);
  db.exec(BUSINESS_SCHEMA_V1_SQL);
  db.pragma("user_version = 1");
  db.exec("CREATE TABLE memory_search_fts (value TEXT)");
  db.close();

  assert.throws(
    () => new RoleStore(dbPath, { create: false, timeZone: "Asia/Shanghai" }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === "SCHEMA_MIGRATION_FAILED" &&
      /SCHEMA_TABLE_INVALID:memory_search_fts/.test(error.message),
  );
  const reopened = new Database(dbPath);
  try {
    assert.equal(reopened.pragma("user_version", { simple: true }), 1);
    const eventTable = reopened
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'memory_events'",
      )
      .get();
    assert.equal(eventTable, undefined);
  } finally {
    reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory batch creates an event from actual messages and indexes it", async () => {
  const fixture = createRole();
  try {
    const first = addMessage(fixture, "上周六我和小林去了杭州旧书店。", "2026-10-28T01:10:00.000Z");
    const second = addMessage(fixture, "店主说下个月会进一批旧地图。", "2026-10-28T01:12:00.000Z");
    registerMessages(fixture, [first, second]);
    const evidence = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId);
    assert.equal(evidence.length, 2);
    const evidenceIds = evidence.map((item) => item.evidenceId);
    const { service, model } = createService(fixture, [
      {
        operations: [
          {
            op: "create_event",
            localKey: "event-1",
            title: "杭州旧书店",
            summary: "角色和小林去了杭州旧书店，店主说下个月进旧地图。",
            subjectiveExperience: "角色觉得那天很安静。",
            occurredAtStart: "2026-10-28T01:10:00.000Z",
            occurredAtEnd: "2026-10-28T01:12:00.000Z",
            experienceDate: "2026-10-28",
            tags: {
              person: ["小林"],
              place: ["杭州"],
              topic: ["旧书店", "旧地图"],
            },
            evidenceIds,
          },
        ],
      },
    ]);
    const result = await service.runBatch(fixture.roleId);
    assert.equal(result.status, "completed", result.errorCode ?? "");
    assert.equal(result.operations, 1);
    assert.equal(model.requests.length, 1);
    const modelEvidence = model.requests[0]?.evidence ?? [];
    assert.equal(modelEvidence.length, 2);
    assert.deepEqual(
      modelEvidence.map((item) => item.segmentIndex),
      [0, 0],
    );
    assert.deepEqual(
      modelEvidence.map((item) => item.segmentCount),
      [1, 1],
    );

    const memory = new MemoryStore(fixture.store.db);
    const events = memory.listEvents(fixture.roleId);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.title, "杭州旧书店");
    assert.equal(event.version, 1);
    const tags = memory.getTags(event.eventId);
    assert.deepEqual(tags.person, ["小林"]);
    assert.deepEqual(tags.place, ["杭州"]);
    const search = memory.getSearchDocument(fixture.roleId, "event", event.eventId);
    assert.ok(search);
    assert.match(search.body, /旧地图/);
    const processed = memory
      .listEvidence(fixture.roleId)
      .every((item) => item.processingStatus === "processed");
    assert.equal(processed, true);
    const sourceCount = (
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM memory_event_sources WHERE event_id = ?")
        .get(event.eventId) as { count: number }
    ).count;
    assert.equal(sourceCount, 2);
    const revisionCount = (
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM memory_revisions WHERE target_id = ?")
        .get(event.eventId) as { count: number }
    ).count;
    assert.equal(revisionCount, 1);
    const modelCalls = fixture.store.db
      .prepare("SELECT status, purpose, batch_id FROM model_calls")
      .all() as Array<{ status: string; purpose: string; batch_id: string }>;
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0]?.status, "succeeded");
    assert.equal(modelCalls[0]?.purpose, "memory_maintenance");
    const metering = fixture.store.db
      .prepare("SELECT counted, purpose FROM call_metering")
      .all() as Array<{ counted: number; purpose: string }>;
    assert.deepEqual(metering, [{ counted: 0, purpose: "memory_maintenance" }]);
    const fts = fixture.store.db
      .prepare(
        `SELECT d.record_id FROM memory_search_fts f
         JOIN memory_search_documents d ON d.document_id = f.rowid
         WHERE memory_search_fts MATCH ? AND d.role_id = ?`,
      )
      .all("旧书店", fixture.roleId) as Array<{ record_id: string }>;
    assert.deepEqual(fts.map((row) => row.record_id), [event.eventId]);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a later batch supplements the same event with a new version", async () => {
  const fixture = createRole();
  try {
    const first = addMessage(fixture, "上周六去了杭州旧书店。", "2026-10-28T01:10:00.000Z");
    registerMessages(fixture, [first]);
    const firstEvidence = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId)[0];
    assert.ok(firstEvidence);
    const firstRun = createService(fixture, [
      {
        operations: [
          {
            op: "create_event",
            localKey: "event-1",
            title: "杭州旧书店",
            summary: "角色去了杭州旧书店。",
            occurredAtStart: "2026-10-28T01:10:00.000Z",
            experienceDate: "2026-10-28",
            tags: { place: ["杭州"] },
            evidenceIds: [firstEvidence.evidenceId],
          },
        ],
      },
    ]);
    assert.equal((await firstRun.service.runBatch(fixture.roleId)).status, "completed");
    const event = firstRun.memory.listEvents(fixture.roleId)[0];
    assert.ok(event);

    const second = addMessage(fixture, "补充：隔壁还有一家卖旧地图的小店。", "2026-10-29T12:05:00.000Z");
    registerMessages(fixture, [second]);
    const secondEvidence = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId)[1];
    assert.ok(secondEvidence);
    const secondRun = createService(fixture, [
      {
        operations: [
          {
            op: "update_event",
            eventId: event.eventId,
            expectedVersion: 1,
            patch: {
              summary: "角色去了杭州旧书店，隔壁还有卖旧地图的小店。",
              tags: { topic: ["旧地图"] },
            },
            addEvidenceIds: [secondEvidence.evidenceId],
            reason: "后续记录补充同一经历",
          },
        ],
      },
    ]);
    const result = await secondRun.service.runBatch(fixture.roleId);
    assert.equal(result.status, "completed");
    const updated = secondRun.memory.listEvents(fixture.roleId)[0];
    assert.ok(updated);
    assert.equal(updated.version, 2);
    assert.match(updated.summary, /旧地图/);
    assert.deepEqual(secondRun.memory.getTags(updated.eventId).topic, ["旧地图"]);
    const sources = (
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM memory_event_sources WHERE event_id = ?")
        .get(updated.eventId) as { count: number }
    ).count;
    assert.equal(sources, 2);
    const revisions = (
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM memory_revisions WHERE target_id = ?")
        .get(updated.eventId) as { count: number }
    ).count;
    assert.equal(revisions, 2);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("invalid model output keeps evidence failed and retries without duplicates", async () => {
  const fixture = createRole();
  try {
    const messageId = addMessage(fixture, "今天整理了一份旧地图。", "2026-10-30T02:00:00.000Z");
    registerMessages(fixture, [messageId]);
    let now = new Date("2026-11-03T10:00:00.000Z");
    const evidence = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId)[0];
    assert.ok(evidence);
    const failedRun = createService(fixture, [{ unexpected: true }], {
      now: () => now,
    });
    const failed = await failedRun.service.runBatch(fixture.roleId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "MEMORY_OPERATION_INVALID");
    let processing = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId)[0];
    assert.equal(processing?.processingStatus, "failed");
    const failedBatch = fixture.store.db
      .prepare("SELECT status, last_error_code FROM memory_batches ORDER BY created_at DESC LIMIT 1")
      .get() as { status: string; last_error_code: string };
    assert.equal(failedBatch.status, "failed");
    assert.equal(failedBatch.last_error_code, "MEMORY_OPERATION_INVALID");

    now = new Date("2026-11-03T10:00:02.000Z");
    const retryRun = createService(fixture, [
      {
        operations: [
          {
            op: "create_event",
            localKey: "retry-event",
            title: "整理旧地图",
            summary: "角色整理了一份旧地图。",
            occurredAtStart: "2026-10-30T02:00:00.000Z",
            experienceDate: "2026-10-30",
            evidenceIds: [evidence.evidenceId],
          },
        ],
      },
    ], { now: () => now });
    const retried = await retryRun.service.runBatch(fixture.roleId);
    assert.equal(retried.status, "completed");
    const memory = new MemoryStore(fixture.store.db);
    assert.equal(memory.listEvents(fixture.roleId).length, 1);
    processing = memory.listEvidence(fixture.roleId)[0];
    assert.equal(processing?.processingStatus, "processed");
    assert.equal(memory.listEvidence(fixture.roleId).length, 1);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("long evidence is segmented and processed in order", async () => {
  const fixture = createRole();
  try {
    const content = "一".repeat(25);
    const messageId = addMessage(fixture, content, "2026-10-31T02:00:00.000Z");
    registerMessages(fixture, [messageId]);
    const { service, model } = createService(
      fixture,
      [{ operations: [] }, { operations: [] }, { operations: [] }],
      { budgetChars: 10 },
    );
    const result = await service.runBatch(fixture.roleId);
    assert.equal(result.status, "completed");
    assert.deepEqual(
      model.requests.map((request) => request.evidence[0]?.segmentIndex),
      [0, 1, 2],
    );
    assert.deepEqual(
      model.requests.map((request) => request.evidence[0]?.content.length),
      [10, 10, 5],
    );
    const memory = new MemoryStore(fixture.store.db);
    assert.equal(
      memory.listEvidence(fixture.roleId)[0]?.processingStatus,
      "processed",
    );
    const segmentCount = (
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM memory_evidence_segments")
        .get() as { count: number }
    ).count;
    assert.equal(segmentCount, 3);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("batches keep raw history from different windows separate", async () => {
  const fixture = createRole();
  try {
    const mainMessage = addMessage(
      fixture,
      "主窗口：周末去了杭州旧书店。",
      "2026-10-28T01:10:00.000Z",
    );
    const travelWindow = fixture.store.createWindow({
      roleId: fixture.roleId,
      kind: "custom",
      source: "nowadays",
    });
    const travelMessage = addMessage(
      fixture,
      "旅行窗口：旧地图到货了。",
      "2026-10-29T02:00:00.000Z",
      travelWindow.windowId,
    );
    registerMessages(fixture, [mainMessage, travelMessage]);
    const evidence = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId);
    const mainEvidence = evidence.find((item) => item.sourceId === mainMessage);
    const travelEvidence = evidence.find((item) => item.sourceId === travelMessage);
    assert.ok(mainEvidence);
    assert.ok(travelEvidence);
    const { service, model } = createService(fixture, [
      createEventFromInput,
      createEventFromInput,
    ]);
    const result = await service.runPending(fixture.roleId);
    assert.equal(result.status, "completed");
    assert.equal(result.batches.length, 2);
    assert.deepEqual(
      model.requests.map((request) =>
        request.evidence.map((item) => item.evidenceId),
      ),
      [[mainEvidence.evidenceId], [travelEvidence.evidenceId]],
    );
    assert.deepEqual(
      model.requests.map((request) => request.evidence[0]?.windowId),
      [fixture.windowId, travelWindow.windowId],
    );
    assert.equal(
      new MemoryStore(fixture.store.db).listEvents(fixture.roleId).length,
      2,
    );
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("batch input capacity splits evidence into consecutive batches", async () => {
  const fixture = createRole();
  try {
    const first = addMessage(fixture, "一".repeat(6), "2026-10-31T01:00:00.000Z");
    const second = addMessage(fixture, "二".repeat(6), "2026-10-31T02:00:00.000Z");
    registerMessages(fixture, [first, second]);
    const evidence = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId);
    const { service, model } = createService(
      fixture,
      [{ operations: [] }, { operations: [] }],
      { budgetChars: 10 },
    );
    const result = await service.runPending(fixture.roleId);
    assert.equal(result.status, "completed");
    assert.equal(result.batches.length, 2);
    assert.deepEqual(
      model.requests.map((request) => request.evidence.length),
      [1, 1],
    );
    assert.deepEqual(
      model.requests.map((request) => request.evidence[0]?.evidenceId),
      evidence.map((item) => item.evidenceId),
    );
    const processing = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId);
    assert.deepEqual(
      processing.map((item) => item.processingStatus),
      ["processed", "processed"],
    );
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("evidence registered during a running batch waits for the next batch", async () => {
  const fixture = createRole();
  try {
    const first = addMessage(fixture, "先保存的消息", "2026-10-31T01:00:00.000Z");
    registerMessages(fixture, [first]);
    let lateMessageId = "";
    const firstScript = (): unknown => {
      lateMessageId = addMessage(
        fixture,
        "整理期间新保存的消息",
        "2026-10-31T03:00:00.000Z",
      );
      registerMessages(fixture, [lateMessageId]);
      return { operations: [] };
    };
    const { service, model } = createService(fixture, [
      firstScript,
      { operations: [] },
    ]);
    const result = await service.runPending(fixture.roleId);
    assert.equal(result.status, "completed");
    assert.equal(result.batches.length, 2);
    assert.equal(
      model.requests.map((request) =>
        request.evidence.map((item) => item.evidenceId),
      ).length,
      2,
    );
    const evidence = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId);
    const firstEvidence = evidence.find((item) => item.sourceId === first);
    const lateEvidence = evidence.find((item) => item.sourceId === lateMessageId);
    assert.ok(firstEvidence);
    assert.ok(lateEvidence);
    assert.deepEqual(model.requests[0]?.evidence.map((item) => item.evidenceId), [
      firstEvidence.evidenceId,
    ]);
    assert.deepEqual(model.requests[1]?.evidence.map((item) => item.evidenceId), [
      lateEvidence.evidenceId,
    ]);
    assert.equal(firstEvidence.processingStatus, "processed");
    assert.equal(lateEvidence.processingStatus, "processed");
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed batches retry after 30 seconds, 2 minutes, 10 minutes and then hourly", async () => {
  const fixture = createRole();
  try {
    const messageId = addMessage(
      fixture,
      "用于重试退避的消息",
      "2026-10-30T02:00:00.000Z",
    );
    registerMessages(fixture, [messageId]);
    let now = new Date("2026-11-03T10:00:00.000Z");
    const memory = new MemoryStore(fixture.store.db);
    const model = new ScriptedMemoryModel([
      { invalid: 1 },
      { invalid: 2 },
      { invalid: 3 },
      { invalid: 4 },
      { invalid: 5 },
    ]);
    const service = new MemoryService(memory, model, {
      timeZone: "Asia/Shanghai",
      now: () => now,
    });
    const delays = [30_000, 120_000, 600_000, 3_600_000, 3_600_000];
    for (const [index, delay] of delays.entries()) {
      const result = await service.runBatch(fixture.roleId);
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "MEMORY_OPERATION_INVALID");
      const row = fixture.store.db
        .prepare(
          "SELECT next_retry_at, attempt_count FROM evidence_processing",
        )
        .get() as { next_retry_at: string; attempt_count: number };
      assert.equal(
        row.next_retry_at,
        new Date(now.getTime() + delay).toISOString(),
      );
      assert.equal(row.attempt_count, index + 1);
      now = new Date(now.getTime() + delay - 1000);
      const early = await service.runBatch(fixture.roleId);
      assert.equal(early.status, "none");
      now = new Date(now.getTime() + 1000);
    }
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("stale update version rejects the whole sub-batch without partial writes", async () => {
  const fixture = createRole();
  try {
    let now = new Date("2026-11-03T10:00:00.000Z");
    const first = addMessage(
      fixture,
      "上周六去了杭州旧书店。",
      "2026-10-28T01:10:00.000Z",
    );
    registerMessages(fixture, [first]);
    const firstEvidence = new MemoryStore(fixture.store.db).listEvidence(
      fixture.roleId,
    )[0];
    assert.ok(firstEvidence);
    const firstRun = createService(fixture, [
      {
        operations: [
          {
            op: "create_event",
            localKey: "event-1",
            title: "杭州旧书店",
            summary: "角色去了杭州旧书店。",
            occurredAtStart: "2026-10-28T01:10:00.000Z",
            experienceDate: "2026-10-28",
            evidenceIds: [firstEvidence.evidenceId],
          },
        ],
      },
    ], { now: () => now });
    assert.equal((await firstRun.service.runBatch(fixture.roleId)).status, "completed");
    const event = firstRun.memory.listEvents(fixture.roleId)[0];
    assert.ok(event);

    const second = addMessage(
      fixture,
      "补充：隔壁还有一家卖旧地图的小店。",
      "2026-10-29T12:05:00.000Z",
    );
    registerMessages(fixture, [second]);
    const secondEvidence = new MemoryStore(fixture.store.db)
      .listEvidence(fixture.roleId)
      .find((item) => item.sourceId === second);
    assert.ok(secondEvidence);
    const conflicting = createService(
      fixture,
      [
        {
          operations: [
            {
              op: "create_event",
              localKey: "should-roll-back",
              title: "不应保存的事件",
              summary: "这个事件应随子批一起回滚。",
              occurredAtStart: "2026-10-29T12:05:00.000Z",
              experienceDate: "2026-10-29",
              evidenceIds: [secondEvidence.evidenceId],
            },
            {
              op: "update_event",
              eventId: event.eventId,
              expectedVersion: event.version + 5,
              patch: { summary: "过期版本不应写入。" },
            },
          ],
        },
      ],
      { now: () => now },
    );
    const failed = await conflicting.service.runBatch(fixture.roleId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "MEMORY_OPERATION_INVALID");
    const afterFailure = conflicting.memory.listEvents(fixture.roleId);
    assert.equal(afterFailure.length, 1);
    assert.equal(afterFailure[0]?.version, 1);
    const processing = new MemoryStore(fixture.store.db)
      .listEvidence(fixture.roleId)
      .find((item) => item.sourceId === second);
    assert.equal(processing?.processingStatus, "failed");

    now = new Date(now.getTime() + 2000);
    const retry = createService(
      fixture,
      [
        {
          operations: [
            {
              op: "update_event",
              eventId: event.eventId,
              expectedVersion: 1,
              patch: { summary: "角色去了杭州旧书店，隔壁还有卖旧地图的小店。" },
              addEvidenceIds: [secondEvidence.evidenceId],
            },
          ],
        },
      ],
      { now: () => now },
    );
    const retried = await retry.service.runBatch(fixture.roleId);
    assert.equal(retried.status, "completed");
    assert.equal(retry.memory.listEvents(fixture.roleId)[0]?.version, 2);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("saved tool results form events from their original evidence", async () => {
  const fixture = createRole();
  try {
    const task = fixture.store.createTask({
      roleId: fixture.roleId,
      goal: "整理旧地图目录",
    });
    const execution = fixture.store.createExecution({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      triggerType: "user_message",
    });
    fixture.store.linkExecutionTask({
      roleId: fixture.roleId,
      executionId: execution.executionId,
      taskId: task.taskId,
      relation: "initiates",
    });
    const call = fixture.store.beginToolCall({
      roleId: fixture.roleId,
      taskId: task.taskId,
      executionId: execution.executionId,
      stepKey: "tool-result-memory",
      toolName: "local_note_write",
      args: { path: "maps.md" },
    });
    fixture.store.saveToolResult({
      roleId: fixture.roleId,
      toolCallId: call.toolCall.toolCallId,
      status: "success",
      rawResponse: { saved: true, summary: "旧地图目录已整理" },
    });
    const toolEvidence = new MemoryStore(fixture.store.db)
      .listEvidence(fixture.roleId)
      .find((item) => item.sourceKind === "tool_result");
    assert.ok(toolEvidence);
    const { service, model } = createService(fixture, [
      (input: MemoryFormationInput) => {
        const item = input.evidence[0];
        assert.ok(item);
        assert.equal(item.sourceKind, "tool_result");
        return {
          operations: [
            {
              op: "create_event",
              localKey: "tool-event",
              title: "整理旧地图目录",
              summary: "工具结果记录了旧地图目录已整理。",
              occurredAtStart: item.occurredAt,
              experienceDate: item.localDate,
              evidenceIds: [item.evidenceId],
            },
          ],
        };
      },
    ]);
    const result = await service.runBatch(fixture.roleId);
    assert.equal(result.status, "completed");
    const memory = new MemoryStore(fixture.store.db);
    const events = memory.listEvents(fixture.roleId);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event);
    const sources = fixture.store.db
      .prepare(
        "SELECT evidence_id FROM memory_event_sources WHERE event_id = ?",
      )
      .all(event.eventId) as Array<{ evidence_id: string }>;
    assert.deepEqual(sources.map((row) => row.evidence_id), [
      toolEvidence.evidenceId,
    ]);
    assert.equal(model.requests[0]?.evidence[0]?.sourceKind, "tool_result");
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("deferred evidence waits for newer records and then joins the next batch", async () => {
  const fixture = createRole();
  try {
    const first = addMessage(
      fixture,
      "信息还不完整的记录",
      "2026-10-31T01:00:00.000Z",
    );
    const second = addMessage(
      fixture,
      "同一批里的完整记录",
      "2026-10-31T01:05:00.000Z",
    );
    registerMessages(fixture, [first, second]);
    const evidence = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId);
    const firstEvidence = evidence.find((item) => item.sourceId === first);
    const secondEvidence = evidence.find((item) => item.sourceId === second);
    assert.ok(firstEvidence);
    assert.ok(secondEvidence);
    const firstRun = createService(fixture, [
      {
        operations: [
          {
            op: "defer",
            evidenceIds: [firstEvidence.evidenceId],
            reason: "等信息补充",
          },
        ],
      },
    ]);
    assert.equal((await firstRun.service.runBatch(fixture.roleId)).status, "completed");
    const afterDefer = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId);
    assert.equal(
      afterDefer.find((item) => item.evidenceId === firstEvidence.evidenceId)
        ?.processingStatus,
      "deferred",
    );
    assert.equal(
      afterDefer.find((item) => item.evidenceId === secondEvidence.evidenceId)
        ?.processingStatus,
      "processed",
    );
    const idle = await firstRun.service.runBatch(fixture.roleId);
    assert.equal(idle.status, "none");

    const third = addMessage(
      fixture,
      "补充的后续记录",
      "2026-10-31T02:00:00.000Z",
    );
    registerMessages(fixture, [third]);
    const secondRun = createService(fixture, [createEventFromInput]);
    const result = await secondRun.service.runBatch(fixture.roleId);
    assert.equal(result.status, "completed");
    const finalEvidence = new MemoryStore(fixture.store.db).listEvidence(
      fixture.roleId,
    );
    assert.deepEqual(
      finalEvidence.map((item) => item.processingStatus),
      ["processed", "processed", "processed"],
    );
    const event = secondRun.memory.listEvents(fixture.roleId)[0];
    assert.ok(event);
    const sources = fixture.store.db
      .prepare(
        "SELECT evidence_id FROM memory_event_sources WHERE event_id = ?",
      )
      .all(event.eventId) as Array<{ evidence_id: string }>;
    assert.deepEqual(sources.map((row) => row.evidence_id), [
      firstEvidence.evidenceId,
    ]);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("tool result evidence updates its source status when unknown is reconciled", () => {
  const fixture = createRole();
  try {
    const task = fixture.store.createTask({
      roleId: fixture.roleId,
      goal: "补录工具状态",
    });
    const execution = fixture.store.createExecution({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      triggerType: "user_message",
    });
    fixture.store.linkExecutionTask({
      roleId: fixture.roleId,
      executionId: execution.executionId,
      taskId: task.taskId,
      relation: "initiates",
    });
    const call = fixture.store.beginToolCall({
      roleId: fixture.roleId,
      taskId: task.taskId,
      executionId: execution.executionId,
      stepKey: "unknown-reconcile",
      toolName: "local_note_write",
      args: { path: "note.md" },
    });
    fixture.store.saveToolResult({
      roleId: fixture.roleId,
      toolCallId: call.toolCall.toolCallId,
      status: "unknown",
    });
    let evidence = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.sourceStatus, "unknown");
    fixture.store.saveToolResult({
      roleId: fixture.roleId,
      toolCallId: call.toolCall.toolCallId,
      status: "success",
      rawResponse: { saved: true },
    });
    evidence = new MemoryStore(fixture.store.db).listEvidence(fixture.roleId);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.sourceStatus, "success");
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a role only allows one running memory batch", async () => {
  const fixture = createRole();
  try {
    const messageId = addMessage(
      fixture,
      "并发批次消息",
      "2026-10-31T01:00:00.000Z",
    );
    registerMessages(fixture, [messageId]);
    const memory = new MemoryStore(fixture.store.db);
    const started = memory.startBatch({
      roleId: fixture.roleId,
      budgetChars: 1000,
      outputReserveChars: 100,
    });
    assert.ok(started);
    assert.throws(
      () =>
        memory.startBatch({
          roleId: fixture.roleId,
          budgetChars: 1000,
          outputReserveChars: 100,
        }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === "MEMORY_BATCH_CONFLICT",
    );
    const { service } = createService(fixture, []);
    const conflict = await service.runBatch(fixture.roleId);
    assert.equal(conflict.status, "none");
    assert.equal(conflict.errorCode, "MEMORY_BATCH_CONFLICT");
    memory.finishBatch({
      roleId: fixture.roleId,
      batchId: started.batch.batchId,
      status: "completed",
    });
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("message thresholds stay at 50 and idle stays at 60 seconds", () => {
  const first = createRole();
  const second = createRole();
  try {
    const thresholdTime = "2026-11-03T09:00:00.000Z";
    const fortyNine = Array.from({ length: 49 }, (_, index) =>
      addMessage(first, `阈值消息 ${index + 1}`, thresholdTime),
    );
    registerMessages(first, fortyNine);
    const firstService = createService(first, [], {
      now: () => new Date("2026-11-03T09:00:59.000Z"),
    });
    firstService.service.onEvidenceRegistered(first.roleId);
    assert.equal(
      secondServiceCount(first),
      0,
    );

    const fiftieth = addMessage(
      first,
      "阈值消息 50",
      "2026-11-03T09:00:59.000Z",
    );
    registerMessages(first, [fiftieth]);
    firstService.service.onEvidenceRegistered(first.roleId);
    const triggers = firstService.memory.listPendingTriggers(first.roleId);
    assert.deepEqual(
      triggers.map((trigger) => trigger.kind),
      ["message_threshold"],
    );

    const thirty = Array.from({ length: 30 }, (_, index) =>
      addMessage(second, `空闲消息 ${index + 1}`, thresholdTime),
    );
    registerMessages(second, thirty);
    const secondService = createService(second, [], {
      now: () => new Date("2026-11-03T09:00:59.000Z"),
    });
    secondService.service.checkIdle(second.roleId);
    assert.equal(secondServiceCount(second), 0);
    secondService.service.checkIdle(
      second.roleId,
      new Date("2026-11-03T09:01:00.000Z"),
    );
    assert.deepEqual(
      secondService.memory
        .listPendingTriggers(second.roleId)
        .map((trigger) => trigger.kind),
      ["idle"],
    );
  } finally {
    first.store.close();
    second.store.close();
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(second.root, { recursive: true, force: true });
  }

  function secondServiceCount(fixture: RoleFixture): number {
    return new MemoryStore(fixture.store.db).listPendingTriggers(fixture.roleId)
      .length;
  }
});

test("message thresholds, idle trigger and task-end trigger are registered", () => {
  const fixture = createRole();
  try {
    const messageIds = Array.from({ length: 50 }, (_, index) =>
      addMessage(
        fixture,
        `第 ${index + 1} 条待整理消息`,
        "2026-11-03T09:00:00.000Z",
      ),
    );
    registerMessages(fixture, messageIds);
    const { service, memory } = createService(fixture, []);
    service.onEvidenceRegistered(fixture.roleId);
    const triggers = memory.listPendingTriggers(fixture.roleId);
    assert.ok(triggers.some((trigger) => trigger.kind === "message_threshold"));
    assert.ok(triggers.some((trigger) => trigger.kind === "idle"));

    const task = fixture.store.createTask({ roleId: fixture.roleId, goal: "整理工具结果" });
    const execution = fixture.store.createExecution({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      triggerType: "user_message",
    });
    fixture.store.linkExecutionTask({
      roleId: fixture.roleId,
      executionId: execution.executionId,
      taskId: task.taskId,
      relation: "initiates",
    });
    const call = fixture.store.beginToolCall({
      roleId: fixture.roleId,
      taskId: task.taskId,
      executionId: execution.executionId,
      stepKey: "task-end-step",
      toolName: "local_note_write",
      args: { path: "note.md" },
    });
    fixture.store.saveToolResult({
      roleId: fixture.roleId,
      toolCallId: call.toolCall.toolCallId,
      status: "success",
      rawResponse: { saved: true },
    });
    fixture.store.finishTask({
      roleId: fixture.roleId,
      taskId: task.taskId,
      status: "completed",
      endReason: "完成",
    });
    service.onTaskFinished(fixture.roleId, task.taskId);
    const afterTask = memory.listPendingTriggers(fixture.roleId);
    assert.ok(afterTask.some((trigger) => trigger.kind === "task_end"));
    const toolEvidence = memory
      .listEvidence(fixture.roleId)
      .find((item) => item.sourceKind === "tool_result");
    assert.ok(toolEvidence);
    assert.equal(toolEvidence.taskId, task.taskId);
    assert.equal(toolEvidence.executionId, execution.executionId);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("no threshold trigger below the 50-message boundary", () => {
  const fixture = createRole();
  try {
    const messageIds = Array.from({ length: 29 }, (_, index) =>
      addMessage(fixture, `边界消息 ${index + 1}`, "2026-11-03T09:30:00.000Z"),
    );
    registerMessages(fixture, messageIds);
    const { service, memory } = createService(fixture, [], {
      now: () => new Date("2026-11-03T10:00:00.000Z"),
    });
    service.onEvidenceRegistered(fixture.roleId);
    const triggers = memory.listPendingTriggers(fixture.roleId);
    assert.equal(
      triggers.some((trigger) => trigger.kind === "message_threshold"),
      false,
    );
    assert.equal(triggers.some((trigger) => trigger.kind === "idle"), false);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("claims preserve the speaker, partial knowledge and a cherished one-time detail across revisions", async () => {
  const fixture = createRole();
  const at = "2026-10-28T01:10:00.000Z";
  try {
    const quote = "那年是我姐姐喜欢栀子花。";
    registerMessages(fixture, [addMessage(fixture, quote, at)]);
    const memory = new MemoryStore(fixture.store.db);
    const evidenceId = memory.listEvidence(fixture.roleId)[0]!.evidenceId;
    const common = {
      op: "create_event", localKey: "flower", title: "栀子花", summary: "说起那年的花",
      occurredAtStart: at, experienceDate: "2026-10-28", evidenceIds: [evidenceId],
    };
    const claims = [
      { kind: "user_quote", text: "喜欢栀子花", evidenceId },
      { kind: "cherished_detail", text: "栀子花与姐姐的联结", evidenceId },
      { kind: "unknown", text: "姐姐今天是否仍然喜欢", evidenceId },
    ];
    const first = createService(fixture, [{ operations: [{ ...common, claims }] }]);
    assert.equal((await first.service.runBatch(fixture.roleId)).status, "completed");
    assert.equal(first.model.requests[0]?.evidence[0]?.sender, "user");
    const event = memory.listEvents(fixture.roleId)[0]!;
    assert.equal(memory.getEvidenceDetail(fixture.roleId, evidenceId).sender, "user");
    assert.deepEqual(memory.listEventClaims(fixture.roleId, event.eventId).map(c => c.learnedAt), [at, at, null]);
    assert.equal(memory.listEventClaims(fixture.roleId, event.eventId)[0]?.quoteContext, quote);
    assert.deepEqual(memory.listRefineCandidates(fixture.roleId, 500).map(item => item.eventId), [event.eventId]);
    assert.match(memory.getSearchDocument(fixture.roleId, "event", event.eventId)!.body, /姐姐的联结/);

    const later = "2026-11-01T08:00:00.000Z";
    const reply = addMessage(fixture, "我还记得你说起的栀子花。", later);
    fixture.store.db.prepare("UPDATE messages SET sender = 'assistant', status = 'completed' WHERE message_id = ?").run(reply);
    registerMessages(fixture, [reply]);
    const secondId = memory.listEvidence(fixture.roleId).find(item => item.sourceId === reply)!.evidenceId;
    const second = createService(fixture, [{ operations: [{
      op: "update_event", eventId: event.eventId, expectedVersion: 1, patch: {}, addEvidenceIds: [secondId],
      claims: [
        { kind: "shared_detail", text: "我还记得你说起的栀子花。", evidenceId: secondId },
        { kind: "reflection", text: "如今懂得这是姐姐的回忆", evidenceId: secondId },
      ],
    }] }]);
    assert.equal((await second.service.runBatch(fixture.roleId)).status, "completed");
    const saved = memory.listEventClaims(fixture.roleId, event.eventId);
    assert.equal(saved.length, 5);
    assert.equal(saved[4]?.sourceAt, later);
    assert.equal(saved[4]?.learnedAt, later);
    assert.equal(saved[4]?.recordedAt, "2026-11-03T10:00:00.000Z");
    assert.equal(saved[0]?.sourceSender, "user");
    assert.equal(saved[4]?.sourceSender, "assistant");
    assert.match(memory.getSearchDocument(fixture.roleId, "event", event.eventId)!.body, /据角色当时的发言） 如今懂得/);
    assert.deepEqual(memory.listEventSources(fixture.roleId, event.eventId).map(item => item.sender), ["user", "assistant"]);
    const refined = memory.refineEvent({roleId:fixture.roleId,events:[{eventId:event.eventId,expectedVersion:2}],
      summary:"谈到一种花和家人的联结。",now:"2026-12-01T12:00:00.000Z"});
    for (const rebuild of [false,true]) {
      if (rebuild) {
        fixture.store.db.exec("DELETE FROM memory_search_documents");
        rebuildTransferMemorySearch(fixture.store.db);
      }
      const doc = memory.getSearchDocument(fixture.roleId,"event",event.eventId)!;
      assert.match(doc.body,/栀子花与姐姐的联结/);
      assert.doesNotMatch(doc.body,/如今懂得|说起那年的花|姐姐今天是否仍然喜欢/);
      assert.ok(memory.getSearchDocument(fixture.roleId,"daily_summary",refined.summary.summaryId));
      assert.equal(memory.getEvidenceDetail(fixture.roleId,evidenceId).content,quote);
      assert.equal(memory.listEventClaims(fixture.roleId,event.eventId).length,5);
    }
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("formation rejects invented quotations and misattributed assistant quotes atomically", async () => {
  for (const sender of ["user", "assistant"]) {
    const fixture = createRole();
    try {
      const at = "2026-10-28T01:10:00.000Z";
      const id = addMessage(fixture, "那年是我姐姐喜欢栀子花。", at);
      fixture.store.db.prepare("UPDATE messages SET sender = ? WHERE message_id = ?").run(sender, id);
      registerMessages(fixture, [id]);
      const memory = new MemoryStore(fixture.store.db);
      const evidenceId = memory.listEvidence(fixture.roleId)[0]!.evidenceId;
      const { service } = createService(fixture, [{ operations: [{
        op: "create_event", localKey: "flower", title: "栀子花", summary: "回忆",
        occurredAtStart: at, experienceDate: "2026-10-28", evidenceIds: [evidenceId],
        claims: [{ kind: "user_quote", text: sender === "user" ? "我一直喜欢栀子花。" : "那年是我姐姐喜欢栀子花。", evidenceId }],
      }] }]);
      assert.equal((await service.runBatch(fixture.roleId)).status, "failed");
      assert.deepEqual(memory.listEvents(fixture.roleId), []);
    } finally {
      fixture.store.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("old growth episodes return by topic and later evidence revises a scoped practice", async () => {
  const fixture = createRole();
  try {
    const at = "2026-10-28T01:10:00.000Z";
    const later = "2026-11-02T08:00:00.000Z";
    registerMessages(fixture, [addMessage(fixture, "旧书估价看版次，核对后查出了误差。", at)]);
    const memory = new MemoryStore(fixture.store.db);
    const evidenceId = memory.listEvidence(fixture.roleId)[0]!.evidenceId;
    const first = createService(fixture, [{ operations: [{
      op: "create_event", localKey: "pricing", title: "辨别版本", summary: "一次估价经历",
      tags: { topic: ["旧书估价"] }, occurredAtStart: at, experienceDate: "2026-10-28",
      evidenceIds: [evidenceId], claims: [{
        kind: "practice", text: "先看版次", practice: { key: "版本核对", scope: "旧书估价", outcome: "解释了价差" }, evidenceId,
      }, { kind: "interest", text: "好奇扉页落款是谁", evidenceId }],
    }] }]);
    assert.equal((await first.service.runBatch(fixture.roleId)).status, "completed");
    const eventId = memory.listEvents(fixture.roleId)[0]!.eventId;
    for (let i = 0; i < 21; i++) {
      memory.createEvent({
        roleId: fixture.roleId, title: "散步" + i, summary: "沿河岸散步", subjectiveExperience: "",
        occurredAtStart: later, occurredAtEnd: null, experienceDate: "2026-11-02", tags: {},
        evidenceIds: [], currentRound: 2, now: "2026-11-05T00:00:00.000Z",
      });
    }
    assert.ok(!memory.listRecentEvents(fixture.roleId).some(item => item.eventId === eventId));
    const source = addMessage(fixture, "旧书估价时，补拍版权页才分清印次。", later);
    registerMessages(fixture, [source]);
    const nextId = memory.listEvidence(fixture.roleId).find(item => item.sourceId === source)!.evidenceId;
    const second = createService(fixture, [{ operations: [{
      op: "update_event", eventId, expectedVersion: 1, patch: {}, addEvidenceIds: [nextId],
      claims: [{ kind: "practice", text: "先核对版权页", practice: {
        key: "版本核对", scope: "版权页不清时请补拍", outcome: "分清了印次",
      }, evidenceId: nextId }],
    }, {
      op: "create_event", localKey: "new-interest", title: "查扉页的落款", summary: "重拾旧书上的疑问",
      occurredAtStart: later, experienceDate: "2026-11-02", evidenceIds: [nextId],
      claims: [{ kind: "reflection", text: "从估价经历追溯疑问的起点", relatedEventId: eventId, evidenceId: nextId }],
    }] }]);
    assert.equal((await second.service.runBatch(fixture.roleId)).status, "completed");
    assert.deepEqual(second.model.requests[0]?.relatedEvents[0]?.practiceKeys, ["版本核对"]);
    const searchBody = memory.getSearchDocument(fixture.roleId, "event", eventId)!.body;
    assert.match(searchBody, /版权页不清时请补拍/);
    assert.doesNotMatch(searchBody, /先看版次/);
    const history = memory.listEventClaims(fixture.roleId, eventId);
    assert.deepEqual(history.filter(claim => claim.practice).map(claim => claim.sourceAt), [at, later]);
    const linked = memory.listEvents(fixture.roleId).find(event => event.title === "查扉页的落款")!;
    assert.equal(memory.listEventClaims(fixture.roleId, linked.eventId)[0]!.relatedEventId, eventId);
    assert.deepEqual(memory.listRelatedGrowthEvents(fixture.roleId, eventId), [linked.eventId]);
    assert.deepEqual(memory.listRelatedGrowthEvents(fixture.roleId, linked.eventId), [eventId]);
    // 迟到的旧证据仍写入历史，不能倒置今天实际采用的方法。
    const oldAt = "2026-10-25T08:00:00.000Z";
    const delayed = addMessage(fixture, "旧书估价，曾按封面辨别。", oldAt);
    registerMessages(fixture, [delayed]);
    const oldId = memory.listEvidence(fixture.roleId).find(item => item.sourceId === delayed)!.evidenceId;
    const third = createService(fixture, [{ operations: [{
      op: "update_event", eventId, expectedVersion: 2, patch: {}, addEvidenceIds: [oldId],
      claims: [{ kind: "practice", text: "比较封面",
        practice: { key: "版本核对", scope: "封面齐全时", outcome: "只辨认出书系" }, evidenceId: oldId }],
    }] }]);
    assert.equal((await third.service.runBatch(fixture.roleId)).status, "completed");
    const current = memory.getSearchDocument(fixture.roleId, "event", eventId)!.body;
    assert.match(current, /先核对版权页/);
    assert.doesNotMatch(current, /比较封面/);
    assert.ok(memory.listEventClaims(fixture.roleId, eventId).some(claim => claim.text === "比较封面"));
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("shared details only record the delivered part of replies in user-visible windows", async () => {
  for (const [source, status, quote, allowed] of [
    ["nowadays", "interrupted", "我只讲到这里", true],
    ["nowadays", "interrupted", "尚未输出的下一句", false],
    ["nowadays-autonomy", "completed", "我只讲到这里", false],
    ["nowadays-autonomy", "interrupted", "我只讲到这里", false],
  ] as const) {
    const fixture = createRole();
    try {
      const window = fixture.store.getOrCreateWindow({ roleId: fixture.roleId, kind: "custom", source });
      const at = "2026-11-03T08:00:00.000Z";
      const id = addMessage(fixture, "我只讲到这里", at, window.windowId);
      fixture.store.db.prepare("UPDATE messages SET sender='assistant', status=? WHERE message_id=?").run(status, id);
      registerMessages(fixture, [id]);
      const memory = new MemoryStore(fixture.store.db);
      const evidenceId = memory.listEvidence(fixture.roleId)[0]!.evidenceId;
      const { service, model } = createService(fixture, [{ operations: [{
        op: "create_event", localKey: "shared", title: "已讲部分", summary: "当日对话",
        occurredAtStart: at, experienceDate: "2026-11-03", evidenceIds: [evidenceId],
        claims: [{ kind: "shared_detail", text: quote, evidenceId }],
      }] }]);
      assert.equal((await service.runBatch(fixture.roleId)).status, allowed ? "completed" : "failed");
      assert.equal(model.requests[0]?.evidence[0]?.publishedReply, source === "nowadays");
      assert.equal(model.requests[0]?.roleName, "记忆验证角色");
      assert.equal(memory.listEvents(fixture.roleId).length, allowed ? 1 : 0);
    } finally {
      fixture.store.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
