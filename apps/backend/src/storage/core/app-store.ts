import { isAdminSeat } from "../../domain/admin-seat.js";
import { randomUUID } from "node:crypto";
import {
  ResourceNotFoundError,
  RoleNotFoundError,
} from "../../domain/errors.js";
import type { ModelProtocol } from "../../domain/model.js";
import type { ResourceKind } from "../../domain/resource.js";
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
  builtinKey?: string | null;
  bioText?: string;
}

export interface RoleIndexRecord {
  roleId: string;
  relativeDir: string;
  builtinKey: string | null;
  isBuiltin: boolean;
  initStatus: RoleInitStatus;
  initError: string | null;
  initPayload: RoleInitPayload | null;
  createdAt: string;
  updatedAt: string;
}

interface RoleIndexRow {
  role_id: string;
  relative_dir: string;
  builtin_key: string | null;
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

  latestModelTestCall(resourceId: string, model?: string): ModelTestCallRecord | null {
    const row = this.db
      .prepare(
        `SELECT test_call_id, resource_id, model_name, protocol, status,
                error_code, config_fingerprint, started_at, finished_at
           FROM model_test_calls
          WHERE resource_id = ? AND (? IS NULL OR model_name = ?)
          ORDER BY finished_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(resourceId, model ?? null, model ?? null) as ModelTestCallRow | undefined;
    return row === undefined ? null : mapModelTestCall(row);
  }

  saveVertexTestRoute(testCallId: string, fingerprint: string, baseUrl: string): void {
    this.db.prepare("INSERT INTO vertex_test_routes (test_call_id, route_fingerprint, base_url) VALUES (?, ?, ?)")
      .run(testCallId, fingerprint, baseUrl);
  }

  verifiedVertexBase(resourceId: string, model: string, fingerprint: string): string | undefined {
    const row = this.db.prepare(`SELECT r.base_url FROM model_test_calls t JOIN vertex_test_routes r USING (test_call_id)
      WHERE t.resource_id = ? AND t.model_name = ? AND r.route_fingerprint = ? AND t.status = 'succeeded'
      ORDER BY t.finished_at DESC, t.rowid DESC LIMIT 1`).get(resourceId, model, fingerprint) as { base_url: string } | undefined;
    return row?.base_url;
  }

  getModelTestCall(testCallId: string): ModelTestCallRecord | null {
    const row = this.db
      .prepare(
        `SELECT test_call_id, resource_id, model_name, protocol, status,
                error_code, config_fingerprint, started_at, finished_at
           FROM model_test_calls
          WHERE test_call_id = ?`,
      )
      .get(testCallId) as ModelTestCallRow | undefined;
    return row === undefined ? null : mapModelTestCall(row);
  }

  /** 将未归属服务的草稿连接测试安全关联到刚保存/更新的资源（308 §4.5）。 */
  attachModelTestCall(input: {
    testCallId: string;
    resourceId: string;
    nextFingerprint: string;
    routeFingerprint?: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE model_test_calls
            SET resource_id = ?, config_fingerprint = ?
          WHERE test_call_id = ? AND resource_id IS NULL`,
      )
      .run(input.resourceId, input.nextFingerprint, input.testCallId);
    if (result.changes && input.routeFingerprint) {
      this.db.prepare("UPDATE vertex_test_routes SET route_fingerprint = ? WHERE test_call_id = ?")
        .run(input.routeFingerprint, input.testCallId);
    }
    return result.changes > 0;
  }

  deleteModelTestCalls(resourceId: string): number {
    return this.db
      .prepare("DELETE FROM model_test_calls WHERE resource_id = ?")
      .run(resourceId).changes;
  }

  createRoleIndex(input: {
    roleId: string;
    relativeDir: string;
    builtinKey?: string | null;
    initPayload: RoleInitPayload;
  }): RoleIndexRecord {
    const now = new Date().toISOString();
    const builtinKey = input.builtinKey ?? input.initPayload.builtinKey ?? null;
    this.db
      .prepare(
        "INSERT INTO roles (role_id, relative_dir, builtin_key, init_status, init_error, init_payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.roleId,
        input.relativeDir,
        builtinKey,
        "initializing",
        null,
        JSON.stringify(input.initPayload),
        now,
        now,
      );
    return {
      roleId: input.roleId,
      relativeDir: input.relativeDir,
      builtinKey,
      isBuiltin: isAdminSeat(builtinKey),
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
        "SELECT role_id, relative_dir, builtin_key, init_status, init_error, init_payload_json, created_at, updated_at FROM roles WHERE role_id = ?",
      )
      .get(roleId) as RoleIndexRow | undefined;
    return row ? mapRoleIndex(row) : null;
  }

  /** 按系统内置角色标识查找（如 "xiacheng"）；找不到返回 null。 */
  getRoleIndexByBuiltinKey(builtinKey: string): RoleIndexRecord | null {
    const row = this.db
      .prepare(
        "SELECT role_id, relative_dir, builtin_key, init_status, init_error, init_payload_json, created_at, updated_at FROM roles WHERE builtin_key = ?",
      )
      .get(builtinKey) as RoleIndexRow | undefined;
    return row ? mapRoleIndex(row) : null;
  }

  listRoleIndexes(): RoleIndexRecord[] {
    const rows = this.db
      .prepare(
        "SELECT role_id, relative_dir, builtin_key, init_status, init_error, init_payload_json, created_at, updated_at FROM roles ORDER BY created_at ASC, role_id ASC",
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

  /** 全局库的通用键值元数据（如投影回填版本标记）。 */
  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM app_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /**
   * 维护角色媒体依赖投影。服务为空时删除该角色的这一类绑定，
   * 保证投影与角色库中的 service_id 同步。
   */
  setRoleMediaBinding(
    roleId: string,
    kind: "voice" | "image",
    serviceId: string | null,
    now = new Date().toISOString(),
  ): void {
    if (!serviceId) {
      this.db
        .prepare("DELETE FROM role_media_bindings WHERE role_id = ? AND kind = ?")
        .run(roleId, kind);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO role_media_bindings (role_id, kind, service_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(role_id, kind) DO UPDATE SET
           service_id = excluded.service_id,
           updated_at = excluded.updated_at`,
      )
      .run(roleId, kind, serviceId, now);
  }

  /** 依赖指定媒体服务的已就绪角色：单条索引查询，不打开角色业务库。 */
  listRoleIdsByMediaService(
    kind: "voice" | "image",
    serviceId: string,
  ): string[] {
    const rows = this.db
      .prepare(
        `SELECT b.role_id
           FROM role_media_bindings b
           JOIN roles r ON r.role_id = b.role_id
          WHERE b.kind = ? AND b.service_id = ? AND r.init_status = 'ready'
          ORDER BY b.role_id`,
      )
      .all(kind, serviceId) as Array<{ role_id: string }>;
    return rows.map((row) => row.role_id);
  }

  /** 单个角色当前绑定的媒体服务：直接查投影，零角色库打开。 */
  listRoleMediaBindings(
    roleId: string,
  ): Array<{ kind: "voice" | "image"; serviceId: string }> {
    const rows = this.db
      .prepare(
        "SELECT kind, service_id FROM role_media_bindings WHERE role_id = ? ORDER BY kind",
      )
      .all(roleId) as Array<{ kind: "voice" | "image"; service_id: string }>;
    return rows.map((row) => ({ kind: row.kind, serviceId: row.service_id }));
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
    builtinKey: row.builtin_key,
    isBuiltin: isAdminSeat(row.builtin_key),
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
