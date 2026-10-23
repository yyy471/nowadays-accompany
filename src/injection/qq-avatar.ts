import type { Logger } from '../core/logger.js';
import { readResponseBytes } from '../platform/http/bounded-body.js';

const UIN_RE = /^\d{5,12}$/;
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 32;

interface CacheEntry {
  at: number;
  expiresAt: number;
  dataUrl?: string;
}

/**
 * 从 QQ 公开头像服务读取头像并缓存为 data URL。
 * 只用于进程卡片展示，不写入账号资料；失败时静默回退到占位图标。
 */
export class QqAvatarCache {
  readonly #fetch: typeof fetch;
  readonly #logger?: Logger;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #pending = new Map<string, Promise<string | undefined>>();

  constructor(options: { fetchImpl?: typeof fetch; logger?: Logger } = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#logger = options.logger;
  }

  async get(uin: string): Promise<string | undefined> {
    if (!UIN_RE.test(uin)) return undefined;
    const cached = this.#entries.get(uin);
    if (cached && cached.expiresAt > Date.now()) return cached.dataUrl;
    const pending = this.#pending.get(uin);
    if (pending) return pending;
    const task = this.#load(uin).finally(() => {
      if (this.#pending.get(uin) === task) this.#pending.delete(uin);
    });
    this.#pending.set(uin, task);
    return task;
  }

  async #load(uin: string): Promise<string | undefined> {
    const at = Date.now();
    try {
      const response = await this.#fetch(
        `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100`,
        { headers: { accept: 'image/*' }, signal: AbortSignal.timeout(3_000) }
      );
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (!response.ok || !contentType.startsWith('image/')) {
        throw new Error(`avatar upstream responded with ${response.status}`);
      }
      const bytes = await readResponseBytes(response, {
        maxBytes: MAX_BYTES,
        timeoutMs: 3_000,
        label: 'QQ avatar'
      });
      if (bytes.length === 0) throw new Error('avatar payload is empty');
      const dataUrl = `data:${contentType};base64,${bytes.toString('base64')}`;
      this.#remember(uin, { at, expiresAt: at + SUCCESS_TTL_MS, dataUrl });
      return dataUrl;
    } catch (error) {
      this.#remember(uin, { at, expiresAt: at + FAILURE_TTL_MS });
      this.#logger?.debug('qq avatar unavailable', {
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  #remember(uin: string, entry: CacheEntry): void {
    this.#entries.delete(uin);
    this.#entries.set(uin, entry);
    if (this.#entries.size <= MAX_ENTRIES) return;
    const expired = [...this.#entries.entries()].find(([, value]) => value.expiresAt <= Date.now());
    const target = expired?.[0] ?? this.#entries.keys().next().value;
    if (target) this.#entries.delete(target);
  }
}
