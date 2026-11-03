import { randomUUID } from "node:crypto";
import { rolePaths } from "../bootstrap/config.js";
import {
  RoleInitializationError,
  WindowNotFoundError,
} from "../domain/errors.js";
import type { AppStore, RoleInitPayload } from "../storage/app-store.js";
import { RoleStorage } from "../storage/role-storage.js";
import type { RoleRecord, WindowRecord } from "../storage/role-store.js";
import { RoleAccess } from "./role-access.js";

export interface RoleView {
  roleId: string;
  displayName: string;
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

export interface CreateRoleInput {
  displayName: string;
  definition: {
    text: string;
    payload?: Record<string, unknown> | undefined;
  };
  state?: Record<string, unknown> | undefined;
}

export class RoleService {
  private readonly access: RoleAccess;

  constructor(
    private readonly appStore: AppStore,
    private readonly dataRoot: string,
  ) {
    this.access = new RoleAccess(appStore, dataRoot);
  }

  createRole(input: CreateRoleInput): RoleView {
    const roleId = randomUUID();
    const initPayload: RoleInitPayload = {
      displayName: input.displayName,
      definition: {
        text: input.definition.text,
        payload: input.definition.payload ?? {},
      },
      state: input.state ?? {},
    };
    this.appStore.createRoleIndex({
      roleId,
      relativeDir: `roles/${roleId}`,
      initPayload,
    });

    let storage: RoleStorage | undefined;
    try {
      storage = new RoleStorage(rolePaths(this.dataRoot, roleId));
      const created = storage.business.createRoleRecord({
        roleId,
        displayName: initPayload.displayName,
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

  initializeRole(roleId: string): RoleView {
    const index = this.access.getIndex(roleId);
    if (index.initStatus === "ready") {
      return this.getRole(roleId);
    }
    if (!index.initPayload) {
      throw new RoleInitializationError(roleId, index.initStatus);
    }

    let storage: RoleStorage | undefined;
    try {
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
          displayName: index.initPayload.displayName,
          definitionText: index.initPayload.definition.text,
          definitionPayload: index.initPayload.definition.payload,
          initialState: index.initPayload.state,
        });
        role = created.role;
        window = created.window;
      }
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
    displayName: role.displayName,
    definition: role.definition,
    definitionRevision: role.definitionRevision,
    defaultWindowId: window.windowId,
    stateVersion: role.stateVersion,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}
