import fs from 'node:fs/promises';
import path from 'node:path';
import { IsolationError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { ConversationRef } from '../routing/identity.js';
import { conversationKey, safePathSegment } from '../routing/identity.js';
import { writeFileAtomic } from './atomic-write.js';
import type { AppendResult, MessageStore, ReadOptions, ReadRangeOptions, ReadRangeResult, StoredMessage } from './contract.js';

export interface JsonlStoreOptions {
  root: string;
  /** 存储根已经是某个账号的目录时传入；此时路径不再追加 accountId 段。 */
  accountId?: string;
  /** 超过后保留最后 N 条；按段删除/局部重写，不再每次整档重写。 */
  maxRecordsPerConversation?: number;
  /** 单段记录数。 */
  segmentRecords?: number;
  logger?: Logger;
}

interface SegmentEntry {
  messageId?: string;
  seq: number;
}

interface SegmentInfo {
  name: string;
  file: string;
  count: number;
  entries: SegmentEntry[];
}

interface PendingRecord {
  record: StoredMessage;
  resolve: (result: AppendResult) => void;
  reject: (error: unknown) => void;
}

interface ConversationState {
  ref: ConversationRef;
  dir: string;
  segments: SegmentInfo[];
  seq: number;
  count: number;
  seen: Map<string, number>;
  seenOrder: string[];
  pending: PendingRecord[];
  flushScheduled: boolean;
  flushChain: Promise<void>;
  init?: Promise<void>;
}

const MAX_SEEN_WITHOUT_RETENTION = 10_000;

/**
 * 追加式会话存储：
 * - 每条消息只追加一行，同一会话组提交，跨会话并行
 * - 按 <root>/<accountId>/<kind>/<peerId>/<segment>.jsonl 隔离
 * - messageId 幂等；seq 由存储层分配；超限按段删除或局部重写
 */
export class JsonlStore implements MessageStore {
  readonly #root: string;
  readonly #accountId?: string;
  readonly #maxRecords?: number;
  readonly #segmentRecords: number;
  readonly #logger?: Logger;
  readonly #states = new Map<string, ConversationState>();

  constructor(options: JsonlStoreOptions) {
    this.#root = options.root;
    this.#accountId = options.accountId;
    this.#maxRecords = options.maxRecordsPerConversation && options.maxRecordsPerConversation > 0
      ? options.maxRecordsPerConversation
      : undefined;
    const requested = options.segmentRecords ?? 500;
    this.#segmentRecords = Math.max(
      1,
      this.#maxRecords ? Math.min(requested, this.#maxRecords) : requested
    );
    this.#logger = options.logger;
  }

  async append(conversation: ConversationRef, message: StoredMessage): Promise<AppendResult> {
    const state = this.#stateFor(conversation);
    await this.#ensureInit(state);
    if (message.messageId) {
      const existing = state.seen.get(message.messageId);
      if (existing !== undefined) return { seq: existing, duplicate: true };
    }

    const seq = state.seq + 1;
    state.seq = seq;
    state.count += 1;
    const record: StoredMessage = { ...message, seq };
    if (message.messageId) {
      state.seen.set(message.messageId, seq);
      state.seenOrder.push(message.messageId);
    }

    const result = await new Promise<AppendResult>((resolve, reject) => {
      state.pending.push({ record, resolve, reject });
      this.#scheduleFlush(state);
    });
    this.#evictSeenIfNeeded(state);
    return result;
  }

  async read(conversation: ConversationRef, options: ReadOptions = {}): Promise<StoredMessage[]> {
    if (options.limit === 0) return [];
    const state = this.#stateFor(conversation);
    await this.#ensureInit(state);
    await this.#drain(state);

    const chunks: StoredMessage[][] = [];
    let collected = 0;
    for (let index = state.segments.length - 1; index >= 0; index -= 1) {
      const segment = state.segments[index];
      if (!segment) continue;
      const records = await this.#readSegment(segment);
      const matching = records.filter((record) => {
        const seq = record.seq ?? 0;
        if (options.contextEpoch !== undefined && record.contextEpoch !== options.contextEpoch) return false;
        if (options.afterSeq !== undefined && seq <= options.afterSeq) return false;
        if (options.beforeSeq !== undefined && seq >= options.beforeSeq) return false;
        return true;
      });
      chunks.unshift(matching);
      collected += matching.length;
      if (options.limit !== undefined && options.limit > 0 && collected >= options.limit) break;
    }

    const records = chunks.flat();
    if (options.limit !== undefined && options.limit >= 0) return records.slice(-options.limit);
    return records;
  }

  async lastSeq(conversation: ConversationRef): Promise<number> {
    const state = this.#stateFor(conversation);
    await this.#ensureInit(state);
    await this.#drain(state);
    // A failed flush can leave an empty newest segment; only persisted entries count.
    for (let index = state.segments.length - 1; index >= 0; index -= 1) {
      const entry = state.segments[index]?.entries.at(-1);
      if (entry) return entry.seq;
    }
    return 0;
  }

  /**
   * Forward, bounded scan. It reads whole segments (the store's natural page) but never loads
   * the full conversation; callers advance by scannedThroughSeq until exhausted.
   */
  async readRange(conversation: ConversationRef, options: ReadRangeOptions): Promise<ReadRangeResult> {
    const state = this.#stateFor(conversation);
    await this.#ensureInit(state);
    await this.#drain(state);
    const limit = Math.max(1, Math.floor(options.limit));
    const records: StoredMessage[] = [];
    if (options.throughSeq <= options.afterSeq) {
      return { records, scannedThroughSeq: options.afterSeq, exhausted: true };
    }
    let scanned = options.afterSeq;
    // Pruning can shift the live segment array while a segment read is awaited; iterate a snapshot
    // so a removed oldest segment cannot cause the next surviving segment to be skipped.
    for (const segment of [...state.segments]) {
      const last = segment.entries.at(-1);
      if (!last || last.seq <= scanned) continue;
      const first = segment.entries[0];
      if (first && first.seq > options.throughSeq) {
        return { records, scannedThroughSeq: options.throughSeq, exhausted: true };
      }
      for (const record of await this.#readSegment(segment)) {
        const seq = record.seq;
        if (seq === undefined || seq <= scanned) continue;
        if (seq > options.throughSeq) {
          return { records, scannedThroughSeq: options.throughSeq, exhausted: true };
        }
        records.push(record);
        scanned = seq;
        if (records.length >= limit) return { records, scannedThroughSeq: scanned, exhausted: false };
      }
    }
    return { records, scannedThroughSeq: options.throughSeq, exhausted: true };
  }

  async listConversations(accountId?: string): Promise<ConversationRef[]> {
    const result: ConversationRef[] = [];
    if (this.#accountId) {
      if (accountId && accountId !== this.#accountId) return result;
      await this.#collectConversations(this.#accountId, this.#root, result);
      return result;
    }
    let accounts: string[];
    try {
      accounts = await fs.readdir(this.#root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw error;
    }
    for (const account of accounts) {
      if (accountId && account !== safePathSegment(accountId)) continue;
      await this.#collectConversations(account, path.join(this.#root, account), result);
    }
    return result;
  }

  async #collectConversations(accountId: string, accountRoot: string, result: ConversationRef[]): Promise<void> {
    for (const kind of await safeReaddir(accountRoot)) {
      if (kind !== 'group' && kind !== 'private') continue;
      for (const peer of await safeReaddir(path.join(accountRoot, kind))) {
        const files = await safeReaddir(path.join(accountRoot, kind, peer));
        if (files.some((file) => file.endsWith('.jsonl'))) result.push({ accountId, kind, peerId: peer });
      }
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.#states.values()].map(async (state) => {
        await state.init?.catch(() => {});
        await state.flushChain.catch(() => {});
      })
    );
    this.#states.clear();
  }

  #stateFor(conversation: ConversationRef): ConversationState {
    if (this.#accountId && conversation.accountId !== this.#accountId) {
      throw new IsolationError(
        `store for account ${this.#accountId} refused conversation for ${conversation.accountId}`
      );
    }
    const key = conversationKey(conversation);
    const existing = this.#states.get(key);
    if (existing) return existing;
    const dir = this.#accountId
      ? path.join(this.#root, safePathSegment(conversation.kind), safePathSegment(conversation.peerId))
      : path.join(
          this.#root,
          safePathSegment(conversation.accountId),
          safePathSegment(conversation.kind),
          safePathSegment(conversation.peerId)
        );
    const state: ConversationState = {
      ref: conversation,
      dir,
      segments: [],
      seq: 0,
      count: 0,
      seen: new Map(),
      seenOrder: [],
      pending: [],
      flushScheduled: false,
      flushChain: Promise.resolve()
    };
    state.init = this.#initialize(state);
    this.#states.set(key, state);
    return state;
  }

  async #ensureInit(state: ConversationState): Promise<void> {
    await state.init;
  }

  async #initialize(state: ConversationState): Promise<void> {
    await fs.mkdir(state.dir, { recursive: true, mode: 0o700 });
    let files: string[];
    try {
      files = (await fs.readdir(state.dir)).filter((name) => /^\d{6}\.jsonl$/.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const name of files) {
      const file = path.join(state.dir, name);
      const records = await this.#readFile(file);
      const entries: SegmentEntry[] = records.map((record) => ({
        ...(record.messageId ? { messageId: record.messageId } : {}),
        seq: record.seq ?? 0
      }));
      const segment: SegmentInfo = { name, file, count: records.length, entries };
      state.segments.push(segment);
      state.count += records.length;
      for (const record of records) {
        if (record.seq !== undefined) state.seq = Math.max(state.seq, record.seq);
        else state.seq = Math.max(state.seq, state.count);
        if (record.messageId) {
          state.seen.set(record.messageId, record.seq ?? state.seq);
          state.seenOrder.push(record.messageId);
        }
      }
    }
    this.#evictSeenIfNeeded(state);
    if (this.#maxRecords) await this.#prune(state);
  }

  #scheduleFlush(state: ConversationState): void {
    if (state.flushScheduled) return;
    state.flushScheduled = true;
    const run = state.flushChain
      .catch(() => {})
      .then(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        state.flushScheduled = false;
        await this.#flush(state);
      });
    state.flushChain = run.catch((error: unknown) => {
      this.#logger?.error('jsonl flush failed', {
        dir: state.dir,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async #drain(state: ConversationState): Promise<void> {
    while (state.flushScheduled || state.pending.length > 0) {
      await state.flushChain.catch(() => {});
    }
  }

  async #flush(state: ConversationState): Promise<void> {
    if (state.pending.length === 0) return;
    const batch = state.pending.splice(0);
    const written = new Set<PendingRecord>();
    try {
      let index = 0;
      while (index < batch.length) {
        let segment = state.segments.at(-1);
        if (!segment || segment.count >= this.#segmentRecords) segment = this.#createSegment(state);
        const capacity = this.#segmentRecords - segment.count;
        const take = Math.min(capacity, batch.length - index);
        const chunk = batch.slice(index, index + take);
        const payload = chunk.map((item) => `${JSON.stringify(item.record)}\n`).join('');
        await fs.appendFile(segment.file, payload, { encoding: 'utf8', mode: 0o600 });
        segment.count += chunk.length;
        for (const item of chunk) {
          written.add(item);
          if (item.record.messageId) {
            segment.entries.push({ messageId: item.record.messageId, seq: item.record.seq! });
          } else {
            segment.entries.push({ seq: item.record.seq! });
          }
        }
        index += take;
      }
    } catch (error) {
      for (const item of batch) {
        if (written.has(item)) {
          item.resolve({ seq: item.record.seq!, duplicate: false });
          continue;
        }
        state.count = Math.max(0, state.count - 1);
        if (item.record.messageId) this.#forgetSeen(state, item.record.messageId, item.record.seq!);
        item.reject(error);
      }
      throw error;
    }
    if (this.#maxRecords) {
      try {
        await this.#prune(state);
      } catch (error) {
        this.#logger?.warn('jsonl prune failed', {
          dir: state.dir,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    // append 的 resolve 必须晚于裁剪完成，否则调用方紧接着 read 会看到超限数据。
    for (const item of batch) item.resolve({ seq: item.record.seq!, duplicate: false });
  }

  #forgetSeen(state: ConversationState, messageId: string, seq: number): void {
    if (state.seen.get(messageId) !== seq) return;
    state.seen.delete(messageId);
    const index = state.seenOrder.lastIndexOf(messageId);
    if (index >= 0) state.seenOrder.splice(index, 1);
  }

  #createSegment(state: ConversationState): SegmentInfo {
    const last = state.segments.at(-1);
    const next = last ? Number(last.name.slice(0, 6)) + 1 : 1;
    const name = `${String(next).padStart(6, '0')}.jsonl`;
    const segment: SegmentInfo = { name, file: path.join(state.dir, name), count: 0, entries: [] };
    state.segments.push(segment);
    return segment;
  }

  async #prune(state: ConversationState): Promise<void> {
    const max = this.#maxRecords;
    if (!max || state.count <= max) return;
    // 大会话按低水位批量裁剪，避免每条新消息都重写；小会话保持精确上限。
    const target = max >= 100 ? Math.max(1, max - Math.max(1, Math.floor(max * 0.05))) : max;
    let excess = state.count - target;

    while (excess > 0 && state.segments.length > 0) {
      const oldest = state.segments[0];
      if (!oldest) break;
      if (oldest.count <= excess) {
        await fs.unlink(oldest.file).catch(() => {});
        state.segments.shift();
        state.count -= oldest.count;
        excess -= oldest.count;
        continue;
      }
      const keep = oldest.count - excess;
      await this.#rewriteSegment(oldest, keep);
      state.count -= excess;
      excess = 0;
    }
    this.#rebuildSeen(state);
  }

  async #rewriteSegment(segment: SegmentInfo, keep: number): Promise<void> {
    if (keep <= 0) {
      await fs.unlink(segment.file).catch(() => {});
      return;
    }
    const records = await this.#readFile(segment.file);
    const kept = records.slice(-keep);
    const payload = kept.map((record) => `${JSON.stringify(record)}\n`).join('');
    await writeFileAtomic(segment.file, payload);
    segment.count = kept.length;
    segment.entries = kept.map((record) => ({
      ...(record.messageId ? { messageId: record.messageId } : {}),
      seq: record.seq ?? 0
    }));
  }

  #rebuildSeen(state: ConversationState): void {
    state.seen.clear();
    state.seenOrder.length = 0;
    state.segments = state.segments.filter((segment) => segment.count > 0);
    for (const segment of state.segments) {
      for (const entry of segment.entries) {
        if (!entry.messageId) continue;
        state.seen.set(entry.messageId, entry.seq);
        state.seenOrder.push(entry.messageId);
      }
    }
    this.#evictSeenIfNeeded(state);
  }

  #evictSeenIfNeeded(state: ConversationState): void {
    const limit = this.#maxRecords ?? MAX_SEEN_WITHOUT_RETENTION;
    while (state.seenOrder.length > limit) {
      const id = state.seenOrder.shift();
      if (id) state.seen.delete(id);
    }
  }

  async #readSegment(segment: SegmentInfo): Promise<StoredMessage[]> {
    return this.#readFile(segment.file);
  }

  async #readFile(file: string): Promise<StoredMessage[]> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: StoredMessage[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as StoredMessage);
      } catch {
        this.#logger?.warn('skipping corrupt jsonl line', { file });
      }
    }
    return records;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
