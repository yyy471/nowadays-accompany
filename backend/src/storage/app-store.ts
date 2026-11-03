import {
  ResourceNotFoundError,
  RoleNotFoundError,
} from "../domain/errors.js";
import type { ResourceKind } from "../domain/resource.js";
import type Database from "better-sqlite3";
import { openAppDatabase } from "./schema.js";

export type RoleInitStatus = "initializing" | "ready" | "failed";

export interface RoleInitPayload {
  displayName: string;
  definition: {
    text: string;
    payload: Record<string, unknown>;
  };
  state: Record<string, unknown>;
}

export interface RoleIndexRecord {
  roleId: string;
  relativeDir: string;
  initStatus: RoleInitStatus;
  initError: string | null;
  initPayload: RoleInitPayload | null;
  createdAt: string;
  updatedAt: string;
}

interface RoleIndexRow {
  role_id: string;
  relative_dir: string;
  init_status: RoleInitStatus;
  init_error: string | null;
  init_payload_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResourceRecord {
  resourceId: string;
  kind: ResourceKind;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ResourceRow {
  resource_id: string;
  kind: ResourceKind;
  name: string;
  enabled: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export class AppStore {
  readonly db: Database.Database;
  readonly path: string;
  readonly schemaVersion: number;

  constructor(dbPath: string) {
    const opened = openAppDatabase(dbPath);
    this.db = opened.db;
    this.path = opened.path;
    this.schemaVersion = opened.schemaVersion;
  }

  createRoleIndex(input: {
    roleId: string;
    relativeDir: string;
    initPayload: RoleInitPayload;
  }): RoleIndexRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO roles (role_id, relative_dir, init_status, init_error, init_payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.roleId,
        input.relativeDir,
        "initializing",
        null,
        JSON.stringify(input.initPayload),
        now,
        now,
      );
    return {
      roleId: input.roleId,
      relativeDir: input.relativeDir,
      initStatus: "initializing",
      initError: null,
      initPayload: input.initPayload,
      createdAt: now,
      updatedAt: now,
    };
  }

  getRoleIndex(roleId: string): RoleIndexRecord | null {
    const row = this.db
      .prepare(
        "SELECT role_id, relative_dir, init_status, init_error, init_payload_json, created_at, updated_at FROM roles WHERE role_id = ?",
      )
      .get(roleId) as RoleIndexRow | undefined;
    return row ? mapRoleIndex(row) : null;
  }

  markRoleReady(roleId: string): void {
    const result = this.db
      .prepare(
        "UPDATE roles SET init_status = ?, init_error = NULL, init_payload_json = NULL, updated_at = ? WHERE role_id = ?",
      )
      .run("ready", new Date().toISOString(), roleId);
    if (result.changes !== 1) {
      throw new RoleNotFoundError(roleId);
    }
  }

  markRoleFailed(roleId: string, message: string): void {
    const result = this.db
      .prepare(
        "UPDATE roles SET init_status = ?, init_error = ?, updated_at = ? WHERE role_id = ?",
      )
      .run("failed", message, new Date().toISOString(), roleId);
    if (result.changes !== 1) {
      throw new RoleNotFoundError(roleId);
    }
  }

  createResource(input: {
    resourceId: string;
    kind: ResourceKind;
    name: string;
    enabled: boolean;
    config: Record<string, unknown>;
  }): ResourceRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO resources (resource_id, kind, name, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.resourceId,
        input.kind,
        input.name,
        input.enabled ? 1 : 0,
        JSON.stringify(input.config),
        now,
        now,
      );
    return this.getResource(input.resourceId);
  }

  getResource(resourceId: string): ResourceRecord {
    const row = this.db
      .prepare(
        "SELECT resource_id, kind, name, enabled, config_json, created_at, updated_at FROM resources WHERE resource_id = ?",
      )
      .get(resourceId) as ResourceRow | undefined;
    if (!row) {
      throw new ResourceNotFoundError(resourceId);
    }
    return mapResource(row);
  }

  listResources(kind?: ResourceKind): ResourceRecord[] {
    const rows = (
      kind === undefined
        ? this.db
            .prepare(
              "SELECT resource_id, kind, name, enabled, config_json, created_at, updated_at FROM resources ORDER BY kind ASC, created_at ASC, resource_id ASC",
            )
            .all()
        : this.db
            .prepare(
              "SELECT resource_id, kind, name, enabled, config_json, created_at, updated_at FROM resources WHERE kind = ? ORDER BY created_at ASC, resource_id ASC",
            )
            .all(kind)
    ) as ResourceRow[];
    return rows.map(mapResource);
  }

  updateResource(input: {
    resourceId: string;
    name?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  }): ResourceRecord {
    const current = this.getResource(input.resourceId);
    this.db
      .prepare(
        "UPDATE resources SET name = ?, enabled = ?, config_json = ?, updated_at = ? WHERE resource_id = ?",
      )
      .run(
        input.name ?? current.name,
        (input.enabled ?? current.enabled) ? 1 : 0,
        JSON.stringify(input.config ?? current.config),
        new Date().toISOString(),
        input.resourceId,
      );
    return this.getResource(input.resourceId);
  }

  close(): void {
    this.db.close();
  }
}

function mapResource(row: ResourceRow): ResourceRecord {
  return {
    resourceId: row.resource_id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled === 1,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoleIndex(row: RoleIndexRow): RoleIndexRecord {
  return {
    roleId: row.role_id,
    relativeDir: row.relative_dir,
    initStatus: row.init_status,
    initError: row.init_error,
    initPayload:
      row.init_payload_json === null
        ? null
        : (JSON.parse(row.init_payload_json) as RoleInitPayload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
