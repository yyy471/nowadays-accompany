import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryService } from "../src/application/memory-service.js";
import { createBackendApp, listen, type BackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../src/bootstrap/config.js";
import {
  MemoryOperationInvalidError,
  MemoryVersionConflictError,
} from "../src/domain/errors.js";
import type { MemoryFormationInput } from "../src/domain/memory.js";
import { ScriptedMemoryModel } from "../src/model/offline-memory.js";
import { localDateFromIso, registerMessageEvidence, sha256 } from "../src/storage/evidence.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { RoleStorage } from "../src/storage/role-storage.js";

interface Fixture {
  root: string;
  app: BackendApp;
  roleId: string;
  windowId: string;
  dataRoot: string;
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-03-"));
  const app = createBackendApp(
    parseBackendConfig(["--app-root", root, "--port", "0"]),
  );
  const created = app.services.roles.createRole({
    displayName: "检索验证角色",
    definition: { text: "一个会回忆的角色。" },
  });
  return {
    root,
    app,
    roleId: created.roleId,
    windowId: created.defaultWindowId,
    dataRoot: app.config.dataRoot,
  };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.app.close();
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function withStorage<T>(fixture: Fixture, action: (storage: RoleStorage) => T): T {
  const storage = RoleStorage.openExisting(
    rolePaths(fixture.dataRoot, fixture.roleId),
  );
  try {
    return action(storage);
  } finally {
    storage.close();
  }
}

interface SeedEventInput {
  content: string;
  title: string;
  summary: string;
  subjectiveExperience?: string;
  occurredAt: string;
  tags?: Record<string, string[]>;
  currentRound?: number;
  windowId?: string;
}

interface SeededEvent {
  eventId: string;
  evidenceId: string;
  messageId: string;
  occurredAt: string;
  experienceDate: string;
}

function seedEvent(fixture: Fixture, input: SeedEventInput): SeededEvent {
  return withStorage(fixture, (storage) => {
    const db = storage.business.db;
    const windowId = input.windowId ?? fixture.windowId;
    const submitted = storage.business.submitMessage(fixture.roleId, windowId, {
      content: input.content,
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    db.prepare(
      "UPDATE messages SET created_at = ?, updated_at = ? WHERE message_id = ?",
    ).run(input.occurredAt, input.occurredAt, submitted.message.messageId);
    registerMessageEvidence(db, {
      roleId: fixture.roleId,
      messageIds: [submitted.message.messageId],
      executionId: null,
      timeZone: "Asia/Shanghai",
    });
    const store = new MemoryStore(db);
    const evidence = store
      .listEvidence(fixture.roleId)
      .find((item) => item.sourceId === submitted.message.messageId);
    assert.ok(evidence);
    const experienceDate = localDateFromIso(input.occurredAt, "Asia/Shanghai");
    const event = store.createEvent({
      roleId: fixture.roleId,
      title: input.title,
      summary: input.summary,
      subjectiveExperience: input.subjectiveExperience ?? "",
      occurredAtStart: input.occurredAt,
      occurredAtEnd: null,
      experienceDate,
      tags: input.tags ?? {},
      evidenceIds: [evidence.evidenceId],
      currentRound: input.currentRound ?? 0,
      now: "2026-11-03T12:00:00.000Z",
    });
    return {
      eventId: event.eventId,
      evidenceId: evidence.evidenceId,
      messageId: submitted.message.messageId,
      occurredAt: input.occurredAt,
      experienceDate,
    };
  });
}

function createRound(
  fixture: Fixture,
  round: number,
): { executionId: string } {
  return withStorage(fixture, (storage) => {
    const execution = storage.business.createExecution({
      roleId: fixture.roleId,
      windowId: fixture.windowId,
      triggerType: "user_message",
    });
    storage.business.db
      .prepare(
        "UPDATE executions SET decision_round = ?, status = 'completed' WHERE execution_id = ?",
      )
      .run(round, execution.executionId);
    return { executionId: execution.executionId };
  });
}

function recall(
  fixture: Fixture,
  executionId: string,
  eventId: string,
): void {
  withStorage(fixture, (storage) => {
    new MemoryStore(storage.business.db).recordRecall({
      roleId: fixture.roleId,
      executionId,
      recordType: "event",
      recordId: eventId,
      now: "2026-11-03T12:00:00.000Z",
    });
  });
}

test("memory search uses FTS for long Chinese terms and LIKE for short terms", async () => {
  const fixture = createFixture();
  try {
    const event = seedEvent(fixture, {
      content: "上周六我和小林去了杭州旧书店。",
      title: "杭州旧书店",
      summary: "角色和小林在杭州旧书店讨论植物书和旧地图。",
      occurredAt: "2026-10-28T01:10:00.000Z",
      tags: { person: ["小林"], place: ["杭州"], topic: ["旧书店"] },
    });
    const service = fixture.app.services.memory;
    const long = service.search(fixture.roleId, { query: "杭州 旧书店" });
    assert.equal(long.items.length, 1);
    assert.equal(long.items[0]?.type, "event");
    assert.equal(long.items[0]?.id, event.eventId);
    assert.equal(long.items[0]?.rank, 1);
    assert.match(long.items[0]?.snippet ?? "", /旧书店/);

    const short = service.search(fixture.roleId, { query: "杭州" });
    assert.deepEqual(short.items.map((item) => item.id), [event.eventId]);

    const single = service.search(fixture.roleId, { query: "林" });
    assert.deepEqual(single.items.map((item) => item.id), [event.eventId]);

    const filtered = service.search(fixture.roleId, {
      places: ["杭州"],
      types: ["event"],
      dateFrom: "2026-10-28",
      dateTo: "2026-10-28",
    });
    assert.deepEqual(filtered.items.map((item) => item.id), [event.eventId]);

    const excluded = service.search(fixture.roleId, {
      topics: ["不存在的主题"],
    });
    assert.deepEqual(excluded.items, []);

    const retrieval = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT mode, status FROM retrieval_queries WHERE retrieval_id = ?",
        )
        .get(long.retrievalId) as { mode: string; status: string },
    );
    assert.deepEqual(retrieval, { mode: "manual", status: "succeeded" });
    const delivered = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT delivered FROM retrieval_results WHERE retrieval_id = ?",
        )
        .all(long.retrievalId) as Array<{ delivered: number }>,
    );
    assert.deepEqual(delivered, [{ delivered: 0 }]);
    const recalls = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM memory_recalls")
        .get() as { count: number },
    );
    assert.equal(recalls.count, 0);
  } finally {
    await closeFixture(fixture);
  }
});

test("memory search stays inside the role and returns success for empty matches", async () => {
  const first = createFixture();
  const second = createFixture();
  try {
    const firstEvent = seedEvent(first, {
      content: "杭州旧书店的下午。",
      title: "杭州旧书店",
      summary: "角色在杭州旧书店停留。",
      occurredAt: "2026-10-28T01:10:00.000Z",
    });
    const secondEvent = seedEvent(second, {
      content: "杭州旧书店的另一个角色。",
      title: "另一个杭州旧书店",
      summary: "另一个角色也去了杭州旧书店。",
      occurredAt: "2026-10-28T01:10:00.000Z",
    });
    const firstItems = first.app.services.memory.search(first.roleId, {
      query: "杭州",
    });
    assert.deepEqual(firstItems.items.map((item) => item.id), [firstEvent.eventId]);
    const secondItems = second.app.services.memory.search(second.roleId, {
      query: "杭州",
    });
    assert.deepEqual(secondItems.items.map((item) => item.id), [secondEvent.eventId]);
    const empty = first.app.services.memory.search(first.roleId, {
      query: "完全不存在的词",
    });
    assert.deepEqual(empty.items, []);
    const status = withStorage(first, (storage) =>
      storage.business.db
        .prepare(
          "SELECT status FROM retrieval_queries WHERE retrieval_id = ?",
        )
        .get(empty.retrievalId) as { status: string },
    );
    assert.equal(status.status, "succeeded");
  } finally {
    await closeFixture(first);
    await closeFixture(second);
  }
});

test("a failed search is recorded instead of looking like an empty result", async () => {
  const fixture = createFixture();
  try {
    seedEvent(fixture, {
      content: "检索失败验证。",
      title: "检索失败验证",
      summary: "这条记录用于制造 FTS 失败。",
      occurredAt: "2026-10-28T01:10:00.000Z",
    });
    withStorage(fixture, (storage) => {
      storage.business.db.exec("DROP TABLE memory_search_fts");
      storage.business.db.exec(
        "CREATE TABLE memory_search_fts (dummy TEXT /* USING fts5 tokenize='trigram' */)",
      );
    });
    assert.throws(
      () =>
        fixture.app.services.memory.search(fixture.roleId, {
          query: "检索失败",
        }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === "MEMORY_QUERY_FAILED",
    );
    const row = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT status, error_code FROM retrieval_queries ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { status: string; error_code: string },
    );
    assert.deepEqual(row, {
      status: "failed",
      error_code: "MEMORY_QUERY_FAILED",
    });
  } finally {
    await closeFixture(fixture);
  }
});

test("memory search recalls across windows of the same role", async () => {
  const fixture = createFixture();
  try {
    const mainEvent = seedEvent(fixture, {
      content: "主窗口：杭州旧书店。",
      title: "主窗口杭州",
      summary: "角色在主窗口记录杭州。",
      occurredAt: "2026-10-28T01:10:00.000Z",
    });
    const secondWindow = withStorage(fixture, (storage) =>
      storage.business.createWindow({
        roleId: fixture.roleId,
        kind: "custom",
        source: "nowadays",
      }),
    );
    const travelEvent = seedEvent(fixture, {
      content: "旅行窗口：杭州旧地图。",
      title: "旅行窗口杭州",
      summary: "角色在旅行窗口记录杭州。",
      occurredAt: "2026-10-29T01:10:00.000Z",
      windowId: secondWindow.windowId,
    });
    const result = fixture.app.services.memory.search(fixture.roleId, {
      query: "杭州",
    });
    assert.deepEqual(
      result.items.map((item) => item.id).sort(),
      [mainEvent.eventId, travelEvent.eventId].sort(),
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("refine candidates respect the 100-round boundary and one-recall limit", async () => {
  const fixture = createFixture();
  try {
    const seeded = seedEvent(fixture, {
      content: "观察期边界记录。",
      title: "观察期边界",
      summary: "角色记录了一段旧经历。",
      occurredAt: "2026-10-28T01:10:00.000Z",
    });
    const at99 = withStorage(fixture, (storage) =>
      new MemoryStore(storage.business.db).listRefineCandidates(
        fixture.roleId,
        99,
      ),
    );
    assert.equal(
      at99.some((candidate) => candidate.eventId === seeded.eventId),
      false,
    );
    const at100 = withStorage(fixture, (storage) =>
      new MemoryStore(storage.business.db).listRefineCandidates(
        fixture.roleId,
        100,
      ),
    );
    assert.equal(
      at100.some((candidate) => candidate.eventId === seeded.eventId),
      true,
    );
    const round = createRound(fixture, 50);
    recall(fixture, round.executionId, seeded.eventId);
    const withOneRecall = withStorage(fixture, (storage) =>
      new MemoryStore(storage.business.db).listRefineCandidates(
        fixture.roleId,
        100,
      ),
    );
    assert.equal(
      withOneRecall.some((candidate) => candidate.eventId === seeded.eventId),
      true,
    );
    const secondRound = createRound(fixture, 51);
    recall(fixture, secondRound.executionId, seeded.eventId);
    const withTwoRecalls = withStorage(fixture, (storage) =>
      new MemoryStore(storage.business.db).listRefineCandidates(
        fixture.roleId,
        100,
      ),
    );
    assert.equal(
      withTwoRecalls.some((candidate) => candidate.eventId === seeded.eventId),
      false,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("event detail, evidence detail and correction preserve original messages", async () => {
  const fixture = createFixture();
  try {
    const seeded = seedEvent(fixture, {
      content: "原始消息：上周六去了杭州旧书店。",
      title: "杭州旧书店",
      summary: "角色去了杭州旧书店。",
      subjectiveExperience: "角色觉得安静。",
      occurredAt: "2026-10-28T01:10:00.000Z",
      tags: { place: ["杭州"], topic: ["旧书店"] },
    });
    const service = fixture.app.services.memory;
    const detail = service.getEvent(fixture.roleId, seeded.eventId);
    assert.equal(detail.title, "杭州旧书店");
    assert.deepEqual(detail.tags.place, ["杭州"]);
    assert.equal(detail.sources.length, 1);
    assert.equal(detail.sources[0]?.evidenceId, seeded.evidenceId);
    const evidence = service.getEvidence(fixture.roleId, seeded.evidenceId);
    assert.equal(evidence.content, "原始消息：上周六去了杭州旧书店。");
    assert.equal(evidence.sourceKind, "message");

    const corrected = service.correctEvent(fixture.roleId, seeded.eventId, {
      expectedVersion: 1,
      patch: {
        summary: "角色和小林去了杭州旧书店。",
        tags: { person: ["小林"] },
      },
      reason: "补充同行者",
    });
    assert.equal(corrected.version, 2);
    const updated = service.getEvent(fixture.roleId, seeded.eventId);
    assert.match(updated.summary, /小林/);
    assert.deepEqual(updated.tags.person, ["小林"]);
    assert.deepEqual(updated.tags.place, ["杭州"]);
    const original = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT content FROM messages WHERE message_id = ?")
        .get(seeded.messageId) as { content: string },
    );
    assert.equal(original.content, "原始消息：上周六去了杭州旧书店。");
    const revision = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT change_source, revision_number, base_revision FROM memory_revisions WHERE target_id = ? ORDER BY revision_number DESC LIMIT 1",
        )
        .get(seeded.eventId) as {
        change_source: string;
        revision_number: number;
        base_revision: number;
      },
    );
    assert.deepEqual(revision, {
      change_source: "agent_correction",
      revision_number: 2,
      base_revision: 1,
    });
    const search = service.search(fixture.roleId, { query: "小林" });
    assert.deepEqual(search.items.map((item) => item.id), [seeded.eventId]);
    assert.throws(
      () =>
        service.correctEvent(fixture.roleId, seeded.eventId, {
          expectedVersion: 1,
          patch: { summary: "过期修改" },
        }),
      (error: unknown) =>
        error instanceof MemoryVersionConflictError && error.status === 409,
    );
    assert.throws(
      () =>
        service.correctEvent(fixture.roleId, seeded.eventId, {
          expectedVersion: 2,
          patch: {},
        }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === "INVALID_MEMORY_CORRECTION",
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("refinement turns a low-recall event into a searchable daily summary", async () => {
  const fixture = createFixture();
  try {
    const seeded = seedEvent(fixture, {
      content: "很久以前去杭州旧书店买植物书。",
      title: "杭州旧书店",
      summary: "角色在杭州旧书店买到了植物书。",
      occurredAt: "2026-10-28T01:10:00.000Z",
      tags: { place: ["杭州"], topic: ["旧书店"] },
    });
    const round = createRound(fixture, 120);
    assert.ok(round.executionId);
    const pending = withStorage(fixture, (storage) => {
      const db = storage.business.db;
      const message = storage.business.submitMessage(
        fixture.roleId,
        fixture.windowId,
        {
          content: "最近又想起杭州旧书店。",
          submissionId: randomUUID(),
          sourcePlatform: "nowadays",
        },
      );
      registerMessageEvidence(db, {
        roleId: fixture.roleId,
        messageIds: [message.message.messageId],
        executionId: null,
        timeZone: "Asia/Shanghai",
      });
      return new MemoryStore(db)
        .listEvidence(fixture.roleId)
        .find((item) => item.sourceId === message.message.messageId);
    });
    assert.ok(pending);

    const storage = RoleStorage.openExisting(
      rolePaths(fixture.dataRoot, fixture.roleId),
    );
    const model = new ScriptedMemoryModel([
      (input: MemoryFormationInput) => {
        assert.ok(
          input.refineCandidates.some(
            (candidate) => candidate.eventId === seeded.eventId,
          ),
        );
        return {
          operations: [
            {
              op: "refine_event",
              events: [
                { eventId: seeded.eventId, expectedVersion: 1 },
              ],
              summary: "角色在杭州旧书店买到了植物书，并想起旧地图。",
              reason: "长期低召回",
            },
          ],
        };
      },
    ]);
    try {
      const memory = new MemoryStore(storage.business.db);
      const service = new MemoryService(memory, model, {
        timeZone: "Asia/Shanghai",
        now: () => new Date("2026-11-03T12:00:00.000Z"),
      });
      const result = await service.runBatch(fixture.roleId);
      assert.equal(result.status, "completed", result.errorCode ?? "");
    } finally {
      storage.close();
    }

    const detail = fixture.app.services.memory.getEvent(
      fixture.roleId,
      seeded.eventId,
    );
    assert.equal(detail.lifecycleStatus, "refined");
    assert.ok(detail.refinedSummaryId);
    assert.equal(detail.version, 2);
    const summary = fixture.app.services.memory.getSummary(
      fixture.roleId,
      detail.refinedSummaryId,
    );
    assert.equal(summary.experienceDate, "2026-10-28");
    assert.match(summary.summary, /植物书/);
    assert.equal(summary.sources.length, 1);
    assert.equal(summary.sources[0]?.windowId, fixture.windowId);
    assert.equal(summary.sources[0]?.fromSequence, 1);
    assert.equal(summary.sources[0]?.toSequence, 1);
    const search = fixture.app.services.memory.search(fixture.roleId, {
      query: "旧书店",
    });
    assert.deepEqual(
      search.items.map((item) => [item.type, item.id]),
      [["daily_summary", summary.summaryId]],
    );
    const eventDoc = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_search_documents WHERE record_type = 'event' AND record_id = ?",
        )
        .get(seeded.eventId) as { count: number },
    );
    assert.equal(eventDoc.count, 0);
    fixture.app.services.memory.correctEvent(fixture.roleId, seeded.eventId, {
      expectedVersion: 2,
      patch: { summary: "精炼后重新理解的摘要。" },
    });
    const afterCorrection = fixture.app.services.memory.search(
      fixture.roleId,
      { query: "旧书店" },
    );
    assert.deepEqual(
      afterCorrection.items.map((item) => [item.type, item.id]),
      [["daily_summary", summary.summaryId]],
    );
    const corrected = fixture.app.services.memory.correctSummary(
      fixture.roleId,
      summary.summaryId,
      { expectedVersion: 1, summary: "角色在杭州旧书店买到了植物书和旧地图。" },
    );
    assert.equal(corrected.version, 2);
    const correctedSearch = fixture.app.services.memory.search(fixture.roleId, {
      query: "旧地图",
    });
    assert.deepEqual(
      correctedSearch.items.map((item) => item.id),
      [summary.summaryId],
    );
    assert.throws(
      () =>
        fixture.app.services.memory.correctSummary(
          fixture.roleId,
          summary.summaryId,
          { expectedVersion: 1, summary: "过期摘要" },
        ),
      (error: unknown) =>
        error instanceof MemoryVersionConflictError && error.status === 409,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("refinement aggregates same-date events and supplements an existing summary", async () => {
  const fixture = createFixture();
  const now = "2026-11-03T12:00:00.000Z";
  try {
    const first = seedEvent(fixture, {
      content: "中午和小林去吃面。",
      title: "午餐一",
      summary: "角色和小林中午去吃面。",
      occurredAt: "2026-10-28T03:10:00.000Z",
      tags: { topic: ["午餐"], person: ["小林"] },
    });
    const second = seedEvent(fixture, {
      content: "下午又和小林聊起午餐。",
      title: "午餐二",
      summary: "角色下午和小林聊起中午的面。",
      occurredAt: "2026-10-28T07:10:00.000Z",
      tags: { topic: ["午餐"], person: ["小林"] },
    });
    const merged = withStorage(fixture, (storage) =>
      new MemoryStore(storage.business.db).refineEvent({
        roleId: fixture.roleId,
        events: [
          { eventId: first.eventId, expectedVersion: 1 },
          { eventId: second.eventId, expectedVersion: 1 },
        ],
        summary: "角色和小林在这一天中午吃面，下午又聊起这顿午餐。",
        topic: "午餐",
        reason: "同日同主题合并",
        now,
      }),
    );
    assert.equal(merged.summary.version, 1);
    assert.equal(
      merged.summary.summary,
      "角色和小林在这一天中午吃面，下午又聊起这顿午餐。",
    );
    assert.equal(merged.summary.experienceDate, first.experienceDate);
    assert.deepEqual(
      merged.events.map((event) => [
        event.lifecycleStatus,
        event.refinedSummaryId,
        event.version,
      ]),
      [
        ["refined", merged.summary.summaryId, 2],
        ["refined", merged.summary.summaryId, 2],
      ],
    );
    const sourceCount = withStorage(
      fixture,
      (storage) =>
        new MemoryStore(storage.business.db).listSummarySources(
          merged.summary.summaryId,
        ).length,
    );
    assert.equal(sourceCount, 1);
    const search = fixture.app.services.memory.search(fixture.roleId, {
      query: "午餐",
    });
    assert.deepEqual(
      search.items.map((item) => [item.type, item.id]),
      [["daily_summary", merged.summary.summaryId]],
    );

    const third = seedEvent(fixture, {
      content: "晚上回忆这顿午餐。",
      title: "午餐三",
      summary: "角色晚上回忆这顿午餐。",
      occurredAt: "2026-10-28T12:10:00.000Z",
      tags: { topic: ["午餐"], person: ["小林"] },
    });
    const supplemented = withStorage(fixture, (storage) =>
      new MemoryStore(storage.business.db).refineEvent({
        roleId: fixture.roleId,
        events: [{ eventId: third.eventId, expectedVersion: 1 }],
        summary: "角色和小林这一天从午饭聊到晚饭，反复提到这顿午餐。",
        targetSummaryId: merged.summary.summaryId,
        expectedSummaryVersion: 1,
        topic: "午餐",
        now,
      }),
    );
    assert.equal(supplemented.summary.version, 2);
    assert.equal(
      supplemented.summary.summary,
      "角色和小林这一天从午饭聊到晚饭，反复提到这顿午餐。",
    );
    assert.equal(
      withStorage(
        fixture,
        (storage) =>
          new MemoryStore(storage.business.db).listSummarySources(
            merged.summary.summaryId,
          ).length,
      ),
      2,
    );
    const revisions = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          `SELECT revision_number, content_json FROM memory_revisions
           WHERE target_type = 'daily_summary' AND target_id = ?
           ORDER BY revision_number ASC`,
        )
        .all(merged.summary.summaryId) as Array<{
        revision_number: number;
        content_json: string;
      }>,
    );
    assert.deepEqual(
      revisions.map((revision) => revision.revision_number),
      [1, 2],
    );
    assert.equal(
      revisions[0]?.content_json.includes("同日同主题合并"),
      true,
    );

    const staleCandidate = seedEvent(fixture, {
      content: "傍晚再次想起这顿午餐。",
      title: "午餐四",
      summary: "角色傍晚再次想起这顿午餐。",
      occurredAt: "2026-10-28T13:10:00.000Z",
      tags: { topic: ["午餐"], person: ["小林"] },
    });
    assert.throws(
      () =>
        withStorage(fixture, (storage) =>
          new MemoryStore(storage.business.db).refineEvent({
            roleId: fixture.roleId,
            events: [
              { eventId: staleCandidate.eventId, expectedVersion: 1 },
            ],
            summary: "冲突的摘要补充。",
            targetSummaryId: merged.summary.summaryId,
            expectedSummaryVersion: 1,
            topic: "午餐",
            now,
          }),
        ),
      (error: unknown) => error instanceof MemoryVersionConflictError,
    );
    const afterConflict = withStorage(fixture, (storage) => {
      const store = new MemoryStore(storage.business.db);
      return {
        event: store.getEvent(fixture.roleId, staleCandidate.eventId),
        summary: store.getSummary(fixture.roleId, merged.summary.summaryId),
      };
    });
    assert.equal(afterConflict.event.lifecycleStatus, "active");
    assert.equal(afterConflict.event.version, 1);
    assert.equal(afterConflict.summary.version, 2);

    const fourth = seedEvent(fixture, {
      content: "第二天又想起午餐。",
      title: "午餐五",
      summary: "角色第二天又想起午餐。",
      occurredAt: "2026-10-29T03:10:00.000Z",
      tags: { topic: ["午餐"], person: ["小林"] },
    });
    assert.throws(
      () =>
        withStorage(fixture, (storage) =>
          new MemoryStore(storage.business.db).refineEvent({
            roleId: fixture.roleId,
            events: [{ eventId: fourth.eventId, expectedVersion: 1 }],
            summary: "不同经历日期不应合并。",
            targetSummaryId: merged.summary.summaryId,
            expectedSummaryVersion: 2,
            topic: "午餐",
            now,
          }),
        ),
      (error: unknown) => error instanceof MemoryOperationInvalidError,
    );
    const fifth = seedEvent(fixture, {
      content: "同一天的另一件事。",
      title: "同日另一件事",
      summary: "角色在同一天遇到另一件事。",
      occurredAt: "2026-10-28T14:10:00.000Z",
      tags: { topic: ["散步"] },
    });
    assert.throws(
      () =>
        withStorage(fixture, (storage) =>
          new MemoryStore(storage.business.db).refineEvent({
            roleId: fixture.roleId,
            events: [
              { eventId: fourth.eventId, expectedVersion: 1 },
              { eventId: fifth.eventId, expectedVersion: 1 },
            ],
            summary: "不同日期不能直接聚合。",
            now,
          }),
        ),
      (error: unknown) => error instanceof MemoryOperationInvalidError,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("memory batches supply summary candidates for supplementing an existing summary", async () => {
  const fixture = createFixture();
  try {
    const first = seedEvent(fixture, {
      content: "中午和小林吃面。",
      title: "午餐一",
      summary: "角色和小林中午吃面。",
      occurredAt: "2026-10-28T03:10:00.000Z",
      tags: { topic: ["午餐"], person: ["小林"] },
    });
    const round = createRound(fixture, 120);
    assert.ok(round.executionId);
    const firstStorage = RoleStorage.openExisting(
      rolePaths(fixture.dataRoot, fixture.roleId),
    );
    let summaryId = "";
    try {
      const service = new MemoryService(
        new MemoryStore(firstStorage.business.db),
        new ScriptedMemoryModel([
          {
            operations: [
              {
                op: "refine_event",
                events: [{ eventId: first.eventId, expectedVersion: 1 }],
                summary: "角色和小林中午吃了一碗面。",
                topic: "午餐",
                reason: "长期低召回",
              },
            ],
          },
        ]),
        {
          timeZone: "Asia/Shanghai",
          now: () => new Date("2026-11-03T12:00:00.000Z"),
        },
      );
      const result = await service.runBatch(fixture.roleId);
      assert.equal(result.status, "completed", result.errorCode ?? "");
      const refined = new MemoryStore(firstStorage.business.db).getEvent(
        fixture.roleId,
        first.eventId,
      );
      assert.ok(refined.refinedSummaryId);
      summaryId = refined.refinedSummaryId;
    } finally {
      firstStorage.close();
    }

    const second = seedEvent(fixture, {
      content: "下午又提起这碗面。",
      title: "午餐二",
      summary: "角色下午又提起中午的面。",
      occurredAt: "2026-10-28T07:10:00.000Z",
      tags: { topic: ["午餐"], person: ["小林"] },
    });
    const secondStorage = RoleStorage.openExisting(
      rolePaths(fixture.dataRoot, fixture.roleId),
    );
    try {
      const model = new ScriptedMemoryModel([
        (input: MemoryFormationInput) => {
          assert.ok(
            input.refineCandidates.some(
              (candidate) => candidate.eventId === second.eventId,
            ),
          );
          const candidate = input.summaryCandidates.find(
            (summary) => summary.summaryId === summaryId,
          );
          assert.ok(candidate);
          assert.equal(candidate.experienceDate, second.experienceDate);
          assert.equal(candidate.version, 1);
          return {
            operations: [
              {
                op: "refine_event",
                events: [
                  { eventId: second.eventId, expectedVersion: 1 },
                ],
                summary: "角色和小林中午吃面，下午又提起这碗面。",
                targetSummaryId: summaryId,
                expectedSummaryVersion: 1,
                topic: "午餐",
                reason: "补充同日同主题摘要",
              },
            ],
          };
        },
      ]);
      const service = new MemoryService(
        new MemoryStore(secondStorage.business.db),
        model,
        {
          timeZone: "Asia/Shanghai",
          now: () => new Date("2026-11-03T12:00:00.000Z"),
        },
      );
      const result = await service.runBatch(fixture.roleId);
      assert.equal(result.status, "completed", result.errorCode ?? "");
    } finally {
      secondStorage.close();
    }

    const summary = fixture.app.services.memory.getSummary(
      fixture.roleId,
      summaryId,
    );
    assert.equal(summary.version, 2);
    assert.equal(
      summary.summary,
      "角色和小林中午吃面，下午又提起这碗面。",
    );
    assert.equal(
      fixture.app.services.memory.getEvent(fixture.roleId, second.eventId)
        .refinedSummaryId,
      summaryId,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("refine candidates exclude events with more than one recall in 100 rounds", async () => {
  const fixture = createFixture();
  try {
    const seeded = seedEvent(fixture, {
      content: "一次旧经历。",
      title: "旧经历",
      summary: "角色经历了一次旧事。",
      occurredAt: "2026-10-28T01:10:00.000Z",
    });
    const firstRound = createRound(fixture, 110);
    const secondRound = createRound(fixture, 111);
    recall(fixture, firstRound.executionId, seeded.eventId);
    recall(fixture, secondRound.executionId, seeded.eventId);
    const candidates = withStorage(fixture, (storage) =>
      new MemoryStore(storage.business.db).listRefineCandidates(
        fixture.roleId,
        120,
      ),
    );
    assert.equal(
      candidates.some((candidate) => candidate.eventId === seeded.eventId),
      false,
    );
    const noRecallEvent = seedEvent(fixture, {
      content: "另一段旧经历。",
      title: "另一段旧经历",
      summary: "角色经历了另一段旧事。",
      occurredAt: "2026-10-27T01:10:00.000Z",
    });
    const after = withStorage(fixture, (storage) =>
      new MemoryStore(storage.business.db).listRefineCandidates(
        fixture.roleId,
        120,
      ),
    );
    assert.equal(
      after.some((candidate) => candidate.eventId === noRecallEvent.eventId),
      true,
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("diary Markdown files are authoritative and refresh the search snapshot", async () => {
  const fixture = createFixture();
  try {
    const event = seedEvent(fixture, {
      content: "上周六去了杭州旧书店。",
      title: "杭州旧书店",
      summary: "角色去了杭州旧书店。",
      occurredAt: "2026-10-28T01:10:00.000Z",
    });
    const service = fixture.app.services.memory;
    const diary = service.createDiary(fixture.roleId, {
      content: "# 十月二十九日\n今天想起了旧书店的植物书。",
      occurredAt: "2026-10-29T12:00:00.000Z",
      eventIds: [event.eventId],
    });
    assert.match(diary.relativePath, /^diaries\/2026-10-29\//);
    const filePath = path.join(
      fixture.dataRoot,
      "roles",
      fixture.roleId,
      "workspace",
      diary.relativePath,
    );
    assert.equal(
      fs.readFileSync(filePath, "utf8"),
      "# 十月二十九日\n今天想起了旧书店的植物书。",
    );
    const row = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT relative_path, content_hash FROM diaries WHERE diary_id = ?",
        )
        .get(diary.diaryId) as {
        relative_path: string;
        content_hash: string;
      },
    );
    assert.equal(row.relative_path, diary.relativePath);
    assert.equal(
      row.content_hash,
      sha256("# 十月二十九日\n今天想起了旧书店的植物书。"),
    );
    assert.deepEqual(diary.eventIds, [event.eventId]);
    const searched = service.search(fixture.roleId, {
      query: "植物书",
      types: ["diary"],
    });
    assert.deepEqual(searched.items.map((item) => item.id), [diary.diaryId]);

    fs.appendFileSync(filePath, "\n外部补充：巷口面馆也值得记录。", "utf8");
    const refreshed = service.getDiary(fixture.roleId, diary.diaryId);
    assert.match(refreshed.content, /外部补充/);
    const refreshedRow = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT content, content_hash FROM diaries WHERE diary_id = ?",
        )
        .get(diary.diaryId) as { content: string; content_hash: string },
    );
    assert.match(refreshedRow.content, /外部补充/);
    assert.equal(
      refreshedRow.content_hash,
      sha256(refreshed.content),
    );
    const externalSearch = service.search(fixture.roleId, {
      query: "面馆",
      types: ["diary"],
    });
    assert.deepEqual(
      externalSearch.items.map((item) => item.id),
      [diary.diaryId],
    );
    const list = service.listDiaries(fixture.roleId);
    assert.equal(list.length, 1);
    assert.equal("content" in list[0]!, false);
    assert.throws(
      () =>
        service.createDiary(fixture.roleId, {
          content: "关联不存在的事件",
          eventIds: [randomUUID()],
        }),
      /MEMORY_EVENT_NOT_FOUND|记忆事件不存在/,
    );
    const diaryDirectory = path.join(
      fixture.dataRoot,
      "roles",
      fixture.roleId,
      "workspace",
      "diaries",
      "2026-10-29",
    );
    assert.deepEqual(fs.readdirSync(diaryDirectory), [
      `${diary.diaryId}.md`,
    ]);
  } finally {
    await closeFixture(fixture);
  }
});

test("memory HTTP routes and CLI read the stored memory", async () => {
  const fixture = createFixture();
  try {
    const event = seedEvent(fixture, {
      content: "HTTP 验证消息：杭州旧书店。",
      title: "HTTP 杭州旧书店",
      summary: "角色通过 HTTP 读取这条记忆。",
      occurredAt: "2026-10-28T01:10:00.000Z",
    });
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const search = await requestJson(baseUrl, "POST", `/v1/roles/${fixture.roleId}/memory/search`, {
      query: "杭州",
    });
    assert.equal(search.status, 200);
    const searchBody = search.body as {
      items: Array<{ id: string; type: string }>;
    };
    assert.deepEqual(searchBody.items.map((item) => item.id), [event.eventId]);
    const detail = await requestJson(
      baseUrl,
      "GET",
      `/v1/roles/${fixture.roleId}/memory/events/${event.eventId}`,
    );
    assert.equal(detail.status, 200);
    assert.equal((detail.body as { title: string }).title, "HTTP 杭州旧书店");
    const evidence = await requestJson(
      baseUrl,
      "GET",
      `/v1/roles/${fixture.roleId}/memory/evidence/${event.evidenceId}`,
    );
    assert.equal(evidence.status, 200);
    assert.match(
      (evidence.body as { content: string }).content,
      /HTTP 验证消息/,
    );
    const diary = await requestJson(
      baseUrl,
      "POST",
      `/v1/roles/${fixture.roleId}/diaries`,
      {
        content: "今天通过接口写下了日记。",
        occurredAt: "2026-10-29T12:00:00.000Z",
      },
    );
    assert.equal(diary.status, 201);
    const diaryId = (diary.body as { diaryId: string }).diaryId;
    const diaryRead = await requestJson(
      baseUrl,
      "GET",
      `/v1/roles/${fixture.roleId}/diaries/${diaryId}`,
    );
    assert.equal(diaryRead.status, 200);
    assert.equal(
      (diaryRead.body as { content: string }).content,
      "今天通过接口写下了日记。",
    );
    const status = await requestJson(
      baseUrl,
      "GET",
      `/v1/roles/${fixture.roleId}/memory/status`,
    );
    assert.equal(status.status, 200);
    assert.equal(
      typeof (status.body as { pendingEvidence: number }).pendingEvidence,
      "number",
    );
    const listed = await requestJson(
      baseUrl,
      "GET",
      `/v1/roles/${fixture.roleId}/memory/batches?limit=5`,
    );
    assert.equal(listed.status, 200);
    const triggered = await requestJson(
      baseUrl,
      "POST",
      `/v1/roles/${fixture.roleId}/memory/batches`,
    );
    assert.equal(triggered.status, 202);
    assert.equal(typeof (triggered.body as { triggerId: string }).triggerId, "string");
    const cliSearch = await runCli(baseUrl, [
      "memory",
      "search",
      "--role",
      fixture.roleId,
      "--json",
      JSON.stringify({ query: "杭州" }),
    ]);
    assert.deepEqual(
      (cliSearch as { items: Array<{ id: string }> }).items.map((item) => item.id),
      [event.eventId],
    );
    const cliDiary = await runCli(baseUrl, [
      "diary",
      "list",
      "--role",
      fixture.roleId,
    ]);
    assert.equal((cliDiary as { items: unknown[] }).items.length, 1);
    const cliCreated = await runCli(baseUrl, [
      "diary",
      "create",
      "--role",
      fixture.roleId,
      "--content",
      "CLI 创建的日记",
      "--occurred-at",
      "2026-10-30T12:00:00.000Z",
    ]);
    assert.equal((cliCreated as { content: string }).content, "CLI 创建的日记");
    const cliListAfterCreate = await runCli(baseUrl, [
      "diary",
      "list",
      "--role",
      fixture.roleId,
    ]);
    assert.equal((cliListAfterCreate as { items: unknown[] }).items.length, 2);
  } finally {
    await closeFixture(fixture);
  }
});

async function requestJson(
  baseUrl: string,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

async function runCli(baseUrl: string, args: readonly string[]): Promise<unknown> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--base-url", baseUrl, ...args],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`CLI_EXIT_${code}:${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as unknown);
      } catch {
        reject(new Error(`CLI_INVALID_JSON:${stdout}`));
      }
    });
  });
}

test("agent search records deliveries and recalls once per execution", async () => {
  const fixture = createFixture();
  try {
    const event = seedEvent(fixture, {
      content: "召回统计用的杭州记录。",
      title: "杭州召回记录",
      summary: "角色回忆杭州。",
      occurredAt: "2026-10-28T01:10:00.000Z",
    });
    const round = createRound(fixture, 10);
    const service = fixture.app.services.memory;
    const first = service.search(
      fixture.roleId,
      { query: "杭州" },
      { mode: "agent", executionId: round.executionId },
    );
    assert.deepEqual(first.items.map((item) => item.id), [event.eventId]);
    service.search(
      fixture.roleId,
      { query: "杭州" },
      { mode: "agent", executionId: round.executionId },
    );
    const recalls = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM memory_recalls")
        .get() as { count: number },
    );
    assert.equal(recalls.count, 1);
    const delivered = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT delivered FROM retrieval_results WHERE retrieval_id = ?",
        )
        .all(first.retrievalId) as Array<{ delivered: number }>,
    );
    assert.deepEqual(delivered, [{ delivered: 1 }]);
    assert.equal(
      service.recordRecall(fixture.roleId, {
        executionId: round.executionId,
        type: "event",
        id: event.eventId,
      }),
      false,
    );
  } finally {
    await closeFixture(fixture);
  }
});
