import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  SECRET_KEY_VERSION,
  type SecretCipher,
} from "../security/secret-cipher.js";

export type StoredSecret =
  | {
      status: "stored";
      value: string;
      updatedAt: string;
      fingerprint: string;
    }
  | { status: "unavailable"; updatedAt: string; fingerprint: string }
  | { status: "missing" };

interface SecretRow {
  ciphertext: string;
  key_version: number;
  created_at: string;
  updated_at: string;
}

/**
 * 模型服务密钥存储。只提供写入、读取解密结果和清除，
 * 不向调用方暴露密文，避免配置接口误回传。
 */
export class SecretStore {
  constructor(
    private readonly db: Database.Database,
    private readonly cipher: SecretCipher,
  ) {}

  get(resourceId: string): StoredSecret {
    const row = this.db
      .prepare(
        "SELECT ciphertext, key_version, created_at, updated_at FROM resource_secrets WHERE resource_id = ?",
      )
      .get(resourceId) as SecretRow | undefined;
    if (row === undefined) {
      return { status: "missing" };
    }
    const fingerprint = fingerprintOfCiphertext(row.ciphertext);
    const value = this.cipher.decrypt(row.ciphertext);
    if (value === null) {
      return { status: "unavailable", updatedAt: row.updated_at, fingerprint };
    }
    return {
      status: "stored",
      value,
      updatedAt: row.updated_at,
      fingerprint,
    };
  }

  set(resourceId: string, value: string, now: string): void {
    const ciphertext = this.cipher.encrypt(value);
    this.db
      .prepare(
        `INSERT INTO resource_secrets
           (resource_id, ciphertext, key_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(resource_id) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           key_version = excluded.key_version,
           updated_at = excluded.updated_at`,
      )
      .run(resourceId, ciphertext, SECRET_KEY_VERSION, now, now);
  }

  clear(resourceId: string): void {
    this.db
      .prepare("DELETE FROM resource_secrets WHERE resource_id = ?")
      .run(resourceId);
  }
}

/**
 * 用密文摘要作为版本标识：每次写入 IV 都不同，即使同一毫秒替换也能让
 * 旧的连接测试结果过期，同时不暴露任何明文信息。
 */
function fingerprintOfCiphertext(ciphertext: string): string {
  return createHash("sha256").update(ciphertext).digest("hex").slice(0, 16);
}
