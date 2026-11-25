import { randomUUID } from "node:crypto";
import { rolePaths } from "../../bootstrap/config.js";
import {
  RoleInitializationError,
  WindowNotFoundError,
} from "../../domain/errors.js";
import type { AppStore, RoleInitPayload } from "../../storage/core/app-store.js";
import { RoleStorage } from "../../storage/core/role-storage.js";
import { RoleActivityStore } from "../../storage/role/role-activity-store.js";
import type { RoleRecord, WindowRecord } from "../../storage/role/role-store.js";
import { RoleAccess } from "./role-access.js";
import type { Worldbook } from "../../domain/worldbook.js";
import { readWorldbooks, replaceWorldbooks, readWorldbookUsage } from "../../storage/role/worldbook-store.js";

export interface RoleView {
  roleId: string;
  isBuiltin: boolean;
  builtinKey: string | null;
  displayName: string;
  bio: string;
  definition: {
    text: string;
    payload: Record<string, unknown>;
  };
  definitionRevision: number;
  defaultWindowId: string;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoleListItemView {
  roleId: string;
  isBuiltin: boolean;
  builtinKey: string | null;
  displayName: string;
  bio: string;
  status: "initializing" | "ready" | "failed";
  initError: string | null;
  defaultWindowId: string | null;
  definitionRevision: number | null;
  stateVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleInput {
  displayName: string;
  definition: {
    text: string;
    payload?: Record<string, unknown> | undefined;
  };
  state?: Record<string, unknown> | undefined;
}

export interface CreateRoleInternalOptions {
  builtinKey?: string;
  bioText?: string;
}

export class RoleService {
  private readonly access: RoleAccess;

  constructor(
    private readonly appStore: AppStore,
    private readonly dataRoot: string,
  ) {
    this.access = new RoleAccess(appStore, dataRoot);
  }

  /** 新建角色默认已停止：先完成配置，再由用户显式开始活动（268 §4）。 */
  private markCreatedStopped(roleId: string): void {
    new RoleActivityStore(this.appStore.db).markCreatedStopped(
      roleId,
      new Date().toISOString(),
    );
  }

  getWorldbooks(roleId: string) {
    return this.access.withStore(roleId, storage => readWorldbooks(storage.business.db, roleId));
  }

  putWorldbooks(roleId: string, expectedRevision: number, books: Worldbook[]) {
    return this.access.withStore(roleId, storage => replaceWorldbooks(storage.business.db, roleId, expectedRevision, books));
  }

  getWorldbookUsage(roleId: string, executionId: string) {
    return this.access.withStore(roleId, storage => readWorldbookUsage(storage.business.db, roleId, executionId));
  }

  createRole(
    input: CreateRoleInput,
    internal?: CreateRoleInternalOptions,
  ): RoleView {
    const roleId = randomUUID();
    const initPayload: RoleInitPayload = {
      displayName: input.displayName,
      definition: {
        text: input.definition.text,
        payload: input.definition.payload ?? {},
      },
      state: input.state ?? {},
      ...(internal?.builtinKey === undefined
        ? {}
        : { builtinKey: internal.builtinKey }),
      ...(internal?.bioText === undefined
        ? {}
        : { bioText: internal.bioText }),
    };
    this.appStore.createRoleIndex({
      roleId,
      relativeDir: `roles/${roleId}`,
      ...(internal?.builtinKey === undefined
        ? {}
        : { builtinKey: internal.builtinKey }),
      initPayload,
    });

    let storage: RoleStorage | undefined;
    try {
      this.markCreatedStopped(roleId);
      storage = new RoleStorage(rolePaths(this.dataRoot, roleId));
      const created = storage.business.createRoleRecord({
        roleId,
        ...(initPayload.builtinKey === undefined
          ? {}
          : { builtinKey: initPayload.builtinKey }),
        displayName: initPayload.displayName,
        ...(initPayload.bioText === undefined
          ? {}
          : { bioText: initPayload.bioText }),
        definitionText: initPayload.definition.text,
        definitionPayload: initPayload.definition.payload,
        initialState: initPayload.state,
      });
      storage.close();
      storage = undefined;
      this.appStore.markRoleReady(roleId);
      return toRoleView(created.role, created.window);
    } catch (error) {
      storage?.close();
      this.markFailed(roleId, error);
      throw new RoleInitializationError(roleId, "failed");
    }
  }

  initializeRole(roleId: string, beforeReady?: (storage: RoleStorage) => void): RoleView {
    const index = this.access.getIndex(roleId);
    if (index.initStatus === "ready") {
      return this.getRole(roleId);
    }
    if (!index.initPayload) {
      throw new RoleInitializationError(roleId, index.initStatus);
    }

    let storage: RoleStorage | undefined;
    try {
      this.markCreatedStopped(roleId);
      storage = new RoleStorage(rolePaths(this.dataRoot, roleId));
      let role: RoleRecord;
      let window: WindowRecord;
      if (storage.business.hasRole(roleId)) {
        role = storage.business.getRole(roleId);
        try {
          window = storage.business.getDefaultWindow(roleId);
        } catch (error) {
          if (!(error instanceof WindowNotFoundError)) {
            throw error;
          }
          window = storage.business.createWindow({
            roleId,
            kind: "main",
            source: "nowadays",
          });
        }
      } else {
        const created = storage.business.createRoleRecord({
          roleId,
          ...(index.builtinKey !== null
            ? { builtinKey: index.builtinKey }
            : index.initPayload.builtinKey === undefined
              ? {}
              : { builtinKey: index.initPayload.builtinKey }),
          displayName: index.initPayload.displayName,
          ...(index.initPayload.bioText === undefined
            ? {}
            : { bioText: index.initPayload.bioText }),
          definitionText: index.initPayload.definition.text,
          definitionPayload: index.initPayload.definition.payload,
          initialState: index.initPayload.state,
        });
        role = created.role;
        window = created.window;
      }
      beforeReady?.(storage);
      storage.close();
      storage = undefined;
      this.appStore.markRoleReady(roleId);
      return toRoleView(role, window);
    } catch (error) {
      storage?.close();
      this.markFailed(roleId, error);
      throw new RoleInitializationError(roleId, "failed");
    }
  }

  listRoles(): RoleListItemView[] {
    return this.appStore.listRoleIndexes().map((index) => {
      if (index.initStatus !== "ready") {
        return {
          roleId: index.roleId,
          isBuiltin: index.isBuiltin,
          builtinKey: index.builtinKey,
          displayName: index.initPayload?.displayName ?? index.roleId,
          bio: index.initPayload?.bioText ?? "",
          status: index.initStatus,
          initError: index.initError,
          defaultWindowId: null,
          definitionRevision: null,
          stateVersion: null,
          createdAt: index.createdAt,
          updatedAt: index.updatedAt,
        };
      }
      try {
        return this.access.withStore(index.roleId, (storage) => {
          const role = storage.business.getRole(index.roleId);
          const window = storage.business.getDefaultWindow(index.roleId);
          return {
            roleId: role.roleId,
            isBuiltin: role.isBuiltin || index.isBuiltin,
            builtinKey: role.builtinKey ?? index.builtinKey,
            displayName: role.displayName,
            bio: role.bioText,
            status: "ready" as const,
            initError: null,
            defaultWindowId: window.windowId,
            definitionRevision: role.definitionRevision,
            stateVersion: role.stateVersion,
            createdAt: role.createdAt,
            updatedAt: role.updatedAt,
          };
        });
      } catch (error) {
        return {
          roleId: index.roleId,
          isBuiltin: index.isBuiltin,
          builtinKey: index.builtinKey,
          displayName: index.initPayload?.displayName ?? index.roleId,
          bio: index.initPayload?.bioText ?? "",
          status: "failed" as const,
          initError: error instanceof Error ? error.message : String(error),
          defaultWindowId: null,
          definitionRevision: null,
          stateVersion: null,
          createdAt: index.createdAt,
          updatedAt: index.updatedAt,
        };
      }
    });
  }

  getRole(roleId: string): RoleView {
    return this.access.withStore(roleId, (storage) => {
      const role = storage.business.getRole(roleId);
      const window = storage.business.getDefaultWindow(roleId);
      return toRoleView(role, window);
    });
  }

  updateDefinition(
    roleId: string,
    input: {
      displayName?: string | undefined;
      bio?: string | undefined;
      definition?:
        | {
            text: string;
            payload?: Record<string, unknown> | undefined;
          }
        | undefined;
      expectedRevision?: number | undefined;
    },
  ): { definitionRevision: number; updatedAt: string } {
    return this.access.withStore(roleId, (storage) => {
      const updated = storage.business.updateDefinition({
        roleId,
        ...(input.bio === undefined ? {} : { bioText: input.bio }),
        ...(input.displayName === undefined
          ? {}
          : { displayName: input.displayName }),
        ...(input.definition === undefined
          ? {}
          : { definitionText: input.definition.text }),
        ...(input.definition?.payload === undefined
          ? {}
          : { definitionPayload: input.definition.payload }),
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
      });
      return {
        definitionRevision: updated.definitionRevision,
        updatedAt: updated.updatedAt,
      };
    });
  }

  getState(roleId: string): {
    state: Record<string, unknown>;
    stateVersion: number;
    updatedAt: string;
  } {
    return this.access.withStore(roleId, (storage) =>
      storage.business.getState(roleId),
    );
  }

  setState(
    roleId: string,
    input: {
      state: Record<string, unknown>;
      expectedVersion?: number | undefined;
    },
  ): { stateVersion: number; updatedAt: string } {
    return this.access.withStore(roleId, (storage) =>
      storage.business.setState({
        roleId,
        state: input.state,
        ...(input.expectedVersion === undefined
          ? {}
          : { expectedVersion: input.expectedVersion }),
      }),
    );
  }

  createWindow(
    roleId: string,
    input: { kind: "main" | "custom"; source: string },
  ): WindowRecord {
    return this.access.withStore(roleId, (storage) =>
      storage.business.createWindow({ roleId, ...input }),
    );
  }

  listWindows(roleId: string): WindowRecord[] {
    return this.access.withStore(roleId, (storage) =>
      storage.business.listWindows(roleId),
    );
  }

  private markFailed(roleId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.appStore.markRoleFailed(roleId, message);
    } catch {
      // 保留原始初始化错误；索引更新失败由后续查询暴露。
    }
  }
}

function toRoleView(role: RoleRecord, window: WindowRecord): RoleView {
  return {
    roleId: role.roleId,
    isBuiltin: role.isBuiltin,
    builtinKey: role.builtinKey,
    displayName: role.displayName,
    bio: role.bioText,
    definition: role.definition,
    definitionRevision: role.definitionRevision,
    defaultWindowId: window.windowId,
    stateVersion: role.stateVersion,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}
