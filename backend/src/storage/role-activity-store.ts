import type Database from "better-sqlite3";
import type {
  RoleActivityRecord,
  RoleActivityState,
} from "../domain/role-activity.js";

interface ActivityRow {
  role_id: string;
  state: RoleActivityState;
  requested_at: string | null;
  confirmed_at: string | null;
  boundary_execution_id: string | null;
  updated_at: string | null;
}

function toRecord(row: ActivityRow | undefined, roleId: string): RoleActivityRecord {
  return {
    roleId,
    state: row?.state ?? "active",
    requestedAt: row?.requested_at ?? null,
    confirmedAt: row?.confirmed_at ?? null,
    boundaryExecutionId: row?.boundary_execution_id ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/** 活动状态放在 app 库：全局模型服务的写入需要一次查完所有角色。 */
export class RoleActivityStore {
  constructor(private readonly db: Database.Database) {}

  get(roleId: string): RoleActivityRecord {
    const row = this.db
      .prepare(
        `SELECT role_id, state, requested_at, confirmed_at,
                boundary_execution_id, updated_at
           FROM role_activity WHERE role_id = ?`,
      )
      .get(roleId) as ActivityRow | undefined;
    return toRecord(row, roleId);
  }

  /** 按 app 库 roles 表左连接，保证尚未产生活动记录的角色也出现在保护范围里。 */
  listAll(): RoleActivityRecord[] {
    const rows = this.db
      .prepare(
        `SELECT r.role_id AS role_id,
                a.state AS state,
                a.requested_at AS requested_at,
                a.confirmed_at AS confirmed_at,
                a.boundary_execution_id AS boundary_execution_id,
                a.updated_at AS updated_at
           FROM roles r
           LEFT JOIN role_activity a ON a.role_id = r.role_id
          ORDER BY r.created_at, r.role_id`,
      )
      .all() as ActivityRow[];
    return rows.map((row) => toRecord(row, row.role_id));
  }

  requestStop(roleId: string, at: string): RoleActivityRecord {
    this.db
      .prepare(
        `INSERT INTO role_activity
           (role_id, state, requested_at, confirmed_at, boundary_execution_id, updated_at)
         VALUES (?, 'stopping', ?, NULL, NULL, ?)
         ON CONFLICT(role_id) DO UPDATE SET
           state = 'stopping',
           requested_at = excluded.requested_at,
           confirmed_at = NULL,
           boundary_execution_id = NULL,
           updated_at = excluded.updated_at
         WHERE role_activity.state <> 'stopped'`,
      )
      .run(roleId, at, at);
    return this.get(roleId);
  }

  /** 只有仍在 stopping 的记录会被确认，避免覆盖之后发生的恢复。 */
  confirmStop(
    roleId: string,
    boundaryExecutionId: string | null,
    at: string,
  ): RoleActivityRecord {
    this.db
      .prepare(
        `INSERT INTO role_activity
           (role_id, state, requested_at, confirmed_at, boundary_execution_id, updated_at)
         VALUES (?, 'stopped', NULL, ?, ?, ?)
         ON CONFLICT(role_id) DO UPDATE SET
           state = 'stopped',
           confirmed_at = excluded.confirmed_at,
           boundary_execution_id = excluded.boundary_execution_id,
           updated_at = excluded.updated_at
         WHERE role_activity.state = 'stopping'`,
      )
      .run(roleId, at, boundaryExecutionId, at);
    return this.get(roleId);
  }

  activate(roleId: string, at: string): RoleActivityRecord {
    this.db
      .prepare(
        `INSERT INTO role_activity
           (role_id, state, requested_at, confirmed_at, boundary_execution_id, updated_at)
         VALUES (?, 'active', NULL, NULL, NULL, ?)
         ON CONFLICT(role_id) DO UPDATE SET
           state = 'active',
           requested_at = NULL,
           confirmed_at = NULL,
           boundary_execution_id = NULL,
           updated_at = excluded.updated_at
         WHERE role_activity.state = 'stopped'`,
      )
      .run(roleId, at);
    return this.get(roleId);
  }
}
