import type Database from "better-sqlite3";
import {
  addColumnIfMissing,
  openVersionedDatabase,
  type OpenedDatabase,
  type RequiredColumns,
  type RequiredIndex,
} from "./schema-verify.js";

export const APP_SCHEMA_VERSION = 17;

export const APP_TABLES = [
  "roles",
  "resources",
  "builtin_resource_seeds",
  "engineering_settings",
  "resource_deletions",
  "role_deletions",
  "model_test_calls",
  "vertex_test_routes",
  "resource_secrets",
  "image_services",
  "voice_services",
  "role_activity",
  "role_transfer_snapshots",
  "role_transfer_selections",
  "role_transfer_publication",
  "token_usage_records",
  "token_usage_meta",
  "app_meta",
  "role_media_bindings",
] as const;

const APP_V2_SQL = `
CREATE TABLE IF NOT EXISTS model_test_calls (
  test_call_id TEXT PRIMARY KEY,
  resource_id TEXT,
  model_name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN (
    'openai-chat', 'openai-responses', 'anthropic-messages'
  )),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  usage_json TEXT
);
`;

/**
 * v3：模型服务密钥只写存储，以及连接测试的配置指纹。
 * 密钥密文独立于资源配置，读接口只暴露状态，不回明文。
 */
const APP_V3_SQL = `
CREATE TABLE IF NOT EXISTS resource_secrets (
  resource_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE model_test_calls ADD COLUMN config_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_model_test_calls_resource
  ON model_test_calls (resource_id, finished_at);
`;

const APP_V4_SQL = `
-- v4：ComfyUI 生图服务连接。ComfyUI 本身不规定模型，模型差异落在
-- 角色生图配置的工作流模板上（DL-150）。密钥仍走 resource_secrets，
-- 读接口只暴露状态，不回明文。
CREATE TABLE IF NOT EXISTS image_services (
  service_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_services_enabled
  ON image_services (enabled, created_at);
`;

const APP_V5_SQL = `
-- v5：角色活动的持久化状态（DL-148）。没有记录视为 active，老库升级无需回填。
-- stopping 表示已请求停止、还在等下一个可保存节点；stopped 是后端确认后的
-- 粘滞状态，必须显式恢复，配置写入也只认这个状态。
CREATE TABLE IF NOT EXISTS role_activity (
  role_id TEXT PRIMARY KEY REFERENCES roles(role_id),
  state TEXT NOT NULL CHECK (state IN ('active', 'stopping', 'stopped')),
  requested_at TEXT,
  confirmed_at TEXT,
  boundary_execution_id TEXT,
  updated_at TEXT NOT NULL
);
`;

export const APP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS roles (
  role_id TEXT PRIMARY KEY,
  relative_dir TEXT NOT NULL UNIQUE,
  init_status TEXT NOT NULL CHECK (init_status IN ('initializing', 'ready', 'failed')),
  init_error TEXT,
  init_payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  resource_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('model', 'mcp', 'skill')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const APP_V6_SQL = `
-- v6：删除资源时先在全局库同事务提交「资源删除 + 待清理记录」（RP-R05）。
-- 角色业务库的残留绑定由启动恢复、删除重试和读侧过滤继续清理。
CREATE TABLE IF NOT EXISTS resource_deletions (
  resource_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`;

const APP_V7_SQL = `
-- v7：角色删除（清理数据路径）先在全局库提交「移除角色 + 待清理记录」，
-- 角色目录的删除失败时由启动恢复或删除重试继续（DL-148）。
CREATE TABLE IF NOT EXISTS role_deletions (
  role_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`;

const APP_V8_SQL = `
-- v8：model_test_calls 协议约束纳入 google-gemini（Google Gemini / Vertex AI 直连）。
ALTER TABLE model_test_calls RENAME TO model_test_calls_v8_old;
DROP INDEX IF EXISTS idx_model_test_calls_resource;

CREATE TABLE model_test_calls (
  test_call_id TEXT PRIMARY KEY,
  resource_id TEXT,
  model_name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN (
    'openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini'
  )),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  usage_json TEXT,
  config_fingerprint TEXT
);

INSERT INTO model_test_calls
  (test_call_id, resource_id, model_name, protocol, status, error_code,
   started_at, finished_at, usage_json, config_fingerprint)
SELECT test_call_id, resource_id, model_name, protocol, status, error_code,
       started_at, finished_at, usage_json, config_fingerprint
  FROM model_test_calls_v8_old;

DROP TABLE model_test_calls_v8_old;
CREATE INDEX IF NOT EXISTS idx_model_test_calls_resource
  ON model_test_calls (resource_id, finished_at);
`;

const APP_V9_SQL = `
-- v9：全局语音服务目录（DL-152）。在设置页统一管理地址、协议与默认引擎，
-- 角色只选择服务并保留各自音色来源、参考音频与语速／情绪试听配置。
CREATE TABLE IF NOT EXISTS voice_services (
  service_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_services_enabled
  ON voice_services (enabled, created_at);
`;

const APP_V10_SQL = `
-- v10：全局角色索引增加内置角色标识，单实例唯一（DL-147 / DL-153）。
ALTER TABLE roles ADD COLUMN builtin_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_roles_builtin_key
  ON roles (builtin_key)
  WHERE builtin_key IS NOT NULL;
`;

const APP_V11_SQL = `
CREATE TABLE IF NOT EXISTS role_transfer_snapshots (
  sequence INTEGER PRIMARY KEY,
  role_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  UNIQUE (role_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS role_transfer_selections (
  role_id TEXT PRIMARY KEY,
  package_digest TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS role_transfer_publication (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  operation_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  had_local INTEGER NOT NULL CHECK (had_local IN (0, 1)),
  phase TEXT NOT NULL CHECK (phase IN ('prepared', 'committed'))
);
`;

const APP_V12_SQL = `
-- V12：全局持久 Token 消耗账本（DL-183），角色与服务删除后历史消耗继续保留。
CREATE TABLE IF NOT EXISTS token_usage_records (
  source_call_id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  role_id TEXT,
  role_name TEXT NOT NULL DEFAULT '',
  resource_id TEXT,
  resource_name TEXT NOT NULL DEFAULT '',
  provider TEXT,
  protocol TEXT NOT NULL,
  model_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'dialogue', 'autonomy', 'memory', 'annotation', 'scene_plan', 'anchor_prompt', 'connection_test'
  )),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'unknown')),
  usage_reported INTEGER NOT NULL CHECK (usage_reported IN (0, 1)),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cached_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0)
);
CREATE INDEX IF NOT EXISTS idx_token_usage_date
  ON token_usage_records (local_date, occurred_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_role_date
  ON token_usage_records (role_id, local_date);
CREATE TABLE IF NOT EXISTS token_usage_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const APP_V13_SQL = `
CREATE TABLE IF NOT EXISTS builtin_resource_seeds (
  command TEXT PRIMARY KEY,
  pending_resource_id TEXT
);
`;

const APP_V14_SQL = `
CREATE TABLE IF NOT EXISTS vertex_test_routes (
  test_call_id TEXT PRIMARY KEY REFERENCES model_test_calls(test_call_id) ON DELETE CASCADE,
  route_fingerprint TEXT NOT NULL,
  base_url TEXT NOT NULL
);
`;

const APP_V15_SQL = `
CREATE TABLE IF NOT EXISTS engineering_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'priority' CHECK (mode IN ('priority','round_robin')),
  members_json TEXT NOT NULL DEFAULT '[]',
  allow_shell INTEGER NOT NULL DEFAULT 0 CHECK (allow_shell IN (0,1))
);
INSERT OR IGNORE INTO engineering_settings (id) VALUES (1);
`;

const APP_V17_SQL = `
-- v17：媒体服务依赖投影。维护/删除服务时按 (kind, service_id) 索引直接命中
-- 依赖角色，避免逐个打开角色业务库扫描；老库由启动期一次性回填。
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS role_media_bindings (
  role_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('voice', 'image')),
  service_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (role_id, kind),
  FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_role_media_bindings_service
  ON role_media_bindings(kind, service_id);
`;

const APP_COLUMNS: readonly RequiredColumns[] = [
  { table: "engineering_settings", columns: ["id", "mode", "members_json", "allow_shell"] },
  { table: "builtin_resource_seeds", columns: ["command", "pending_resource_id"] },
  {
    table: "roles",
    columns: ["builtin_key"],
  },
  {
    table: "token_usage_records",
    columns: [
      "source_call_id",
      "local_date",
      "occurred_at",
      "role_id",
      "role_name",
      "resource_id",
      "resource_name",
      "provider",
      "protocol",
      "model_name",
      "category",
      "status",
      "usage_reported",
      "input_tokens",
      "cached_tokens",
      "cache_creation_tokens",
      "output_tokens",
    ],
  },
];

const APP_INDEXES: readonly RequiredIndex[] = [
  {
    name: "idx_app_roles_builtin_key",
    table: "roles",
    columns: ["builtin_key"],
    unique: true,
    partial: true,
    predicate: "builtin_key IS NOT NULL",
  },
  {
    name: "idx_token_usage_date",
    table: "token_usage_records",
    columns: ["local_date", "occurred_at"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_token_usage_role_date",
    table: "token_usage_records",
    columns: ["role_id", "local_date"],
    unique: false,
    partial: false,
  },
  {
    name: "idx_role_media_bindings_service",
    table: "role_media_bindings",
    columns: ["kind", "service_id"],
    unique: false,
    partial: false,
  },
];

function migrateAppV10(db: Database.Database): void {
  addColumnIfMissing(db, "roles", "builtin_key", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_app_roles_builtin_key
      ON roles (builtin_key)
      WHERE builtin_key IS NOT NULL;
  `);
}

export function openAppDatabase(dbPath: string): OpenedDatabase {
  return openVersionedDatabase(
    dbPath,
    APP_SCHEMA_VERSION,
    APP_SCHEMA_SQL +
      APP_V2_SQL +
      APP_V3_SQL +
      APP_V4_SQL +
      APP_V5_SQL +
      APP_V6_SQL +
      APP_V7_SQL +
      APP_V8_SQL +
      APP_V9_SQL +
      APP_V10_SQL +
      APP_V11_SQL +
      APP_V12_SQL +
      APP_V13_SQL + APP_V14_SQL + APP_V15_SQL + APP_V17_SQL,
    {
      1: (db) => db.exec(APP_V2_SQL),
      2: (db) => db.exec(APP_V3_SQL),
      3: (db) => db.exec(APP_V4_SQL),
      4: (db) => db.exec(APP_V5_SQL),
      5: (db) => db.exec(APP_V6_SQL),
      6: (db) => db.exec(APP_V7_SQL),
      7: (db) => db.exec(APP_V8_SQL),
      8: (db) => db.exec(APP_V9_SQL),
      9: migrateAppV10,
      10: (db) => db.exec(APP_V11_SQL),
      11: (db) => db.exec(APP_V12_SQL),
      12: (db) => db.exec(APP_V13_SQL),
      13: (db) => db.exec(APP_V14_SQL),
      14: (db) => db.exec(APP_V15_SQL),
      15: (db) => addColumnIfMissing(db, "engineering_settings", "allow_shell", "INTEGER NOT NULL DEFAULT 0 CHECK (allow_shell IN (0,1))"),
      16: (db) => db.exec(APP_V17_SQL),
    },
    APP_TABLES,
    APP_INDEXES,
    APP_COLUMNS,
    { create: true },
  );
}
