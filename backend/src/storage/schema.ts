import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const APP_SCHEMA_VERSION = 1;
export const BUSINESS_SCHEMA_VERSION = 1;
export const EXECUTION_SCHEMA_VERSION = 1;

export const APP_TABLES = ["roles", "resources"] as const;
export const BUSINESS_TABLES = [
  "roles",
  "windows",
  "messages",
  "tasks",
  "executions",
  "execution_tasks",
  "tool_calls",
  "tool_call_mode_events",
  "tool_results",
  "role_bindings",
  "task_resource_continuations",
] as const;

const APP_SCHEMA_SQL = `
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

const BUSINESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS roles (
  role_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  definition_text TEXT NOT NULL,
  definition_payload_json TEXT NOT NULL,
  definition_revision INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS windows (
  window_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  kind TEXT NOT NULL CHECK (kind IN ('main', 'custom')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL REFERENCES windows(window_id),
  sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant')),
  content TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  status TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  submission_id TEXT,
  submission_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (window_id, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_window_submission
  ON messages (window_id, submission_id)
  WHERE submission_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'failed')),
  end_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  window_id TEXT REFERENCES windows(window_id),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('user_message', 'autonomous', 'tool_result', 'recovery')),
  trigger_message_id TEXT REFERENCES messages(message_id),
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'superseded', 'failed')),
  state_version_loaded INTEGER,
  state_version_committed INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_tasks (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  relation TEXT NOT NULL CHECK (relation IN ('initiates', 'continues', 'references')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, task_id)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  tool_call_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  step_key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'unknown')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (execution_id, step_key)
);

CREATE TABLE IF NOT EXISTS tool_call_mode_events (
  event_id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(tool_call_id),
  mode TEXT NOT NULL CHECK (mode IN ('foreground', 'background')),
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_results (
  tool_call_id TEXT PRIMARY KEY REFERENCES tool_calls(tool_call_id),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'unknown')),
  raw_response_json TEXT,
  adapted_result_json TEXT,
  diagnostic_code TEXT,
  error_json TEXT,
  saved_at TEXT NOT NULL,
  previous_status TEXT CHECK (previous_status IN ('unknown')),
  previous_diagnostic_code TEXT,
  previous_raw_response_json TEXT,
  previous_adapted_result_json TEXT,
  previous_error_json TEXT,
  reconciled_at TEXT
);

CREATE TABLE IF NOT EXISTS role_bindings (
  role_id TEXT NOT NULL REFERENCES roles(role_id),
  capability TEXT NOT NULL CHECK (capability IN ('chat_model', 'memory_model', 'mcp', 'skill')),
  resource_id TEXT NOT NULL,
  model_name TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (role_id, capability, resource_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_role_single_chat_model
  ON role_bindings (role_id)
  WHERE capability = 'chat_model';

CREATE UNIQUE INDEX IF NOT EXISTS idx_role_single_memory_model
  ON role_bindings (role_id)
  WHERE capability = 'memory_model';

CREATE TABLE IF NOT EXISTS task_resource_continuations (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  resource_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (task_id, resource_id)
);
`;

export interface OpenedDatabase {
  db: Database.Database;
  path: string;
  schemaVersion: number;
}

export interface DatabaseOpenOptions {
  create?: boolean;
}

interface RequiredIndex {
  name: string;
  table: string;
  columns: readonly string[];
  unique: boolean;
  partial: boolean;
  predicate: string;
}

interface RequiredColumns {
  table: string;
  columns: readonly string[];
}

const BUSINESS_COLUMNS: readonly RequiredColumns[] = [
  {
    table: "tool_results",
    columns: [
      "tool_call_id",
      "status",
      "raw_response_json",
      "adapted_result_json",
      "diagnostic_code",
      "error_json",
      "saved_at",
      "previous_status",
      "previous_diagnostic_code",
      "previous_raw_response_json",
      "previous_adapted_result_json",
      "previous_error_json",
      "reconciled_at",
    ],
  },
];

const BUSINESS_INDEXES: readonly RequiredIndex[] = [
  {
    name: "idx_messages_window_submission",
    table: "messages",
    columns: ["window_id", "submission_id"],
    unique: true,
    partial: true,
    predicate: "submission_id IS NOT NULL",
  },
  {
    name: "idx_role_single_chat_model",
    table: "role_bindings",
    columns: ["role_id"],
    unique: true,
    partial: true,
    predicate: "capability = 'chat_model'",
  },
  {
    name: "idx_role_single_memory_model",
    table: "role_bindings",
    columns: ["role_id"],
    unique: true,
    partial: true,
    predicate: "capability = 'memory_model'",
  },
];

export function openAppDatabase(dbPath: string): OpenedDatabase {
  return openVersionedDatabase(
    dbPath,
    APP_SCHEMA_VERSION,
    APP_SCHEMA_SQL,
    APP_TABLES,
    [],
    [],
    { create: true },
  );
}

export function openBusinessDatabase(
  dbPath: string,
  options: DatabaseOpenOptions = {},
): OpenedDatabase {
  return openVersionedDatabase(
    dbPath,
    BUSINESS_SCHEMA_VERSION,
    BUSINESS_SCHEMA_SQL,
    BUSINESS_TABLES,
    BUSINESS_INDEXES,
    BUSINESS_COLUMNS,
    options,
  );
}

export function openExecutionDatabase(
  dbPath: string,
  options: DatabaseOpenOptions = {},
): OpenedDatabase {
  const create = options.create !== false;
  const db = openRawDatabase(dbPath, create);
  try {
    ensureVersionOnly(db, EXECUTION_SCHEMA_VERSION, create);
    return { db, path: dbPath, schemaVersion: EXECUTION_SCHEMA_VERSION };
  } catch (error) {
    db.close();
    throw error;
  }
}

function openVersionedDatabase(
  dbPath: string,
  version: number,
  schemaSql: string,
  requiredTables: readonly string[],
  requiredIndexes: readonly RequiredIndex[],
  requiredColumns: readonly RequiredColumns[],
  options: DatabaseOpenOptions,
): OpenedDatabase {
  const create = options.create !== false;
  const db = openRawDatabase(dbPath, create);
  try {
    ensureSchema(db, version, schemaSql, create);
    assertTables(db, requiredTables);
    assertIndexes(db, requiredIndexes);
    assertColumns(db, requiredColumns);
    return { db, path: dbPath, schemaVersion: version };
  } catch (error) {
    db.close();
    throw error;
  }
}

function openRawDatabase(dbPath: string, create: boolean): Database.Database {
  if (!create && !fs.existsSync(dbPath)) {
    throw new Error(`STORAGE_FILE_MISSING:${path.basename(dbPath)}`);
  }
  if (create) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = create
    ? new Database(dbPath)
    : new Database(dbPath, { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function ensureSchema(
  db: Database.Database,
  version: number,
  schemaSql: string,
  create: boolean,
): void {
  const current = readUserVersion(db);
  if (current === version) {
    return;
  }
  if (current !== 0) {
    throw new Error(`SCHEMA_VERSION_UNSUPPORTED:${version}:${current}`);
  }
  if (!create) {
    throw new Error(`SCHEMA_INITIALIZATION_REQUIRED:${version}`);
  }
  db.transaction(() => {
    db.exec(schemaSql);
    db.pragma(`user_version = ${version}`);
  })();
}

function ensureVersionOnly(
  db: Database.Database,
  version: number,
  create: boolean,
): void {
  const current = readUserVersion(db);
  if (current === version) {
    return;
  }
  if (current !== 0) {
    throw new Error(`SCHEMA_VERSION_UNSUPPORTED:${version}:${current}`);
  }
  if (!create) {
    throw new Error(`SCHEMA_INITIALIZATION_REQUIRED:${version}`);
  }
  db.pragma(`user_version = ${version}`);
}

function readUserVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function assertTables(
  db: Database.Database,
  requiredTables: readonly string[],
): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  const existing = new Set(rows.map((row) => row.name));
  for (const table of requiredTables) {
    if (!existing.has(table)) {
      throw new Error(`SCHEMA_TABLE_MISSING:${table}`);
    }
  }
}

function assertIndexes(
  db: Database.Database,
  requiredIndexes: readonly RequiredIndex[],
): void {
  for (const spec of requiredIndexes) {
    const indexList = db.pragma(`index_list("${spec.table}")`) as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const found = indexList.find((row) => row.name === spec.name);
    if (!found) {
      throw new Error(`SCHEMA_INDEX_MISSING:${spec.name}`);
    }
    if (
      (found.unique === 1) !== spec.unique ||
      (found.partial === 1) !== spec.partial
    ) {
      throw new Error(`SCHEMA_INDEX_INVALID:${spec.name}`);
    }
    const info = db.pragma(`index_info("${spec.name}")`) as Array<{
      seqno: number;
      name: string;
    }>;
    const columns = info
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    if (columns.join(",") !== spec.columns.join(",")) {
      throw new Error(`SCHEMA_INDEX_INVALID:${spec.name}`);
    }
    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get(spec.name) as { sql: string | null } | undefined;
    const predicate = row?.sql ? extractWhereClause(row.sql) : null;
    if (
      predicate === null ||
      normalizeSql(predicate) !== normalizeSql(spec.predicate)
    ) {
      throw new Error(`SCHEMA_INDEX_INVALID:${spec.name}`);
    }
  }
}

function assertColumns(
  db: Database.Database,
  requiredColumns: readonly RequiredColumns[],
): void {
  for (const spec of requiredColumns) {
    const rows = db.pragma(`table_info("${spec.table}")`) as Array<{
      name: string;
    }>;
    const existing = new Set(rows.map((row) => row.name));
    for (const column of spec.columns) {
      if (!existing.has(column)) {
        throw new Error(`SCHEMA_COLUMN_MISSING:${spec.table}.${column}`);
      }
    }
  }
}

function extractWhereClause(sql: string): string | null {
  const match = /\bwhere\b([\s\S]*)$/i.exec(sql);
  return match?.[1] ?? null;
}

function normalizeSql(sql: string): string {
  let normalized = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "'" || char === '"' || char === "`") {
      normalized += char;
      index += 1;
      while (index < sql.length) {
        const quoted = sql[index] ?? "";
        normalized += quoted;
        index += 1;
        if (quoted !== char) {
          continue;
        }
        if (sql[index] === char) {
          normalized += char;
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (char === ";" || /\s/.test(char) || char === "(" || char === ")") {
      index += 1;
      continue;
    }
    normalized += char.toLowerCase();
    index += 1;
  }
  return normalized;
}
