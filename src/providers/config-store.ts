import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import { writeFileAtomic } from '../storage/atomic-write.js';
import type { SkillConfig } from '../extensions/types.js';
import type { AccountPolicy, ProviderConfig, RuntimeConfigV2 } from './types.js';
import {
  configFingerprint,
  defaultAccountPolicy,
  emptyRuntimeConfig,
  parseAccountPolicy,
  parseProvider,
  parseRuntimeConfig
} from './types.js';
import { AccompanyError } from '../core/errors.js';
import { ConfigError } from './errors.js';
import { removeProviderFromConfig } from './provider-removal.js';

export interface ConfigStoreOptions {
  filePath: string;
  legacyFile?: string;
  logger?: Logger;
}

/**
 * schemaVersion=2 的运行时配置：模型服务、账号策略、Skill 与媒体保留策略。
 * v1 的 config.json 仍由 LayeredConfig 服务旧插件；这里绝不覆盖它。
 * 写入走“临时文件 → 备份现有文件 → 原子替换”，失败保留原文件。
 */
export class ConfigStore {
  readonly #filePath: string;
  readonly #legacyFile?: string;
  readonly #logger?: Logger;
  #config: RuntimeConfigV2;
  #version = 0;
  #mutationChain: Promise<void> = Promise.resolve();
  #writeChain: Promise<void> = Promise.resolve();
  #loaded = false;
  #legacyBackup?: string;

  private constructor(options: ConfigStoreOptions, config: RuntimeConfigV2) {
    this.#filePath = path.resolve(options.filePath);
    this.#legacyFile = options.legacyFile ? path.resolve(options.legacyFile) : undefined;
    this.#logger = options.logger;
    this.#config = config;
  }

  static async load(options: ConfigStoreOptions): Promise<ConfigStore> {
    let raw: unknown;
    let exists = true;
    try {
      raw = JSON.parse(await fs.readFile(path.resolve(options.filePath), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        exists = false;
        raw = emptyRuntimeConfig();
      } else if (error instanceof SyntaxError) {
        throw new ConfigError(`config file is not valid JSON: ${options.filePath}`, { cause: error });
      } else {
        throw new ConfigError(`config file is unreadable: ${options.filePath}`, { cause: error });
      }
    }
    const config = exists ? parseRuntimeConfig(raw, options.filePath) : emptyRuntimeConfig();
    const store = new ConfigStore(options, config);
    store.#loaded = exists;
    await store.#backupLegacyOnce();
    return store;
  }

  get filePath(): string {
    return this.#filePath;
  }

  get backupPath(): string {
    return `${this.#filePath}.bak`;
  }

  get legacyBackupPath(): string | undefined {
    return this.#legacyBackup;
  }

  get loadedFromFile(): boolean {
    return this.#loaded;
  }

  get version(): number {
    return this.#version;
  }

  get fingerprint(): string {
    return configFingerprint(this.#config);
  }

  snapshot(): RuntimeConfigV2 {
    return structuredClone(this.#config);
  }

  provider(id: string): ProviderConfig | undefined {
    const found = this.#config.providers.find((provider) => provider.id === id);
    return found ? structuredClone(found) : undefined;
  }

  accountPolicy(accountId: string): AccountPolicy | undefined {
    const found = this.#config.accountPolicies[accountId];
    return found ? structuredClone(found) : undefined;
  }

  async upsertProvider(raw: unknown, setting?: { capability: string; modelId: string }): Promise<ProviderConfig> {
    const provider = parseProvider(raw);
    return this.#mutate((next) => {
      if (setting) {
        for (const item of next.providers) {
          const selections = { ...(item.options.settingsModels as Record<string, string> ?? {}) };
          delete selections[setting.capability];
          item.options.settingsModels = selections;
        }
        provider.options.settingsModels = { ...(provider.options.settingsModels as Record<string, string> ?? {}), [setting.capability]: setting.modelId };
      }
      const index = next.providers.findIndex((entry) => entry.id === provider.id);
      if (index >= 0) next.providers[index] = provider;
      else next.providers.push(provider);
      return provider;
    });
  }

  providerRemovalImpact(id: string): { providerId: string; exists: boolean; affectedAccounts: string[] } {
    const result = removeProviderFromConfig(this.snapshot(), id);
    return { providerId: id, exists: result.removed, affectedAccounts: result.affectedAccounts };
  }

  async removeProvider(id: string): Promise<{ removed: boolean; affectedAccounts: string[] }> {
    return this.#mutate(next => removeProviderFromConfig(next, id));
  }

  async setAccountPolicy(
    accountId: string,
    raw: unknown,
    options: { preserveExtensions?: boolean } = {}
  ): Promise<AccountPolicy> {
    const policy = parseAccountPolicy(raw, `accountPolicies.${accountId}`);
    const legacyTools = Boolean(raw && typeof raw === 'object' && !Array.isArray(raw)
      && Object.prototype.hasOwnProperty.call(raw, 'enabledTools'));
    return this.#mutate((next) => {
      // Skill definitions have their own revision/CAS path; a legacy full-policy save must not
      // silently drop what the Skill service wrote in the meantime.
      const current = next.accountPolicies[accountId];
      const updated: AccountPolicy = current?.skills
        ? { ...policy, skills: structuredClone(current.skills) }
        : policy;
      // The model page is not an extension-policy owner. Legacy `enabledTools` writes keep their
      // historical meaning until EXT-H removes that path.
      if (options.preserveExtensions && !legacyTools) {
        if (current?.extensions) updated.extensions = structuredClone(current.extensions);
        else delete updated.extensions;
      }
      next.accountPolicies[accountId] = updated;
      return updated;
    });
  }

  async removeAccountPolicy(accountId: string): Promise<boolean> {
    return this.#mutate((next) => {
      if (!next.accountPolicies[accountId]) return false;
      delete next.accountPolicies[accountId];
      return true;
    });
  }

  /**
   * CAS for one account policy subtree. `expectedVersion` is the store version observed by the
   * caller; any intervening config write fails the update instead of overwriting it. `beforeCommit`
   * runs inside the mutation queue so cross-file preconditions (for example the profile revision)
   * cannot be satisfied by a stale read.
   */
  async updateAccountPolicy(
    accountId: string,
    expectedVersion: number,
    apply: (current: AccountPolicy) => AccountPolicy,
    beforeCommit?: () => Promise<void>
  ): Promise<AccountPolicy> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new ConfigError('expected config version must be a non-negative integer');
    }
    return this.#runMutation(async () => {
      if (this.#version !== expectedVersion) {
        throw new AccompanyError('extension_conflict', '扩展配置已被其他窗口修改，请刷新后重试。');
      }
      await beforeCommit?.();
      const next = this.snapshot();
      const current = next.accountPolicies[accountId] ?? defaultAccountPolicy();
      const updated = parseAccountPolicy(apply(current), `accountPolicies.${accountId}`);
      next.accountPolicies[accountId] = updated;
      await this.#commit(next);
      return updated;
    });
  }

  /**
   * CAS for the public Skill subtree. Only the Skill array is replaced; providers, account policies
   * and media settings are carried over from the same snapshot.
   */
  async updateSkills(
    expectedVersion: number,
    apply: (current: SkillConfig[]) => SkillConfig[]
  ): Promise<SkillConfig[]> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new ConfigError('expected config version must be a non-negative integer');
    }
    return this.#runMutation(async () => {
      if (this.#version !== expectedVersion) {
        throw new AccompanyError('skill_conflict', 'Skill 定义已被其他窗口修改，请刷新后重试。');
      }
      const next = this.snapshot();
      const updated = apply(next.skills.map((skill) => structuredClone(skill)));
      next.skills = updated;
      await this.#commit(next);
      return structuredClone(next.skills);
    });
  }

  async replace(raw: unknown): Promise<RuntimeConfigV2> {
    const config = parseRuntimeConfig(raw, this.#filePath);
    return this.#runMutation(async () => {
      await this.#commit(config);
      return config;
    });
  }

  async restoreBackup(): Promise<RuntimeConfigV2> {
    return this.#runMutation(async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(this.backupPath, 'utf8'));
      } catch (error) {
        throw new ConfigError(`config backup is missing or unreadable: ${this.backupPath}`, { cause: error });
      }
      const config = parseRuntimeConfig(raw, this.backupPath);
      await this.#commit(config);
      return config;
    });
  }

  async dispose(): Promise<void> {
    await this.#mutationChain.catch(() => {});
    await this.#writeChain.catch(() => {});
  }

  /**
   * 所有修改都在同一队列内基于最新配置读改写；只串行化写文件会让并发保存互相覆盖。
   */
  #mutate<T>(apply: (next: RuntimeConfigV2) => T | Promise<T>): Promise<T> {
    return this.#runMutation(async () => {
      const next = this.snapshot();
      const result = await apply(next);
      await this.#commit(next);
      return result;
    });
  }

  #runMutation<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#mutationChain.catch(() => {}).then(task);
    this.#mutationChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #backupLegacyOnce(): Promise<void> {
    if (this.#loaded || !this.#legacyFile) return;
    try {
      await fs.access(this.#legacyFile);
    } catch {
      return;
    }
    const target = `${this.#legacyFile}.backup.json`;
    try {
      await fs.access(target);
      this.#legacyBackup = target;
      return;
    } catch {
      // 首次备份
    }
    try {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.copyFile(this.#legacyFile, target);
      await fs.chmod(target, 0o600).catch(() => {});
      this.#legacyBackup = target;
      this.#logger?.info('legacy config backed up before phase-1 config', { from: this.#legacyFile, to: target });
    } catch (error) {
      throw new ConfigError(`failed to back up legacy config before migration: ${target}`, { cause: error });
    }
  }

  async #commit(next: RuntimeConfigV2): Promise<void> {
    const normalized = parseRuntimeConfig(next, this.#filePath);
    const payload = `${JSON.stringify(normalized, null, 2)}\n`;
    const task = this.#writeChain
      .catch(() => {})
      .then(async () => {
        try {
          if (this.#loaded) {
            await fs.copyFile(this.#filePath, this.backupPath);
            await fs.chmod(this.backupPath, 0o600).catch(() => {});
          }
          await writeFileAtomic(this.#filePath, payload);
        } catch (error) {
          throw new ConfigError(`failed to persist config: ${this.#filePath}`, { cause: error });
        }
      });
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
    this.#config = normalized;
    this.#loaded = true;
    this.#version += 1;
  }
}
