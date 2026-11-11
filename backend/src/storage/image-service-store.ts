import type Database from "better-sqlite3";
import { ImageServiceNotFoundError } from "../domain/errors.js";
import type {
  ImageServiceConfig,
  ImageServiceRecord,
} from "../domain/image-service.js";

interface ImageServiceRow {
  service_id: string;
  name: string;
  enabled: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * 全局生图服务连接。ComfyUI 通常只有一个地址，模型差异放在角色配置里，
 * 所以这里只存连接本身，不存任何模型参数。
 */
export class ImageServiceStore {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    serviceId: string;
    name: string;
    enabled: boolean;
    config: ImageServiceConfig;
    now: string;
  }): ImageServiceRecord {
    this.db
      .prepare(
        `INSERT INTO image_services
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

  get(serviceId: string): ImageServiceRecord {
    const record = this.find(serviceId);
    if (record === null) {
      throw new ImageServiceNotFoundError(serviceId);
    }
    return record;
  }

  find(serviceId: string): ImageServiceRecord | null {
    const row = this.db
      .prepare(
        `SELECT service_id, name, enabled, config_json, created_at, updated_at
           FROM image_services WHERE service_id = ?`,
      )
      .get(serviceId) as ImageServiceRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  list(): ImageServiceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT service_id, name, enabled, config_json, created_at, updated_at
           FROM image_services ORDER BY created_at ASC, service_id ASC`,
      )
      .all() as ImageServiceRow[];
    return rows.map(mapRow);
  }

  update(input: {
    serviceId: string;
    name?: string;
    enabled?: boolean;
    config?: ImageServiceConfig;
    now: string;
  }): ImageServiceRecord {
    const current = this.get(input.serviceId);
    this.db
      .prepare(
        `UPDATE image_services
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
      .prepare("DELETE FROM image_services WHERE service_id = ?")
      .run(serviceId);
    return result.changes > 0;
  }
}

function mapRow(row: ImageServiceRow): ImageServiceRecord {
  return {
    serviceId: row.service_id,
    name: row.name,
    enabled: row.enabled === 1,
    config: JSON.parse(row.config_json) as ImageServiceConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
