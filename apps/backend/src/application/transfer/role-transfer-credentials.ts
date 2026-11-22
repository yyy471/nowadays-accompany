import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { BackendConfig } from "../../bootstrap/config.js";
import { resolveCredential } from "../../model/credentials.js";
import { SecretCipher } from "../../security/secret-cipher.js";
import { canonicalJson, sha256, TRANSFER_TABLES, type TransferTables } from "./role-transfer-data.js";

const REMOVED = "[credential removed]";
const CREDENTIAL_FIELDS = new Set([
  "authorization", "proxyauthorization", "xapikey", "xgoogapikey", "apikey", "accesstoken",
  "refreshtoken", "idtoken", "bearertoken", "token", "clientsecret", "secret", "password", "passwd",
  "privatekey", "masterkey", "credential", "credentials", "credentialref", "cookie", "setcookie",
  "secretkey", "accesskey", "accesskeyid", "secretaccesskey", "sessiontoken", "connectionstring",
]);
const FIELD_PATTERN = String.raw`(?:proxy[-_ ]?authorization|authorization|x[-_ ]?(?:goog[-_ ]?)?api[-_ ]?key|api[-_ ]?key|(?:access|refresh|id|bearer|session)[-_ ]?token|token|(?:client|access)[-_ ]?secret|secret(?:[-_ ]?key)?|passw(?:or)?d|(?:private|master)[-_ ]?key|credentials?(?:[-_ ]?ref)?|(?:set[-_ ]?)?cookie)`;
const INLINE_FIELDS = new RegExp(String.raw`(\b${FIELD_PATTERN}["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic)\s+[^\s,;{}<>"']+|[^\s,;{}<>"']+)`, "gi");
const URL_AUTH = /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi;
const TOKEN_SHAPES = /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{18,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g;

const CONNECTION_FIELDS = new Set(["baseurl", "sourcepath", "configfingerprint", "command", "args"]);

function fieldName(key: string): string { return key.toLowerCase().replace(/[-_ ]/g, ""); }

function credentialField(key: string): boolean { return CREDENTIAL_FIELDS.has(fieldName(key)); }

function environmentValues(value: unknown, values: Set<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") continue;
    const parts = key.split(/[_-]/);
    if (parts.some((_, index) => credentialField(parts.slice(index).join(""))) || /^(?:Bearer|Basic)\s+\S/i.test(item)) {
      collectStrings(item, values);
      continue;
    }
    for (const token of item.match(TOKEN_SHAPES) ?? []) collectStrings(token, values);
    // 数据库或代理地址可在普通变量名下包含连接凭据。
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(item)) {
      const url = URL.parse(item);
      if (url?.password) {
        collectStrings(item, values);
        collectStrings(url.password, values);
      }
    }
  }
}

function parsedJson(text: string): unknown {
  if (!/^[\s]*[{[\"]/.test(text)) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function collectStrings(value: unknown, values: Set<string>): void {
  if (typeof value === "string" && value !== "" && value !== REMOVED) {
    values.add(value);
    const bare = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
    if (bare !== undefined) values.add(bare);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, values);
  }
}

function collectHistoricalCredentials(value: unknown, values: Set<string>, depth = 0): void {
  if (depth > 80) throw new Error("ROLE_TRANSFER_HISTORY_TOO_DEEP");
  if (typeof value === "string") {
    const parsed = parsedJson(value);
    if (parsed !== undefined) {
      collectHistoricalCredentials(parsed, values, depth + 1);
    } else {
      for (const match of value.matchAll(INLINE_FIELDS)) {
        const prefixLength = match[1]?.length ?? 0;
        if (value.startsWith(REMOVED, match.index + prefixLength)) continue;
        const literal = match[0].slice(prefixLength).replace(/^["']|["']$/g, "");
        if (literal.length >= 5 && literal !== REMOVED) collectStrings(literal, values);
      }
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (credentialField(key)) collectStrings(item, values);
    else if (fieldName(key) === "env") environmentValues(item, values);
    else collectHistoricalCredentials(item, values, depth + 1);
  }
}

export function installCredentialValues(config: BackendConfig, app: Database.Database): Set<string> {
  const values = new Set<string>();
  const hasTable = app.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
  const keyPath = path.join(config.appRoot, "secrets", "master.key");
  const keyStat = fs.lstatSync(keyPath, { throwIfNoEntry: false });
  const localKey = keyStat?.isFile() && keyStat.nlink === 1 && !fs.lstatSync(path.dirname(keyPath)).isSymbolicLink();
  if (localKey) {
    values.add(fs.readFileSync(keyPath, "utf8").trim());
  }
  if (hasTable.get("resource_secrets")) {
    const cipher = new SecretCipher(config.appRoot);
    for (const row of app.prepare("SELECT ciphertext FROM resource_secrets").iterate() as Iterable<{ ciphertext: string }>) {
      values.add(row.ciphertext);
      const plain = localKey ? cipher.decrypt(row.ciphertext) : null;
      if (plain === null) throw new Error("ROLE_TRANSFER_SOURCE_CREDENTIAL_UNAVAILABLE");
      values.add(plain);
    }
  }
  for (const table of ["resources", "image_services", "voice_services"]) {
    if (!hasTable.get(table)) continue;
    for (const row of app.prepare(`SELECT config_json FROM ${table}`).iterate() as Iterable<{ config_json: string }>) {
      const parsed = JSON.parse(row.config_json) as Record<string, unknown>;
      collectHistoricalCredentials(parsed, values);
      if (typeof parsed.credentialRef === "string") {
        try {
          const value = resolveCredential(config.appRoot, parsed.credentialRef);
          if (value !== undefined) values.add(value);
        } catch {
          // 引用可能暂不可用，历史结构化凭据与引用仍会被筛除。
        }
      }
    }
  }
  return values;
}

export class RoleTransferCredentialFilter {
  private readonly literals: string[];
  private readonly bytes: Buffer[];

  constructor(values: ReadonlySet<string>, tables: TransferTables) {
    const candidates = new Set(values);
    for (const table of TRANSFER_TABLES) {
      for (const row of tables[table] ?? []) {
        for (const [column, value] of Object.entries(row)) {
          if (column.endsWith("_json")) collectHistoricalCredentials(value, candidates);
        }
      }
    }
    const encoded = new Set<string>();
    for (const value of candidates) {
      if (!value || value === REMOVED) continue;
      encoded.add(value);
      if (value.length >= 5) {
        const bytes = Buffer.from(value);
        encoded.add(bytes.toString("base64"));
        encoded.add(bytes.toString("base64url"));
        encoded.add(JSON.stringify(value).slice(1, -1));
        try { encoded.add(encodeURIComponent(value)); } catch { /* 保留原始值 */ }
      }
    }
    this.literals = [...encoded].sort((a, b) => b.length - a.length);
    this.bytes = this.literals.filter((value) => value.length >= 5).map((value) => Buffer.from(value));
  }

  sanitizeTables(tables: TransferTables): void {
    for (const table of TRANSFER_TABLES) {
      for (const [index, row] of (tables[table] ?? []).entries()) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value !== "string") continue;
          const sanitized = column.endsWith("_json") ? this.json(value) : this.text(value);
          if (sanitized === value) continue;
          if (table === "web_reading_deliveries" && (column === "original_text" || column === "url" || column === "page_version")) {
            throw new Error(`ROLE_TRANSFER_CREDENTIAL_IN_WEB_EVIDENCE:${index + 1}:${column}`);
          }
          if (/(?:_id|_at|_hash|_path)$/.test(column) || column === "status" || column === "source_kind") {
            throw new Error(`ROLE_TRANSFER_CREDENTIAL_IN_IDENTITY:${table}:${index + 1}:${column}`);
          }
          row[column] = sanitized;
          if (column === "content" && table === "diaries") row.content_hash = sha256(sanitized);
          if (column === "content" && table === "messages") {
            row.submission_hash = row.submission_hash === null ? null : sha256(sanitized);
          }
        }
      }
    }
  }

  assertSafeData(data: Buffer, location: string): void {
    if (this.bytes.some((secret) => data.includes(secret))) {
      throw new Error(`ROLE_TRANSFER_CREDENTIAL_IN_FILE:${location}`);
    }
  }

  text(value: string): string {
    // 短值只匹配完整字段，以免普通中英文文本被误当成短环境变量。
    const result = value.split(REMOVED).map((part) => {
      let clean = part;
      for (const literal of this.literals) {
        if (literal.length >= 5) clean = clean.replaceAll(literal, REMOVED);
        else if (clean === literal) clean = REMOVED;
      }
      return clean;
    }).join(REMOVED);
    return result
      .replace(URL_AUTH, `$1${REMOVED}@`)
      .replace(TOKEN_SHAPES, REMOVED)
      .replace(INLINE_FIELDS, (match: string, prefix: string, offset: number, text: string) =>
        text.startsWith(REMOVED, offset + prefix.length) ? match : `${prefix}${REMOVED}`);
  }

  private json(value: string): string {
    try {
      return canonicalJson(this.nested(JSON.parse(value) as unknown));
    } catch (error) {
      if (error instanceof SyntaxError) return this.text(value);
      throw error;
    }
  }

  private nested(value: unknown, depth = 0, parentField = ""): unknown {
    if (depth > 80) throw new Error("ROLE_TRANSFER_HISTORY_TOO_DEEP");
    if (typeof value === "string") {
      const parsed = parsedJson(value);
      return parsed === undefined ? this.text(value) : canonicalJson(this.nested(parsed, depth + 1, parentField));
    }
    if (Array.isArray(value)) return value.map((item: unknown) => this.nested(item, depth + 1, parentField));
    if (value === null || typeof value !== "object") return value;
    const fields = Object.keys(value).map(fieldName);
    const connection = parentField === "config" || parentField === "connection" ||
      (fields.includes("baseurl") && fields.includes("protocol")) ||
      (fields.includes("command") && (fields.includes("args") || fields.includes("env")));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const field = fieldName(key);
      const environment = field === "env" && item !== null && typeof item === "object" && !Array.isArray(item);
      const restricted = credentialField(key) || environment || (connection && CONNECTION_FIELDS.has(field));
      return [this.text(key), restricted ? REMOVED : this.nested(item, depth + 1, field)];
    }));
  }
}
