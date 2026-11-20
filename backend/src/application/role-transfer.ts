import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { rolePaths, type BackendConfig } from "../bootstrap/config.js";
import { AppStore } from "../storage/app-store.js";
import { checkAppDatabaseFiles, checkedInstallEntry, lockInstallation } from "../storage/installation-lock.js";
import { canonicalJson, sha256 } from "./role-transfer-data.js";
import {
  captureRoleTransfer, readRoleTransferPackage, resolveRoleTransferBindings, roleTransferTimelineFacts,
  roleTransferWithAncestors, writeRoleTransferPackage, type RoleTransferPackage,
} from "./role-transfer-package.js";
import { checkTransferRoleDirectory, publishRoleTransfer, recoverRoleTransfer, type PublicationHook } from "./role-transfer-publication.js";

export type TransferRelation = "new" | "same" | "package-ahead" | "local-ahead" | "diverged" | "unknown";
export type TransferChoice = "local" | "package";
type TransferMapping = Readonly<Record<string, string>>;
type TransferSelection = { package_digest: string; target_fingerprint: string };
type RoleIndexFacts = { role_id: string; relative_dir: string; init_status: string; builtin_key?: string | null };
type TimelineEvidence = { facts: Set<string>; userMessages: Set<string> };

const snapshotLimit = 128;

function withInstallation<T>(config: BackendConfig, file: string, action: () => T): T {
  const release = lockInstallation(config);
  try {
    assertPackageFileOutsideManagedDirs(config, file);
    const hasJournal = withAppRead(config, (db) => tableExists(db, "role_transfer_publication") &&
      Boolean(db!.prepare("SELECT 1 FROM role_transfer_publication WHERE singleton = 1").get()));
    const root = path.join(config.dataRoot, ".role-transfer");
    if (hasJournal || (checkedInstallEntry(root, "directory") && fs.readdirSync(root).length > 0)) {
      withAppWrite(config, (store) => recoverRoleTransfer(config, store));
    }
    return action();
  } finally {
    release();
  }
}

function withAppRead<T>(config: BackendConfig, action: (db: Database.Database | null) => T): T {
  const db = checkAppDatabaseFiles(config) ?
    new Database(config.appDatabasePath, { readonly: true, fileMustExist: true }) : null;
  try { return action(db); }
  finally { db?.close(); }
}

function withAppWrite<T>(config: BackendConfig, action: (store: AppStore) => T): T {
  checkAppDatabaseFiles(config);
  const store = new AppStore(config.appDatabasePath);
  try { return action(store); }
  finally { store.close(); }
}

function tableExists(db: Database.Database | null, table: string): boolean {
  return Boolean(db?.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
}

function localSnapshots(db: Database.Database | null, roleId: string) {
  if (!tableExists(db, "role_transfer_snapshots")) return [];
  const rows = db!.prepare(`
    SELECT fingerprint, facts_json FROM role_transfer_snapshots WHERE role_id = ?
    ORDER BY sequence DESC LIMIT ?
  `).all(roleId, snapshotLimit) as { fingerprint: string; facts_json: string }[];
  return rows.map(({ fingerprint, facts_json }) => {
    const evidence = JSON.parse(facts_json) as { facts?: unknown; userMessages?: unknown };
    const { facts, userMessages } = evidence;
    if (!isHashList(facts) || facts.length === 0 || !isHashList(userMessages)) {
      throw new Error("ROLE_TRANSFER_BASELINE_INVALID");
    }
    return { fingerprint, facts: new Set(facts), userMessages: new Set(userMessages) };
  });
}

function isHashList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && /^[0-9a-f]{64}$/.test(item));
}

function timelineEvidence(pkg: RoleTransferPackage): TimelineEvidence {
  const userMessages = pkg.tables.messages.filter((row) => row.sender === "user").map((row) =>
    sha256(canonicalJson([row.message_id, row.window_id, row.content, row.source_platform, row.submission_id, row.created_at])));
  return { facts: roleTransferTimelineFacts(pkg), userMessages: new Set(userMessages) };
}

function saveSnapshot(db: Database.Database, pkg: RoleTransferPackage, evidence: TimelineEvidence): void {
  // 同一快照重复导出无需增加历史记录，边界旧记录丢失时退回显式选择。
  db.prepare(`
    INSERT INTO role_transfer_snapshots (role_id, fingerprint, facts_json) VALUES (?, ?, ?)
    ON CONFLICT (role_id, fingerprint) DO NOTHING
  `).run(pkg.roleId, pkg.timelineFingerprint, JSON.stringify({
    facts: [...evidence.facts].sort(), userMessages: [...evidence.userMessages].sort(),
  }));
  db.prepare(`
    DELETE FROM role_transfer_snapshots WHERE role_id = ? AND sequence NOT IN (
      SELECT sequence FROM role_transfer_snapshots WHERE role_id = ? ORDER BY sequence DESC LIMIT ?
    )
  `).run(pkg.roleId, pkg.roleId, snapshotLimit);
}

function containsFacts(candidate: ReadonlySet<string>, baseline: ReadonlySet<string>): boolean {
  for (const fact of baseline) if (!candidate.has(fact)) return false;
  return true;
}

function keepsMessageAnchors(candidate: TimelineEvidence, baseline: TimelineEvidence): boolean {
  return baseline.userMessages.size > 0 && containsFacts(candidate.userMessages, baseline.userMessages);
}

function readIndex(db: Database.Database | null, roleId: string): RoleIndexFacts | undefined {
  const indexes = db?.prepare("SELECT * FROM roles WHERE lower(role_id) = lower(?)").all(roleId) as RoleIndexFacts[] | undefined;
  if (indexes?.some((index) => index.role_id !== roleId)) throw new Error("ROLE_TRANSFER_ROLE_ID_ALIAS");
  const index = indexes?.[0];
  if (tableExists(db, "role_deletions") &&
      db!.prepare("SELECT 1 FROM role_deletions WHERE lower(role_id) = lower(?)").get(roleId)) {
    throw new Error("ROLE_TRANSFER_ROLE_PENDING_DELETION");
  }
  if (index?.init_status !== undefined && index.init_status !== "ready") {
    throw new Error("ROLE_TRANSFER_ROLE_NOT_READY");
  }
  if (index && index.relative_dir !== `roles/${roleId}`) throw new Error("ROLE_TRANSFER_ROLE_INDEX_PATH_INVALID");
  return index;
}

function assertPackageFileOutsideManagedDirs(config: BackendConfig, file: string): void {
  const target = path.resolve(file);
  const parent = fs.realpathSync(path.dirname(target));
  const dataRoot = fs.realpathSync(config.dataRoot);
  for (const directory of ["roles", ".role-transfer"]) {
    const managed = path.join(dataRoot, directory);
    const relative = path.relative(managed, path.join(parent, path.basename(target)));
    if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
      throw new Error("ROLE_TRANSFER_PACKAGE_IN_MANAGED_DIRECTORY");
    }
  }
}

export function exportRoleTransfer(config: BackendConfig, roleId: string, file: string) {
  return withInstallation(config, file, () => {
    rolePaths(config.dataRoot, roleId);
    if (!checkTransferRoleDirectory(config, roleId)) throw new Error("ROLE_TRANSFER_ROLE_MISSING");
    const pkg = captureRoleTransfer(config, roleId);
    const evidence = timelineEvidence(pkg);
    const ancestors = withAppRead(config, (db) => {
      const index = readIndex(db, roleId);
      if (index && (index.builtin_key ?? null) !== pkg.builtinKey) throw new Error("ROLE_TRANSFER_PRESET_IDENTITY_MISMATCH");
      return localSnapshots(db, roleId).filter((snapshot) => containsFacts(evidence.facts, snapshot.facts) ||
        keepsMessageAnchors(evidence, snapshot)).map(({ fingerprint }) => fingerprint);
    });
    const exported = roleTransferWithAncestors(pkg, ancestors);
    writeRoleTransferPackage(file, exported);
    withAppWrite(config, (store) => store.db.transaction(() => saveSnapshot(store.db, pkg, evidence))());
    return { roleId, digest: exported.digest, timelineFingerprint: exported.timelineFingerprint, bindings: exported.bindings };
  });
}

function compareTimelines(
  local: RoleTransferPackage | null, incoming: RoleTransferPackage,
  incomingEvidence: TimelineEvidence, snapshots: ReturnType<typeof localSnapshots>,
): TransferRelation {
  if (local === null) return "new";
  const localHead = local.timelineFingerprint;
  const packageHead = incoming.timelineFingerprint;
  if (localHead === packageHead) return "same";
  const localEvidence = timelineEvidence(local);
  const declared = new Set(incoming.ancestors);
  // 远端声明只用来查找本机留存的基线。即使声明正确，也必须完整保留本机事实。
  if (declared.has(localHead) && snapshots.some(({ fingerprint }) => fingerprint === localHead) &&
      containsFacts(incomingEvidence.facts, localEvidence.facts)) return "package-ahead";
  if (snapshots.some(({ fingerprint }) => fingerprint === packageHead) &&
      containsFacts(localEvidence.facts, incomingEvidence.facts)) return "local-ahead";
  const independentMessages = !containsFacts(localEvidence.userMessages, incomingEvidence.userMessages) &&
    !containsFacts(incomingEvidence.userMessages, localEvidence.userMessages);
  const differentFacts = !containsFacts(localEvidence.facts, incomingEvidence.facts) &&
    !containsFacts(incomingEvidence.facts, localEvidence.facts);
  if (differentFacts && snapshots.some(({ fingerprint, facts }) =>
    declared.has(fingerprint) && containsFacts(localEvidence.facts, facts) &&
    containsFacts(incomingEvidence.facts, facts))) return "diverged";
  // 可变笔记或角色状态可改变；只有双方互有独有消息且共享已核验的消息锚点时才升级为分化。
  if (independentMessages && snapshots.some((snapshot) => declared.has(snapshot.fingerprint) &&
      keepsMessageAnchors(localEvidence, snapshot) && keepsMessageAnchors(incomingEvidence, snapshot))) return "diverged";
  return "unknown";
}

function inspectTransfer(config: BackendConfig, file: string, mapping: TransferMapping) {
  const incoming = readRoleTransferPackage(file);
  const bindings = resolveRoleTransferBindings(config, incoming, mapping);
  const incomingEvidence = timelineEvidence(incoming);
  const { roleId, builtinKey } = incoming;
  const hasDirectory = checkTransferRoleDirectory(config, roleId);
  return withAppRead(config, (db) => {
    const index = readIndex(db, roleId);
    const local = hasDirectory ? captureRoleTransfer(config, roleId) : null;
    if ((index && !local) || (index && (index.builtin_key ?? null) !== builtinKey) || (local && local.builtinKey !== builtinKey)) {
      throw new Error("ROLE_TRANSFER_PRESET_IDENTITY_MISMATCH");
    }
    if (builtinKey !== null && db && db.prepare("PRAGMA table_info(roles)").all().some(
      (column) => (column as { name: string }).name === "builtin_key",
    ) && db.prepare("SELECT 1 FROM roles WHERE builtin_key = ? AND role_id <> ?").get(builtinKey, roleId)) {
      throw new Error("ROLE_TRANSFER_PRESET_KEY_IN_USE");
    }
    const snapshots = localSnapshots(db, roleId);
    const relation = compareTimelines(local, incoming, incomingEvidence, snapshots);
    const activity = tableExists(db, "role_activity") ?
      db!.prepare("SELECT * FROM role_activity WHERE role_id = ?").get(roleId) : null;
    const selection = tableExists(db, "role_transfer_selections") ?
      db!.prepare("SELECT package_digest, target_fingerprint FROM role_transfer_selections WHERE role_id = ?").get(roleId) as TransferSelection | undefined :
      undefined;
    const token = sha256(canonicalJson({
      version: 1, installation: fs.realpathSync(config.appRoot), incoming: incoming.digest, local: local?.digest ?? null,
      index: index ?? null, activity: activity ?? null, targets: bindings.targetFingerprint, relation, selection: selection ?? null,
    }));
    const requiresChoice = relation === "diverged" || relation === "unknown" || (!index && relation === "same");
    return {
      incoming, incomingEvidence, bindings, index, selection,
      preview: {
        roleId, token, relation, requiresChoice, packageDigest: incoming.digest,
        localFingerprint: local?.timelineFingerprint ?? null, packageFingerprint: incoming.timelineFingerprint,
        registered: Boolean(index), bindings: incoming.bindings, unresolved: bindings.unresolved,
      },
    };
  });
}

export function preflightRoleTransfer(config: BackendConfig, file: string, mapping: TransferMapping = {}) {
  return withInstallation(config, file, () => inspectTransfer(config, file, mapping).preview);
}

export function applyRoleTransfer(
  config: BackendConfig,
  file: string,
  token: string,
  mapping: TransferMapping = {},
  choice?: TransferChoice,
  hook?: PublicationHook,
) {
  return withInstallation(config, file, () => {
    const { preview, incoming, incomingEvidence, bindings, index, selection } = inspectTransfer(config, file, mapping);
    if (token !== preview.token) throw new Error("ROLE_TRANSFER_PREFLIGHT_STALE");
    if (preview.requiresChoice && !choice) throw new Error("ROLE_TRANSFER_CHOICE_REQUIRED");
    if (choice === "local") {
      if (preview.relation === "new") throw new Error("ROLE_TRANSFER_LOCAL_TIMELINE_MISSING");
      return { ...preview, outcome: "kept-local" };
    }
    const alreadyApplied = selection?.package_digest === incoming.digest && selection.target_fingerprint === bindings.targetFingerprint;
    if (preview.relation === "local-ahead" || (index && preview.relation === "same" &&
        (alreadyApplied || choice !== "package"))) return { ...preview, outcome: "unchanged" };
    withAppWrite(config, (store) => publishRoleTransfer(config, store, incoming, bindings, () => {
      const role = incoming.tables.roles[0]!;
      const stoppedAt = new Date().toISOString();
      store.db.prepare(`
        INSERT INTO roles (role_id, relative_dir, builtin_key, init_status, init_error, init_payload_json, created_at, updated_at)
        VALUES (?, ?, ?, 'ready', NULL, NULL, ?, ?)
        ON CONFLICT(role_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(incoming.roleId, `roles/${incoming.roleId}`, incoming.builtinKey, role.created_at, role.updated_at);
      store.db.prepare(`
        INSERT INTO role_activity (role_id, state, requested_at, confirmed_at, boundary_execution_id, updated_at)
        VALUES (?, 'stopped', NULL, ?, NULL, ?)
        ON CONFLICT(role_id) DO UPDATE SET
          state = 'stopped', requested_at = NULL, confirmed_at = excluded.confirmed_at,
          boundary_execution_id = NULL, updated_at = excluded.updated_at
      `).run(incoming.roleId, stoppedAt, stoppedAt);
      saveSnapshot(store.db, incoming, incomingEvidence);
      store.db.prepare(`
        INSERT INTO role_transfer_selections (role_id, package_digest, target_fingerprint) VALUES (?, ?, ?)
        ON CONFLICT(role_id) DO UPDATE SET
          package_digest = excluded.package_digest, target_fingerprint = excluded.target_fingerprint
      `).run(incoming.roleId, incoming.digest, bindings.targetFingerprint);
    }, hook));
    return { ...preview, outcome: "published" };
  });
}
