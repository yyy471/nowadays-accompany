import fs from 'node:fs/promises';
import path from 'node:path';
import { AccompanyError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { isLoopbackHost } from '../core/net.js';

export interface InjectionSettings {
  runtimeDir?: string;
  baseUrl?: string;
  /** 应用启动或服务恢复后，仅重连上次仍在运行且账号匹配的已注入进程。 */
  resumeLastListen?: boolean;
}

interface FileShape {
  version: 1;
  runtimeDir?: string;
  baseUrl?: string;
  resumeLastListen?: boolean;
}

export interface InjectionSettingsStoreOptions {
  filePath: string;
  logger?: Logger;
}

/** 非敏感注入设置；管理密码只进凭据库，不写入此文件。 */
export class InjectionSettingsStore {
  readonly #filePath: string;
  readonly #logger?: Logger;
  #value: InjectionSettings = {};
  #chain: Promise<void> = Promise.resolve();

  private constructor(options: InjectionSettingsStoreOptions, value: InjectionSettings) {
    this.#filePath = path.resolve(options.filePath);
    this.#logger = options.logger;
    this.#value = value;
  }

  static async load(options: InjectionSettingsStoreOptions): Promise<InjectionSettingsStore> {
    let raw: unknown = {};
    try {
      raw = JSON.parse(await fs.readFile(path.resolve(options.filePath), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AccompanyError(
          'injection_settings_unreadable',
          `injection settings are unreadable: ${options.filePath}`,
          { cause: error }
        );
      }
    }
    return new InjectionSettingsStore(options, parseSettings(raw, 'injectionSettings'));
  }

  get(): InjectionSettings {
    return { ...this.#value };
  }

  async set(raw: unknown): Promise<InjectionSettings> {
    const next = parseSettings(raw, 'injectionSettings');
    const task = this.#chain.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.#filePath}.${process.pid}.tmp`;
      const payload: FileShape = { version: 1, ...next };
      try {
        await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(tmp, this.#filePath);
      } catch (error) {
        await fs.unlink(tmp).catch(() => {});
        throw new AccompanyError('injection_settings_write_failed', 'failed to persist injection settings', {
          cause: error
        });
      }
      this.#value = next;
    });
    this.#chain = task.then(
      () => undefined,
      () => undefined
    );
    await task;
    this.#logger?.info('injection settings saved', { runtimeDir: next.runtimeDir });
    return { ...next };
  }

  async dispose(): Promise<void> {
    await this.#chain.catch(() => {});
  }
}

function parseSettings(raw: unknown, source: string): InjectionSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AccompanyError('injection_settings_invalid', `${source} must be an object`);
  }
  const value = raw as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => !['version', 'runtimeDir', 'baseUrl', 'resumeLastListen'].includes(key));
  if (unknown.length > 0) {
    throw new AccompanyError('injection_settings_invalid', `${source} has unknown field ${unknown[0]}`);
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new AccompanyError('injection_settings_invalid', `${source}.version must be 1`);
  }
  if (value.resumeLastListen !== undefined && typeof value.resumeLastListen !== 'boolean') {
    throw new AccompanyError('injection_settings_invalid', `${source}.resumeLastListen must be a boolean`);
  }
  let runtimeDir: string | undefined;
  if (value.runtimeDir !== undefined) {
    if (typeof value.runtimeDir !== 'string' || !value.runtimeDir.trim()) {
      throw new AccompanyError('injection_settings_invalid', `${source}.runtimeDir must be a non-empty string`);
    }
    runtimeDir = path.resolve(value.runtimeDir.trim());
  }
  let baseUrl: string | undefined;
  if (value.baseUrl !== undefined) {
    if (typeof value.baseUrl !== 'string' || !value.baseUrl.trim()) {
      throw new AccompanyError('injection_settings_invalid', `${source}.baseUrl must be a non-empty string`);
    }
    let parsed: URL;
    try {
      parsed = new URL(value.baseUrl.trim());
    } catch {
      throw new AccompanyError('injection_settings_invalid', `${source}.baseUrl must be a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AccompanyError('injection_settings_invalid', `${source}.baseUrl must use http or https`);
    }
    if (!isLoopbackHost(parsed.hostname)) {
      throw new AccompanyError('injection_settings_invalid', `${source}.baseUrl must be loopback`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new AccompanyError(
        'injection_settings_invalid',
        `${source}.baseUrl must not contain credentials, query parameters or fragments`
      );
    }
    baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  }
  return {
    ...(runtimeDir ? { runtimeDir } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(value.resumeLastListen !== undefined ? { resumeLastListen: value.resumeLastListen } : {})
  };
}
