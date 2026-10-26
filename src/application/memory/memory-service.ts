import { createHash, randomUUID } from 'node:crypto';
import { AccompanyError, InvalidSpecError, IsolationError } from '../../core/errors.js';
import { assertIdentifier, assertKind, type ConversationRef } from '../../routing/identity.js';
import { MemoryStore } from '../../memory/store.js';
import {
  memoryContentDigest,
  memoryNamespace,
  memoryPayloadDigest,
  normalizeContent,
  normalizeKeys,
  parseActivateExtractionRequest,
  parseClearRequest,
  parseCreateRecordRequest,
  parseDeleteRecordRequest,
  parseMemoryListQuery,
  parseMemoryPreviewRequest,
  parseMemoryScope,
  parsePauseExtractionRequest,
  parseSaveSettingsRequest,
  parseUpdateRecordRequest
} from '../../memory/schema.js';
import { selectMemory } from '../../memory/selector.js';
import { serializeJson } from '../../storage/atomic-write.js';
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_DEFAULT_REVISION,
  MEMORY_LIMITS,
  type MemoryExtractionPauseReason,
  type MemoryExtractionState,
  type MemoryRecord,
  type MemoryScope,
  type MemorySnapshot,
  type MemoryState
} from '../../memory/types.js';
import type {
  MemoryDeleteResult,
  MemoryExtractionEffectiveStatus,
  MemoryExtractionStatusView,
  MemoryExtractionView,
  MemoryPreviewResult,
  MemoryRecordDetail,
  MemoryRecordMutation,
  MemoryRecordPage,
  MemoryRecordSummary,
  MemoryStateView
} from '../../contracts/memory.js';

export interface MemoryRoleResolver {
  /** Stable history epoch of the current explicit role; undefined when the conversation has no valid binding. */
  contextEpoch(accountId: string, conversation: ConversationRef): Promise<string | undefined>;
}

export interface MemoryServiceOptions {
  roles: MemoryRoleResolver;
  accountDir: (accountId: string) => string;
  /** Stable highest persisted seq for the conversation; used only to set the activation boundary. */
  messages?: {
    lastSeq(accountId: string, conversation: ConversationRef): Promise<number>;
  };
  now?: () => number;
  store?: MemoryStore;
}

export interface ExtractionCommitFact {
  content: string;
  keys: string[];
  /** Evidence seq range, already restricted to the selected input batch by the caller. */
  fromSeq: number;
  throughSeq: number;
}

export interface ExtractionCommitInput {
  expectedScope: string;
  expectedRevision: string;
  expectedGeneration: number;
  expectedThroughSeq: number;
  /** Highest seq inspected by this attempt; may be below the trigger when caps apply. */
  processedThroughSeq: number;
  sourceKey: string;
  facts: ExtractionCommitFact[];
  now: number;
}

export interface ExtractionCommitResult {
  committed: boolean;
  duplicate: boolean;
  added: number;
  capacityPaused: boolean;
  revision: string;
  generation: number;
  throughSeq: number;
}

export interface ExtractionAdvanceInput {
  expectedScope: string;
  expectedGeneration: number;
  expectedThroughSeq: number;
  /** Last inspected seq of a prefix that contains no eligible unprocessed text. */
  processedThroughSeq: number;
  now: number;
}

async function boundary<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof AccompanyError) throw error;
    throw new AccompanyError('memory_io_error', '长期记忆读写失败，请检查文件和目录权限后重试。', { cause: error });
  }
}

const conflict = (message: string): AccompanyError => new AccompanyError('memory_conflict', message);
const notFound = (): AccompanyError => new AccompanyError('memory_record_not_found', '指定记忆不存在或已被删除。');

/**
 * MEM01 management storage plus MEM03 activation/pause metadata.
 * It never reads chat content, calls a model, or injects context; those belong to MEM02/MEM03 runtime.
 */
export class MemoryService {
  readonly #options: MemoryServiceOptions;
  readonly #store: MemoryStore;
  readonly #now: () => number;

  constructor(options: MemoryServiceOptions) {
    this.#options = options;
    this.#store = options.store ?? new MemoryStore();
    this.#now = options.now ?? Date.now;
  }

  settings(conversation: ConversationRef): Promise<MemoryStateView> {
    return boundary(async () => {
      const { scope, dir } = await this.#scope(conversation);
      const { state } = await this.#store.read(dir, scope);
      return this.#view(scope, state);
    });
  }

  /** Read-only preview using only the saved state and its memory budget; never writes or calls a model. */
  preview(conversation: ConversationRef, raw: unknown): Promise<MemoryPreviewResult> {
    return boundary(async () => {
      const input = parseMemoryPreviewRequest(raw);
      const { scope, dir } = await this.#scope(conversation);
      this.#assertToken(scope, input.expectedScope);
      const { state } = await this.#store.read(dir, scope);
      const evaluation = selectMemory({
        records: state.records,
        currentText: input.text,
        enabled: state.settings.enabled,
        budgetChars: state.settings.budgetChars,
        maxSelected: state.settings.maxSelected
      });
      await this.#assertScopeStillCurrent(conversation, scope);
      return {
        scopeToken: memoryNamespace(scope),
        revision: state.revision,
        generation: state.generation,
        evaluation,
        budgetBasis: 'memory-only' as const,
        notice: '只读预览仅按记忆预算计算；真实对话还受角色、世界书与历史占用限制，实际注入可能更少。'
      };
    });
  }

  saveSettings(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView> {
    return boundary(async () => {
      const input = parseSaveSettingsRequest(raw);
      const { scope, dir } = await this.#scope(conversation);
      this.#assertToken(scope, input.expectedScope);
      const { state } = await this.#store.transact(dir, scope, async current => {
        assertStateRevision(input.expectedRevision, current.revision);
        const enabled = input.settings.enabled;
        const settings = { ...input.settings, autoExtract: enabled && input.settings.autoExtract };
        let extraction = current.extraction;
        if (!enabled) {
          // Disabling memory must not leave an activation that could resume after a restart.
          if (current.extraction || current.settings.autoExtract) {
            extraction = pauseExtractionState(current.extraction, 'memory-disabled');
          }
        } else if (!settings.autoExtract && current.extraction?.activationVersion === 1) {
          extraction = pauseExtractionState(current.extraction, 'user');
        }
        const next: MemoryState = {
          ...current,
          settings,
          ...(extraction ? { extraction } : {}),
          revision: randomUUID(),
          generation: current.generation + 1
        };
        await this.#assertScopeStillCurrent(conversation, scope);
        return { state: next, result: undefined };
      });
      return this.#view(scope, state);
    });
  }

  extractionStatus(conversation: ConversationRef): Promise<MemoryExtractionStatusView> {
    return boundary(async () => {
      const { scope, dir } = await this.#scope(conversation);
      const { state } = await this.#store.read(dir, scope);
      const view = this.#view(scope, state);
      return {
        scopeToken: view.scopeToken,
        revision: view.revision,
        generation: view.generation,
        extraction: view.extraction
      };
    });
  }

  /**
   * Explicit paid-model opt-in. The boundary is the stable latest seq so prior chat is never backfilled;
   * the caller can only start "now", and no model call happens here.
   */
  activateExtraction(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView> {
    return boundary(async () => {
      const input = parseActivateExtractionRequest(raw);
      const { scope, dir } = await this.#scope(conversation);
      this.#assertToken(scope, input.expectedScope);
      const { state } = await this.#store.transact(dir, scope, async current => {
        assertStateRevision(input.expectedRevision, current.revision);
        if (!current.settings.enabled) {
          throw new AccompanyError('memory_extraction_disabled', '请先明确开启长期记忆，再激活自动提取。');
        }
        const latestSeq = await this.#lastStableSeq(scope.accountId, conversation);
        const boundary = Math.max(
          current.extraction?.throughSeq ?? 0,
          current.extraction?.activatedAfterSeq ?? 0,
          latestSeq
        );
        const extraction: MemoryExtractionState = {
          ...(current.extraction ?? { throughSeq: boundary }),
          throughSeq: boundary,
          activationVersion: 1,
          activatedAfterSeq: boundary
        };
        delete extraction.pausedReason;
        delete extraction.cooldownUntil;
        delete extraction.lastFailure;
        const next: MemoryState = {
          ...current,
          settings: { ...current.settings, autoExtract: true },
          extraction,
          revision: randomUUID(),
          generation: current.generation + 1
        };
        await this.#assertScopeStillCurrent(conversation, scope);
        return { state: next, result: undefined };
      });
      return this.#view(scope, state);
    });
  }

  pauseExtraction(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView> {
    return boundary(async () => {
      const input = parsePauseExtractionRequest(raw);
      const { scope, dir } = await this.#scope(conversation);
      this.#assertToken(scope, input.expectedScope);
      const { state } = await this.#store.transact(dir, scope, async current => {
        assertStateRevision(input.expectedRevision, current.revision);
        const next: MemoryState = {
          ...current,
          settings: { ...current.settings, autoExtract: false },
          extraction: pauseExtractionState(current.extraction, 'user'),
          revision: randomUUID(),
          generation: current.generation + 1
        };
        await this.#assertScopeStillCurrent(conversation, scope);
        return { state: next, result: undefined };
      });
      return this.#view(scope, state);
    });
  }

  /**
   * Reserves one provider attempt without changing revision/generation. The captured generation and
   * watermark must still match; otherwise an old notification is dropped before any paid call.
   */
  beginExtractionAttempt(
    conversation: ConversationRef,
    expectedScope: string,
    expectedGeneration: number,
    expectedThroughSeq: number,
    now: number
  ): Promise<{ started: boolean; reason?: string }> {
    return boundary(async () => {
      const { scope, dir } = await this.#scope(conversation);
      if (memoryNamespace(scope) !== expectedScope) return { started: false, reason: 'scope_changed' };
      const { result } = await this.#store.transact<{ started: boolean; reason?: string }>(dir, scope, async current => {
        if (current.generation !== expectedGeneration) {
          return { state: current, write: false, result: { started: false, reason: 'generation_changed' } };
        }
        if ((current.extraction?.throughSeq ?? 0) !== expectedThroughSeq) {
          return { state: current, write: false, result: { started: false, reason: 'watermark_changed' } };
        }
        const status = extractionView(current, now).effectiveStatus;
        if (status !== 'active') return { state: current, write: false, result: { started: false, reason: status } };
        const extraction: MemoryExtractionState = { ...current.extraction!, lastAttemptAt: now };
        await this.#assertScopeStillCurrent(conversation, scope);
        return { state: { ...current, extraction }, result: { started: true } };
      });
      return result;
    });
  }

  /**
   * Advances the scan watermark over an inspected prefix that produced no eligible text.
   * It is never used to skip an unread eligible message; the transaction rechecks
   * generation, activation, pause state and the current watermark.
   */
  advanceExtraction(conversation: ConversationRef, input: ExtractionAdvanceInput): Promise<boolean> {
    return boundary(async () => {
      const { scope, dir } = await this.#scope(conversation);
      if (memoryNamespace(scope) !== input.expectedScope) return false;
      const { result } = await this.#store.transact<boolean>(dir, scope, async current => {
        if (current.generation !== input.expectedGeneration) {
          return { state: current, write: false, result: false };
        }
        const extraction = current.extraction;
        if (!extraction || extractionView(current, input.now).effectiveStatus !== 'active') {
          return { state: current, write: false, result: false };
        }
        if (extraction.throughSeq !== input.expectedThroughSeq) {
          return { state: current, write: false, result: false };
        }
        if (!Number.isSafeInteger(input.processedThroughSeq) || input.processedThroughSeq <= input.expectedThroughSeq) {
          return { state: current, write: false, result: false };
        }
        const next: MemoryState = {
          ...current,
          extraction: { ...extraction, throughSeq: input.processedThroughSeq },
          revision: randomUUID(),
          generation: current.generation + 1
        };
        await this.#assertScopeStillCurrent(conversation, scope);
        return { state: next, result: true };
      });
      return result;
    });
  }

  /** Records a safe failure state; a missing generation/extraction match leaves the new state untouched. */
  recordExtractionFailure(    conversation: ConversationRef,
    expectedScope: string,
    expectedGeneration: number,
    failure: { code: string; at: number; cooldownUntil?: number; fatal?: boolean }
  ): Promise<boolean> {
    return boundary(async () => {
      const { scope, dir } = await this.#scope(conversation);
      if (memoryNamespace(scope) !== expectedScope) return false;
      const code = /^[a-z][a-z0-9_]{0,63}$/.test(failure.code) ? failure.code : 'extraction_failed';
      const { result } = await this.#store.transact(dir, scope, async current => {
        if (current.generation !== expectedGeneration || !current.extraction) {
          return { state: current, write: false, result: false };
        }
        const extraction: MemoryExtractionState = {
          ...current.extraction,
          lastFailure: { code, at: failure.at, ...(failure.fatal ? { fatal: true } : {}) },
          ...(failure.cooldownUntil !== undefined ? { cooldownUntil: failure.cooldownUntil } : {})
        };
        await this.#assertScopeStillCurrent(conversation, scope);
        return { state: { ...current, extraction }, result: true };
      });
      return result;
    });
  }

  /**
   * Atomic extraction commit: records, generation, watermark and the sourceKey receipt live in one
   * state file write. Capacity is all-or-nothing and pauses extraction without advancing the watermark.
   */
  commitExtraction(conversation: ConversationRef, input: ExtractionCommitInput): Promise<ExtractionCommitResult> {
    return boundary(async () => {
      const { scope, dir } = await this.#scope(conversation);
      if (memoryNamespace(scope) !== input.expectedScope) {
        throw conflict('会话角色或记忆作用域已变化，本次提取结果未提交。');
      }
      const { result } = await this.#store.transact<ExtractionCommitResult>(dir, scope, async current => {
        if (!/^[a-f0-9]{64}$/.test(input.sourceKey)) throw new InvalidSpecError('提取来源标识无效。');
        const currentExtraction = current.extraction;
        const replay = currentExtraction?.lastCompletedSourceKey === input.sourceKey
          || currentExtraction?.recentResults?.some(entry => entry.sourceKey === input.sourceKey) === true;
        if (replay) {
          // The same evidence already committed; acknowledge even if the caller still holds the old revision.
          return {
            state: current,
            write: false,
            result: {
              committed: false,
              duplicate: true,
              added: 0,
              capacityPaused: false,
              revision: current.revision,
              generation: current.generation,
              throughSeq: currentExtraction?.throughSeq ?? 0
            }
          };
        }
        if (current.revision !== input.expectedRevision || current.generation !== input.expectedGeneration) {
          throw conflict('自动提取状态已变化，本次结果未提交。');
        }
        if (!current.settings.enabled || !current.settings.autoExtract || currentExtraction?.activationVersion !== 1
          || currentExtraction.pausedReason) {
          throw conflict('自动提取已暂停或未激活，本次结果未提交。');
        }
        if (currentExtraction.throughSeq !== input.expectedThroughSeq) {
          throw conflict('自动提取水位已变化，本次结果未提交。');
        }
        if (!Number.isSafeInteger(input.processedThroughSeq) || input.processedThroughSeq < input.expectedThroughSeq) {
          throw new InvalidSpecError('自动提取处理水位无效。');
        }
        if (input.facts.length > MEMORY_LIMITS.maxExtractionFacts) {
          throw new InvalidSpecError(`单次自动提取最多${MEMORY_LIMITS.maxExtractionFacts}条。`);
        }

        const seen = new Set(current.records.map(record => memoryContentDigest(record.content)));
        const candidates: Array<ExtractionCommitFact & { digest: string }> = [];
        for (const fact of input.facts) {
          if (!Number.isSafeInteger(fact.fromSeq) || !Number.isSafeInteger(fact.throughSeq)
            || fact.fromSeq <= input.expectedThroughSeq || fact.throughSeq < fact.fromSeq
            || fact.throughSeq > input.processedThroughSeq) {
            throw new InvalidSpecError('自动提取证据范围无效。');
          }
          const content = normalizeContent(fact.content).normalize('NFKC').trim();
          const keys = normalizeKeys(fact.keys);
          if (content.length > MEMORY_LIMITS.maxExtractionContentChars
            || keys.length > MEMORY_LIMITS.maxExtractionKeys
            || keys.some(key => key.length > MEMORY_LIMITS.maxExtractionKeyChars)) {
            throw new InvalidSpecError('自动提取结果超过单条上限。');
          }
          const digest = memoryContentDigest(content);
          if (seen.has(digest)) continue;
          seen.add(digest);
          candidates.push({ content, keys, fromSeq: fact.fromSeq, throughSeq: fact.throughSeq, digest });
        }

        const now = input.now;
        const added: MemoryRecord[] = candidates.map(candidate => ({
          id: `r-${randomUUID()}`,
          revision: randomUUID(),
          type: 'fact' as const,
          content: candidate.content,
          keys: candidate.keys,
          pinned: false,
          origin: 'model' as const,
          createdAt: now,
          updatedAt: now,
          source: { fromSeq: candidate.fromSeq, throughSeq: candidate.throughSeq }
        }));
        const successExtraction: MemoryExtractionState = {
          ...currentExtraction,
          throughSeq: Math.max(currentExtraction.throughSeq, input.processedThroughSeq),
          lastCompletedSourceKey: input.sourceKey,
          recentResults: [...(currentExtraction.recentResults ?? []), {
            sourceKey: input.sourceKey,
            throughSeq: input.processedThroughSeq,
            at: now
          }].slice(-MEMORY_LIMITS.recentExtractionResults),
          lastSuccessAt: now
        };
        delete successExtraction.lastFailure;
        delete successExtraction.cooldownUntil;
        const success: MemoryState = {
          ...current,
          records: [...current.records, ...added],
          extraction: successExtraction,
          revision: randomUUID(),
          generation: current.generation + 1
        };

        const totalChars = success.records.reduce((sum, record) => sum + record.content.length, 0);
        const capacity = success.records.length > MEMORY_LIMITS.maxRecords
          || totalChars > MEMORY_LIMITS.maxTotalContentChars
          || Buffer.byteLength(serializeJson(success), 'utf8') > this.#store.maxStateFileBytes;
        if (capacity) {
          const paused: MemoryState = {
            ...current,
            settings: { ...current.settings, autoExtract: false },
            extraction: pauseExtractionState(currentExtraction, 'capacity'),
            revision: randomUUID(),
            generation: current.generation + 1
          };
          await this.#assertScopeStillCurrent(conversation, scope);
          return {
            state: paused,
            result: {
              committed: false,
              duplicate: false,
              added: 0,
              capacityPaused: true,
              revision: paused.revision,
              generation: paused.generation,
              throughSeq: paused.extraction?.throughSeq ?? currentExtraction.throughSeq
            }
          };
        }

        await this.#assertScopeStillCurrent(conversation, scope);
        return {
          state: success,
          result: {
            committed: true,
            duplicate: false,
            added: added.length,
            capacityPaused: false,
            revision: success.revision,
            generation: success.generation,
            throughSeq: successExtraction.throughSeq
          }
        };
      });
      return result;
    });
  }

  /**
   * Runtime capture for an already-resolved role epoch. It must not re-resolve the role:
   * the caller captured role/worldbook first and uses this same epoch for the turn.
   * Read/parse failures become an unavailable snapshot instead of throwing.
   */
  async runtimeSnapshot(accountId: string, conversation: ConversationRef, contextEpoch: string): Promise<MemorySnapshot> {
    if (conversation.accountId !== accountId) {
      throw new IsolationError(`memory scope account ${accountId} does not match conversation ${conversation.accountId}`);
    }
    const scope = parseMemoryScope({
      accountId,
      kind: conversation.kind,
      peerId: conversation.peerId,
      contextEpoch
    });
    const scopeToken = memoryNamespace(scope);
    try {
      const { state, exists } = await this.#store.read(this.#options.accountDir(accountId), scope);
      return readySnapshot(scopeToken, state, exists);
    } catch (error) {
      return unavailableSnapshot(scopeToken, error);
    }
  }

  listRecords(conversation: ConversationRef, query: unknown = {}): Promise<MemoryRecordPage> {
    return boundary(async () => {
      const { offset, limit } = parseMemoryListQuery(query);
      const { scope, dir } = await this.#scope(conversation);
      const { state } = await this.#store.read(dir, scope);
      const ordered = [...state.records].sort((left, right) =>
        right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id));
      const items = ordered.slice(offset, offset + limit).map(summary);
      const next = offset + items.length;
      return {
        scopeToken: memoryNamespace(scope),
        revision: state.revision,
        generation: state.generation,
        total: ordered.length,
        items,
        ...(next < ordered.length ? { nextOffset: next } : {})
      };
    });
  }

  getRecord(conversation: ConversationRef, id: string): Promise<MemoryRecordDetail> {
    return boundary(async () => {
      assertRecordId(id);
      const { scope, dir } = await this.#scope(conversation);
      const { state } = await this.#store.read(dir, scope);
      const record = state.records.find(item => item.id === id);
      if (!record) throw notFound();
      return { ...this.#view(scope, state), record };
    });
  }

  createRecord(conversation: ConversationRef, raw: unknown): Promise<MemoryRecordMutation> {
    return boundary(async () => {
      const input = parseCreateRecordRequest(raw);
      const { scope, dir } = await this.#scope(conversation);
      this.#assertToken(scope, input.expectedScope);
      const payload = memoryPayloadDigest(input.record);
      const { result } = await this.#store.transact(dir, scope, async current => {
        // A committed receipt answers a lost response even though the caller still holds the pre-commit revision.
        const replay = current.receipts.find(receipt => receipt.requestId === input.requestId);
        if (replay) {
          if (replay.payload !== payload) throw conflict('相同requestId已提交过不同内容，请重新读取后再试。');
          const existing = current.records.find(record => record.id === replay.recordId);
          if (!existing) throw conflict('该请求已处理，对应记忆已被删除；请重新读取后再新增。');
          await this.#assertScopeStillCurrent(conversation, scope);
          return {
            state: current,
            write: false,
            result: { ...this.#view(scope, current), record: existing, created: false }
          };
        }
        assertStateRevision(input.expectedRevision, current.revision);
        if (current.records.length >= MEMORY_LIMITS.maxRecords) {
          throw new InvalidSpecError(`每个会话最多保存${MEMORY_LIMITS.maxRecords}条记忆。`);
        }
        assertContentCapacity(current, input.record.content.length);
        const now = this.#now();
        const record: MemoryRecord = {
          id: `r-${randomUUID()}`,
          revision: randomUUID(),
          type: 'fact',
          content: input.record.content,
          keys: input.record.keys,
          pinned: input.record.pinned,
          origin: 'user',
          createdAt: now,
          updatedAt: now
        };
        const receipts = [...current.receipts, { requestId: input.requestId, payload, recordId: record.id, at: now }]
          .slice(-MEMORY_LIMITS.receiptLimit);
        const next: MemoryState = {
          ...current,
          records: [...current.records, record],
          receipts,
          revision: randomUUID(),
          generation: current.generation + 1
        };
        await this.#assertScopeStillCurrent(conversation, scope);
        return { state: next, result: { ...this.#view(scope, next), record, created: true } };
      });
      return result;
    });
  }

  updateRecord(conversation: ConversationRef, id: string, raw: unknown): Promise<MemoryRecordMutation> {
    return boundary(async () => {
      assertRecordId(id);
      const input = parseUpdateRecordRequest(raw);
      const { scope, dir } = await this.#scope(conversation);
      this.#assertToken(scope, input.expectedScope);
      const { result } = await this.#store.transact(dir, scope, async current => {
        assertStateRevision(input.expectedRevision, current.revision);
        const index = current.records.findIndex(item => item.id === id);
        if (index < 0) throw notFound();
        const record = current.records[index]!;
        if (record.revision !== input.recordRevision) throw conflict('该记忆已被修改，请重新读取后再保存。');
        if (record.type !== 'fact') throw conflict('摘要不能通过手工接口修改。');
        if (input.content !== undefined) assertContentCapacity(current, input.content.length - record.content.length);
        const corrected = record.origin === 'model';
        const nextRecord: MemoryRecord = {
          ...record,
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.keys !== undefined ? { keys: input.keys } : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
          ...(corrected ? { origin: 'user' as const } : {}),
          revision: randomUUID(),
          updatedAt: this.#now()
        };
        const records = current.records.map((item, position) => position === index ? nextRecord : item);
        const next: MemoryState = {
          ...current,
          records,
          // A manual correction of a model fact must not be overwritten by a later model run.
          ...(corrected
            ? { settings: { ...current.settings, autoExtract: false }, extraction: pauseExtractionState(current.extraction, 'user') }
            : {}),
          revision: randomUUID(),
          generation: current.generation + 1
        };
        await this.#assertScopeStillCurrent(conversation, scope);
        return { state: next, result: { ...this.#view(scope, next), record: nextRecord } };
      });
      return result;
    });
  }

  deleteRecord(conversation: ConversationRef, id: string, raw: unknown): Promise<MemoryDeleteResult> {
    return boundary(async () => {
      assertRecordId(id);
      const input = parseDeleteRecordRequest(raw);
      const { scope, dir } = await this.#scope(conversation);
      this.#assertToken(scope, input.expectedScope);
      const { state } = await this.#store.transact(dir, scope, async current => {
        assertStateRevision(input.expectedRevision, current.revision);
        const record = current.records.find(item => item.id === id);
        if (!record) throw notFound();
        if (record.revision !== input.recordRevision) throw conflict('该记忆已被修改，请重新读取后再删除。');
        const next: MemoryState = {
          ...current,
          settings: { ...current.settings, autoExtract: false },
          // Removing a fact pauses extraction in the same commit so an in-flight job cannot restore it.
          extraction: pauseExtractionState(current.extraction, 'deleted'),
          records: current.records.filter(item => item.id !== id),
          revision: randomUUID(),
          generation: current.generation + 1
        };
        await this.#assertScopeStillCurrent(conversation, scope);
        return { state: next, result: undefined };
      });
      return {
        scopeToken: memoryNamespace(scope),
        revision: state.revision,
        generation: state.generation,
        recordCount: state.records.length,
        deleted: id,
        extraction: extractionView(state, this.#now())
      };
    });
  }

  clear(conversation: ConversationRef, raw: unknown): Promise<MemoryStateView> {
    return boundary(async () => {
      const input = parseClearRequest(raw);
      const { scope, dir } = await this.#scope(conversation);
      this.#assertToken(scope, input.expectedScope);
      const { state } = await this.#store.transact(dir, scope, async current => {
        assertStateRevision(input.expectedRevision, current.revision);
        const next: MemoryState = {
          ...current,
          settings: { ...current.settings, autoExtract: false },
          extraction: pauseExtractionState(current.extraction, 'cleared'),
          records: [],
          revision: randomUUID(),
          generation: current.generation + 1
        };
        await this.#assertScopeStillCurrent(conversation, scope);
        return { state: next, result: undefined };
      });
      return this.#view(scope, state);
    });
  }

  async #lastStableSeq(accountId: string, conversation: ConversationRef): Promise<number> {
    if (!this.#options.messages) {
      throw new AccompanyError('memory_extraction_unavailable', '消息存储不支持稳定序号查询，无法激活自动提取。');
    }
    return this.#options.messages.lastSeq(accountId, conversation);
  }

  #view(scope: MemoryScope, state: MemoryState): MemoryStateView {
    return stateView(scope, state, this.#now());
  }

  async #scope(conversation: ConversationRef): Promise<{ scope: MemoryScope; dir: string }> {
    const accountId = assertIdentifier(conversation.accountId, 'accountId');
    const kind = assertKind(conversation.kind);
    const peerId = assertIdentifier(conversation.peerId, 'peerId');
    const contextEpoch = await this.#options.roles.contextEpoch(accountId, { accountId, kind, peerId });
    if (!contextEpoch) throw new AccompanyError('memory_scope_missing', '该会话尚未绑定有效角色卡，不能使用长期记忆。');
    return { scope: { accountId, kind, peerId, contextEpoch }, dir: this.#options.accountDir(accountId) };
  }

  #assertToken(scope: MemoryScope, expected: string): void {
    if (expected !== memoryNamespace(scope)) throw conflict('会话角色或记忆作用域已变化，请重新打开长期记忆后再试。');
  }

  /** Final linearization check inside the serialized commit, before any state is written. */
  async #assertScopeStillCurrent(conversation: ConversationRef, scope: MemoryScope): Promise<void> {
    const contextEpoch = await this.#options.roles.contextEpoch(scope.accountId, conversation);
    if (!contextEpoch || contextEpoch !== scope.contextEpoch) {
      throw conflict('会话角色已变化，本次记忆操作未提交；请重新打开长期记忆后再试。');
    }
  }
}

function assertStateRevision(expected: string, current: string): void {
  if (expected !== current) throw conflict('长期记忆已被其他操作修改，请重新读取后再试。');
}

function assertRecordId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new InvalidSpecError('记忆记录标识无效。');
}

function assertContentCapacity(state: MemoryState, additionalChars: number): void {
  if (additionalChars <= 0) return;
  const total = state.records.reduce((sum, record) => sum + record.content.length, 0);
  if (total + additionalChars > MEMORY_LIMITS.maxTotalContentChars) {
    throw new InvalidSpecError('记忆正文总长度超过上限，请先删除不再需要的记忆。');
  }
}

function stateView(scope: MemoryScope, state: MemoryState, now: number): MemoryStateView {
  return {
    accountId: scope.accountId,
    kind: scope.kind,
    peerId: scope.peerId,
    scopeToken: memoryNamespace(scope),
    revision: state.revision,
    generation: state.generation,
    settings: { ...state.settings },
    recordCount: state.records.length,
    extraction: extractionView(state, now)
  };
}

function extractionView(state: MemoryState, now: number): MemoryExtractionView {
  const extraction = state.extraction;
  let effectiveStatus: MemoryExtractionEffectiveStatus;
  if (!state.settings.enabled) effectiveStatus = 'disabled';
  else if (!state.settings.autoExtract) effectiveStatus = extraction?.pausedReason ? 'paused' : 'disabled';
  else if (extraction?.activationVersion !== 1) effectiveStatus = 'needs-confirmation';
  else if (extraction.pausedReason) effectiveStatus = 'paused';
  else if (extraction.lastFailure?.fatal) effectiveStatus = 'failed';
  else if (extraction.cooldownUntil !== undefined && extraction.cooldownUntil > now) effectiveStatus = 'cooldown';
  else effectiveStatus = 'active';
  return {
    effectiveStatus,
    autoExtract: state.settings.autoExtract,
    ...(extraction?.activationVersion === 1 ? { activationVersion: 1 as const } : {}),
    ...(extraction?.activatedAfterSeq !== undefined ? { activatedAfterSeq: extraction.activatedAfterSeq } : {}),
    throughSeq: extraction?.throughSeq ?? 0,
    ...(extraction?.lastCompletedSourceKey ? { lastCompletedSourceKey: extraction.lastCompletedSourceKey } : {}),
    recentResultCount: extraction?.recentResults?.length ?? 0,
    ...(extraction?.lastAttemptAt !== undefined ? { lastAttemptAt: extraction.lastAttemptAt } : {}),
    ...(extraction?.lastSuccessAt !== undefined ? { lastSuccessAt: extraction.lastSuccessAt } : {}),
    ...(extraction?.cooldownUntil !== undefined ? { cooldownUntil: extraction.cooldownUntil } : {}),
    ...(extraction?.pausedReason !== undefined ? { pausedReason: extraction.pausedReason } : {}),
    ...(extraction?.lastFailure !== undefined ? { lastFailure: { ...extraction.lastFailure } } : {})
  };
}

function pauseExtractionState(
  current: MemoryExtractionState | undefined,
  reason: MemoryExtractionPauseReason
): MemoryExtractionState {
  const extraction: MemoryExtractionState = current
    ? { ...current, pausedReason: reason }
    : { throughSeq: 0, pausedReason: reason };
  delete extraction.activationVersion;
  delete extraction.activatedAfterSeq;
  delete extraction.cooldownUntil;
  return extraction;
}

function summary(record: MemoryRecord): MemoryRecordSummary {
  return {
    id: record.id,
    revision: record.revision,
    type: record.type,
    contentLength: record.content.length,
    keys: [...record.keys],
    pinned: record.pinned,
    origin: record.origin,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.source ? { source: { ...record.source } } : {})
  };
}

function readySnapshot(scopeToken: string, state: MemoryState, exists: boolean): MemorySnapshot {
  const records = Object.freeze(state.records.map(record => Object.freeze({
    ...record,
    keys: Object.freeze([...record.keys]) as unknown as string[],
    ...(record.source ? { source: Object.freeze({ ...record.source }) } : {})
  }))) as unknown as readonly MemoryRecord[];
  return Object.freeze({
    scopeToken,
    revision: state.revision,
    generation: state.generation,
    settings: Object.freeze({ ...state.settings }),
    records,
    state: 'ready' as const,
    guard: snapshotGuard(scopeToken, state, exists)
  });
}

function unavailableSnapshot(scopeToken: string, error: unknown): MemorySnapshot {
  const code = error instanceof AccompanyError ? error.code : 'memory_io_error';
  return Object.freeze({
    scopeToken,
    revision: MEMORY_DEFAULT_REVISION,
    generation: 0,
    settings: Object.freeze({ ...DEFAULT_MEMORY_SETTINGS }),
    records: Object.freeze([]) as unknown as readonly MemoryRecord[],
    state: 'unavailable' as const,
    error: `长期记忆状态不可用（${code}），已停止自动回复。`,
    guard: createHash('sha256')
      .update(JSON.stringify(['memory-guard-v1', scopeToken, 'unavailable']))
      .digest('hex')
  });
}

/** Stable digest over everything an automatic reply must have observed; no plaintext leaves the process. */
function snapshotGuard(scopeToken: string, state: MemoryState, exists: boolean): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'memory-guard-v1',
      scopeToken,
      exists,
      state.revision,
      state.generation,
      state.settings.enabled,
      state.settings.autoExtract,
      state.settings.budgetChars,
      state.settings.maxSelected,
      state.records.map(record => [
        record.id,
        record.revision,
        record.type,
        record.content,
        record.keys,
        record.pinned,
        record.origin,
        record.createdAt,
        record.updatedAt,
        record.source?.fromSeq ?? null,
        record.source?.throughSeq ?? null
      ])
    ]))
    .digest('hex');
}
