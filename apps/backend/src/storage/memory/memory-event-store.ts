import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  InvalidMemoryCorrectionError,
  MemoryOperationInvalidError,
  MemoryVersionConflictError,
} from "../../domain/errors.js";
import type {
  MemoryClaimRecord,
  MemoryEventRecord,
  MemoryEventSourceRecord,
  MemoryTagValues,
  RefineCandidateBrief,
  RelatedEventBrief,
} from "../../domain/memory.js";
import { memoryQueryTokens } from "../../domain/memory-query-tokens.js";
import { indexRetainedDetails, upsertSearchDocument } from "./memory-search-store.js";
import {
  comparePracticeHistory,
  currentPracticeKey,
  insertRevision,
  mapEvent,
  mapEventSource,
  readEvent,
  readEventClaims,
  readEvidenceMessageContext,
  searchableClaimText,
} from "./memory-store-types.js";
import type {
  CreateEventInput,
  EventClaim,
  EventRow,
  EvidenceRow,
  UpdateEventInput,
} from "./memory-store-types.js";

export class MemoryEventStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  listEvents(roleId: string): MemoryEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, role_id, title, summary, subjective_experience,
                occurred_at_start, occurred_at_end, experience_date, lifecycle_status,
                refined_summary_id, version, last_supplemented_round, created_at, updated_at
         FROM memory_events WHERE role_id = ? ORDER BY created_at ASC, event_id ASC`,
      )
      .all(roleId) as EventRow[];
    return rows.map(mapEvent);
  }

  listRecentEvents(roleId: string, limit = 20, evidenceText = ""): RelatedEventBrief[] {
    const evidence = evidenceText.toLowerCase();
    const terms = memoryQueryTokens(evidence, "auto").filter(word => word.length >= 2);
    const rows = this.db
      .prepare(
        `SELECT e.event_id, d.title, CASE WHEN e.lifecycle_status = 'active' THEN e.summary ELSE d.body END AS summary,
           e.experience_date, e.version,
           (? <> '' AND (
           instr(?, lower(e.title)) > 0 OR EXISTS (
             SELECT 1 FROM memory_event_tags t WHERE t.event_id = e.event_id
               AND t.dimension IN ('topic','place') AND length(t.normalized_value) >= 2
               AND instr(?, t.normalized_value) > 0
           ) OR (e.lifecycle_status='refined' AND EXISTS (
             SELECT 1 FROM json_each(?) term WHERE instr(d.related_text,term.value)>0
           ))
         )) AS relevant
         FROM memory_events e JOIN memory_search_documents d
           ON d.role_id=e.role_id AND d.record_type='event' AND d.record_id=e.event_id
         WHERE e.role_id = ? AND (e.lifecycle_status = 'active' OR relevant)
         ORDER BY relevant DESC, e.updated_at DESC, e.event_id ASC LIMIT ?`,
      )
      .all(evidence, evidence, evidence, JSON.stringify(terms), roleId, limit) as Array<{
        event_id: string;
        title: string;
        summary: string;
        experience_date: string;
        version: number;
        relevant: number;
      }>;
    return rows.map(row => {
      const keys = row.relevant ? [...new Set(this.listEventClaims(roleId, row.event_id)
        .map(currentPracticeKey).filter((key): key is string => Boolean(key)))].slice(0, 12) : [];
      return {
        eventId: row.event_id,
        title: row.title,
        summary: row.summary,
        experienceDate: row.experience_date,
        version: row.version,
        ...(keys.length ? { practiceKeys: keys } : {}),
      };
    });
  }

  getEvent(roleId: string, eventId: string): MemoryEventRecord {
    return readEvent(this.db, roleId, eventId);
  }

  createEvent(input: CreateEventInput): MemoryEventRecord {
    const eventId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_events
         (event_id, role_id, title, summary, subjective_experience,
          occurred_at_start, occurred_at_end, experience_date, lifecycle_status,
          refined_summary_id, version, last_supplemented_round, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.roleId,
        input.title,
        input.summary,
        input.subjectiveExperience,
        input.occurredAtStart,
        input.occurredAtEnd,
        input.experienceDate,
        input.currentRound,
        input.now,
        input.now,
      );
    this.insertTags(eventId, input.tags);
    for (const evidenceId of input.evidenceIds) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_event_sources (event_id, evidence_id, linked_at)
           VALUES (?, ?, ?)`,
        )
        .run(eventId, evidenceId, input.now);
    }
    insertRevision(this.db, {
      roleId: input.roleId,
      targetType: "event",
      targetId: eventId,
      revisionNumber: 1,
      baseRevision: 0,
      changeSource: "memory_batch",
      content: {
        title: input.title,
        summary: input.summary,
        subjectiveExperience: input.subjectiveExperience,
        occurredAtStart: input.occurredAtStart,
        occurredAtEnd: input.occurredAtEnd,
        experienceDate: input.experienceDate,
        tags: input.tags,
        claims: input.claims ?? [],
      },
      evidenceIds: input.evidenceIds,
      now: input.now,
    });
    upsertSearchDocument(this.db, {
      roleId: input.roleId,
      recordType: "event",
      recordId: eventId,
      title: input.title,
      body: [input.summary, input.subjectiveExperience, ...searchableClaimText(input.claims ?? [])].filter(Boolean).join("\n"),
      now: input.now,
    });
    return this.getEvent(input.roleId, eventId);
  }

  updateEvent(input: UpdateEventInput): MemoryEventRecord {
    const current = this.getEvent(input.roleId, input.eventId);
    if (current.version !== input.expectedVersion) {
      throw new MemoryVersionConflictError(
        input.eventId,
        input.expectedVersion,
        current.version,
      );
    }
    const patch = input.patch;
    const title = patch.title ?? current.title;
    const summary = patch.summary ?? current.summary;
    const subjectiveExperience =
      patch.subjectiveExperience ?? current.subjectiveExperience;
    const occurredAtStart = patch.occurredAtStart ?? current.occurredAtStart;
    const occurredAtEnd =
      patch.occurredAtEnd === undefined
        ? current.occurredAtEnd
        : patch.occurredAtEnd;
    if (occurredAtEnd !== null && occurredAtEnd < occurredAtStart) {
      throw new MemoryOperationInvalidError("事件结束时间早于开始时间", {
        eventId: input.eventId,
      });
    }
    const nextVersion = current.version + 1;
    const changes = this.correctClaimLines(input);
    const experienceDate = input.experienceDate ?? current.experienceDate;
    this.db
      .prepare(
        `UPDATE memory_events
         SET title = ?, summary = ?, subjective_experience = ?,
             occurred_at_start = ?, occurred_at_end = ?, experience_date = ?,
             version = ?, last_supplemented_round = ?, updated_at = ?
         WHERE event_id = ? AND role_id = ?`,
      )
      .run(
        title,
        summary,
        subjectiveExperience,
        occurredAtStart,
        occurredAtEnd,
        experienceDate,
        nextVersion,
        input.currentRound,
        input.now,
        input.eventId,
        input.roleId,
      );
    if (patch.tags) {
      this.replaceTagDimensions(input.eventId, patch.tags);
    }
    for (const evidenceId of input.addEvidenceIds) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_event_sources (event_id, evidence_id, linked_at)
           VALUES (?, ?, ?)`,
        )
        .run(input.eventId, evidenceId, input.now);
    }
    const tags = this.getTags(input.eventId);
    insertRevision(this.db, {
      roleId: input.roleId,
      targetType: "event",
      targetId: input.eventId,
      revisionNumber: nextVersion,
      baseRevision: current.version,
      changeSource: input.changeSource ?? "memory_batch",
      content: {
        ...(input.reason ? { reason: input.reason } : {}),
        title,
        summary,
        subjectiveExperience,
        occurredAtStart,
        occurredAtEnd,
        experienceDate,
        tags,
        claims: [...(input.claims ?? []), ...changes.replacements],
        ...(changes.withdrawn.size ? { supersedeClaimIds: [...changes.withdrawn] } : {}),
      },
      evidenceIds: input.addEvidenceIds,
      now: input.now,
    });
    if (current.lifecycleStatus === "active") {
      upsertSearchDocument(this.db, {
        roleId: input.roleId,
        recordType: "event",
        recordId: input.eventId,
        title,
        body: [summary, subjectiveExperience, ...searchableClaimText(this.listEventClaims(input.roleId, input.eventId))].filter(Boolean).join("\n"),
        now: input.now,
      });
    } else {
      indexRetainedDetails(this.db, input.roleId, input.eventId, input.now);
    }
    return this.getEvent(input.roleId, input.eventId);
  }

  listRelatedGrowthEvents(roleId: string, eventId: string): string[] {
    const rows = this.db.prepare(
      `WITH links AS (
         SELECT r.target_id AS later, json_extract(c.value, '$.relatedEventId') AS earlier
         FROM memory_revisions r, json_each(r.content_json, '$.claims') c
         WHERE r.role_id = ? AND r.target_type = 'event' AND json_type(c.value, '$.relatedEventId') = 'text'
           AND NOT EXISTS (
             SELECT 1 FROM memory_revisions edit, json_each(edit.content_json, '$.supersedeClaimIds') old
             WHERE edit.target_id=r.target_id AND edit.target_type='event' AND edit.role_id=r.role_id
               AND old.value = 'v' || r.revision_number || ':' || c.key
           )
       )
       SELECT earlier AS event_id FROM links WHERE later = ? AND earlier <> later
       UNION SELECT later AS event_id FROM links WHERE earlier = ? AND earlier <> later
       ORDER BY event_id`,
    ).all(roleId, eventId, eventId) as { event_id: string }[];
    return rows.map(row => row.event_id);
  }

  private correctClaimLines(input: UpdateEventInput): { withdrawn: Set<string>; replacements: MemoryClaimRecord[] } {
    const selected = new Set(input.supersedeClaimIds ?? []);
    const withdrawn = new Set(selected);
    const replacements: MemoryClaimRecord[] = [];
    const textById = input.claimReplacements ?? {};
    if (Object.keys(textById).some(id => !selected.has(id))) {
      throw new InvalidMemoryCorrectionError("替换文字必须对应本次选中的线索");
    }
    if (!selected.size) return { withdrawn, replacements };
    const source = input.changeSource;
    if (source !== "user_correction" && source !== "agent_correction") {
      throw new InvalidMemoryCorrectionError("需要指定更正来源");
    }
    const claims = this.listEventClaims(input.roleId, input.eventId);
    for (const id of selected) {
      const claim = claims.find(item => item.claimId === id);
      if (!claim) throw new InvalidMemoryCorrectionError("所选线索已失效或不属于该事件", { claimId: id });
      const key = currentPracticeKey(claim);
      if (key) {
        // 撤下现行做法时，旧的已被其覆盖的版本不能自动重新成为当前做法。
        for (const item of claims) {
          if (currentPracticeKey(item) === key && comparePracticeHistory(item, claim) <= 0) withdrawn.add(item.claimId);
        }
      }
      const text = textById[id];
      if (text === undefined) continue;
      const correctedKind = claim.kind === "correction" ? claim.correctedKind : claim.kind;
      replacements.push({
        kind: "correction", ...(correctedKind ? { correctedKind } : {}), text,
        evidenceId: claim.evidenceId, learnedAt: input.now, sourceAt: claim.sourceAt,
        recordedAt: input.now, correctionSource: source,
        ...(key ? { correctedPracticeKey: key, originalPracticeClaimId: claim.originalPracticeClaimId ?? claim.claimId } : {}),
        ...(claim.relatedEventId ? { relatedEventId: claim.relatedEventId } : {}),
      });
    }
    return { withdrawn, replacements };
  }

  listEventClaims(roleId: string, eventId: string): EventClaim[] {
    return readEventClaims(this.db, roleId, eventId);
  }

  listEventSources(
    roleId: string,
    eventId: string,
  ): MemoryEventSourceRecord[] {
    this.getEvent(roleId, eventId);
    const rows = this.db
      .prepare(
        `SELECT er.*
         FROM memory_event_sources s
         JOIN evidence_records er ON er.evidence_id = s.evidence_id
         WHERE s.event_id = ? AND er.role_id = ?
         ORDER BY er.role_sequence ASC`,
      )
      .all(eventId, roleId) as EvidenceRow[];
    return rows.map(row => ({ ...mapEventSource(row), sender: readEvidenceMessageContext(this.db, row.source_kind, row.source_id).sender }));
  }

  listRefineCandidates(
    roleId: string,
    currentRound: number,
    window = 100,
  ): RefineCandidateBrief[] {
    const rows = this.db
      .prepare(
        `SELECT e.event_id, e.title, e.summary, e.experience_date, e.version,
                e.last_supplemented_round
         FROM memory_events e
         WHERE e.role_id = ? AND e.lifecycle_status = 'active'
           AND ? - e.last_supplemented_round >= ?
           AND (
             SELECT COUNT(*)
             FROM memory_recalls mr
             JOIN executions x ON x.execution_id = mr.execution_id
             WHERE mr.role_id = e.role_id
               AND mr.record_type = 'event'
               AND mr.record_id = e.event_id
               AND x.decision_round IS NOT NULL
               AND x.decision_round > ? - ?
               AND x.decision_round <= ?
           ) <= 1
         ORDER BY e.experience_date ASC, e.event_id ASC
         LIMIT 50`,
      )
      .all(
        roleId,
        currentRound,
        window,
        currentRound,
        window,
        currentRound,
      ) as Array<{
      event_id: string;
      title: string;
      summary: string;
      experience_date: string;
      version: number;
      last_supplemented_round: number;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      title: row.title,
      summary: row.summary,
      experienceDate: row.experience_date,
      version: row.version,
      lastSupplementedRound: row.last_supplemented_round,
    }));
  }

  getTags(eventId: string): MemoryTagValues {
    const rows = this.db
      .prepare(
        "SELECT dimension, value FROM memory_event_tags WHERE event_id = ? ORDER BY dimension ASC, normalized_value ASC",
      )
      .all(eventId) as Array<{ dimension: keyof MemoryTagValues; value: string }>;
    const tags: MemoryTagValues = {};
    for (const row of rows) {
      const list = tags[row.dimension] ?? [];
      list.push(row.value);
      tags[row.dimension] = list;
    }
    return tags;
  }

  private insertTags(eventId: string, tags: MemoryTagValues): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO memory_event_tags
       (event_id, dimension, value, normalized_value) VALUES (?, ?, ?, ?)`,
    );
    const dimensions: Array<keyof MemoryTagValues> = [
      "person",
      "topic",
      "place",
      "emotion",
      "source",
    ];
    for (const dimension of dimensions) {
      for (const value of tags[dimension] ?? []) {
        const normalized = value.trim().toLowerCase();
        if (!normalized) {
          continue;
        }
        insert.run(eventId, dimension, value.trim(), normalized);
      }
    }
  }

  private replaceTagDimensions(eventId: string, tags: MemoryTagValues): void {
    const dimensions: Array<keyof MemoryTagValues> = [
      "person",
      "topic",
      "place",
      "emotion",
      "source",
    ];
    for (const dimension of dimensions) {
      if (tags[dimension] === undefined) {
        continue;
      }
      this.db
        .prepare(
          "DELETE FROM memory_event_tags WHERE event_id = ? AND dimension = ?",
        )
        .run(eventId, dimension);
    }
    this.insertTags(eventId, tags);
  }
}
