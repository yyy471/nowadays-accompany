import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CredentialVaultUnavailableError,
  type CredentialVault
} from '../src/index.js';
import { writeJsonAtomic } from '../src/storage/atomic-write.js';

interface VaultFile {
  version: 1;
  entries: Record<string, string>;
}

/**
 * 用 Electron 的 DPAPI 支持（Windows）加密凭据，密文落在 userData/credentials.json。
 * 系统保护不可用时只报错，不退回明文；解密失败按未配置处理，避免把坏数据当密钥发给服务。
 */
export class SafeStorageCredentialVault implements CredentialVault {
  readonly kind = 'electron-safe-storage';
  readonly #file: string;
  #entries: Record<string, string> | undefined;
  #revisions = new Map<string, number>();
  #chain: Promise<void> = Promise.resolve();

  constructor() {
    this.#file = path.join(app.getPath('userData'), 'credentials.json');
  }

  get available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async get(ref: string): Promise<string | undefined> {
    const entries = await this.#load();
    const encrypted = entries[ref];
    if (!encrypted) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return undefined;
    }
  }

  async has(ref: string): Promise<boolean> {
    const entries = await this.#load();
    return Boolean(entries[ref]);
  }

  revision(ref: string): number {
    return this.#revisions.get(ref) ?? 0;
  }

  async set(ref: string, secret: string): Promise<void> {
    if (!this.available) throw new CredentialVaultUnavailableError();
    if (!ref.trim()) throw new Error('credential ref is required');
    if (!secret.trim()) throw new Error('credential must be a non-empty string');
    const encrypted = safeStorage.encryptString(secret).toString('base64');
    await this.#update((entries) => {
      entries[ref] = encrypted;
    });
    this.#revisions.set(ref, this.revision(ref) + 1);
  }

  async delete(ref: string): Promise<void> {
    await this.#update((entries) => {
      delete entries[ref];
    });
    this.#revisions.set(ref, this.revision(ref) + 1);
  }

  async #update(mutate: (entries: Record<string, string>) => void): Promise<void> {
    const task = this.#chain.catch(() => {}).then(async () => {
      const entries = await this.#read();
      mutate(entries);
      const payload: VaultFile = { version: 1, entries };
      await writeJsonAtomic(this.#file, payload);
      this.#entries = entries;
    });
    this.#chain = task;
    return task;
  }

  async #load(): Promise<Record<string, string>> {
    if (this.#entries) return this.#entries;
    this.#entries = await this.#read();
    return this.#entries;
  }

  async #read(): Promise<Record<string, string>> {
    try {
      const raw = JSON.parse(await fs.readFile(this.#file, 'utf8')) as Partial<VaultFile>;
      return raw && raw.version === 1 && raw.entries && typeof raw.entries === 'object' ? { ...raw.entries } : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return {};
      return {};
    }
  }
}
