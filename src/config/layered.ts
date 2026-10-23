import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import { writeFileAtomic } from '../storage/atomic-write.js';
import type { ChatKind } from '../routing/identity.js';
import { conversationKey } from '../routing/identity.js';

export type ConfigLayer = Record<string, unknown>;

export interface ScopeContext {
  accountId: string;
  kind: ChatKind;
  peerId: string;
}

export interface ConfigLayers {
  global: ConfigLayer;
  byAccount: Record<string, ConfigLayer>;
  /** key: "<accountId>:<kind>" 或 "<kind>"（后者对所有账号生效） */
  byKind: Record<string, ConfigLayer>;
  /** key: "<accountId>/<kind>/<peerId>" */
  byConversation: Record<string, ConfigLayer>;
}

export interface LayeredConfigOptions {
  layers?: Partial<ConfigLayers>;
  filePath?: string;
  logger?: Logger;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并：对象递归合并，数组与标量整体替换（顺序稳定，便于测试）。 */
export function mergeLayers(base: ConfigLayer, patch: ConfigLayer): ConfigLayer {
  const out: ConfigLayer = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeLayers(current, value) : structuredClone(value);
  }
  return out;
}

function emptyLayers(): ConfigLayers {
  return { global: {}, byAccount: {}, byKind: {}, byConversation: {} };
}

/**
 * 分层配置：global → account → kind → conversation。
 * 没有全局单例；每个 Core 持有一份，文件写入由实例内的串行队列保证。
 */
export class LayeredConfig {
  readonly #layers: ConfigLayers;
  readonly #filePath?: string;
  readonly #logger?: Logger;
  #writeChain: Promise<void> = Promise.resolve();
  #version = 0;

  constructor(options: LayeredConfigOptions = {}) {
    const layers = options.layers ?? {};
    this.#layers = {
      global: structuredClone(layers.global ?? {}),
      byAccount: structuredClone(layers.byAccount ?? {}),
      byKind: structuredClone(layers.byKind ?? {}),
      byConversation: structuredClone(layers.byConversation ?? {})
    };
    this.#filePath = options.filePath;
    this.#logger = options.logger;
  }

  static async load(filePath: string, logger?: Logger): Promise<LayeredConfig> {
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<ConfigLayers>;
      return new LayeredConfig({ layers: raw, filePath, logger });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger?.warn('config file unreadable, starting empty', { filePath });
      }
      return new LayeredConfig({ filePath, logger });
    }
  }

  get version(): number {
    return this.#version;
  }

  resolve(ctx: ScopeContext): ConfigLayer {
    const key = conversationKey(ctx);
    let merged: ConfigLayer = structuredClone(this.#layers.global);
    merged = mergeLayers(merged, this.#layers.byAccount[ctx.accountId] ?? {});
    merged = mergeLayers(merged, this.#layers.byKind[ctx.kind] ?? {});
    // account+kind 是最具体的 kind 作用域，必须最后覆盖通用 kind。
    merged = mergeLayers(merged, this.#layers.byKind[`${ctx.accountId}:${ctx.kind}`] ?? {});
    merged = mergeLayers(merged, this.#layers.byConversation[key] ?? {});
    return merged;
  }

  snapshot(): ConfigLayers {
    return structuredClone(this.#layers);
  }

  async setGlobal(patch: ConfigLayer): Promise<void> {
    this.#layers.global = mergeLayers(this.#layers.global, patch);
    this.#version += 1;
    await this.#persist();
  }

  async setAccount(accountId: string, patch: ConfigLayer): Promise<void> {
    this.#layers.byAccount[accountId] = mergeLayers(this.#layers.byAccount[accountId] ?? {}, patch);
    this.#version += 1;
    await this.#persist();
  }

  async setKind(key: string, patch: ConfigLayer): Promise<void> {
    this.#layers.byKind[key] = mergeLayers(this.#layers.byKind[key] ?? {}, patch);
    this.#version += 1;
    await this.#persist();
  }

  async setConversation(key: string, patch: ConfigLayer): Promise<void> {
    this.#layers.byConversation[key] = mergeLayers(this.#layers.byConversation[key] ?? {}, patch);
    this.#version += 1;
    await this.#persist();
  }

  /** 串行落盘：并发调用不会交错写坏文件；一次失败不能毒化后续写入。 */
  async #persist(): Promise<void> {
    if (!this.#filePath) return;
    const filePath = this.#filePath;
    const payload = `${JSON.stringify(this.#layers, null, 2)}\n`;
    const task = this.#writeChain.catch(() => {}).then(() => writeFileAtomic(filePath, payload));
    this.#writeChain = task.then(
      () => undefined,
      () => undefined
    );
    try {
      await task;
    } catch (error) {
      this.#logger?.error('config persist failed', {
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
