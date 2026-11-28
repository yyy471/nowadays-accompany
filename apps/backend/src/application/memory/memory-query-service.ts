import { randomUUID } from "node:crypto";
import { memoryQueryTokens } from "../../domain/memory-query-tokens.js";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  AppError,
  DiaryFileMissingError,
  InvalidMemoryCorrectionError,
  MemoryQueryFailedError,
} from "../../domain/errors.js";
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
  MemoryCorrectionSource,
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
} from "../../domain/memory.js";
import {
  DEFAULT_DIARY_SEGMENT_CHARS,
  MAX_DIARY_SEGMENT_CHARS,
} from "../../domain/memory.js";
import { localDateFromIso, sha256 } from "../../storage/memory/evidence.js";
import { MemoryStore, type MemoryStatus } from "../../storage/memory/memory-store.js";
import type { RoleAccess } from "../role/role-access.js";
import { eventWorldbookReferences, type EventWorldbookReference } from "../../storage/role/worldbook-store.js";
import {
  cosineSimilarity,
  decodeVectorBlob,
  encodeVectorBlob,
  fuseRrfRankings,
  normalizeVector,
  type EmbeddingPort,
  type VectorRankedDocument,
} from "./memory-hybrid-search.js";

export interface MemoryQueryServiceOptions {
  timeZone?: string;
  now?: () => Date;
  /** 可选 Embedding 端口解析器；返回 null 时混合检索零开销退回纯 FTS5。 */
  resolveEmbeddingPort?: () => EmbeddingPort | null;
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

interface HybridCandidate {
  document: DocumentRow;
  experienceDate: string;
}

interface CachedEmbeddingRow {
  document_id: number;
  content_hash: string;
  dimensions: number;
  vector_blob: Buffer;
}

const HYBRID_MIN_SIMILARITY = 0.25;
const EMBEDDING_BATCH_SIZE = 32;

export class MemoryQueryService {
  private readonly timeZone: string | undefined;
  private readonly now: () => Date;
  private readonly resolveEmbeddingPort: (() => EmbeddingPort | null) | undefined;

  constructor(
    private readonly access: RoleAccess,
    options: MemoryQueryServiceOptions = {},
  ) {
    this.timeZone = options.timeZone;
    this.now = options.now ?? (() => new Date());
    this.resolveEmbeddingPort = options.resolveEmbeddingPort;
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
            delivered: false,
          })),
        });
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

  /**
   * 可选混合检索：FTS5 与 Embedding 向量余弦相似度经 RRF 融合。
   * 未配置端口、查询为空或任何外部调用失败时，静默退回同步 search，
   * 保证与现有纯 FTS5 行为一致且不中断用户对话。
   */
  async searchHybrid(
    roleId: string,
    request: MemorySearchRequest,
    context: SearchContext = { mode: "manual" },
  ): Promise<MemorySearchOutcome> {
    const port = this.resolveEmbeddingPort?.() ?? null;
    const query = request.query?.trim() ?? "";
    if (port === null || query.length === 0) {
      return this.search(roleId, request, context);
    }
    const tokens = memoryQueryTokens(query, context.mode);
    const prepared = this.access.withStore(roleId, (storage) => {
      const db = storage.business.db;
      const candidates = this.collectCandidates(db, roleId, request);
      const matches = this.matchDocuments(db, roleId, tokens);
      const ftsMatchedIds = this.rankFtsMatches(
        candidates,
        tokens,
        matches,
      );
      const cached = this.loadCachedVectors(db, roleId, port.modelKey);
      const vectors = new Map<number, Float32Array>();
      const pending: Array<{
        documentId: number;
        contentHash: string;
        text: string;
      }> = [];
      for (const candidate of candidates) {
        const document = candidate.document;
        const text = `${document.title}\n${document.body}`;
        const contentHash = sha256(text);
        const row = cached.get(document.document_id);
        const vector = row !== undefined &&
            row.content_hash === contentHash &&
            row.dimensions > 0
          ? decodeVectorBlob(row.vector_blob, row.dimensions)
          : null;
        if (vector !== null && vector.length > 0) {
          vectors.set(document.document_id, vector);
        } else {
          pending.push({ documentId: document.document_id, contentHash, text });
        }
      }
      return { candidates, ftsMatchedIds, vectors, pending };
    });

    let queryVector: Float32Array = new Float32Array(0);
    const computed = new Map<number, Float32Array>();
    try {
      const queryEmbedding = await embedWithTimeout(port, [query], 3000);
      const rawQuery = asEmbeddingVector(queryEmbedding[0]);
      if (rawQuery === null) {
        throw new Error("EMBEDDING_QUERY_VECTOR_INVALID");
      }
      queryVector = rawQuery;
      for (let offset = 0; offset < prepared.pending.length; offset += EMBEDDING_BATCH_SIZE) {
        const batch = prepared.pending.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        const embedded = await embedWithTimeout(
          port,
          batch.map((item) => item.text),
          8000,
        );
        if (embedded.length !== batch.length) {
          throw new Error("EMBEDDING_DOCUMENT_LENGTH_MISMATCH");
        }
        for (const [index, raw] of embedded.entries()) {
          const target = batch[index];
          if (target === undefined) {
            continue;
          }
          const vector = asEmbeddingVector(raw);
          if (vector === null) {
            throw new Error("EMBEDDING_DOCUMENT_VECTOR_INVALID");
          }
          computed.set(target.documentId, vector);
        }
      }
    } catch {
      return this.search(roleId, request, context);
    }

    return this.access.withStore(roleId, (storage) => {
      const db = storage.business.db;
      const store = new MemoryStore(db);
      const now = this.now().toISOString();
      this.persistVectors(
        db,
        roleId,
        port.modelKey,
        prepared.pending,
        computed,
        now,
      );
      const vectors = new Map(prepared.vectors);
      for (const [documentId, vector] of computed) {
        vectors.set(documentId, vector);
      }
      const vectorRanked: VectorRankedDocument[] = [];
      for (const candidate of prepared.candidates) {
        const vector = vectors.get(candidate.document.document_id);
        if (vector === undefined) {
          continue;
        }
        const similarity = cosineSimilarity(queryVector, vector);
        if (similarity >= HYBRID_MIN_SIMILARITY) {
          vectorRanked.push({
            documentId: candidate.document.document_id,
            similarity,
          });
        }
      }
      vectorRanked.sort(
        (left, right) =>
          right.similarity - left.similarity || left.documentId - right.documentId,
      );
      const fused = fuseRrfRankings(prepared.ftsMatchedIds, vectorRanked, {
        minSimilarity: HYBRID_MIN_SIMILARITY,
      });
      const byId = new Map<number, HybridCandidate>(
        prepared.candidates.map((candidate): [number, HybridCandidate] => [
          candidate.document.document_id,
          candidate,
        ]),
      );
      const items = [...fused.entries()]
        .filter(([, score]) => score > 0)
        .flatMap(([documentId, score]) => {
          const candidate = byId.get(documentId);
          if (candidate === undefined) {
            return [];
          }
          const document = candidate.document;
          return [{
            type: document.record_type,
            id: document.record_id,
            title: document.title,
            snippet: makeSnippet(document.body, tokens),
            experienceDate: candidate.experienceDate,
            updatedAt: document.updated_at,
            rrfScore: score,
          }];
        })
        .sort(compareHybridItems)
        .slice(0, request.limit ?? 20)
        .map((item, index) => ({
          type: item.type,
          id: item.id,
          title: item.title,
          snippet: item.snippet,
          experienceDate: item.experienceDate,
          rank: index + 1,
        }));
      const retrievalId = randomUUID();
      store.saveRetrieval({
        retrievalId,
        roleId,
        executionId: context.executionId ?? null,
        mode: context.mode,
        queryJson: JSON.stringify(request),
        status: "succeeded",
        errorCode: null,
        now,
        items: items.map((item) => ({
          type: item.type,
          id: item.id,
          rank: item.rank,
          delivered: false,
        })),
      });
      return { retrievalId, items };
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
    actor: MemoryCorrectionSource = "agent_correction",
  ): { eventId: string; version: number; updatedAt: string } {
    return this.access.withStore(roleId, (storage) => {
      const store = new MemoryStore(storage.business.db);
      const updated = storage.business.db.transaction(() => {
        const current = store.getEvent(roleId, eventId);
        if (
          Object.keys(input.patch).length === 0 &&
          (input.addEvidenceIds?.length ?? 0) === 0 &&
          (input.supersedeClaimIds?.length ?? 0) === 0
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
          changeSource: actor,
          ...(input.supersedeClaimIds ? { supersedeClaimIds: input.supersedeClaimIds } : {}),
          ...(input.claimReplacements ? { claimReplacements: input.claimReplacements } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
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
    actor: MemoryCorrectionSource = "agent_correction",
  ): { summaryId: string; version: number; updatedAt: string } {
    return this.access.withStore(roleId, (storage) => {
      const store = new MemoryStore(storage.business.db);
      const updated = storage.business.db.transaction(() =>
        store.correctSummary({
          roleId,
          summaryId,
          expectedVersion: input.expectedVersion,
          summary: input.summary,
          changeSource: actor,
          ...(input.reason ? { reason: input.reason } : {}),
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

  listBatches(roleId: string, limit: number, offset = 0): MemoryBatchRecord[] {
    return this.access.withStore(roleId, (storage) =>
      new MemoryStore(storage.business.db).listBatches(roleId, limit, offset),
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
    const tokens = memoryQueryTokens(request.query ?? "", mode);
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

  /**
   * 混合检索的候选集：只做结构化过滤（类型、日期、标签、有效日期），
   * 不要求字面命中，语义召回才能覆盖零重叠的同义改写。
   */
  private collectCandidates(
    db: Database.Database,
    roleId: string,
    request: MemorySearchRequest,
  ): HybridCandidate[] {
    const documents = db
      .prepare(
        `SELECT document_id, record_type, record_id, title, body, updated_at
         FROM memory_search_documents WHERE role_id = ?`,
      )
      .all(roleId) as DocumentRow[];
    const wantedTypes = new Set(request.types ?? []);
    const tagFilters = tagFiltersOf(request);
    const eventTags = tagFilters.length ? this.loadEventTags(db, roleId) : undefined;
    const candidates: HybridCandidate[] = [];
    for (const document of documents) {
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
      candidates.push({ document, experienceDate });
    }
    return candidates;
  }

  /** 用既有 compareSearchItems 语义给字面命中排序，保持与纯 FTS5 一致。 */
  private rankFtsMatches(
    candidates: readonly HybridCandidate[],
    tokens: readonly string[],
    matches: ReadonlyMap<number, MatchInfo>,
  ): number[] {
    if (matches.size === 0) {
      return [];
    }
    const byId = new Map<number, HybridCandidate>(
      candidates.map((candidate): [number, HybridCandidate] => [
        candidate.document.document_id,
        candidate,
      ]),
    );
    const ranked = [...matches.entries()].flatMap(([documentId, match]) => {
      const candidate = byId.get(documentId);
      if (candidate === undefined) {
        return [];
      }
      const document = candidate.document;
      const haystack = `${document.title}\n${document.body}`.toLowerCase();
      const tokenMatches = tokens.filter((token) =>
        haystack.includes(token.toLowerCase()),
      ).length;
      return [{
        documentId,
        tokenMatches,
        ftsScore: match.ftsScore,
        like: match.like,
        experienceDate: candidate.experienceDate,
        updatedAt: document.updated_at,
        type: document.record_type,
        id: document.record_id,
      }];
    });
    ranked.sort(compareSearchItems);
    return ranked.map((item) => item.documentId);
  }

  private loadCachedVectors(
    db: Database.Database,
    roleId: string,
    modelKey: string,
  ): Map<number, CachedEmbeddingRow> {
    const rows = db
      .prepare(
        `SELECT document_id, content_hash, dimensions, vector_blob
         FROM memory_search_embeddings
         WHERE role_id = ? AND model_key = ?`,
      )
      .all(roleId, modelKey) as CachedEmbeddingRow[];
    return new Map<number, CachedEmbeddingRow>(
      rows.map((row): [number, CachedEmbeddingRow] => [row.document_id, row]),
    );
  }

  /** 向量缓存是派生数据，写失败不应影响本次检索结果。 */
  private persistVectors(
    db: Database.Database,
    roleId: string,
    modelKey: string,
    pending: ReadonlyArray<{ documentId: number; contentHash: string }>,
    computed: ReadonlyMap<number, Float32Array>,
    now: string,
  ): void {
    if (pending.length === 0) {
      return;
    }
    const insert = db.prepare(
      `INSERT OR REPLACE INTO memory_search_embeddings
       (document_id, role_id, model_key, content_hash, dimensions, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      db.transaction(() => {
        for (const item of pending) {
          const vector = computed.get(item.documentId);
          if (vector === undefined) {
            continue;
          }
          insert.run(
            item.documentId,
            roleId,
            modelKey,
            item.contentHash,
            vector.length,
            encodeVectorBlob(vector),
            now,
          );
        }
      })();
    } catch {
      // 缓存写入失败只丢失本次复用机会，不改变检索语义。
    }
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
      // 调用方已取得索引正文。已精炼事件只有仍保留具体线索时才有事件索引。
      if (!row) {
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

function compareHybridItems(
  left: {
    rrfScore: number;
    experienceDate: string;
    updatedAt: string;
    type: MemoryRecordType;
    id: string;
  },
  right: {
    rrfScore: number;
    experienceDate: string;
    updatedAt: string;
    type: MemoryRecordType;
    id: string;
  },
): number {
  if (left.rrfScore !== right.rrfScore) {
    return right.rrfScore - left.rrfScore;
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

/**
 * 校验端口返回值并统一归一化；允许 Float32Array 与普通数字数组，
 * 其他形状或非有限值一律视为外部返回异常。
 */
function asEmbeddingVector(value: unknown): Float32Array | null {
  if (value instanceof Float32Array) {
    return value.length === 0 ? null : normalizeVector(value);
  }
  if (Array.isArray(value) && value.length > 0) {
    if (!value.every((item) =>
      typeof item === "number" && Number.isFinite(item))) {
      return null;
    }
    return normalizeVector(value as number[]);
  }
  return null;
}

/**
 * 以固定上限等待外部 Embedding，超时主动 abort；
 * 端口即使忽略 signal，Promise.race 也会保证检索层及时降级。
 */
async function embedWithTimeout(
  port: EmbeddingPort,
  texts: readonly string[],
  timeoutMs: number,
): Promise<Float32Array[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("EMBEDDING_TIMEOUT"));
      reject(new Error("EMBEDDING_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([port.embed(texts, controller.signal), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
