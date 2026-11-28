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
  cosineSimilarityWithBlob,
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
  resolveEmbeddingPort?: (roleId: string) => EmbeddingPort | null;
  /** 单批向量化的文档数（在线补算与后台回填共用），默认 32。 */
  embeddingBatchSize?: number;
  /** 实时检索路径最多同步补算的批次数，默认 2。 */
  onlineBackfillMaxBatches?: number;
  /** 实时检索路径同步补算的总预算（毫秒），默认 3000。 */
  onlineBackfillBudgetMs?: number;
  /** 查询向量化超时，默认 3000。 */
  embeddingQueryTimeoutMs?: number;
  /** 单批文档向量化超时，默认 3000。 */
  embeddingBatchTimeoutMs?: number;
  /** 角色是否允许后台回填（活动状态）；未提供时默认允许。 */
  isRoleActive?: (roleId: string) => boolean;
  /** 角色是否正在删除收尾；删除期间不再开启或继续后台回填。 */
  isRoleDeleting?: (roleId: string) => boolean;
  /** 后台回填任务真正结算（含取消收尾）后通知，用于让停止确认收敛；关闭路径不回调。 */
  onBackfillIdle?: (roleId: string) => void;
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

interface PendingEmbedding {
  documentId: number;
  contentHash: string;
  text: string;
}

interface BackfillTask {
  promise: Promise<void>;
  controller: AbortController;
  /** 该向量空间实际使用的全局模型资源，用于维护与删除的在途依赖。 */
  resourceId: string | undefined;
}

const HYBRID_MIN_SIMILARITY = 0.25;

export class MemoryQueryService {
  private readonly timeZone: string | undefined;
  private readonly now: () => Date;
  private readonly resolveEmbeddingPort:
    | ((roleId: string) => EmbeddingPort | null)
    | undefined;
  private readonly embeddingBatchSize: number;
  private readonly onlineBackfillMaxBatches: number;
  private readonly onlineBackfillBudgetMs: number;
  private readonly embeddingQueryTimeoutMs: number;
  private readonly embeddingBatchTimeoutMs: number;
  private readonly isRoleActive: ((roleId: string) => boolean) | undefined;
  private readonly isRoleDeleting: ((roleId: string) => boolean) | undefined;
  private readonly onBackfillIdle: ((roleId: string) => void) | undefined;
  /** 每个角色最多一个后台回填任务，实例级状态，避免模块级单例串角色。 */
  private readonly backfillTasks = new Map<string, BackfillTask>();
  private closed = false;

  constructor(
    private readonly access: RoleAccess,
    options: MemoryQueryServiceOptions = {},
  ) {
    this.timeZone = options.timeZone;
    this.now = options.now ?? (() => new Date());
    this.resolveEmbeddingPort = options.resolveEmbeddingPort;
    this.embeddingBatchSize = boundedInt(options.embeddingBatchSize, 32, 1);
    this.onlineBackfillMaxBatches = boundedInt(
      options.onlineBackfillMaxBatches,
      2,
      0,
    );
    this.onlineBackfillBudgetMs = boundedInt(
      options.onlineBackfillBudgetMs,
      3000,
      0,
    );
    this.embeddingQueryTimeoutMs = boundedInt(
      options.embeddingQueryTimeoutMs,
      3000,
      1,
    );
    this.embeddingBatchTimeoutMs = boundedInt(
      options.embeddingBatchTimeoutMs,
      3000,
      1,
    );
    this.isRoleActive = options.isRoleActive;
    this.isRoleDeleting = options.isRoleDeleting;
    this.onBackfillIdle = options.onBackfillIdle;
  }

  /**
   * 立即中止全部后台回填并等待收尾。即使注入端口忽略 signal，
   * 检索层的取消竞速也会让 close 及时返回，随后上层才关闭角色存储。
   */
  async close(): Promise<void> {
    this.closed = true;
    const tasks = [...this.backfillTasks.values()];
    for (const task of tasks) {
      task.controller.abort();
    }
    await Promise.allSettled(tasks.map((task) => task.promise));
  }

  /** 该角色是否有后台回填在途；用于角色运行态与维护等待。 */
  isBackfilling(roleId: string): boolean {
    return this.backfillTasks.has(roleId);
  }

  /** 目标资源上正在回填的角色；与记忆／对话在途合并成外部依赖。 */
  inflightRoleIds(resourceId: string): string[] {
    const roles: string[] = [];
    for (const [roleId, task] of this.backfillTasks) {
      if (task.resourceId === resourceId) {
        roles.push(roleId);
      }
    }
    return roles.sort();
  }

  /**
   * 停止请求触发的礼貌取消：只中止在途批次，任务条目保留到真正结算。
   * 这样停止确认、资源维护与删除在清理期间仍能看到 isBackfilling 与在途依赖；
   * 结算后由后台任务自行移除条目并回调 onBackfillIdle 收敛停止。
   */
  cancelBackgroundBackfill(roleId: string): void {
    this.backfillTasks.get(roleId)?.controller.abort();
  }

  /**
   * 删除收尾：中止该角色回填并等待任务真正结算。
   * 必须在角色存储驱逐之前调用，避免收尾期间继续写库；不提前移除条目，
   * 让删除期间的在途登记保持可见，由后台任务结算时自行清理。
   */
  async disposeRole(roleId: string): Promise<void> {
    const task = this.backfillTasks.get(roleId);
    if (task === undefined) {
      return;
    }
    task.controller.abort();
    await task.promise.catch(() => undefined);
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
   *
   * 实时路径只同步补算有限批次（默认 2 批 / 3 秒），每批算完立即增量落盘，
   * 后续批次失败不会丢前序结果；剩余未向量化文档交给实例级后台回填。
   * 未配置端口、查询为空或任何外部调用失败时静默退回同步 search。
   */
  async searchHybrid(
    roleId: string,
    request: MemorySearchRequest,
    context: SearchContext = { mode: "manual" },
  ): Promise<MemorySearchOutcome> {
    const port = this.resolveEmbeddingPort?.(roleId) ?? null;
    const query = request.query?.trim() ?? "";
    if (port === null || query.length === 0) {
      return this.search(roleId, request, context);
    }
    const tokens = memoryQueryTokens(query, context.mode);
    // 先仅收集经结构化条件过滤的候选与 FTS 排序，推迟向量 BLOB 读取至查询向量成功返回后，
    // 避免查询超时/失败时浪费缓存读取与解码，并支持按候选集合缩小 SQL 读取范围（411 R3-09）。
    const prepared = this.access.withStore(roleId, (storage) => {
      const db = storage.business.db;
      const candidates = this.collectCandidates(db, roleId, request);
      const matches = this.matchDocuments(db, roleId, tokens);
      const ftsMatchedIds = this.rankFtsMatches(
        candidates,
        tokens,
        matches,
      );
      return { candidates, ftsMatchedIds };
    });

    let queryVector: Float32Array;
    try {
      const queryEmbedding = await embedWithTimeout(
        port,
        [query],
        this.embeddingQueryTimeoutMs,
      );
      const rawQuery = asEmbeddingVector(queryEmbedding[0]);
      if (rawQuery === null) {
        throw new Error("EMBEDDING_QUERY_VECTOR_INVALID");
      }
      queryVector = rawQuery;
    } catch {
      return this.search(roleId, request, context);
    }

    // 仅加载当前候选集对应的向量缓存，并在单次扫描中直接完成哈希校验、维度比对与余弦打分，
    // 不在内存中保留整份 Float32Array 映射，减少大角色库检索时的峰值内存与无效解码。
    const vectorRanked: VectorRankedDocument[] = [];
    const pending: PendingEmbedding[] = [];
    let availableVectorCount = 0;
    this.access.withStore(roleId, (storage) => {
      const cached = this.loadCachedVectors(
        storage.business.db,
        roleId,
        port.modelKey,
        prepared.candidates.map((candidate) => candidate.document.document_id),
      );
      const reeligible: PendingEmbedding[] = [];
      const uncached: PendingEmbedding[] = [];
      for (const candidate of prepared.candidates) {
        const document = candidate.document;
        const text = `${document.title}\n${document.body}`;
        const contentHash = sha256(text);
        const row = cached.get(document.document_id);
        if (row !== undefined && row.content_hash === contentHash && row.dimensions > 0) {
          if (row.dimensions === queryVector.length) {
            const similarity = cosineSimilarityWithBlob(
              queryVector,
              row.vector_blob,
              row.dimensions,
            );
            if (similarity !== null) {
              availableVectorCount += 1;
              if (similarity >= HYBRID_MIN_SIMILARITY) {
                vectorRanked.push({
                  documentId: document.document_id,
                  similarity,
                });
              }
              continue;
            }
          } else if (row.vector_blob.byteLength === row.dimensions * 4) {
            // 同键旧向量维度漂移：优先排入重算队列，避免持续命中旧缓存。
            reeligible.push({ documentId: document.document_id, contentHash, text });
            continue;
          }
        }
        uncached.push({ documentId: document.document_id, contentHash, text });
      }
      pending.push(...reeligible, ...uncached);
    });

    // 在线增量补算：最多 N 批且受总预算约束，每批成功立即落盘。
    const deadline = Date.now() + this.onlineBackfillBudgetMs;
    let nextOffset = 0;
    for (
      let batchIndex = 0;
      batchIndex < this.onlineBackfillMaxBatches;
      batchIndex += 1
    ) {
      if (nextOffset >= pending.length || this.closed) {
        break;
      }
      if (Date.now() >= deadline) {
        break;
      }
      const batch = pending.slice(
        nextOffset,
        nextOffset + this.embeddingBatchSize,
      );
      const remainingMs = Math.max(50, deadline - Date.now());
      try {
        const batchVectors = await this.embedBatch(
          port,
          batch,
          Math.min(this.embeddingBatchTimeoutMs, remainingMs),
          undefined,
          queryVector.length,
        );
        // 落盘前复核：关机或删除收尾开始后不得再写角色库。
        if (this.closed || this.isRoleDeleting?.(roleId) === true) {
          break;
        }
        // 先落盘再继续下一批：后续超时/失败也不会丢失已经算完的向量。
        this.access.withStore(roleId, (storage) =>
          this.persistVectors(
            storage.business.db,
            roleId,
            port.modelKey,
            batch,
            batchVectors,
            this.now().toISOString(),
          ),
        );
        for (const [documentId, vector] of batchVectors) {
          availableVectorCount += 1;
          const similarity = cosineSimilarity(queryVector, vector);
          if (similarity >= HYBRID_MIN_SIMILARITY) {
            vectorRanked.push({ documentId, similarity });
          }
        }
        nextOffset += batch.length;
      } catch {
        // 保留已落盘的前序批次，停止本轮在线补算并交给后台回填。
        break;
      }
    }

    if (nextOffset < pending.length && !this.closed) {
      this.scheduleBackgroundBackfill(
        roleId,
        port.modelKey,
        port.resourceId,
        pending.slice(nextOffset),
        queryVector.length,
      );
    }

    // 没有任何可用向量时退回纯 FTS5，避免空融合改变既有检索语义。
    if (availableVectorCount === 0) {
      return this.search(roleId, request, context);
    }

    return this.access.withStore(roleId, (storage) => {
      const db = storage.business.db;
      const store = new MemoryStore(db);
      const now = this.now().toISOString();
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

  /** 把一批文档向量化并校验形状；端口返回值异常视为本批失败。 */
  private async embedBatch(
    port: EmbeddingPort,
    batch: readonly PendingEmbedding[],
    timeoutMs: number,
    signal?: AbortSignal,
    expectedDimensions?: number,
  ): Promise<Map<number, Float32Array>> {
    if (batch.length === 0) {
      return new Map();
    }
    const embedded = await embedWithTimeout(
      port,
      batch.map((item) => item.text),
      timeoutMs,
      signal,
    );
    if (embedded.length !== batch.length) {
      throw new Error("EMBEDDING_DOCUMENT_LENGTH_MISMATCH");
    }
    const vectors = new Map<number, Float32Array>();
    for (const [index, raw] of embedded.entries()) {
      const target = batch[index];
      if (target === undefined) {
        continue;
      }
      const vector = asEmbeddingVector(raw);
      if (vector === null) {
        throw new Error("EMBEDDING_DOCUMENT_VECTOR_INVALID");
      }
      // 缓存键未变但维度漂移时，新返回的向量同样不能当作可用缓存。
      // 在线补算与后台回填都按本次查询向量的维度校验，失配整批放弃。
      if (
        expectedDimensions !== undefined &&
        vector.length !== expectedDimensions
      ) {
        throw new Error("EMBEDDING_DOCUMENT_DIMENSION_MISMATCH");
      }
      vectors.set(target.documentId, vector);
    }
    return vectors;
  }

  /**
   * 为单个角色登记后台回填任务。同一角色只保留一个任务，
   * 通过 setTimeout(0) 让出当前请求，避免拖慢实时检索。
   * 角色已停止、正在删除或服务关闭时不再开启新任务。
   */
  private scheduleBackgroundBackfill(
    roleId: string,
    modelKey: string,
    resourceId: string | undefined,
    pending: readonly PendingEmbedding[],
    expectedDimensions: number,
  ): void {
    if (pending.length === 0 || this.closed) {
      return;
    }
    if (!this.canRunBackground(roleId)) {
      return;
    }
    if (this.backfillTasks.has(roleId)) {
      return;
    }
    const controller = new AbortController();
    const task: Promise<void> = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 0);
      timer.unref?.();
    })
      .then(() =>
        this.runBackgroundBackfill(
          roleId,
          modelKey,
          pending,
          expectedDimensions,
          controller.signal,
        ))
      .catch(() => {})
      .finally(() => {
        if (this.backfillTasks.get(roleId)?.controller === controller) {
          this.backfillTasks.delete(roleId);
          // 条目移除后再通知，isBackfilling／在途依赖此时已经收敛。
          // 关闭期间不回调：对话与调度可能已在收尾，避免重复收敛或恢复调度。
          if (!this.closed) {
            try {
              this.onBackfillIdle?.(roleId);
            } catch {
              // 停止通知失败不得产生未处理的拒绝。
            }
          }
        }
      });
    this.backfillTasks.set(roleId, {
      promise: task,
      controller,
      resourceId,
    });
  }

  /**
   * 后台逐批补齐未向量化文档：
   * - 每批前重新解析端口，禁用、模型切换、维护中或活动停止都干净结束；
   * - 取消、删除收尾与关机后不再开始下一批或写库；
   * - 每批等嵌入返回后再次核对当前向量键，旧空间回调不会写入新键；
   * - 角色存储不可写时静默退出。
   */
  private async runBackgroundBackfill(
    roleId: string,
    modelKey: string,
    pending: readonly PendingEmbedding[],
    expectedDimensions: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for (
        let offset = 0;
        offset < pending.length;
        offset += this.embeddingBatchSize
      ) {
        if (signal.aborted || !this.canRunBackground(roleId)) {
          return;
        }
        const port = this.resolveEmbeddingPort?.(roleId) ?? null;
        if (port === null || port.modelKey !== modelKey) {
          return;
        }
        const batch = pending.slice(offset, offset + this.embeddingBatchSize);
        let batchVectors: Map<number, Float32Array>;
        try {
          batchVectors = await this.embedBatch(
            port,
            batch,
            this.embeddingBatchTimeoutMs,
            signal,
            expectedDimensions,
          );
        } catch {
          return;
        }
        // 等嵌入返回后重新核对：中止、删除、活动停止或配置切换都不得再写。
        if (signal.aborted || !this.canRunBackground(roleId)) {
          return;
        }
        const current = this.resolveEmbeddingPort?.(roleId) ?? null;
        if (current === null || current.modelKey !== modelKey) {
          return;
        }
        try {
          this.access.withStore(roleId, (storage) =>
            this.persistVectors(
              storage.business.db,
              roleId,
              modelKey,
              batch,
              batchVectors,
              this.now().toISOString(),
            ),
          );
        } catch {
          // 角色已删除或存储暂不可写：后台回填静默结束。
          return;
        }
      }
    } catch {
      // 后台任务不向调用方抛出，失败即结束本轮回填。
    }
  }

  /** 后台回填只在角色可活动且不在删除收尾时运行。 */
  private canRunBackground(roleId: string): boolean {
    if (this.closed) {
      return false;
    }
    if (this.isRoleDeleting?.(roleId) === true) {
      return false;
    }
    if (this.isRoleActive !== undefined && !this.isRoleActive(roleId)) {
      return false;
    }
    return true;
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
   * 混合检索的候选集：单条 SQL 联表取回有效经历日期并下推类型与日期过滤，
   * 避免逐条 N+1 查询，且不要求字面命中以保留同义改写召回能力（411 R3-09）。
   */
  private collectCandidates(
    db: Database.Database,
    roleId: string,
    request: MemorySearchRequest,
  ): HybridCandidate[] {
    const clauses: string[] = [
      "d.role_id = ?",
      "COALESCE(e.experience_date, s.experience_date, di.experience_date) IS NOT NULL",
    ];
    const params: unknown[] = [roleId];
    const wantedTypes = request.types?.length ? [...new Set(request.types)] : [];
    if (wantedTypes.length > 0) {
      clauses.push(`d.record_type IN (${wantedTypes.map(() => "?").join(", ")})`);
      params.push(...wantedTypes);
    }
    if (request.dateFrom) {
      clauses.push("COALESCE(e.experience_date, s.experience_date, di.experience_date) >= ?");
      params.push(request.dateFrom);
    }
    if (request.dateTo) {
      clauses.push("COALESCE(e.experience_date, s.experience_date, di.experience_date) <= ?");
      params.push(request.dateTo);
    }
    const rows = db
      .prepare(
        `SELECT d.document_id, d.record_type, d.record_id, d.title, d.body, d.updated_at,
                COALESCE(e.experience_date, s.experience_date, di.experience_date) AS experience_date
         FROM memory_search_documents d
         LEFT JOIN memory_events e
           ON d.record_type = 'event' AND e.event_id = d.record_id AND e.role_id = d.role_id
         LEFT JOIN daily_summaries s
           ON d.record_type = 'daily_summary' AND s.summary_id = d.record_id AND s.role_id = d.role_id
         LEFT JOIN diaries di
           ON d.record_type = 'diary' AND di.diary_id = d.record_id AND di.role_id = d.role_id
         WHERE ${clauses.join(" AND ")}`,
      )
      .all(...params) as Array<DocumentRow & { experience_date: string }>;
    const tagFilters = tagFiltersOf(request);
    const eventTags = tagFilters.length ? this.loadEventTags(db, roleId) : undefined;
    const candidates: HybridCandidate[] = [];
    for (const row of rows) {
      if (tagFilters.length > 0) {
        if (row.record_type !== "event") {
          continue;
        }
        const tags = eventTags?.get(row.record_id);
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
      candidates.push({
        document: {
          document_id: row.document_id,
          record_type: row.record_type,
          record_id: row.record_id,
          title: row.title,
          body: row.body,
          updated_at: row.updated_at,
        },
        experienceDate: row.experience_date,
      });
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

  /** 仅加载当次候选文档对应的向量缓存；按 500 条分片避免触及 SQLite 参数上限。 */
  private loadCachedVectors(
    db: Database.Database,
    roleId: string,
    modelKey: string,
    candidateIds: readonly number[],
  ): Map<number, CachedEmbeddingRow> {
    const map = new Map<number, CachedEmbeddingRow>();
    if (candidateIds.length === 0) {
      return map;
    }
    const chunkSize = 500;
    for (let offset = 0; offset < candidateIds.length; offset += chunkSize) {
      const slice = candidateIds.slice(offset, offset + chunkSize);
      const placeholders = slice.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT document_id, content_hash, dimensions, vector_blob
           FROM memory_search_embeddings
           WHERE role_id = ? AND model_key = ? AND document_id IN (${placeholders})`,
        )
        .all(roleId, modelKey, ...slice) as CachedEmbeddingRow[];
      for (const row of rows) {
        map.set(row.document_id, row);
      }
    }
    return map;
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

/** 取整并限制下界；非法值回退到安全默认，避免异常配置放大后台开销。 */
function boundedInt(value: number | undefined, fallback: number, min: number): number {
  return value !== undefined && Number.isFinite(value) && value >= min
    ? Math.floor(value)
    : fallback;
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
 * 以固定上限等待外部 Embedding，超时或外部取消都主动 abort；
 * 端口即使忽略 signal，取消竞速也会保证检索层及时结束。
 */
async function embedWithTimeout(
  port: EmbeddingPort,
  texts: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  const controller = new AbortController();
  const combined = signal === undefined
    ? controller.signal
    : AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("EMBEDDING_TIMEOUT");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  const cancelled = signal === undefined
    ? null
    : new Promise<never>((_, reject) => {
        onAbort = () => {
          const error = new Error("EMBEDDING_ABORTED");
          controller.abort(error);
          reject(error);
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
  // 竞速可能先由端口成功结算；避免随后的取消 rejection 成为未处理异常。
  cancelled?.catch(() => undefined);
  try {
    return await Promise.race([
      port.embed(texts, combined),
      timeout,
      ...(cancelled === null ? [] : [cancelled]),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      signal?.removeEventListener("abort", onAbort);
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
