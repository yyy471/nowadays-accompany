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
  DiarySegmentView,
  EventCorrection,
  MemoryBatchRecord,
  MemoryClaimRecord,
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
import {
  DEFAULT_DIARY_SEGMENT_CHARS,
  MAX_DIARY_SEGMENT_CHARS,
} from "../domain/memory.js";
import { localDateFromIso, sha256 } from "../storage/evidence.js";
import { MemoryStore, type MemoryStatus } from "../storage/memory-store.js";
import type { RoleAccess } from "./role-access.js";
import { eventWorldbookReferences, type EventWorldbookReference } from "../storage/worldbook-store.js";

export interface MemoryQueryServiceOptions {
  timeZone?: string;
  now?: () => Date;
}

export interface SearchContext {
  mode: "auto" | "agent" | "manual";
  executionId?: string | null;
}

export interface EventDetail extends MemoryEventRecord {
  worldbookEntries: EventWorldbookReference[];
  tags: MemoryTagValues;
  sources: MemoryEventSourceRecord[];
  claims: MemoryClaimRecord[];
  relatedGrowthEventIds: string[];
}

export interface SummaryDetail extends DailySummaryRecord {
  sources: DailySummarySourceRecord[];
}

interface DocumentRow {
  document_id: number;
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
        const items = this.runSearch(store, roleId, request, context.mode);
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
        worldbookEntries: eventWorldbookReferences(storage.business.db, roleId, eventId),
        tags: store.getTags(eventId),
        sources: store.listEventSources(roleId, eventId),
        claims: store.listEventClaims(roleId, eventId),
        relatedGrowthEventIds: store.listRelatedGrowthEvents(roleId, eventId),
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
      }).immediate();
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
      ).immediate();
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

  /**
   * 按日记编号分段读取正文（GAP-06）：复用 getDiary 的管道
   * （角色隔离、路径防逃逸、文件缺失错误、快照哈希回写），
   * 按码点切片，保留 Markdown 正文与工作空间文件的对应关系。
   */
  getDiarySegment(
    roleId: string,
    diaryId: string,
    options: { fromChar?: number; maxChars?: number } = {},
  ): DiarySegmentView {
    const fromChar = Math.max(
      0,
      Math.floor(options.fromChar ?? 0),
    );
    const maxChars = Math.min(
      MAX_DIARY_SEGMENT_CHARS,
      Math.max(1, Math.floor(options.maxChars ?? DEFAULT_DIARY_SEGMENT_CHARS)),
    );
    return this.access.withStore(roleId, (storage) => {
      const store = new MemoryStore(storage.business.db);
      const diary = store.getDiary(roleId, diaryId);
      const filePath = safeWorkspacePath(
        storage.paths.workspaceDir,
        diary.relativePath,
      );
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
      const chars = Array.from(content);
      const totalChars = chars.length;
      const start = Math.min(fromChar, totalChars);
      const end = Math.min(start + maxChars, totalChars);
      return {
        diaryId: diary.diaryId,
        relativePath: diary.relativePath,
        occurredAt: diary.occurredAt,
        experienceDate: diary.experienceDate,
        content: chars.slice(start, end).join(""),
        totalChars,
        fromChar: start,
        toChar: end,
        hasMore: end < totalChars,
        eventIds: diary.eventIds,
      };
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
    mode: SearchContext["mode"],
  ): MemorySearchItem[] {
    const db = store.getDatabase();
    const tokens = tokenizeQuery(request.query ?? "", mode);
    if (request.query?.trim() && tokens.length === 0 && !request.dateFrom && !request.dateTo) return [];
    const matches = this.matchDocuments(db, roleId, tokens);
    if (tokens.length && !matches.size) return [];
    const filterByMatch = tokens.length > 0;
    const documents = db
      .prepare(
        `SELECT document_id, record_type, record_id, title, body, updated_at
         FROM memory_search_documents WHERE role_id = ?
         ${filterByMatch ? "AND document_id IN (SELECT value FROM json_each(?))" : ""}`,
      )
      .all(...(filterByMatch ? [roleId, JSON.stringify([...matches.keys()])] : [roleId])) as DocumentRow[];
    const wantedTypes = new Set(request.types ?? []);
    const tagFilters = tagFiltersOf(request);
    const eventTags = tagFilters.length ? this.loadEventTags(db, roleId) : undefined;
    const items: Array<MemorySearchItem & {
      tokenMatches: number;
      ftsScore: number | null;
      like: boolean;
      experienceDate: string;
      updatedAt: string;
    }> = [];
    for (const document of documents) {
      const match = matches.get(document.document_id);
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
        const tags = eventTags?.get(document.record_id);
        const matchesAll = tagFilters.every((filter) => {
          const values = tags?.get(filter.dimension);
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
    return items.map(({ type, id, title, snippet, experienceDate }) => ({
      type,
      id,
      title,
      snippet,
      experienceDate,
      rank: 0,
    }));
  }

  private matchDocuments(
    db: Database.Database,
    roleId: string,
    tokens: readonly string[],
  ): Map<number, MatchInfo> {
    const matches = new Map<number, MatchInfo>();
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
          `SELECT d.document_id, bm25(memory_search_fts) AS score
           FROM memory_search_fts
           JOIN memory_search_documents d ON d.document_id = memory_search_fts.rowid
           WHERE memory_search_fts MATCH ? AND d.role_id = ?`,
        )
        .all(expression, roleId) as Array<{
        document_id: number;
        score: number;
      }>;
      for (const row of rows) {
        matches.set(row.document_id, {
          ftsScore: row.score,
          like: false,
        });
      }
    }
    for (const token of shortTokens) {
      const pattern = `%${token.replace(/[%_\\]/g, "\\$&")}%`;
      const rows = db
        .prepare(
          `SELECT document_id FROM memory_search_documents
           WHERE role_id = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`,
        )
        .all(roleId, pattern, pattern) as Array<{
        document_id: number;
      }>;
      for (const row of rows) {
        const existing = matches.get(row.document_id);
        if (existing) {
          existing.like = true;
        } else {
          matches.set(row.document_id, { ftsScore: null, like: true });
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

const wordSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
// 口语问句里的时间、指代与寒暄独立命中时，通常不能定位到某件经历。
const queryFillers = new Set(
  "今天 明天 昨天 那天 当时 最近 后来 之前 以前 上次 这次 时候 我们 你们 他们 那个 这个 那些 这些 一下 一起 已经 是不是 有没有 还有 没有 怎么 怎样 什么 哪里 为什么 知道 记得 记不记得 我想 你有 你好 您好 哈喽 早安 晚安 谢谢 哈哈 你好呀 提过 说过".split(" "),
);

function tokenizeQuery(query: string, mode: SearchContext["mode"]): string[] {
  const tokens = new Set<string>();
  for (const clause of query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
    if (mode === "auto" && queryFillers.has(clause)) continue;
    if (!/\p{Script=Han}/u.test(clause) || clause.length <= 3) {
      tokens.add(clause);
      continue;
    }
    const words = Array.from(wordSegmenter.segment(clause))
      .filter((word) => word.isWordLike && word.segment.length >= 2 && !queryFillers.has(word.segment))
      .map((word) => word.segment);
    // 保留整段作精确匹配；长问句还可用其中的专名和事物找到不同措辞的原文。
    tokens.add(clause);
    for (const word of words) tokens.add(word);
  }
  return [...tokens];
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
  const width = 120;
  let offset = 0;
  let bestStart = 0;
  let bestEnd = Math.min(body.length, width);
  let bestScore = 0;
  // 每条说法单独占一行。让同一段里同时出现的多个线索优先，并尽量留下段首的来源说明。
  for (const line of body.split("\n")) {
    for (let start = 0; start < line.length; start += width / 2) {
      const slice = line.slice(start, start + width).toLowerCase();
      const score = tokens.reduce((total, term) =>
        total + (slice.includes(term) ? Math.min(term.length, 12) : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestStart = offset + start;
        bestEnd = bestStart + slice.length;
      }
      if (start + width >= line.length) break;
    }
    offset += line.length + 1;
  }
  const snippet = body.slice(bestStart, bestEnd).replace(/\s+/g, " ").trim();
  return `${bestStart > 0 ? "…" : ""}${snippet}${bestEnd < body.length ? "…" : ""}`;
}

function safeWorkspacePath(workspaceDir: string, relativePath: string): string {
  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("DIARY_PATH_INVALID");
  }
  return target;
}
