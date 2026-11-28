import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  DiaryNotFoundError,
  MemoryOperationInvalidError,
  MemorySummaryNotFoundError,
  MemoryVersionConflictError,
} from "../../domain/errors.js";
import type {
  DailySummaryBrief,
  DailySummaryRecord,
  DailySummarySourceRecord,
  DiaryDetail,
  DiaryRecord,
  EvidenceSender,
  MemoryEventRecord,
  MemoryEventSourceRecord,
  MemorySourceKind,
  SummaryEvidenceItem,
} from "../../domain/memory.js";
import type { MemoryEventStore } from "./memory-event-store.js";
import { indexRetainedDetails, upsertSearchDocument } from "./memory-search-store.js";
import {
  diaryTitle,
  groupSummarySources,
  insertRevision,
  loadEvidenceContent,
  mapDiary,
  mapSummary,
} from "./memory-store-types.js";
import type {
  CorrectSummaryInput,
  CreateDiaryInput,
  DiaryRow,
  ListSummaryEvidenceInput,
  RefineEventInput,
  SummaryRow,
  SummarySourceRow,
  UpdateDiarySnapshotInput,
} from "./memory-store-types.js";

export class MemorySummaryDiaryStore {
  private readonly db: Database.Database;
  private readonly events: MemoryEventStore;

  constructor(db: Database.Database, events: MemoryEventStore) {
    this.db = db;
    this.events = events;
  }

  getSummary(roleId: string, summaryId: string): DailySummaryRecord {
    const row = this.db
      .prepare(
        `SELECT summary_id, role_id, experience_date, topic, summary, version,
                created_at, updated_at
         FROM daily_summaries WHERE summary_id = ? AND role_id = ?`,
      )
      .get(summaryId, roleId) as SummaryRow | undefined;
    if (!row) {
      throw new MemorySummaryNotFoundError(summaryId);
    }
    return mapSummary(row);
  }

  listSummarySources(summaryId: string): DailySummarySourceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT summary_source_id, summary_id, window_id, from_sequence,
                to_sequence, occurred_from, occurred_to
         FROM daily_summary_sources WHERE summary_id = ?
         ORDER BY occurred_from ASC, summary_source_id ASC`,
      )
      .all(summaryId) as SummarySourceRow[];
    return rows.map((row) => ({
      summarySourceId: row.summary_source_id,
      summaryId: row.summary_id,
      windowId: row.window_id,
      fromSequence: row.from_sequence,
      toSequence: row.to_sequence,
      occurredFrom: row.occurred_from,
      occurredTo: row.occurred_to,
    }));
  }

  listSummaryEvidence(input: ListSummaryEvidenceInput): SummaryEvidenceItem[] {
    this.getSummary(input.roleId, input.summaryId);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const sources = this.listSummarySources(input.summaryId).filter(
      (source) =>
        input.windowId === undefined || source.windowId === input.windowId,
    );
    const items = new Map<string, SummaryEvidenceItem>();
    for (const source of sources) {
      if (source.windowId === null) {
        continue;
      }
      const fromSequence = input.fromSequence ?? source.fromSequence;
      const toSequence = input.toSequence ?? source.toSequence;
      if (fromSequence !== null && toSequence !== null) {
        const rows = this.db
          .prepare(
            `SELECT er.evidence_id, er.source_kind, er.window_id, er.occurred_at,
                    er.role_sequence, m.sequence, m.content, m.sender
               FROM evidence_records er
               JOIN messages m
                 ON er.source_kind = 'message' AND m.message_id = er.source_id
              WHERE er.role_id = ? AND m.window_id = ?
                AND m.sequence >= ? AND m.sequence <= ?
              ORDER BY er.role_sequence ASC`,
          )
          .all(
            input.roleId,
            source.windowId,
            Math.min(fromSequence, toSequence),
            Math.max(fromSequence, toSequence),
          ) as Array<{
          evidence_id: string;
          source_kind: MemorySourceKind;
          window_id: string | null;
          occurred_at: string;
          role_sequence: number;
          sequence: number;
          sender: EvidenceSender;
          content: string;
        }>;
        for (const row of rows) {
          items.set(row.evidence_id, {
            evidenceId: row.evidence_id,
            sourceKind: row.source_kind,
            windowId: row.window_id,
            sequence: row.sequence,
            sender: row.sender,
            occurredAt: row.occurred_at,
            roleSequence: row.role_sequence,
            content: row.content,
          });
        }
      }
      const toolRows = this.db
        .prepare(
          `SELECT evidence_id, source_kind, source_id, window_id, occurred_at,
                  role_sequence
             FROM evidence_records
            WHERE role_id = ? AND source_kind = 'tool_result'
              AND window_id = ? AND occurred_at >= ? AND occurred_at <= ?
            ORDER BY role_sequence ASC`,
        )
        .all(
          input.roleId,
          source.windowId,
          source.occurredFrom,
          source.occurredTo,
        ) as Array<{
        evidence_id: string;
        source_kind: MemorySourceKind;
        source_id: string;
        window_id: string | null;
        occurred_at: string;
        role_sequence: number;
      }>;
      for (const row of toolRows) {
        if (items.has(row.evidence_id)) {
          continue;
        }
        items.set(row.evidence_id, {
          evidenceId: row.evidence_id,
          sourceKind: row.source_kind,
          windowId: row.window_id,
          sequence: null,
          sender: null,
          occurredAt: row.occurred_at,
          roleSequence: row.role_sequence,
          content: loadEvidenceContent(this.db, {
            role_id: input.roleId,
            source_kind: row.source_kind,
            source_id: row.source_id,
          }),
        });
      }
    }
    return [...items.values()]
      .sort((left, right) => left.roleSequence - right.roleSequence)
      .slice(0, limit);
  }

  listSummaryCandidates(
    roleId: string,
    experienceDates: readonly string[],
  ): DailySummaryBrief[] {
    const dates = [...new Set(experienceDates)];
    if (dates.length === 0) {
      return [];
    }
    const placeholders = dates.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT summary_id, experience_date, topic, summary, version
         FROM daily_summaries
         WHERE role_id = ? AND experience_date IN (${placeholders})
         ORDER BY experience_date ASC, created_at ASC, summary_id ASC
         LIMIT 100`,
      )
      .all(roleId, ...dates) as Array<{
      summary_id: string;
      experience_date: string;
      topic: string;
      summary: string;
      version: number;
    }>;
    return rows.map((row) => ({
      summaryId: row.summary_id,
      experienceDate: row.experience_date,
      topic: row.topic,
      summary: row.summary,
      version: row.version,
    }));
  }

  refineEvent(input: RefineEventInput): { events: MemoryEventRecord[]; summary: DailySummaryRecord } {
    return this.db.transaction(() => {
      const seen = new Set<string>();
      const events: MemoryEventRecord[] = [];
      for (const target of input.events) {
        if (seen.has(target.eventId)) {
          throw new MemoryOperationInvalidError("精炼目标事件重复", {
            eventId: target.eventId,
          });
        }
        seen.add(target.eventId);
        const event = this.events.getEvent(input.roleId, target.eventId);
        if (event.version !== target.expectedVersion) {
          throw new MemoryVersionConflictError(
            target.eventId,
            target.expectedVersion,
            event.version,
          );
        }
        if (event.lifecycleStatus !== "active") {
          throw new MemoryOperationInvalidError("事件已精炼，不能重复精炼", {
            eventId: target.eventId,
          });
        }
        events.push(event);
      }
      const firstEvent = events[0];
      if (!firstEvent) {
        throw new MemoryOperationInvalidError("精炼至少需要一个事件");
      }
      if (events.some((event) => event.experienceDate !== firstEvent.experienceDate)) {
        throw new MemoryOperationInvalidError(
          "只能聚合同一经历日期的事件",
          {
            experienceDates: [
              ...new Set(events.map((event) => event.experienceDate)),
            ],
          },
        );
      }
      const experienceDate = firstEvent.experienceDate;
      const summaryText = input.summary.trim();
      if (summaryText.length === 0) {
        throw new MemoryOperationInvalidError("摘要正文不能为空");
      }
      const eventSources = new Map<string, MemoryEventSourceRecord[]>();
      for (const event of events) {
        const sources = this.events.listEventSources(input.roleId, event.eventId);
        if (sources.length === 0) {
          throw new MemoryOperationInvalidError("事件没有来源证据，不能精炼", {
            eventId: event.eventId,
          });
        }
        eventSources.set(event.eventId, sources);
      }
      const sources = [...eventSources.values()].flat();
      const eventTopics = events.map(
        (event) => this.events.getTags(event.eventId).topic?.[0]?.trim() ?? "",
      );
      const providedTopic = input.topic?.trim() ?? "";
      const distinctTopics = [
        ...new Set(eventTopics.filter((topic) => topic.length > 0)),
      ];
      if (
        providedTopic.length === 0 &&
        distinctTopics.length > 1
      ) {
        throw new MemoryOperationInvalidError(
          "聚合事件的主题不一致，需要提供摘要主题",
          { topics: distinctTopics },
        );
      }
      let summaryId: string;
      let summaryVersion: number;
      let baseVersion: number;
      let topic: string;
      let summaryTitle: string;
      if (input.targetSummaryId !== undefined) {
        if (input.expectedSummaryVersion === undefined) {
          throw new MemoryOperationInvalidError(
            "补充已有摘要必须提供摘要版本",
            { summaryId: input.targetSummaryId },
          );
        }
        const target = this.getSummary(input.roleId, input.targetSummaryId);
        if (target.experienceDate !== experienceDate) {
          throw new MemoryOperationInvalidError(
            "摘要日期与事件经历日期不一致",
            {
              summaryId: target.summaryId,
              summaryExperienceDate: target.experienceDate,
              experienceDate,
            },
          );
        }
        if (target.version !== input.expectedSummaryVersion) {
          throw new MemoryVersionConflictError(
            target.summaryId,
            input.expectedSummaryVersion,
            target.version,
          );
        }
        if (
          target.topic.length > 0 &&
          providedTopic.length > 0 &&
          target.topic !== providedTopic
        ) {
          throw new MemoryOperationInvalidError(
            "摘要主题与已有摘要不一致",
            {
              summaryId: target.summaryId,
              summaryTopic: target.topic,
              topic: providedTopic,
            },
          );
        }
        summaryId = target.summaryId;
        baseVersion = target.version;
        summaryVersion = target.version + 1;
        topic =
          providedTopic.length > 0
            ? providedTopic
            : target.topic.length > 0
              ? target.topic
              : (distinctTopics[0] ?? "");
        summaryTitle = topic || experienceDate;
        this.db
          .prepare(
            `UPDATE daily_summaries
             SET topic = ?, summary = ?, version = ?, updated_at = ?
             WHERE summary_id = ? AND role_id = ?`,
          )
          .run(
            topic,
            summaryText,
            summaryVersion,
            input.now,
            summaryId,
            input.roleId,
          );
      } else {
        summaryId = randomUUID();
        baseVersion = 0;
        summaryVersion = 1;
        topic = providedTopic.length > 0 ? providedTopic : (distinctTopics[0] ?? "");
        summaryTitle = topic || experienceDate;
        this.db
          .prepare(
            `INSERT INTO daily_summaries
             (summary_id, role_id, experience_date, topic, summary, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            summaryId,
            input.roleId,
            experienceDate,
            topic,
            summaryText,
            input.now,
            input.now,
          );
      }
      for (const source of groupSummarySources(this.db, sources)) {
        const duplicate = this.db
          .prepare(
            `SELECT 1 FROM daily_summary_sources
             WHERE summary_id = ? AND window_id IS ? AND from_sequence IS ?
               AND to_sequence IS ? AND occurred_from = ? AND occurred_to = ?`,
          )
          .get(
            summaryId,
            source.windowId,
            source.fromSequence,
            source.toSequence,
            source.occurredFrom,
            source.occurredTo,
          );
        if (duplicate) {
          continue;
        }
        this.db
          .prepare(
            `INSERT INTO daily_summary_sources
             (summary_source_id, summary_id, window_id, from_sequence, to_sequence,
              occurred_from, occurred_to)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            summaryId,
            source.windowId,
            source.fromSequence,
            source.toSequence,
            source.occurredFrom,
            source.occurredTo,
          );
      }
      const refinedEventIds = events.map((event) => event.eventId);
      for (const event of events) {
        const nextVersion = event.version + 1;
        this.db
          .prepare(
            `UPDATE memory_events
             SET lifecycle_status = 'refined', refined_summary_id = ?, version = ?,
                 updated_at = ?
             WHERE event_id = ? AND role_id = ?`,
          )
          .run(summaryId, nextVersion, input.now, event.eventId, input.roleId);
        indexRetainedDetails(this.db, input.roleId, event.eventId, input.now);
        insertRevision(this.db, {
          roleId: input.roleId,
          targetType: "event",
          targetId: event.eventId,
          revisionNumber: nextVersion,
          baseRevision: event.version,
          changeSource: "memory_batch",
          content: {
            lifecycleStatus: "refined",
            refinedSummaryId: summaryId,
            title: event.title,
            summary: event.summary,
            experienceDate: event.experienceDate,
            mergedEventIds: refinedEventIds,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
          evidenceIds: (eventSources.get(event.eventId) ?? []).map(
            (source) => source.evidenceId,
          ),
          now: input.now,
        });
      }
      upsertSearchDocument(this.db, {
        roleId: input.roleId,
        recordType: "daily_summary",
        recordId: summaryId,
        title: summaryTitle,
        body: summaryText,
        now: input.now,
      });
      insertRevision(this.db, {
        roleId: input.roleId,
        targetType: "daily_summary",
        targetId: summaryId,
        revisionNumber: summaryVersion,
        baseRevision: baseVersion,
        changeSource: "memory_batch",
        content: {
          experienceDate,
          topic,
          summary: summaryText,
          eventIds: refinedEventIds,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
        evidenceIds: sources.map((source) => source.evidenceId),
        now: input.now,
      });
      return {
        events: events.map((event) =>
          this.events.getEvent(input.roleId, event.eventId),
        ),
        summary: this.getSummary(input.roleId, summaryId),
      };
    })();
  }

  correctSummary(input: CorrectSummaryInput): DailySummaryRecord {
    const current = this.getSummary(input.roleId, input.summaryId);
    if (current.version !== input.expectedVersion) {
      throw new MemoryVersionConflictError(
        input.summaryId,
        input.expectedVersion,
        current.version,
      );
    }
    const nextVersion = current.version + 1;
    this.db
      .prepare(
        `UPDATE daily_summaries
         SET summary = ?, version = ?, updated_at = ?
         WHERE summary_id = ? AND role_id = ?`,
      )
      .run(input.summary, nextVersion, input.now, input.summaryId, input.roleId);
    upsertSearchDocument(this.db, {
      roleId: input.roleId,
      recordType: "daily_summary",
      recordId: input.summaryId,
      title: current.topic || current.experienceDate,
      body: input.summary,
      now: input.now,
    });
    insertRevision(this.db, {
      roleId: input.roleId,
      targetType: "daily_summary",
      targetId: input.summaryId,
      revisionNumber: nextVersion,
      baseRevision: current.version,
      changeSource: input.changeSource ?? "agent_correction",
      content: {
        ...(input.reason ? { reason: input.reason } : {}),
        experienceDate: current.experienceDate,
        topic: current.topic,
        summary: input.summary,
      },
      evidenceIds: [],
      now: input.now,
    });
    return this.getSummary(input.roleId, input.summaryId);
  }

  createDiary(input: CreateDiaryInput): DiaryRecord {
    for (const eventId of input.eventIds) {
      this.events.getEvent(input.roleId, eventId);
    }
    this.db
      .prepare(
        `INSERT INTO diaries
         (diary_id, role_id, relative_path, content, content_hash, occurred_at,
          experience_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.diaryId,
        input.roleId,
        input.relativePath,
        input.content,
        input.contentHash,
        input.occurredAt,
        input.experienceDate,
        input.now,
        input.now,
      );
    for (const eventId of input.eventIds) {
      this.db
        .prepare(
          `INSERT INTO diary_events (diary_id, event_id, linked_at)
           VALUES (?, ?, ?)`,
        )
        .run(input.diaryId, eventId, input.now);
    }
    upsertSearchDocument(this.db, {
      roleId: input.roleId,
      recordType: "diary",
      recordId: input.diaryId,
      title: diaryTitle(input.content, input.experienceDate),
      body: input.content,
      now: input.now,
    });
    return this.getDiaryRow(input.roleId, input.diaryId);
  }

  listDiaries(roleId: string): DiaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT diary_id, role_id, relative_path, content, content_hash,
                occurred_at, experience_date, created_at, updated_at
         FROM diaries WHERE role_id = ?
         ORDER BY experience_date DESC, occurred_at DESC, diary_id ASC`,
      )
      .all(roleId) as DiaryRow[];
    return rows.map(mapDiary);
  }

  getDiary(roleId: string, diaryId: string): DiaryDetail {
    const row = this.db
      .prepare(
        `SELECT diary_id, role_id, relative_path, content, content_hash,
                occurred_at, experience_date, created_at, updated_at
         FROM diaries WHERE diary_id = ? AND role_id = ?`,
      )
      .get(diaryId, roleId) as DiaryRow | undefined;
    if (!row) {
      throw new DiaryNotFoundError(diaryId);
    }
    const links = this.db
      .prepare(
        "SELECT event_id FROM diary_events WHERE diary_id = ? ORDER BY linked_at ASC, event_id ASC",
      )
      .all(diaryId) as Array<{ event_id: string }>;
    return {
      ...mapDiary(row),
      content: row.content,
      eventIds: links.map((link) => link.event_id),
    };
  }

  updateDiarySnapshot(input: UpdateDiarySnapshotInput): DiaryRecord {
    const current = this.getDiaryRow(input.roleId, input.diaryId);
    this.db
      .prepare(
        `UPDATE diaries SET content = ?, content_hash = ?, updated_at = ?
         WHERE diary_id = ? AND role_id = ?`,
      )
      .run(
        input.content,
        input.contentHash,
        input.now,
        input.diaryId,
        input.roleId,
      );
    upsertSearchDocument(this.db, {
      roleId: input.roleId,
      recordType: "diary",
      recordId: input.diaryId,
      title: diaryTitle(input.content, current.experienceDate),
      body: input.content,
      now: input.now,
    });
    return this.getDiaryRow(input.roleId, input.diaryId);
  }

  private getDiaryRow(roleId: string, diaryId: string): DiaryRecord {
    const row = this.db
      .prepare(
        `SELECT diary_id, role_id, relative_path, content, content_hash,
                occurred_at, experience_date, created_at, updated_at
         FROM diaries WHERE diary_id = ? AND role_id = ?`,
      )
      .get(diaryId, roleId) as DiaryRow | undefined;
    if (!row) {
      throw new DiaryNotFoundError(diaryId);
    }
    return mapDiary(row);
  }
}
