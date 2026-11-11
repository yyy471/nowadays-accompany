import { randomUUID } from "node:crypto";
import {
  ResourceNotFoundError,
  RoleNotFoundError,
} from "../domain/errors.js";
import type { ModelProtocol } from "../domain/model.js";
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

export interface ModelTestCallRecord {
  testCallId: string;
  resourceId: string | null;
  modelName: string;
  protocol: ModelProtocol;
  status: "succeeded" | "failed";
  errorCode: string | null;
  configFingerprint: string | null;
  startedAt: string;
  finishedAt: string;
}

interface ModelTestCallRow {
  test_call_id: string;
  resource_id: string | null;
  model_name: string;
  protocol: ModelProtocol;
  status: "succeeded" | "failed";
  error_code: string | null;
  config_fingerprint: string | null;
  started_at: string;
  finished_at: string;
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

  saveModelTestCall(input: {
    resourceId: string | null;
    modelName: string;
    protocol: ModelProtocol;
    status: "succeeded" | "failed";
    errorCode: string | null;
    configFingerprint: string | null;
    startedAt: string;
    finishedAt: string;
    usageJson: string | null;
  }): string {
    const testCallId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO model_test_calls
         (test_call_id, resource_id, model_name, protocol, status, error_code,
          config_fingerprint, started_at, finished_at, usage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        testCallId,
        input.resourceId,
        input.modelName,
        input.protocol,
        input.status,
        input.errorCode,
        input.configFingerprint,
        input.startedAt,
        input.finishedAt,
        input.usageJson,
      );
    return testCallId;
  }

  latestModelTestCall(resourceId: string): ModelTestCallRecord | null {
    const row = this.db
      .prepare(
        `SELECT test_call_id, resource_id, model_name, protocol, status,
                error_code, config_fingerprint, started_at, finished_at
           FROM model_test_calls
          WHERE resource_id = ?
          ORDER BY finished_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(resourceId) as ModelTestCallRow | undefined;
    return row === undefined ? null : mapModelTestCall(row);
  }

  deleteModelTestCalls(resourceId: string): number {
    return this.db
      .prepare("DELETE FROM model_test_calls WHERE resource_id = ?")
      .run(resourceId).changes;
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

  listRoleIndexes(): RoleIndexRecord[] {
    const rows = this.db
      .prepare(
        "SELECT role_id, relative_dir, init_status, init_error, init_payload_json, created_at, updated_at FROM roles ORDER BY created_at ASC, role_id ASC",
      )
      .all() as RoleIndexRow[];
    return rows.map(mapRoleIndex);
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

  /**
   * 删除全局资源及其测试记录。引用检查由 ResourceService 在调用前完成；
   * 这里只保证资源不存在时给出 404，而不是静默成功。
   */
  deleteResource(resourceId: string): void {
    this.db.transaction(() => {
      this.getResource(resourceId);
      this.db
        .prepare("DELETE FROM model_test_calls WHERE resource_id = ?")
        .run(resourceId);
      this.db
        .prepare("DELETE FROM resources WHERE resource_id = ?")
        .run(resourceId);
    })();
  }

  /**
   * 待清理的已删除资源（RP-R05）。与资源删除放在同一事务里写入：决策提交
   * 成功后，即使后续角色库清理中断，也能靠这条记录在启动恢复或重试时继续
   * 清理残留绑定；读侧也据此过滤尚未物理删除的绑定。
   */
  recordResourceDeletion(resourceId: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO resource_deletions (resource_id, created_at)
         VALUES (?, ?)
         ON CONFLICT(resource_id) DO NOTHING`,
      )
      .run(resourceId, at);
  }

  listResourceDeletions(): string[] {
    const rows = this.db
      .prepare(
        `SELECT resource_id FROM resource_deletions
          ORDER BY created_at, resource_id`,
      )
      .all() as Array<{ resource_id: string }>;
    return rows.map((row) => row.resource_id);
  }

  isResourceDeletionPending(resourceId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM resource_deletions WHERE resource_id = ?")
      .get(resourceId) as { present: number } | undefined;
    return row !== undefined;
  }

  clearResourceDeletion(resourceId: string): void {
    this.db
      .prepare("DELETE FROM resource_deletions WHERE resource_id = ?")
      .run(resourceId);
  }

  /**
   * 移除角色索引与其活动记录。两条删除路径都从管理列表移除角色；
   * role_activity 有外键指向 roles，必须先删。
   */
  deleteRole(roleId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM role_activity WHERE role_id = ?")
        .run(roleId);
      this.db.prepare("DELETE FROM roles WHERE role_id = ?").run(roleId);
    })();
  }

  /**
   * 已接受但角色目录尚未删除的清理记录（DL-148）。与移除角色放在同一
   * 事务里写入，目录删除失败或进程中断时由启动恢复与删除重试继续。
   */
  recordRoleDeletion(roleId: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO role_deletions (role_id, created_at)
         VALUES (?, ?)
         ON CONFLICT(role_id) DO NOTHING`,
      )
      .run(roleId, at);
  }

  listRoleDeletions(): string[] {
    const rows = this.db
      .prepare(
        "SELECT role_id FROM role_deletions ORDER BY created_at, role_id",
      )
      .all() as Array<{ role_id: string }>;
    return rows.map((row) => row.role_id);
  }

  isRoleDeletionPending(roleId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM role_deletions WHERE role_id = ?")
      .get(roleId) as { present: number } | undefined;
    return row !== undefined;
  }

  clearRoleDeletion(roleId: string): void {
    this.db
      .prepare("DELETE FROM role_deletions WHERE role_id = ?")
      .run(roleId);
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

function mapModelTestCall(row: ModelTestCallRow): ModelTestCallRecord {
  return {
    testCallId: row.test_call_id,
    resourceId: row.resource_id,
    modelName: row.model_name,
    protocol: row.protocol,
    status: row.status,
    errorCode: row.error_code,
    configFingerprint: row.config_fingerprint,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
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
