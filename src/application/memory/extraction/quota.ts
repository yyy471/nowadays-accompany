import fs from 'node:fs/promises';
import { AccompanyError } from '../../../core/errors.js';
import { KeyedSerialExecutor } from '../../../platform/async/keyed-serial-executor.js';
import { writeFileAtomic } from '../../../storage/atomic-write.js';

export interface ExtractionQuotaLimits {
  perAccountPerHour: number;
  globalPerHour: number;
}

export const DEFAULT_EXTRACTION_QUOTA_LIMITS: ExtractionQuotaLimits = {
  perAccountPerHour: 12,
  globalPerHour: 30
};

export interface ExtractionQuotaSnapshot {
  windowStart: number;
  resetAt: number;
  accountUsed: number;
  accountLimit: number;
  globalUsed: number;
  globalLimit: number;
}

interface QuotaFile {
  version: 1;
  windowStart: number;
  global: number;
  accounts: Record<string, number>;
}

interface QuotaFileCandidate {
  version?: unknown;
  windowStart?: unknown;
  global?: unknown;
  accounts?: unknown;
}

const HOUR_MS = 3_600_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ACCOUNTS = 1_000;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

function validAccountId(accountId: string): boolean {
  return accountId !== '__proto__' && ACCOUNT_ID.test(accountId);
}

/**
 * Hourly, persistent call admission. It is a conservative local cost fence, not a monetary budget:
 * a call is counted before the provider request and failures still consume the count.
 */
export class ExtractionQuotaStore {
  readonly #file: string;
  readonly #now: () => number;
  readonly #limits: ExtractionQuotaLimits;
  readonly #writes = new KeyedSerialExecutor();
  #windowStart: number;
  #global = 0;
  #accounts = new Map<string, number>();
  #unavailable = false;
  #disposed = false;

  private constructor(file: string, now: () => number, limits: ExtractionQuotaLimits) {
    this.#file = file;
    this.#now = now;
    this.#limits = limits;
    this.#windowStart = hourStart(now());
  }

  static async load(
    file: string,
    options: { now?: () => number; limits?: Partial<ExtractionQuotaLimits> } = {}
  ): Promise<ExtractionQuotaStore> {
    const limits = {
      perAccountPerHour: options.limits?.perAccountPerHour ?? DEFAULT_EXTRACTION_QUOTA_LIMITS.perAccountPerHour,
      globalPerHour: options.limits?.globalPerHour ?? DEFAULT_EXTRACTION_QUOTA_LIMITS.globalPerHour
    };
    assertLimit(limits.perAccountPerHour, 'perAccountPerHour');
    assertLimit(limits.globalPerHour, 'globalPerHour');
    const store = new ExtractionQuotaStore(file, options.now ?? Date.now, limits);
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) throw new Error('quota file exceeds the size limit');
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as QuotaFileCandidate;
      if (raw.version !== 1 || !Number.isSafeInteger(raw.windowStart) || (raw.windowStart as number) < 0
        || !Number.isSafeInteger(raw.global) || (raw.global as number) < 0
        || !raw.accounts || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)) {
        throw new Error('quota file is invalid');
      }
      const accounts = new Map<string, number>();
      for (const [accountId, count] of Object.entries(raw.accounts as Record<string, unknown>)) {
        if (!validAccountId(accountId) || !Number.isSafeInteger(count) || (count as number) < 0) {
          throw new Error('quota file has an invalid account entry');
        }
        accounts.set(accountId, count as number);
      }
      if (accounts.size > MAX_ACCOUNTS) throw new Error('quota file has too many accounts');
      store.#windowStart = raw.windowStart as number;
      store.#global = raw.global as number;
      store.#accounts = accounts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store;
      // A corrupt quota file must fail closed: starting with zero would grant extra paid calls.
      store.#unavailable = true;
    }
    return store;
  }

  async acquire(accountId: string, at = this.#now()): Promise<ExtractionQuotaSnapshot | undefined> {
    if (this.#disposed) throw new AccompanyError('memory_extraction_quota_unavailable', '自动提取协作者已关闭。');
    if (!validAccountId(accountId)) throw new AccompanyError('invalid_spec', '自动提取账号标识无效。');
    return this.#writes.run(this.#file, async () => {
      if (this.#unavailable) {
        throw new AccompanyError('memory_extraction_quota_unavailable', '自动提取配额状态不可用，已拒绝新的模型调用。');
      }
      const windowStart = hourStart(at);
      const accounts = windowStart === this.#windowStart ? new Map(this.#accounts) : new Map<string, number>();
      const global = windowStart === this.#windowStart ? this.#global : 0;
      const used = accounts.get(accountId) ?? 0;
      if (used >= this.#limits.perAccountPerHour || global >= this.#limits.globalPerHour) {
        if (windowStart !== this.#windowStart) {
          await this.#persist(windowStart, global, accounts);
          this.#windowStart = windowStart;
          this.#global = global;
          this.#accounts = accounts;
        }
        return undefined;
      }
      if (!accounts.has(accountId) && accounts.size >= MAX_ACCOUNTS) {
        throw new AccompanyError('memory_extraction_quota_unavailable', '自动提取配额账号数量达到上限，已拒绝新的模型调用。');
      }
      accounts.set(accountId, used + 1);
      const nextGlobal = global + 1;
      await this.#persist(windowStart, nextGlobal, accounts);
      this.#windowStart = windowStart;
      this.#global = nextGlobal;
      this.#accounts = accounts;
      return this.#snapshot(accountId, windowStart, nextGlobal, accounts);
    });
  }

  snapshot(accountId: string, at = this.#now()): ExtractionQuotaSnapshot {
    const windowStart = hourStart(at);
    if (windowStart !== this.#windowStart) {
      return this.#snapshot(accountId, windowStart, 0, new Map());
    }
    return this.#snapshot(accountId, this.#windowStart, this.#global, this.#accounts);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#writes.run(this.#file, async () => {}).catch(() => {});
  }

  #snapshot(
    accountId: string,
    windowStart: number,
    global: number,
    accounts: Map<string, number>
  ): ExtractionQuotaSnapshot {
    return {
      windowStart,
      resetAt: windowStart + HOUR_MS,
      accountUsed: accounts.get(accountId) ?? 0,
      accountLimit: this.#limits.perAccountPerHour,
      globalUsed: global,
      globalLimit: this.#limits.globalPerHour
    };
  }

  async #persist(windowStart: number, global: number, accounts: Map<string, number>): Promise<void> {
    const payload: QuotaFile = {
      version: 1,
      windowStart,
      global,
      accounts: Object.fromEntries([...accounts.entries()].sort(([left], [right]) => left.localeCompare(right)))
    };
    try {
      await writeFileAtomic(this.#file, `${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      throw new AccompanyError('memory_extraction_quota_unavailable', '自动提取配额无法持久化，已拒绝本次模型调用。', { cause: error });
    }
  }
}

function hourStart(at: number): number {
  if (!Number.isSafeInteger(at) || at < 0) throw new AccompanyError('invalid_spec', '自动提取配额时间无效。');
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

function assertLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AccompanyError('invalid_spec', `自动提取配额 ${label} 必须是正整数。`);
  }
}
