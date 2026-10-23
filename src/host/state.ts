import fs from 'node:fs/promises';
import path from 'node:path';
import { InvalidSpecError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

// `~` 只用于 source/kind 限定的复合状态键（如 private~plugin~echo），普通插件 id 不允许。
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

/** 按插件命名空间隔离的持久状态，落在 <accountDir>/plugin-state/<pluginId>.json。 */
export class PluginStateStore {
  readonly #root: string;
  readonly #logger?: Logger;
  readonly #chains = new Map<string, Promise<void>>();

  constructor(root: string, logger?: Logger) {
    this.#root = root;
    this.#logger = logger;
  }

  async read(pluginId: string): Promise<Record<string, unknown>> {
    const file = this.#fileFor(pluginId);
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#logger?.warn('plugin state unreadable', { file });
      }
      return {};
    }
  }

  async write(pluginId: string, value: Record<string, unknown>): Promise<void> {
    const file = this.#fileFor(pluginId);
    const previous = this.#chains.get(file) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, file);
    });
    this.#chains.set(file, task);
    try {
      await task;
    } finally {
      if (this.#chains.get(file) === task) this.#chains.delete(file);
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#chains.values()]);
    this.#chains.clear();
  }

  #fileFor(pluginId: string): string {
    if (!PLUGIN_ID.test(pluginId)) throw new InvalidSpecError(`invalid plugin id: ${pluginId}`);
    return path.join(this.#root, `${pluginId}.json`);
  }
}
