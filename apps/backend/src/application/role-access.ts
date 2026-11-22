import { rolePaths } from "../bootstrap/config.js";
import {
  AppError,
  InvalidRoleIdError,
  RoleNotFoundError,
  RoleNotReadyError,
  StorageError,
} from "../domain/errors.js";
import type { AppStore, RoleIndexRecord } from "../storage/app-store.js";
import { RoleStorage } from "../storage/role-storage.js";

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

  withStore<T>(
    roleId: string,
    action: (storage: RoleStorage) => T,
  ): T {
    this.requireReady(roleId);
    let storage: RoleStorage;
    try {
      storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId));
    } catch (error) {
      throw toStorageError(error);
    }
    try {
      return action(storage);
    } finally {
      storage.close();
    }
  }

  async withStoreAsync<T>(
    roleId: string,
    action: (storage: RoleStorage) => Promise<T>,
  ): Promise<T> {
    this.requireReady(roleId);
    let storage: RoleStorage;
    try {
      storage = RoleStorage.openExisting(rolePaths(this.dataRoot, roleId));
    } catch (error) {
      throw toStorageError(error);
    }
    try {
      return await action(storage);
    } finally {
      storage.close();
    }
  }

  /**
   * 一次性打开多个角色的业务库，供删除资源前的预检（RP-R03）：
   * 任一库打不开时先关闭已打开的句柄再报错，调用方可在改动任何绑定之前终止。
   * 返回的句柄由调用方负责关闭。
   */
  openReadyStores(roleIds: Iterable<string>): RoleStorage[] {
    const opened: RoleStorage[] = [];
    try {
      for (const roleId of roleIds) {
        this.requireReady(roleId);
        try {
          opened.push(RoleStorage.openExisting(rolePaths(this.dataRoot, roleId)));
        } catch (error) {
          throw toStorageError(error);
        }
      }
      return opened;
    } catch (error) {
      for (const storage of opened) storage.close();
      throw error;
    }
  }
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
