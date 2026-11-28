import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  AppError,
  FtsUnavailableError,
  SchemaMigrationError,
} from "../../domain/errors.js";

export const EXECUTION_SCHEMA_VERSION = 2;

export interface OpenedDatabase {
  db: Database.Database;
  path: string;
  schemaVersion: number;
}

export interface DatabaseOpenOptions {
  create?: boolean;
  timeZone?: string;
}

export interface RequiredIndex {
  name: string;
  table: string;
  columns: readonly string[];
  unique: boolean;
  partial: boolean;
  predicate?: string;
}

export interface RequiredColumns {
  table: string;
  columns: readonly string[];
}

export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info("${table}")`) as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definitionSql: string,
): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definitionSql};`);
  }
}

const EXECUTION_V2_SQL = `
CREATE TABLE execution_checkpoints (
  execution_id TEXT NOT NULL,
  step INTEGER NOT NULL CHECK (step >= 1),
  next_node TEXT NOT NULL CHECK (next_node IN ('model', 'tools', 'closing', 'done')),
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, step)
);
`;

export function openExecutionDatabase(
  dbPath: string,
  options: DatabaseOpenOptions = {},
): OpenedDatabase {
  return openVersionedDatabase(
    dbPath, EXECUTION_SCHEMA_VERSION, EXECUTION_V2_SQL,
    { 1: (db) => db.exec(EXECUTION_V2_SQL) },
    ["execution_checkpoints"], [], [], options,
  );
}

export function openVersionedDatabase(
  dbPath: string,
  version: number,
  schemaSql: string,
  migrations: Record<number, (db: Database.Database) => void>,
  requiredTables: readonly string[],
  requiredIndexes: readonly RequiredIndex[],
  requiredColumns: readonly RequiredColumns[],
  options: DatabaseOpenOptions,
): OpenedDatabase {
  const create = options.create !== false;
  const db = openRawDatabase(dbPath, create);
  let currentVersion = 0;
  try {
    currentVersion = readUserVersion(db);
    db.transaction(() => {
      ensureSchema(db, version, schemaSql, migrations, create);
      assertTables(db, requiredTables);
      assertIndexes(db, requiredIndexes);
      assertColumns(db, requiredColumns);
      if (requiredTables.includes("memory_search_fts")) {
        assertFtsIndex(db);
      }
    })();
    return { db, path: dbPath, schemaVersion: version };
  } catch (error) {
    db.close();
    if (error instanceof AppError) {
      throw error;
    }
    if (isFtsUnavailable(error)) {
      throw new FtsUnavailableError();
    }
    if (currentVersion > 0 && currentVersion < version) {
      throw new SchemaMigrationError(error);
    }
    throw error;
  }
}

function isFtsUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("no such module: fts5") ||
    message.includes("no such tokenizer: trigram") ||
    message.includes("unknown tokenizer: trigram")
  );
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
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function ensureSchema(
  db: Database.Database,
  version: number,
  schemaSql: string,
  migrations: Record<number, (db: Database.Database) => void>,
  create: boolean,
): void {
  const current = readUserVersion(db);
  if (current === version) {
    return;
  }
  if (current === 0) {
    if (!create) {
      throw new Error(`SCHEMA_INITIALIZATION_REQUIRED:${version}`);
    }
    db.exec(schemaSql);
    db.pragma(`user_version = ${version}`);
    return;
  }
  if (current > version) {
    throw new Error(`SCHEMA_VERSION_UNSUPPORTED:${version}:${current}`);
  }
  for (let next = current; next < version; next += 1) {
    const migrate = migrations[next];
    if (!migrate) {
      throw new Error(`SCHEMA_MIGRATION_REQUIRED:${version}:${next}`);
    }
    migrate(db);
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
    if (!spec.partial) {
      continue;
    }
    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get(spec.name) as { sql: string | null } | undefined;
    const predicate = row?.sql ? extractWhereClause(row.sql) : null;
    if (
      predicate === null ||
      normalizeSql(predicate) !== normalizeSql(spec.predicate ?? "")
    ) {
      throw new Error(`SCHEMA_INDEX_INVALID:${spec.name}`);
    }
  }
}

export function assertFtsIndex(db: Database.Database): void {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_search_fts'",
    )
    .get() as { sql: string | null } | undefined;
  if (!row?.sql) {
    throw new Error("SCHEMA_TABLE_MISSING:memory_search_fts");
  }
  if (
    !/using\s+fts5/i.test(row.sql) ||
    !/tokenize\s*=\s*'trigram'/i.test(row.sql)
  ) {
    throw new Error("SCHEMA_TABLE_INVALID:memory_search_fts");
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
