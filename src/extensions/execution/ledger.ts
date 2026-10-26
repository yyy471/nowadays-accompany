import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AccompanyError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { ChatKind } from '../../routing/identity.js';
import { writeFileAtomic } from '../../storage/atomic-write.js';
import { SerialExecutor } from '../../platform/async/serial-executor.js';
import type { ToolEffect, ToolInvocationResult, ToolInvocationStatus } from '../contracts.js';
import { stableStringify } from '../../providers/types.js';

export const TOOL_LEDGER_LIMITS = {
  maxTerminalEntries: 256,
  retentionMs: 7 * 24 * 60 * 60 * 1_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxStoredResultBytes: 2 * 1024,
  maxCallIdLength: 200,
  maxGenerationLength: 128,
  maxMessageIdLength: 200
} as const;

export type ToolLedgerStatus = 'started' | ToolInvocationStatus;

export interface ToolInvocationScope {
  accountId: string;
  kind: ChatKind;
  peerId: string;
  /** Stable inbound message id or seq; the host must provide it, not a wall-clock value. */
  messageId: string;
  /** Zero-based model round within the turn. */
  turn: number;
  /** Zero-based position in the batch. */
  index: number;
  contextEpoch?: string;
  runtimeGeneration?: string;
}

export interface ToolInvocationKeyParts extends ToolInvocationScope {
  callId?: string;
  toolId: string;
}

export interface ToolLedgerResult {
  status: ToolInvocationStatus;
  errorCode?: string;
  text?: string;
  data?: unknown;
  truncated?: boolean;
  jobId?: string;
  media?: NonNullable<ToolInvocationResult['media']>;
}

export interface ToolLedgerEntry {
  key: string;
  invocationId: string;
  accountId: string;
  kind: ChatKind;
  peerId: string;
  messageId: string;
  turn: number;
  index: number;
  contextEpoch?: string;
  runtimeGeneration?: string;
  toolId: string;
  effect: ToolEffect;
  handlerGeneration: string;
  argumentDigest: string;
  status: ToolLedgerStatus;
  startedAt: number;
  updatedAt: number;
  result?: ToolLedgerResult;
}

export interface ToolLedgerBeginInput {
  key: string;
  invocationId: string;
  scope: ToolInvocationScope;
  toolId: string;
  effect: ToolEffect;
  handlerGeneration: string;
  argumentDigest: string;
  at?: number;
}

export type ToolLedgerBegin =
  | { kind: 'new' }
  | { kind: 'replay'; result: ToolInvocationResult }
  | { kind: 'conflict' }
  | { kind: 'in_progress'; record: ToolLedgerEntry }
  | { kind: 'unknown'; record: ToolLedgerEntry };

interface ToolLedgerFile {
  version: 1;
  entries: ToolLedgerEntry[];
}

/** Stable host invocation key; call ids are opaque and must not be used as file paths. */
export function toolInvocationKey(parts: ToolInvocationKeyParts): string {
  return crypto.createHash('sha256').update(stableStringify({
    accountId: parts.accountId,
    kind: parts.kind,
    peerId: parts.peerId,
    messageId: parts.messageId,
    turn: parts.turn,
    index: parts.index,
    callId: parts.callId ?? '',
    toolId: parts.toolId
  })).digest('hex').slice(0, 32);
}

/** Deterministic pairing id when the provider omitted a tool call id. */
export function toolInvocationId(key: string, callId?: string): string {
  if (callId) return callId;
  return `tool_${key.slice(0, 16)}`;
}

export function toolArgumentDigest(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}

export function toolLedgerPath(accountDir: string): string {
  return path.join(accountDir, 'state', 'tool-invocations.json');
}

/**
 * Account-private invocation ledger. The store is fail-closed: unreadable data, a full file or a
 * failed action-intent write prevents the side effect instead of silently losing idempotency.
 */
export class ToolInvocationStore {
  readonly #filePath: string;
  readonly #logger?: Logger;
  readonly #now: () => number;
  readonly #entries: ToolLedgerEntry[] = [];
  readonly #byKey = new Map<string, ToolLedgerEntry>();
  readonly #mutations = new SerialExecutor({ maxPending: 64 });
  #unavailable?: string;
  #closed = false;

  private constructor(filePath: string, logger: Logger | undefined, now: () => number) {
    this.#filePath = filePath;
    this.#logger = logger;
    this.#now = now;
  }

  static async load(filePath: string, logger?: Logger, now: () => number = Date.now): Promise<ToolInvocationStore> {
    const store = new ToolInvocationStore(path.resolve(filePath), logger, now);
    await store.#read();
    return store;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get unavailableReason(): string | undefined {
    return this.#unavailable;
  }

  snapshot(): ToolLedgerEntry[] {
    return this.#entries.map((entry) => structuredClone(entry));
  }

  /** Adds or replays an invocation. Action intents are persisted before this method returns. */
  async begin(input: ToolLedgerBeginInput): Promise<ToolLedgerBegin> {
    return this.#mutations.run(async () => {
      this.#assertUsable();
      const existing = this.#byKey.get(input.key);
      if (existing) {
        if (existing.argumentDigest !== input.argumentDigest) return { kind: 'conflict' };
        if (existing.handlerGeneration !== input.handlerGeneration) return { kind: 'conflict' };
        if (existing.contextEpoch !== input.scope.contextEpoch) return { kind: 'conflict' };
        if (existing.runtimeGeneration !== input.scope.runtimeGeneration) return { kind: 'conflict' };
        if (existing.status === 'started') return { kind: 'in_progress', record: structuredClone(existing) };
        if (existing.status === 'unknown') return { kind: 'unknown', record: structuredClone(existing) };
        return { kind: 'replay', result: toInvocationResult(existing) };
      }
      const at = input.at ?? this.#now();
      const entry: ToolLedgerEntry = {
        key: input.key,
        invocationId: input.invocationId,
        accountId: input.scope.accountId,
        kind: input.scope.kind,
        peerId: input.scope.peerId,
        messageId: input.scope.messageId,
        turn: input.scope.turn,
        index: input.scope.index,
        ...(input.scope.contextEpoch !== undefined ? { contextEpoch: input.scope.contextEpoch } : {}),
        ...(input.scope.runtimeGeneration ? { runtimeGeneration: input.scope.runtimeGeneration } : {}),
        toolId: input.toolId,
        effect: input.effect,
        handlerGeneration: input.handlerGeneration,
        argumentDigest: input.argumentDigest,
        status: 'started',
        startedAt: at,
        updatedAt: at
      };
      this.#entries.push(entry);
      this.#byKey.set(entry.key, entry);
      if (input.effect === 'action') {
        this.#prune();
        try {
          await this.#persist();
        } catch (error) {
          this.#remove(entry);
          throw error;
        }
      }
      return { kind: 'new' };
    });
  }

  /** Persists a terminal result. A failed write degrades the entry to unknown, never to success. */
  async complete(key: string, result: ToolInvocationResult, at = this.#now()): Promise<ToolInvocationResult> {
    return this.#mutations.run(async () => {
      const entry = this.#byKey.get(key);
      if (!entry) throw new AccompanyError('tool_ledger_missing', 'tool invocation receipt is missing');
      if (entry.status !== 'started') {
        if (entry.status === 'unknown') throw new AccompanyError('tool_ledger_unknown', 'tool invocation is already unknown');
        return toInvocationResult(entry);
      }
      entry.status = result.status;
      entry.result = boundedLedgerResult(result);
      entry.updatedAt = at;
      this.#prune();
      try {
        await this.#persist();
      } catch (error) {
        entry.status = 'unknown';
        entry.result = { status: 'unknown', errorCode: 'ledger_write_failed', truncated: true };
        entry.updatedAt = this.#now();
        this.#unavailable = 'tool_ledger_write_failed';
        throw error;
      }
      return result;
    });
  }

  /** Marks an action whose side effect may have started as unknown; no retry is implied. */
  async markUnknown(key: string, errorCode: string, at = this.#now()): Promise<void> {
    await this.#mutations.run(async () => {
      const entry = this.#byKey.get(key);
      if (!entry || entry.status !== 'started') return;
      entry.status = 'unknown';
      entry.result = { status: 'unknown', errorCode, truncated: true };
      entry.updatedAt = at;
      try {
        await this.#persist();
      } catch (error) {
        this.#logger?.warn('tool ledger unknown write failed', {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  async drain(): Promise<void> {
    await this.#mutations.drain();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#mutations.close();
  }

  async #read(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.#unavailable = 'tool_ledger_unavailable';
      this.#logger?.warn('tool ledger unreadable', { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#unavailable = 'tool_ledger_corrupt';
      this.#logger?.warn('tool ledger is not valid JSON');
      return;
    }
    if (Buffer.byteLength(raw, 'utf8') > TOOL_LEDGER_LIMITS.maxFileBytes) {
      this.#unavailable = 'tool_ledger_full';
      this.#logger?.warn('tool ledger exceeds its size limit');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed as Partial<ToolLedgerFile>).version !== 1
      || !Array.isArray((parsed as Partial<ToolLedgerFile>).entries)) {
      this.#unavailable = 'tool_ledger_corrupt';
      this.#logger?.warn('tool ledger has an invalid shape');
      return;
    }
    let recovered = false;
    for (const rawEntry of (parsed as ToolLedgerFile).entries) {
      const entry = parseEntry(rawEntry);
      if (!entry) {
        this.#unavailable = 'tool_ledger_corrupt';
        this.#logger?.warn('tool ledger contains an invalid receipt');
        return;
      }
      if (entry.status === 'started') {
        entry.status = 'unknown';
        entry.result = { status: 'unknown', errorCode: 'interrupted', truncated: true };
        entry.updatedAt = this.#now();
        recovered = true;
      }
      this.#entries.push(entry);
      this.#byKey.set(entry.key, entry);
    }
    const pruned = this.#prune();
    if (recovered || pruned) {
      try {
        await this.#persist();
      } catch (error) {
        this.#logger?.warn('tool ledger recovery write failed', {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  #assertUsable(): void {
    if (this.#closed) throw new AccompanyError('tool_ledger_closed', 'tool ledger is closed');
    if (this.#unavailable) throw new AccompanyError(this.#unavailable, 'tool ledger is unavailable');
  }

  #prune(): boolean {
    const now = this.#now();
    let changed = false;
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index]!;
      const terminal = entry.status === 'ok' || entry.status === 'error' || entry.status === 'submitted';
      if (terminal && now - entry.updatedAt > TOOL_LEDGER_LIMITS.retentionMs) {
        this.#remove(entry);
        changed = true;
      }
    }
    const terminal = this.#entries.filter((entry) => entry.status === 'ok' || entry.status === 'error' || entry.status === 'submitted');
    const excess = terminal.length - TOOL_LEDGER_LIMITS.maxTerminalEntries;
    if (excess > 0) {
      for (const entry of terminal.slice(0, excess)) {
        this.#remove(entry);
        changed = true;
      }
    }
    return changed;
  }

  #remove(entry: ToolLedgerEntry): void {
    const index = this.#entries.indexOf(entry);
    if (index >= 0) this.#entries.splice(index, 1);
    this.#byKey.delete(entry.key);
  }

  async #persist(): Promise<void> {
    const body = `${JSON.stringify({ version: 1, entries: this.#entries } satisfies ToolLedgerFile)}\n`;
    if (Buffer.byteLength(body, 'utf8') > TOOL_LEDGER_LIMITS.maxFileBytes) {
      throw new AccompanyError('tool_ledger_full', 'tool invocation ledger has reached its size limit');
    }
    await writeFileAtomic(this.#filePath, body);
  }
}

function parseEntry(raw: unknown): ToolLedgerEntry | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.key !== 'string' || !/^[a-f0-9]{32}$/.test(value.key)) return undefined;
  if (typeof value.invocationId !== 'string' || !value.invocationId || value.invocationId.length > TOOL_LEDGER_LIMITS.maxCallIdLength) return undefined;
  if (typeof value.accountId !== 'string' || !safeSegment(value.accountId)) return undefined;
  if (value.kind !== 'private' && value.kind !== 'group') return undefined;
  if (typeof value.peerId !== 'string' || !safeSegment(value.peerId)) return undefined;
  if (typeof value.messageId !== 'string' || !value.messageId || value.messageId.length > TOOL_LEDGER_LIMITS.maxMessageIdLength) return undefined;
  if (!Number.isSafeInteger(value.turn) || (value.turn as number) < 0) return undefined;
  if (!Number.isSafeInteger(value.index) || (value.index as number) < 0) return undefined;
  if (value.contextEpoch !== undefined && (typeof value.contextEpoch !== 'string' || value.contextEpoch.length === 0 || Buffer.byteLength(value.contextEpoch, 'utf8') > 2_048)) return undefined;
  if (value.runtimeGeneration !== undefined && (typeof value.runtimeGeneration !== 'string' || value.runtimeGeneration.length > TOOL_LEDGER_LIMITS.maxGenerationLength)) return undefined;
  if (typeof value.toolId !== 'string' || !value.toolId) return undefined;
  if (value.effect !== 'read' && value.effect !== 'action') return undefined;
  if (typeof value.handlerGeneration !== 'string' || !value.handlerGeneration || value.handlerGeneration.length > TOOL_LEDGER_LIMITS.maxGenerationLength) return undefined;
  if (typeof value.argumentDigest !== 'string' || !/^[a-f0-9]{32}$/.test(value.argumentDigest)) return undefined;
  if (!isLedgerStatus(value.status)) return undefined;
  if (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) return undefined;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return undefined;
  let result: ToolLedgerResult | undefined;
  if (value.status === 'started') {
    if (value.result !== undefined) return undefined;
  } else {
    if (value.result === undefined) return undefined;
    result = parseLedgerResult(value.result);
    if (!result || result.status !== value.status) return undefined;
  }
  return {
    key: value.key,
    invocationId: value.invocationId,
    accountId: value.accountId,
    kind: value.kind,
    peerId: value.peerId,
    messageId: value.messageId,
    turn: value.turn as number,
    index: value.index as number,
    ...(typeof value.contextEpoch === 'string' ? { contextEpoch: value.contextEpoch } : {}),
    ...(typeof value.runtimeGeneration === 'string' ? { runtimeGeneration: value.runtimeGeneration } : {}),
    toolId: value.toolId,
    effect: value.effect,
    handlerGeneration: value.handlerGeneration,
    argumentDigest: value.argumentDigest,
    status: value.status,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(result ? { result } : {})
  };
}

function parseLedgerResult(raw: unknown): ToolLedgerResult | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!isInvocationStatus(value.status)) return undefined;
  if (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || value.errorCode.length > 64)) return undefined;
  if (value.text !== undefined && (typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > TOOL_LEDGER_LIMITS.maxStoredResultBytes)) return undefined;
  if (value.jobId !== undefined && (typeof value.jobId !== 'string' || value.jobId.length > 200)) return undefined;
  if (value.media !== undefined) {
    if (!value.media || typeof value.media !== 'object' || Array.isArray(value.media)) return undefined;
    const media = value.media as Record<string, unknown>;
    if (typeof media.mediaId !== 'string' || !media.mediaId) return undefined;
    if (media.kind !== 'image' && media.kind !== 'audio' && media.kind !== 'video' && media.kind !== 'file') return undefined;
    if (media.mimeType !== undefined && (typeof media.mimeType !== 'string' || media.mimeType.length > 128)) return undefined;
  }
  return {
    status: value.status,
    ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(value.data !== undefined ? { data: value.data } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(typeof value.jobId === 'string' ? { jobId: value.jobId } : {}),
    ...(value.media ? { media: value.media as ToolLedgerResult['media'] } : {})
  };
}

function isLedgerStatus(value: unknown): value is ToolLedgerStatus {
  return value === 'started' || isInvocationStatus(value);
}

function isInvocationStatus(value: unknown): value is ToolInvocationStatus {
  return value === 'ok' || value === 'error' || value === 'submitted' || value === 'unknown';
}

function safeSegment(value: string): boolean {
  return value.length > 0 && value.length <= 64 && !/[\/\\\u0000-\u001f]/.test(value);
}

function boundedLedgerResult(result: ToolInvocationResult): ToolLedgerResult {
  let text = result.text;
  if (text && Buffer.byteLength(text, 'utf8') > TOOL_LEDGER_LIMITS.maxStoredResultBytes) {
    text = truncateUtf8(text, TOOL_LEDGER_LIMITS.maxStoredResultBytes);
  }
  let data = result.data;
  let truncated = result.truncated === true || text !== result.text;
  if (data !== undefined) {
    try {
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > TOOL_LEDGER_LIMITS.maxStoredResultBytes) {
        data = undefined;
        truncated = true;
      }
    } catch {
      data = undefined;
      truncated = true;
    }
  }
  return {
    status: result.status,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(text ? { text } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(result.jobId ? { jobId: result.jobId } : {}),
    ...(result.media ? { media: result.media } : {})
  };
}

function toInvocationResult(entry: ToolLedgerEntry): ToolInvocationResult {
  const result = entry.result;
  return {
    invocationId: entry.invocationId,
    status: result?.status ?? (entry.status === 'started' ? 'unknown' : entry.status),
    ...(result?.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result?.text ? { text: result.text } : {}),
    ...(result?.data !== undefined ? { data: result.data } : {}),
    ...(result?.truncated ? { truncated: true } : {}),
    ...(result?.jobId ? { jobId: result.jobId } : {}),
    ...(result?.media ? { media: result.media } : {})
  };
}

function truncateUtf8(text: string, maxBytes: number): string {
  const ellipsis = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, 'utf8'));
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= budget) return `${buffer.toString('utf8')}${ellipsis}`;
  return `${buffer.subarray(0, budget).toString('utf8').replace(/\uFFFD+$/, '')}${ellipsis}`;
}
