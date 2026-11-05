import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  AppError,
  DiaryFileMissingError,
  InvalidMemoryCorrectionError,
  MemoryQueryFailedError,
} from "../domain/errors.js";
import type {
  DailySummaryRecord,
  DailySummarySourceRecord,
  DiaryCreateInput,
  DiaryDetail,
  DiaryRecord,
  EventCorrection,
  MemoryBatchRecord,
  MemoryEventRecord,
  MemoryEventSourceRecord,
  MemoryEvidenceDetail,
  MemoryRecordType,
  MemorySearchItem,
  MemorySearchOutcome,
  MemorySearchRequest,
  MemoryTagValues,
  SummaryCorrection,
  SummaryEvidenceItem,
} from "../domain/memory.js";
import { localDateFromIso, sha256 } from "../storage/evidence.js";
import { MemoryStore, type MemoryStatus } from "../storage/memory-store.js";
import type { RoleAccess } from "./role-access.js";

export interface MemoryQueryServiceOptions {
  timeZone?: string;
  now?: () => Date;
}

export interface SearchContext {
  mode: "auto" | "agent" | "manual";
  executionId?: string | null;
}

export interface EventDetail extends MemoryEventRecord {
  tags: MemoryTagValues;
  sources: MemoryEventSourceRecord[];
}

export interface SummaryDetail extends DailySummaryRecord {
  sources: DailySummarySourceRecord[];
}

interface DocumentRow {
  record_type: MemoryRecordType;
  record_id: string;
  title: string;
  body: string;
  updated_at: string;
}

interface MatchInfo {
  ftsScore: number | null;
  like: boolean;
}

export class MemoryQueryService {
  private readonly timeZone: string | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly access: RoleAccess,
    options: MemoryQueryServiceOptions = {},
  ) {
    this.timeZone = options.timeZone;
    this.now = options.now ?? (() => new Date());
  }

  search(
    roleId: string,
    request: MemorySearchRequest,
    context: SearchContext = { mode: "manual" },
  ): MemorySearchOutcome {
    return this.access.withStore(roleId, (storage) => {
      const store = new MemoryStore(storage.business.db);
      const retrievalId = randomUUID();
      const now = this.now().toISOString();
      try {
        const items = this.runSearch(store, roleId, request);
        const limited = items.slice(0, request.limit ?? 20).map((item, index) => ({
          ...item,
          rank: index + 1,
        }));
        const delivered = context.mode !== "manual";
        store.saveRetrieval({
          retrievalId,
          roleId,
          executionId: context.executionId ?? null,
          mode: context.mode,
          queryJson: JSON.stringify(request),
          status: "succeeded",
          errorCode: null,
          now,
          items: limited.map((item) => ({
            type: item.type,
            id: item.id,
            rank: item.rank,
            delivered,
          })),
        });
        if (delivered && context.executionId) {
          for (const item of limited) {
            store.recordRecall({
              roleId,
              executionId: context.executionId,
              recordType: item.type,
              recordId: item.id,
              now,
            });
          }
        }
        return { retrievalId, items: limited };
      } catch (error) {
        const code = error instanceof AppError ? error.code : "MEMORY_QUERY_FAILED";
        store.saveRetrieval({
          retrievalId,
          roleId,
          executionId: context.executionId ?? null,
          mode: context.mode,
          queryJson: JSON.stringify(request),
          status: "failed",
          errorCode: code,
          now,
          items: [],
        });
        if (error instanceof AppError) {
          throw error;
        }
        throw new MemoryQueryFailedError();
      }
    });
  }

  getEvent(roleId: string, eventId: string): EventDetail {
    return this.access.withStore(roleId, (storage) => {
      const store = new MemoryStore(storage.business.db);
      return {
        ...store.getEvent(roleId, eventId),
        tags: store.getTags(eventId),
        sources: store.listEventSources(roleId, eventId),
      };
    });
  }

  getSummaryEvidence(
    roleId: string,
    summaryId: string,
    options: {
      windowId?: string;
      fromSequence?: number;
      toSequence?: number;
      limit?: number;
    } = {},
  ): SummaryEvidenceItem[] {
    return this.access.withStore(roleId, (storage) =>
      new MemoryStore(storage.business.db).listSummaryEvidence({
        roleId,
        summaryId,
        ...options,
      }),
    );
  }

  getEvidence(roleId: string, evidenceId: string): MemoryEvidenceDetail {
    return this.access.withStore(roleId, (storage) =>
      new MemoryStore(storage.business.db).getEvidenceDetail(roleId, evidenceId),
    );
  }

  getSummary(roleId: string, summaryId: string): SummaryDetail {
    return this.access.withStore(roleId, (storage) => {
      const store = new MemoryStore(storage.business.db);
      return {
        ...store.getSummary(roleId, summaryId),
        sources: store.listSummarySources(summaryId),
      };
    });
  }

  correctEvent(
    roleId: string,
    eventId: string,
    input: EventCorrection,
  ): { eventId: string; version: number; updatedAt: string } {
    return this.access.withStore(roleId, (storage) => {
      const store = new MemoryStore(storage.business.db);
      const updated = storage.business.db.transaction(() => {
        const current = store.getEvent(roleId, eventId);
        if (
          Object.keys(input.patch).length === 0 &&
          (input.addEvidenceIds?.length ?? 0) === 0
        ) {
          throw new InvalidMemoryCorrectionError(
            "事件纠错没有提供任何变化",
            { eventId },
          );
        }
        const occurredAtStart =
          input.patch.occurredAtStart ?? current.occurredAtStart;
        const occurredAtEnd =
          input.patch.occurredAtEnd === undefined
            ? current.occurredAtEnd
            : input.patch.occurredAtEnd;
        if (occurredAtEnd !== null && occurredAtEnd < occurredAtStart) {
          throw new InvalidMemoryCorrectionError(
            "事件结束时间早于开始时间",
            { eventId },
          );
        }
        const experienceDate = input.patch.occurredAtStart
          ? localDateFromIso(input.patch.occurredAtStart, this.timeZone)
          : current.experienceDate;
        return store.updateEvent({
          roleId,
          eventId,
          expectedVersion: input.expectedVersion,
          patch: input.patch,
          addEvidenceIds: input.addEvidenceIds ?? [],
          currentRound: store.getCurrentRound(roleId),
          now: this.now().toISOString(),
          experienceDate,
          changeSource: "agent_correction",
        });
      })();
      return {
        eventId: updated.eventId,
        version: updated.version,
        updatedAt: updated.updatedAt,
      };
    });
  }

  correctSummary(
    roleId: string,
    summaryId: string,
    input: SummaryCorrection,
  ): { summaryId: string; version: number; updatedAt: string } {
    return this.access.withStore(roleId, (storage) => {
      const store = new MemoryStore(storage.business.db);
      const updated = storage.business.db.transaction(() =>
        store.correctSummary({
          roleId,
          summaryId,
          expectedVersion: input.expectedVersion,
          summary: input.summary,
          now: this.now().toISOString(),
        }),
      )();
      return {
        summaryId: updated.summaryId,
        version: updated.version,
        updatedAt: updated.updatedAt,
      };
    });
  }

  listDiaries(roleId: string): DiaryRecord[] {
    return this.access.withStore(roleId, (storage) =>
      new MemoryStore(storage.business.db).listDiaries(roleId),
    );
  }

  createDiary(
    roleId: string,
    input: DiaryCreateInput,
  ): DiaryDetail {
    return this.access.withStore(roleId, (storage) => {
      const store = new MemoryStore(storage.business.db);
      const diaryId = randomUUID();
      const occurredAt = input.occurredAt ?? this.now().toISOString();
      const experienceDate = localDateFromIso(occurredAt, this.timeZone);
      const relativePath = `diaries/${experienceDate}/${diaryId}.md`;
      const target = safeWorkspacePath(storage.paths.workspaceDir, relativePath);
      const contentHash = sha256(input.content);
      const eventIds = [...new Set(input.eventIds ?? [])];
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tempPath = `${target}.tmp-${randomUUID()}`;
      fs.writeFileSync(tempPath, input.content, "utf8");
      fs.renameSync(tempPath, target);
      try {
        storage.business.db.transaction(() =>
          store.createDiary({
            diaryId,
            roleId,
            relativePath,
            content: input.content,
            contentHash,
            occurredAt,
            experienceDate,
            eventIds,
            now: this.now().toISOString(),
          }),
        )();
      } catch (error) {
        fs.rmSync(target, { force: true });
        throw error;
      }
      return store.getDiary(roleId, diaryId);
    });
  }

  getDiary(roleId: string, diaryId: string): DiaryDetail {
    return this.access.withStore(roleId, (storage) => {
      const store = new MemoryStore(storage.business.db);
      const diary = store.getDiary(roleId, diaryId);
      const filePath = safeWorkspacePath(storage.paths.workspaceDir, diary.relativePath);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        throw new DiaryFileMissingError(diaryId);
      }
      const contentHash = sha256(content);
      storage.business.db.transaction(() => {
        if (contentHash !== sha256(diary.content)) {
          store.updateDiarySnapshot({
            roleId,
            diaryId,
            content,
            contentHash,
            now: this.now().toISOString(),
          });
        }
      })();
      return { ...diary, content };
    });
  }

  getStatus(roleId: string): MemoryStatus {
    return this.access.withStore(roleId, (storage) =>
      new MemoryStore(storage.business.db).getMemoryStatus(roleId),
    );
  }

  listBatches(roleId: string, limit: number): MemoryBatchRecord[] {
    return this.access.withStore(roleId, (storage) =>
      new MemoryStore(storage.business.db).listBatches(roleId, limit),
    );
  }

  trigger(roleId: string): { triggerId: string; duplicate: boolean } {
    return this.access.withStore(roleId, (storage) =>
      new MemoryStore(storage.business.db).enqueueTrigger({
        roleId,
        kind: "manual",
        now: this.now().toISOString(),
      }),
    );
  }

  recordRecall(
    roleId: string,
    input: {
      executionId: string;
      type: MemoryRecordType;
      id: string;
    },
  ): boolean {
    return this.access.withStore(roleId, (storage) => {
      const store = new MemoryStore(storage.business.db);
      if (input.type === "event") {
        store.getEvent(roleId, input.id);
      } else if (input.type === "daily_summary") {
        store.getSummary(roleId, input.id);
      } else {
        store.getDiary(roleId, input.id);
      }
      return store.recordRecall({
        roleId,
        executionId: input.executionId,
        recordType: input.type,
        recordId: input.id,
        now: this.now().toISOString(),
      });
    });
  }

  private runSearch(
    store: MemoryStore,
    roleId: string,
    request: MemorySearchRequest,
  ): MemorySearchItem[] {
    const db = store.getDatabase();
    const tokens = tokenizeQuery(request.query ?? "");
    const matches = this.matchDocuments(db, roleId, tokens);
    const documents = db
      .prepare(
        `SELECT record_type, record_id, title, body, updated_at
         FROM memory_search_documents WHERE role_id = ?`,
      )
      .all(roleId) as DocumentRow[];
    const wantedTypes = new Set(request.types ?? []);
    const tagFilters = tagFiltersOf(request);
    const eventTags = this.loadEventTags(db, roleId);
    const items: Array<MemorySearchItem & {
      tokenMatches: number;
      ftsScore: number | null;
      like: boolean;
      experienceDate: string;
      updatedAt: string;
    }> = [];
    for (const document of documents) {
      const key = `${document.record_type}:${document.record_id}`;
      const match = matches.get(key);
      if (tokens.length > 0 && !match) {
        continue;
      }
      if (wantedTypes.size > 0 && !wantedTypes.has(document.record_type)) {
        continue;
      }
      const experienceDate = this.experienceDateOf(
        db,
        roleId,
        document.record_type,
        document.record_id,
      );
      if (experienceDate === null) {
        continue;
      }
      if (request.dateFrom && experienceDate < request.dateFrom) {
        continue;
      }
      if (request.dateTo && experienceDate > request.dateTo) {
        continue;
      }
      if (tagFilters.length > 0) {
        if (document.record_type !== "event") {
          continue;
        }
        const tags = eventTags.get(document.record_id) ?? new Map();
        const matchesAll = tagFilters.every((filter) => {
          const values = tags.get(filter.dimension);
          return filter.values.some((value) =>
            values?.has(normalizeTag(value)) ?? false,
          );
        });
        if (!matchesAll) {
          continue;
        }
      }
      const haystack = `${document.title}\n${document.body}`.toLowerCase();
      const tokenMatches = tokens.filter((token) =>
        haystack.includes(token.toLowerCase()),
      ).length;
      items.push({
        type: document.record_type,
        id: document.record_id,
        title: document.title,
        snippet: makeSnippet(document.body, tokens),
        rank: 0,
        tokenMatches,
        ftsScore: match?.ftsScore ?? null,
        like: match?.like ?? false,
        experienceDate,
        updatedAt: document.updated_at,
      });
    }
    items.sort(compareSearchItems);
    return items.map(({ type, id, title, snippet }) => ({
      type,
      id,
      title,
      snippet,
      rank: 0,
    }));
  }

  private matchDocuments(
    db: Database.Database,
    roleId: string,
    tokens: readonly string[],
  ): Map<string, MatchInfo> {
    const matches = new Map<string, MatchInfo>();
    if (tokens.length === 0) {
      return matches;
    }
    const longTokens = tokens.filter((token) => Array.from(token).length >= 3);
    const shortTokens = tokens.filter((token) => Array.from(token).length > 0 && Array.from(token).length < 3);
    if (longTokens.length > 0) {
      const expression = longTokens
        .map((token) => `"${token.replace(/"/g, '""')}"`)
        .join(" OR ");
      const rows = db
        .prepare(
          `SELECT d.record_type, d.record_id, bm25(memory_search_fts) AS score
           FROM memory_search_fts
           JOIN memory_search_documents d ON d.document_id = memory_search_fts.rowid
           WHERE memory_search_fts MATCH ? AND d.role_id = ?`,
        )
        .all(expression, roleId) as Array<{
        record_type: MemoryRecordType;
        record_id: string;
        score: number;
      }>;
      for (const row of rows) {
        matches.set(`${row.record_type}:${row.record_id}`, {
          ftsScore: row.score,
          like: false,
        });
      }
    }
    for (const token of shortTokens) {
      const pattern = `%${token.replace(/[%_\\]/g, "\\$&")}%`;
      const rows = db
        .prepare(
          `SELECT record_type, record_id FROM memory_search_documents
           WHERE role_id = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`,
        )
        .all(roleId, pattern, pattern) as Array<{
        record_type: MemoryRecordType;
        record_id: string;
      }>;
      for (const row of rows) {
        const key = `${row.record_type}:${row.record_id}`;
        const existing = matches.get(key);
        if (existing) {
          existing.like = true;
        } else {
          matches.set(key, { ftsScore: null, like: true });
        }
      }
    }
    return matches;
  }

  private experienceDateOf(
    db: Database.Database,
    roleId: string,
    type: MemoryRecordType,
    id: string,
  ): string | null {
    if (type === "event") {
      const row = db
        .prepare(
          "SELECT experience_date, lifecycle_status FROM memory_events WHERE event_id = ? AND role_id = ?",
        )
        .get(id, roleId) as
        | { experience_date: string; lifecycle_status: string }
        | undefined;
      if (!row || row.lifecycle_status !== "active") {
        return null;
      }
      return row.experience_date;
    }
    if (type === "daily_summary") {
      const row = db
        .prepare(
          "SELECT experience_date FROM daily_summaries WHERE summary_id = ? AND role_id = ?",
        )
        .get(id, roleId) as { experience_date: string } | undefined;
      return row?.experience_date ?? null;
    }
    const row = db
      .prepare(
        "SELECT experience_date FROM diaries WHERE diary_id = ? AND role_id = ?",
      )
      .get(id, roleId) as { experience_date: string } | undefined;
    return row?.experience_date ?? null;
  }

  private loadEventTags(
    db: Database.Database,
    roleId: string,
  ): Map<string, Map<string, Set<string>>> {
    const result = new Map<string, Map<string, Set<string>>>();
    const rows = db
      .prepare(
        `SELECT t.event_id, t.dimension, t.normalized_value
         FROM memory_event_tags t
         JOIN memory_events e ON e.event_id = t.event_id
         WHERE e.role_id = ?`,
      )
      .all(roleId) as Array<{
      event_id: string;
      dimension: string;
      normalized_value: string;
    }>;
    for (const row of rows) {
      let dimensions = result.get(row.event_id);
      if (!dimensions) {
        dimensions = new Map();
        result.set(row.event_id, dimensions);
      }
      let values = dimensions.get(row.dimension);
      if (!values) {
        values = new Set();
        dimensions.set(row.dimension, values);
      }
      values.add(row.normalized_value);
    }
    return result;
  }
}

function tokenizeQuery(query: string): string[] {
  const normalized = query.replace(
    /(?<=[\u4e00-\u9fff])[的了和与及在](?=[\u4e00-\u9fff])/gu,
    " ",
  );
  return normalized
    .split(/[\s,，。.;；、:：!?！？()（）[\]【】\-—_/\\]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function tagFiltersOf(
  request: MemorySearchRequest,
): Array<{ dimension: string; values: string[] }> {
  const filters: Array<{ dimension: string; values: string[] }> = [];
  if (request.people) {
    filters.push({ dimension: "person", values: request.people });
  }
  if (request.topics) {
    filters.push({ dimension: "topic", values: request.topics });
  }
  if (request.places) {
    filters.push({ dimension: "place", values: request.places });
  }
  if (request.emotions) {
    filters.push({ dimension: "emotion", values: request.emotions });
  }
  if (request.sources) {
    filters.push({ dimension: "source", values: request.sources });
  }
  return filters;
}

function compareSearchItems(
  left: {
    tokenMatches: number;
    ftsScore: number | null;
    like: boolean;
    experienceDate: string;
    updatedAt: string;
    type: MemoryRecordType;
    id: string;
  },
  right: {
    tokenMatches: number;
    ftsScore: number | null;
    like: boolean;
    experienceDate: string;
    updatedAt: string;
    type: MemoryRecordType;
    id: string;
  },
): number {
  if (left.tokenMatches !== right.tokenMatches) {
    return right.tokenMatches - left.tokenMatches;
  }
  const leftScore = left.ftsScore ?? Number.POSITIVE_INFINITY;
  const rightScore = right.ftsScore ?? Number.POSITIVE_INFINITY;
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }
  if (left.experienceDate !== right.experienceDate) {
    return right.experienceDate.localeCompare(left.experienceDate);
  }
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }
  if (left.type !== right.type) {
    return left.type.localeCompare(right.type);
  }
  return left.id.localeCompare(right.id);
}

function makeSnippet(body: string, tokens: readonly string[]): string {
  const lower = body.toLowerCase();
  let index = -1;
  for (const token of tokens) {
    const found = lower.indexOf(token.toLowerCase());
    if (found >= 0 && (index < 0 || found < index)) {
      index = found;
    }
  }
  const start = index > 0 ? Math.max(0, index - 40) : 0;
  const end = Math.min(body.length, start + 120);
  const snippet = body.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${end < body.length ? "…" : ""}`;
}

function safeWorkspacePath(workspaceDir: string, relativePath: string): string {
  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("DIARY_PATH_INVALID");
  }
  return target;
}
