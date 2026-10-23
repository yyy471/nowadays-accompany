import fs from 'node:fs/promises';
import path from 'node:path';
import { safePathSegment } from '../routing/identity.js';

interface AccountBaseSpec {
  accountId?: string;
  dataDir?: string;
}

export interface AccountDirectoryOptions {
  dataRoot: string;
  /** 当前运行实例；用于把账号定位到自定义 dataDir。 */
  specs?: () => AccountBaseSpec[];
}

/**
 * 账号根目录的唯一解析入口。
 * 只计算路径；`ensure` 才创建目录，查询未知账号不会产生空目录。
 */
export class AccountDirectory {
  readonly #dataRoot: string;
  readonly #specs?: () => AccountBaseSpec[];

  constructor(options: AccountDirectoryOptions) {
    this.#dataRoot = path.resolve(options.dataRoot);
    this.#specs = options.specs;
  }

  get dataRoot(): string {
    return this.#dataRoot;
  }

  /** 默认根与所有自定义根下的 accounts 目录，用于枚举已有账号。 */
  accountsRoots(): string[] {
    const roots = new Set<string>([path.join(this.#dataRoot, 'accounts')]);
    for (const spec of this.#specs?.() ?? []) {
      if (!spec.dataDir) continue;
      roots.add(path.join(path.resolve(spec.dataDir), 'accounts'));
    }
    return [...roots];
  }

  /** 账号目录路径；不创建目录。 */
  path(accountId: string, options: { baseDir?: string } = {}): string {
    const base = options.baseDir
      ? path.resolve(options.baseDir)
      : this.#baseFor(accountId) ?? this.#dataRoot;
    return path.join(base, 'accounts', safePathSegment(accountId));
  }

  forSpec(spec: AccountBaseSpec | undefined, accountId: string): string {
    return this.path(accountId, spec?.dataDir ? { baseDir: spec.dataDir } : {});
  }

  /** 读取已有账号时使用；自定义目录存在则优先，否则回退默认目录。 */
  async resolveExisting(accountId: string): Promise<string | undefined> {
    const custom = this.#baseFor(accountId);
    const candidates = custom
      ? [this.path(accountId, { baseDir: custom }), this.path(accountId, { baseDir: this.#dataRoot })]
      : [this.path(accountId)];
    for (const candidate of candidates) {
      try {
        if ((await fs.stat(candidate)).isDirectory()) return candidate;
      } catch {
        // 目录不存在或不可读时继续尝试下一个根
      }
    }
    return undefined;
  }

  /** 写入资料时使用；允许创建账号目录。 */
  async ensure(accountId: string, options: { baseDir?: string } = {}): Promise<string> {
    const dir = this.path(accountId, options);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** 枚举默认根和自定义根中已经存在的账号目录。 */
  async listKnown(): Promise<string[]> {
    const ids = new Set<string>();
    for (const spec of this.#specs?.() ?? []) {
      if (spec.accountId) ids.add(spec.accountId);
    }
    for (const root of this.accountsRoots()) {
      let names: string[];
      try {
        names = await fs.readdir(root);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        try {
          if ((await fs.stat(path.join(root, name))).isDirectory()) ids.add(name);
        } catch {
          // 目录可能在枚举时被删除
        }
      }
    }
    return [...ids];
  }

  #baseFor(accountId: string): string | undefined {
    for (const spec of this.#specs?.() ?? []) {
      if (spec.accountId === accountId && spec.dataDir) return path.resolve(spec.dataDir);
    }
    return undefined;
  }
}
