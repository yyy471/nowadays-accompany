import type Database from "better-sqlite3";
import { VoiceServiceNotFoundError } from "../../domain/errors.js";
import type {
  VoiceServiceConfig,
  VoiceServiceRecord,
} from "../../domain/voice-service.js";

interface VoiceServiceRow {
  service_id: string;
  name: string;
  enabled: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * 全局语音服务目录（App 库）。统一维护服务地址、协议与可选默认引擎，
 * 角色配置只引用 serviceId 并管理各自音色与试听（DL-152）。
 */
export class VoiceServiceStore {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    serviceId: string;
    name: string;
    enabled: boolean;
    config: VoiceServiceConfig;
    now: string;
  }): VoiceServiceRecord {
    this.db
      .prepare(
        `INSERT INTO voice_services
           (service_id, name, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.serviceId,
        input.name,
        input.enabled ? 1 : 0,
        JSON.stringify(input.config),
        input.now,
        input.now,
      );
    return this.get(input.serviceId);
  }

  get(serviceId: string): VoiceServiceRecord {
    const record = this.find(serviceId);
    if (record === null) {
      throw new VoiceServiceNotFoundError(serviceId);
    }
    return record;
  }

  find(serviceId: string): VoiceServiceRecord | null {
    const row = this.db
      .prepare(
        `SELECT service_id, name, enabled, config_json, created_at, updated_at
           FROM voice_services WHERE service_id = ?`,
      )
      .get(serviceId) as VoiceServiceRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  findByEndpoint(
    protocol: VoiceServiceConfig["protocol"],
    baseUrl: string,
  ): VoiceServiceRecord | null {
    const existing = this.list().find(
      (item) =>
        item.config.protocol === protocol && item.config.baseUrl === baseUrl,
    );
    return existing ?? null;
  }

  list(): VoiceServiceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT service_id, name, enabled, config_json, created_at, updated_at
           FROM voice_services ORDER BY created_at ASC, service_id ASC`,
      )
      .all() as VoiceServiceRow[];
    return rows.map(mapRow);
  }

  update(input: {
    serviceId: string;
    name?: string;
    enabled?: boolean;
    config?: VoiceServiceConfig;
    now: string;
  }): VoiceServiceRecord {
    const current = this.get(input.serviceId);
    this.db
      .prepare(
        `UPDATE voice_services
            SET name = ?, enabled = ?, config_json = ?, updated_at = ?
          WHERE service_id = ?`,
      )
      .run(
        input.name ?? current.name,
        (input.enabled ?? current.enabled) ? 1 : 0,
        JSON.stringify(input.config ?? current.config),
        input.now,
        input.serviceId,
      );
    return this.get(input.serviceId);
  }

  delete(serviceId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM voice_services WHERE service_id = ?")
      .run(serviceId);
    return result.changes > 0;
  }
}

function mapRow(row: VoiceServiceRow): VoiceServiceRecord {
  return {
    serviceId: row.service_id,
    name: row.name,
    enabled: row.enabled === 1,
    config: JSON.parse(row.config_json) as VoiceServiceConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
