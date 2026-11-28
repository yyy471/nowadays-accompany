import { rolePaths } from "../../bootstrap/config.js";
import {
  AppError,
  InvalidRoleIdError,
  RoleNotFoundError,
  RoleNotReadyError,
  StorageError,
} from "../../domain/errors.js";
import type { AppStore, RoleIndexRecord } from "../../storage/core/app-store.js";
import { RoleStorage } from "../../storage/core/role-storage.js";

export interface RoleStorageLease { storage: RoleStorage; release(): void }
interface PoolEntry {
  storage: RoleStorage;
  refs: number;
  timer?: NodeJS.Timeout;
  drain?: { promise: Promise<void>; resolve: () => void };
  stale?: boolean;
}

export class RoleAccess {
  constructor(
    private readonly appStore: AppStore,
    private readonly dataRoot: string,
  ) {}

  getIndex(roleId: string): RoleIndexRecord {
    assertRoleId(roleId);
    const index = this.appStore.getRoleIndex(roleId);
    if (!index) {
      throw new RoleNotFoundError(roleId);
    }
    return index;
  }

  requireReady(roleId: string): RoleIndexRecord {
    const index = this.getIndex(roleId);
    if (index.initStatus !== "ready") {
      throw new RoleNotReadyError(roleId, index.initStatus);
    }
    return index;
  }

  private readonly entries = new Map<string, PoolEntry>();
  private readonly blocked = new Set<string>();
  private closing = false;

  borrow(roleId: string): RoleStorageLease {
    this.requireReady(roleId);
    if (this.closing || this.blocked.has(roleId)) throw new StorageError("\u89d2\u8272\u5b58\u50a8\u4e0d\u53ef\u7528", { reason: "ROLE_STORAGE_BLOCKED" });
    let entry = this.entries.get(roleId);
    if (entry && !entry.drain && !entry.storage.isHealthy) {
      if (entry.timer) { clearTimeout(entry.timer); delete entry.timer; }
      this.entries.delete(roleId);
      if (entry.refs === 0) {
        try { entry.storage.close(); } catch { /* ignore */ }
      } else {
        entry.stale = true;
      }
      entry = undefined;
    }
    if (!entry) {
      let storage: RoleStorage;
      try { storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId)); }
      catch (error) { throw toStorageError(error); }
      entry = { storage, refs: 0 };
      this.entries.set(roleId, entry);
    }
    if (entry.drain) throw new StorageError("\u89d2\u8272\u5b58\u50a8\u4e0d\u53ef\u7528", { reason: "ROLE_STORAGE_BLOCKED" });
    if (entry.timer) { clearTimeout(entry.timer); delete entry.timer; }
    entry.refs++;
    const current = entry;
    let released = false;
    return { storage: current.storage, release: () => {
      if (released) return;
      released = true;
      current.refs--;
      if (current.refs === 0) {
        if (current.drain) {
          if (this.entries.get(roleId) === current) this.entries.delete(roleId);
          try { current.storage.close(); } catch { /* ignore */ }
          current.drain.resolve();
        } else if (current.stale) {
          try { current.storage.close(); } catch { /* ignore */ }
        } else if (!this.closing && !this.blocked.has(roleId)) {
          current.timer = setTimeout(() => {
            if (this.entries.get(roleId) === current) this.entries.delete(roleId);
            current.storage.close();
          }, 60_000);
          current.timer.unref();
        }
      }
    }};
  }

  withStore<T>(roleId: string, action: (storage: RoleStorage) => T): T {
    const lease = this.borrow(roleId);
    let fatal = false;
    try { return action(lease.storage); }
    catch (error) { fatal = isFatalSqliteError(error); throw error; }
    finally { lease.release(); if (fatal) void this.evict(roleId); }
  }

  async withStoreAsync<T>(roleId: string, action: (storage: RoleStorage) => Promise<T>): Promise<T> {
    const lease = this.borrow(roleId);
    let fatal = false;
    try { return await action(lease.storage); }
    catch (error) { fatal = isFatalSqliteError(error); throw error; }
    finally { lease.release(); if (fatal) void this.evict(roleId); }
  }

  withReadyStores<T>(roleIds: Iterable<string>, action: (stores: RoleStorage[]) => T): T {
    const leases: RoleStorageLease[] = [];
    try {
      for (const roleId of roleIds) leases.push(this.borrow(roleId));
      return action(leases.map(lease => lease.storage));
    } finally { for (const lease of leases) lease.release(); }
  }

  evict(roleId: string): void | Promise<void> {
    const entry = this.entries.get(roleId);
    if (!entry) return;
    if (entry.drain) return entry.drain.promise;
    if (entry.timer) { clearTimeout(entry.timer); delete entry.timer; }
    if (entry.refs === 0) {
      this.entries.delete(roleId);
      try { entry.storage.close(); } catch { /* ignore */ }
      return;
    }
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    entry.drain = { promise, resolve };
    return promise;
  }

  async blockAndEvict(roleId: string): Promise<void> {
    this.blocked.add(roleId);
    await this.evict(roleId);
  }

  unblock(roleId: string): void { this.blocked.delete(roleId); }

  closeAll(): void | Promise<void> {
    this.closing = true;
    const drains: Promise<void>[] = [];
    for (const roleId of this.entries.keys()) {
      const drain = this.evict(roleId);
      if (drain) drains.push(drain);
    }
    if (drains.length) return Promise.all(drains).then(() => undefined);
  }



}

function isFatalSqliteError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^SQLITE_(?:IOERR|CORRUPT|NOTADB|CANTOPEN|READONLY_DBMOVED)/.test(code)) {
    return true;
  }
  return error instanceof Error &&
    /database connection is not open|ROLE_STORAGE_CLOSED|SQLITE_IOERR|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(error.message);
}

function toStorageError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  const raw = error instanceof Error ? error.message : "";
  const separator = raw.indexOf(":");
  const reason = (separator < 0 ? raw : raw.slice(0, separator)) || "UNKNOWN";
  const part = separator < 0 ? undefined : raw.slice(separator + 1);
  return new StorageError(
    "角色存储不可用",
    part === undefined ? { reason } : { reason, part },
  );
}

function assertRoleId(roleId: string): void {
  try {
    rolePaths("data", roleId);
  } catch {
    throw new InvalidRoleIdError();
  }
}
