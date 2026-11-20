import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { rolePaths, type BackendConfig, type RolePaths } from "../bootstrap/config.js";
import { BUSINESS_SCHEMA_VERSION, openBusinessDatabase } from "../storage/schema.js";
import { RoleStorage } from "../storage/role-storage.js";
import { XIA_CHENG_BUILTIN_KEY } from "./preset-assistant.js";
import {
  captureTransferBindings, resolveTransferTargets, targetTransferSettings, transferBindingSchema,
  validateTransferBindings, type RoleTransferBindings,
} from "./role-transfer-bindings.js";
import { installCredentialValues, RoleTransferCredentialFilter } from "./role-transfer-credentials.js";
import {
  canonicalJson, normalizeExecutionFacts, rebuildTransferMemorySearch, sha256, sortedRows, TRANSFER_TABLES,
  transferColumns, type TransferRow, type TransferTables,
} from "./role-transfer-data.js";
import { assertRegularPath, captureTransferFiles, stageTransferFiles, validateTransferFiles } from "./role-transfer-files.js";

export type { RoleTransferBinding, RoleTransferBindings } from "./role-transfer-bindings.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const transferPackageSchema = z.object({
  version: z.literal(1),
  roleId: z.string().uuid(),
  builtinKey: z.literal(XIA_CHENG_BUILTIN_KEY).nullable(),
  ancestors: z.array(digestSchema).max(128),
  timelineFingerprint: digestSchema,
  digest: digestSchema,
  bindings: z.array(transferBindingSchema),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.union([z.string(), z.number().finite(), z.null()])))),
  files: z.array(z.discriminatedUnion("kind", [
    z.object({ path: z.string(), kind: z.literal("directory") }).strict(),
    z.object({ path: z.string(), kind: z.literal("file"), sha256: digestSchema,
      byteSize: z.number().int().nonnegative(), data: z.string() }).strict(),
  ])),
}).strict();

export type RoleTransferPackage = Omit<z.infer<typeof transferPackageSchema>, "tables"> & { tables: TransferTables };

export function captureRoleTransfer(config: BackendConfig, roleId: string, ancestors: readonly string[] = []): RoleTransferPackage {
  const paths = rolePaths(config.dataRoot, roleId);
  const sourcePath = assertRegularPath(config.appRoot, `data/roles/${roleId}/business.sqlite`, false);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  let app: Database.Database | null = null;
  let working = source;
  let tempDir: string | undefined;
  try {
    app = openAppReadOnly(config);
    const version = Number(source.pragma("user_version", { simple: true }));
    if (version < 1 || version > BUSINESS_SCHEMA_VERSION) throw new Error("ROLE_TRANSFER_SOURCE_VERSION_UNSUPPORTED");
    if (version < BUSINESS_SCHEMA_VERSION) {
      // 旧版先迁移隔离副本，保证导出与预检只读取原安装。
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-transfer-"));
      const copy = path.join(tempDir, "business.sqlite");
      source.prepare("VACUUM INTO ?").run(copy);
      working = openBusinessDatabase(copy, { create: false }).db;
    }
    const tables = captureTables(working);
    const role = tables.roles[0];
    const builtinKey = role?.builtin_key;
    validateOwnership(roleId, builtinKey, tables);
    const credentials = new RoleTransferCredentialFilter(app ? installCredentialValues(config, app) : new Set(), tables);
    credentials.sanitizeTables(tables);
    normalizeExecutionFacts(tables);
    const bindings = captureTransferBindings(working, roleId, credentials);
    for (const table of TRANSFER_TABLES) tables[table] = sortedRows(tables[table]);
    const files = captureTransferFiles(paths.roleDir, tables, credentials);
    const body = { version: 1 as const, roleId, builtinKey: builtinKey as RoleTransferPackage["builtinKey"], bindings, tables, files };
    const fingerprint = timelineFingerprint(body);
    return validateRoleTransfer(roleTransferWithAncestors({ ...body, timelineFingerprint: fingerprint }, ancestors));
  } finally {
    if (working !== source) working.close();
    source.close();
    app?.close();
    if (tempDir !== undefined) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function captureTables(db: Database.Database): TransferTables {
  return Object.fromEntries(TRANSFER_TABLES.map((table) => {
    if (table === "web_reading_deliveries" && !db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)) {
      return [table, []];
    }
    const columns = transferColumns(table).map((column) => `"${column}"`).join(", ");
    return [table, db.prepare(`SELECT ${columns} FROM "${table}"`).all()];
  })) as TransferTables;
}

function openAppReadOnly(config: BackendConfig): Database.Database | null {
  if (!fs.existsSync(config.appDatabasePath)) return null;
  const file = assertRegularPath(config.appRoot, "data/app.sqlite", false);
  return new Database(file, { readonly: true, fileMustExist: true });
}

export function writeRoleTransferPackage(filePath: string, pkg: RoleTransferPackage): void {
  validateRoleTransfer(pkg);
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  const temporary = path.join(parent, `.role-transfer-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, canonicalJson(pkg), { flag: "wx", mode: 0o600, flush: true });
    // 同目录硬链接发布完整文件，不覆盖已有包。
    try {
      fs.linkSync(temporary, resolved);
    } catch (error) {
      // 禁止硬链接的文件系统仍可用独占复制导出，读入时会校验整个包。
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      fs.copyFileSync(temporary, resolved, fs.constants.COPYFILE_EXCL);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readRoleTransferPackage(filePath: string): RoleTransferPackage {
  const resolved = path.resolve(filePath);
  assertRegularPath(path.dirname(resolved), path.basename(resolved), false);
  let candidate: unknown;
  try {
    candidate = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  } catch {
    throw new Error("ROLE_TRANSFER_PACKAGE_INVALID");
  }
  return validateRoleTransfer(candidate);
}

export function resolveRoleTransferBindings(
  config: BackendConfig,
  pkg: RoleTransferPackage,
  mapping: Readonly<Record<string, string>> = {},
): RoleTransferBindings {
  const app = openAppReadOnly(config);
  try {
    return resolveTransferTargets(app, pkg.bindings, pkg.digest, mapping);
  } finally {
    app?.close();
  }
}

export function stageRoleTransfer(paths: RolePaths, pkg: RoleTransferPackage, bindings: RoleTransferBindings): void {
  validateRoleTransfer(pkg);
  if (paths.roleId !== pkg.roleId || bindings.packageDigest !== pkg.digest) throw new Error("ROLE_TRANSFER_STAGE_MISMATCH");
  const expected = rolePaths(path.dirname(path.dirname(paths.roleDir)), pkg.roleId);
  const safe = { ...expected, roleDir: paths.roleDir };
  // 调用方指定隔离目录，所有内部路径仍采用标准角色布局。
  for (const [key, value] of Object.entries(safe)) {
    if (key === "roleId" || key === "roleDir") continue;
    if (paths[key as keyof RolePaths] !== path.join(paths.roleDir, path.basename(value))) throw new Error("ROLE_TRANSFER_STAGE_PATH_INVALID");
  }
  const dir = fs.lstatSync(paths.roleDir, { throwIfNoEntry: false });
  if (dir !== undefined && (!dir.isDirectory() || dir.isSymbolicLink() || fs.readdirSync(paths.roleDir).length > 0)) {
    throw new Error("ROLE_TRANSFER_STAGE_NOT_EMPTY");
  }
  const storage = new RoleStorage(paths);
  try {
    writeBusinessFacts(storage.business.db, pkg, bindings.targets, true);
    stageTransferFiles(paths.roleDir, pkg.files);
    storage.business.db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    storage.close();
  }
}

function validateRoleTransfer(value: unknown): RoleTransferPackage {
  const result = transferPackageSchema.safeParse(value);
  if (!result.success) throw new Error("ROLE_TRANSFER_PACKAGE_INVALID");
  const pkg = result.data as RoleTransferPackage;
  const { digest, ...snapshot } = pkg;
  if (sha256(canonicalJson(snapshot)) !== digest) throw new Error("ROLE_TRANSFER_PACKAGE_DIGEST_MISMATCH");
  if (pkg.ancestors.includes(pkg.timelineFingerprint) || new Set(pkg.ancestors).size !== pkg.ancestors.length) {
    throw new Error("ROLE_TRANSFER_ANCESTORS_INVALID");
  }
  validateOwnership(pkg.roleId, pkg.builtinKey, pkg.tables);
  validateTransferBindings(pkg.bindings, pkg.tables);
  validateTransferFiles(pkg.files, pkg.tables);
  if (timelineFingerprint(pkg) !== pkg.timelineFingerprint) throw new Error("ROLE_TRANSFER_TIMELINE_DIGEST_MISMATCH");
  const originalTables = canonicalJson(pkg.tables);
  normalizeExecutionFacts(pkg.tables);
  const credentials = new RoleTransferCredentialFilter(new Set(), pkg.tables);
  credentials.sanitizeTables(pkg.tables);
  if (canonicalJson(pkg.tables) !== originalTables) throw new Error("ROLE_TRANSFER_HISTORY_NOT_PORTABLE");
  for (const entry of pkg.files) {
    if (entry.kind === "file") credentials.assertSafeData(Buffer.from(entry.data, "base64"), "package");
  }
  const { db } = openBusinessDatabase(":memory:");
  try {
    writeBusinessFacts(db, pkg, new Map(), false);
  } finally {
    db.close();
  }
  return pkg;
}

function validateOwnership(roleId: string, builtinKey: unknown, tables: TransferTables): void {
  if (Object.keys(tables).length !== TRANSFER_TABLES.length ||
      !TRANSFER_TABLES.every((table) => Object.hasOwn(tables, table))) throw new Error("ROLE_TRANSFER_TABLE_INVALID");
  if (tables.roles.length !== 1 || tables.roles[0]?.role_id !== roleId ||
      tables.roles[0].builtin_key !== builtinKey || (builtinKey !== null && builtinKey !== XIA_CHENG_BUILTIN_KEY)) {
    throw new Error("ROLE_TRANSFER_ROLE_OWNERSHIP_MISMATCH");
  }
  for (const table of TRANSFER_TABLES) {
    const columns = transferColumns(table);
    for (const row of tables[table]) {
      if (Object.keys(row).length !== columns.length || !columns.every((column) => Object.hasOwn(row, column))) {
        throw new Error(`ROLE_TRANSFER_COLUMNS_INVALID:${table}`);
      }
      if (Object.hasOwn(row, "role_id") && row.role_id !== roleId) throw new Error("ROLE_TRANSFER_ROLE_OWNERSHIP_MISMATCH");
    }
  }
  if (builtinKey === null && [...tables.outfits, ...tables.outfit_assets].some((row) => row.is_preset !== 0)) {
    throw new Error("ROLE_TRANSFER_PRESET_OWNERSHIP_MISMATCH");
  }
}

export function roleTransferTimelineFingerprint(pkg: Pick<RoleTransferPackage, "roleId" | "tables" | "files">): string {
  return timelineFingerprint(pkg);
}

export function roleTransferWithAncestors(
  pkg: Omit<RoleTransferPackage, "ancestors" | "digest"> & Partial<Pick<RoleTransferPackage, "ancestors" | "digest">>,
  ancestors: readonly string[],
): RoleTransferPackage {
  const { digest: _digest, ...snapshot } = pkg;
  const body = { ...snapshot, ancestors: [...new Set(ancestors)].filter((ancestor) => ancestor !== pkg.timelineFingerprint).sort() };
  return { ...body, digest: sha256(canonicalJson(body)) };
}

function timelineProjection(pkg: Pick<RoleTransferPackage, "roleId" | "tables" | "files">) {
  const tables = Object.fromEntries(TRANSFER_TABLES.filter((table) => table !== "execution_stream_events").map((table) => {
    const rows = pkg.tables[table].map((row) => Object.fromEntries(Object.entries(row).filter(([column]) =>
      column !== "updated_at" && !(table === "model_calls" && column === "resource_id") &&
      !(table === "role_voice_settings" && column === "enabled"))));
    return [table, sortedRows(rows)];
  }));
  const files = pkg.files.map((entry) => entry.kind === "file" ? [entry.path, entry.sha256] : [entry.path]).sort((a, b) =>
    a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
  return { roleId: pkg.roleId, tables, files };
}

function timelineFingerprint(pkg: Pick<RoleTransferPackage, "roleId" | "tables" | "files">): string {
  return sha256(canonicalJson(timelineProjection(pkg)));
}

export function roleTransferTimelineFacts(pkg: Pick<RoleTransferPackage, "roleId" | "tables" | "files">): Set<string> {
  const { tables, files } = timelineProjection(pkg);
  return new Set([
    ...Object.entries(tables).flatMap(([table, rows]) => rows.map((row) => sha256(canonicalJson([table, row])))),
    ...files.map((file) => sha256(canonicalJson(["files", file]))),
  ]);
}

function writeBusinessFacts(
  db: Database.Database,
  pkg: RoleTransferPackage,
  targets: RoleTransferBindings["targets"],
  rebuild: boolean,
): void {
  try {
    db.transaction(() => {
      db.pragma("defer_foreign_keys = ON");
      const { general, voice, image } = targetTransferSettings(pkg.tables, pkg.bindings, targets);
      for (const table of TRANSFER_TABLES) {
        if (table === "role_voice_settings" || table === "role_scene_image_settings") continue;
        insertRows(db, table, pkg.tables[table]);
      }
      insertRows(db, "role_bindings", general);
      insertRows(db, "role_voice_settings", voice);
      insertRows(db, "role_scene_image_settings", image);
      if ((db.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("ROLE_TRANSFER_RELATION_INVALID");
      assertTransferRelations(db);
      if (rebuild) rebuildTransferMemorySearch(db);
    })();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ROLE_TRANSFER_")) throw error;
    throw new Error("ROLE_TRANSFER_BUSINESS_INVALID");
  }
}

function insertRows(db: Database.Database, table: string, rows: TransferRow[]): void {
  if (rows.length === 0) return;
  const schema = db.pragma(`table_info("${table}")`) as { name: string; type: string }[];
  const columns = Object.keys(rows[0]!);
  const types = new Map(schema.map(({ name, type }) => [name, type]));
  const insert = db.prepare(`INSERT INTO "${table}" (${columns.map((name) => `"${name}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  for (const row of rows) {
    const values = columns.map((column) => {
      const value = row[column];
      const type = types.get(column);
      const valid = value === null || (type === "TEXT" && typeof value === "string") ||
        (type === "INTEGER" && typeof value === "number" && Number.isSafeInteger(value)) ||
        (type === "REAL" && typeof value === "number" && Number.isFinite(value));
      if (!valid) throw new Error(`ROLE_TRANSFER_COLUMN_TYPE_INVALID:${table}:${column}`);
      return value;
    });
    insert.run(...values);
  }
}

function assertTransferRelations(db: Database.Database): void {
  const bad = db.prepare(`
    SELECT 1 FROM message_segments s JOIN messages m ON m.message_id = s.message_id WHERE s.window_id <> m.window_id
    UNION ALL
    SELECT 1 FROM scene_image_tasks t JOIN messages m ON m.message_id = t.message_id
      JOIN message_segments s1 ON s1.segment_id = t.start_segment_id
      JOIN message_segments s2 ON s2.segment_id = t.end_segment_id
      WHERE t.window_id <> m.window_id OR s1.message_id <> t.message_id OR s2.message_id <> t.message_id
    UNION ALL
    SELECT 1 FROM scene_image_assets a JOIN scene_image_tasks t ON t.task_id = a.task_id
      WHERE a.message_id <> t.message_id OR a.window_id <> t.window_id
    LIMIT 1`).get();
  if (bad) throw new Error("ROLE_TRANSFER_RELATION_INVALID");
}
