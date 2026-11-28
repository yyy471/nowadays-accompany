import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { rolePaths, type BackendConfig } from "../../bootstrap/config.js";
import { AppStore } from "../../storage/core/app-store.js";
import { checkAppDatabaseFiles, checkedInstallEntry, lockInstallation } from "../../storage/core/installation-lock.js";
import { canonicalJson, portableTransferTables, sha256 } from "./role-transfer-data.js";
import {
  captureRoleTransfer, MAX_ROLE_TRANSFER_PACKAGE_BYTES, readRoleTransferPackage, resolveRoleTransferBindings,
  roleTransferTimelineFacts, roleTransferTimelineFingerprint, roleTransferWithAncestors, writeRoleTransferPackage,
  type ReadRoleTransferPackageOptions, type RoleTransferPackage,
} from "./role-transfer-package.js";
import { checkTransferRoleDirectory, publishRoleTransfer, recoverRoleTransfer, type PublicationHook } from "./role-transfer-publication.js";

export type TransferRelation = "new" | "same" | "package-ahead" | "local-ahead" | "diverged" | "unknown";
export type TransferChoice = "local" | "package";
type TransferMapping = Readonly<Record<string, string>>;
type TransferSelection = { package_digest: string; target_fingerprint: string };
type RoleIndexFacts = { role_id: string; relative_dir: string; init_status: string; builtin_key?: string | null };
type TimelineEvidence = { facts: Set<string>; userMessages: Set<string> };

const snapshotLimit = 128;

/**
 * 一次迁移操作访问应用库的方式。
 *
 * 离线 CLI 在获取安装锁后自行打开只读／写入连接；运行态 HTTP 后端已持有
 * 同一个 `AppStore`，复用它的连接既能避免二次加锁，也能看到本进程刚写入的
 * 活动状态。两条路径共享下面的核心逻辑，保证行为一致。
 */
interface TransferContext {
  read<T>(action: (db: Database.Database | null) => T): T;
  write<T>(action: (store: AppStore) => T): T;
}

function installationContext(config: BackendConfig): TransferContext {
  return {
    read<T>(action: (db: Database.Database | null) => T): T { return withAppRead(config, action); },
    write<T>(action: (store: AppStore) => T): T { return withAppWrite(config, action); },
  };
}

function openedStoreContext(store: AppStore): TransferContext {
  return {
    read<T>(action: (db: Database.Database | null) => T): T { return action(store.db); },
    write<T>(action: (target: AppStore) => T): T { return action(store); },
  };
}

/**
 * 崩溃日志检查：上次进程可能在发布迁移包的中途退出。Journal 表或 .role-transfer
 * 目录仍有残留时先收敛，避免留下半换名的角色目录。运行态后端启动时已做过一次，
 * 这里保持幂等，让 CLI 与 HTTP 两条路径都能防御异常退出。
 */
function recoverPendingTransfer(config: BackendConfig, context: TransferContext): void {
  const hasJournal = context.read((db) => tableExists(db, "role_transfer_publication") &&
    Boolean(db!.prepare("SELECT 1 FROM role_transfer_publication WHERE singleton = 1").get()));
  const root = path.join(config.dataRoot, ".role-transfer");
  if (hasJournal || (checkedInstallEntry(root, "directory") && fs.readdirSync(root).length > 0)) {
    context.write((store) => recoverRoleTransfer(config, store));
  }
}

function withInstallation<T>(config: BackendConfig, file: string, action: () => T): T {
  const release = lockInstallation(config);
  try {
    assertPackageFileOutsideManagedDirs(config, file);
    recoverPendingTransfer(config, installationContext(config));
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

/**
 * 判断目标是否位于目录内（含目录本身）。
 *
 * Windows 文件系统大小写不敏感，比较前统一小写，避免 `AppRoot` 与
 * `approot` 之间的漏判。
 */
function isInsideDirectory(directory: string, target: string): boolean {
  const win32 = process.platform === "win32";
  const relative = path.relative(
    win32 ? directory.toLowerCase() : directory,
    win32 ? target.toLowerCase() : target,
  );
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/**
 * 校验迁移包路径：必须是 `.json` 且位于安装数据目录之外。
 * HTTP 层在异步读包前先调用它，保持与同步 CLI 相同的路径安全顺序。
 */
export function assertRoleTransferPackagePath(config: BackendConfig, file: string): void {
  assertPackageFileOutsideManagedDirs(config, file);
}

function assertPackageFileOutsideManagedDirs(config: BackendConfig, file: string): void {
  const target = path.resolve(file);
  // 迁移包必须是 JSON：先按扩展名拒绝明显不是迁移包的目标，避免误写到数据库等文件。
  if (path.extname(target).toLowerCase() !== ".json") throw new Error("ROLE_TRANSFER_PACKAGE_EXTENSION_INVALID");
  const parent = fs.realpathSync(path.dirname(target));
  const resolvedTarget = path.join(parent, path.basename(target));
  // 应用根目录与数据目录都禁止写入迁移包，防止覆盖安装数据或角色库。
  if (isInsideDirectory(fs.realpathSync(config.appRoot), resolvedTarget) ||
      isInsideDirectory(fs.realpathSync(config.dataRoot), resolvedTarget)) {
    throw new Error("ROLE_TRANSFER_PACKAGE_IN_MANAGED_DIRECTORY");
  }
}

function exportWithContext(
  config: BackendConfig,
  context: TransferContext,
  roleId: string,
  file: string,
  options?: ReadRoleTransferPackageOptions,
) {
  rolePaths(config.dataRoot, roleId);
  if (!checkTransferRoleDirectory(config, roleId)) throw new Error("ROLE_TRANSFER_ROLE_MISSING");
  // 导出与写入共用同一预算：同步 CLI 未显式传参时也必须采用默认上限，
  // 否则采集阶段会把默认值当成无限制。
  const maxBytes = options?.maxBytes ?? MAX_ROLE_TRANSFER_PACKAGE_BYTES;
  const pkg = captureRoleTransfer(config, roleId, [], { maxBytes });
  const evidence = timelineEvidence(pkg);
  const ancestors = context.read((db) => {
    const index = readIndex(db, roleId);
    if (index && (index.builtin_key ?? null) !== pkg.builtinKey) throw new Error("ROLE_TRANSFER_PRESET_IDENTITY_MISMATCH");
    return localSnapshots(db, roleId).filter((snapshot) => containsFacts(evidence.facts, snapshot.facts) ||
      keepsMessageAnchors(evidence, snapshot)).map(({ fingerprint }) => fingerprint);
  });
  const exported = roleTransferWithAncestors(pkg, ancestors);
  writeRoleTransferPackage(file, exported, { maxBytes });
  context.write((store) => store.db.transaction(() => saveSnapshot(store.db, pkg, evidence))());
  return { roleId, digest: exported.digest, timelineFingerprint: exported.timelineFingerprint, bindings: exported.bindings };
}

export function exportRoleTransfer(
  config: BackendConfig,
  roleId: string,
  file: string,
  options?: ReadRoleTransferPackageOptions,
) {
  return withInstallation(config, file, () => exportWithContext(config, installationContext(config), roleId, file, options));
}

/**
 * 运行态 HTTP 后端使用的导出：复用已打开的 `AppStore`，不再获取安装锁，
 * 也不关闭传入的 `store`。调用方负责先把角色停下来并驱逐角色库连接。
 * `options.maxBytes` 与导入共用同一 UTF-8 字节预算。
 */
export function exportRoleTransferWithStore(
  config: BackendConfig, store: AppStore, roleId: string, file: string,
  options?: ReadRoleTransferPackageOptions,
) {
  assertPackageFileOutsideManagedDirs(config, file);
  const context = openedStoreContext(store);
  recoverPendingTransfer(config, context);
  return exportWithContext(config, context, roleId, file, options);
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

function inspectTransfer(
  config: BackendConfig,
  context: TransferContext,
  file: string,
  mapping: TransferMapping,
  options?: ReadRoleTransferPackageOptions,
) {
  return inspectTransferPackage(config, context, readRoleTransferPackage(file, options), mapping);
}

/**
 * 使用已读取并校验过的包快照完成预检，不再重读文件。
 *
 * 运行态 HTTP 服务先用异步读取取得唯一快照，展示、守卫与令牌都基于它，
 * 避免同一次操作混用两份读包结果。
 */
function inspectTransferPackage(
  config: BackendConfig,
  context: TransferContext,
  incoming: RoleTransferPackage,
  mapping: TransferMapping,
) {
  const bindings = resolveRoleTransferBindings(config, incoming, mapping);
  const tables = portableTransferTables(incoming.tables);
  const portable = tables === incoming.tables ? incoming : { ...incoming, tables,
    timelineFingerprint: roleTransferTimelineFingerprint({ ...incoming, tables }) };
  const incomingEvidence = timelineEvidence(portable);
  const { roleId, builtinKey } = incoming;
  const hasDirectory = checkTransferRoleDirectory(config, roleId);
  return context.read((db) => {
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
    const relation = compareTimelines(local, portable, incomingEvidence, snapshots);
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
        localFingerprint: local?.timelineFingerprint ?? null, packageFingerprint: portable.timelineFingerprint,
        registered: Boolean(index), bindings: incoming.bindings, unresolved: bindings.unresolved,
      },
    };
  });
}

export function preflightRoleTransfer(config: BackendConfig, file: string, mapping: TransferMapping = {}) {
  return withInstallation(config, file, () => inspectTransfer(config, installationContext(config), file, mapping).preview);
}

/** 运行态 HTTP 后端使用的预检：复用已打开的 `AppStore`，不获取安装锁。 */
export function preflightRoleTransferWithStore(
  config: BackendConfig, store: AppStore, file: string, mapping: TransferMapping = {},
  options?: ReadRoleTransferPackageOptions,
) {
  assertPackageFileOutsideManagedDirs(config, file);
  const context = openedStoreContext(store);
  recoverPendingTransfer(config, context);
  return inspectTransfer(config, context, file, mapping, options).preview;
}

/**
 * 运行态 HTTP 预检（已读包）：调用方在异步读取前已完成路径检查与读取，
 * 本函数只收敛残余事务并基于这份已校验快照生成预检结果。
 */
export function preflightRoleTransferPackageWithStore(
  config: BackendConfig, store: AppStore,
  incoming: RoleTransferPackage, mapping: TransferMapping = {},
) {
  const context = openedStoreContext(store);
  recoverPendingTransfer(config, context);
  return inspectTransferPackage(config, context, incoming, mapping).preview;
}

/**
 * 使用已读取并校验过的包快照应用导入：令牌校验、守卫角色与发布都来自同一份快照。
 */
function applyInspectPackage(
  config: BackendConfig,
  context: TransferContext,
  incoming: RoleTransferPackage,
  token: string,
  mapping: TransferMapping,
  choice: TransferChoice | undefined,
  hook: PublicationHook | undefined,
) {
  const { preview, incomingEvidence, bindings, index, selection } =
    inspectTransferPackage(config, context, incoming, mapping);
  if (token !== preview.token) throw new Error("ROLE_TRANSFER_PREFLIGHT_STALE");
  if (preview.requiresChoice && !choice) throw new Error("ROLE_TRANSFER_CHOICE_REQUIRED");
  if (choice === "local") {
    if (preview.relation === "new") throw new Error("ROLE_TRANSFER_LOCAL_TIMELINE_MISSING");
    return { ...preview, outcome: "kept-local" };
  }
  const alreadyApplied = selection?.package_digest === incoming.digest && selection.target_fingerprint === bindings.targetFingerprint;
  if (preview.relation === "local-ahead" || (index && preview.relation === "same" &&
      (alreadyApplied || choice !== "package"))) return { ...preview, outcome: "unchanged" };
  context.write((store) => publishRoleTransfer(config, store, incoming, bindings, () => {
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
    // 媒体依赖投影跟随导入后的最终 service_id（目标机映射结果），
    // 与写入角色库的值保持一致；未解析的目标不登记依赖。
    const importedService = (capability: "voice" | "image"): string | null => {
      const binding = incoming.bindings.find(item => item.capability === capability);
      return binding ? (bindings.targets.get(binding.key)?.resourceId ?? null) : null;
    };
    store.setRoleMediaBinding(incoming.roleId, "voice", importedService("voice"), stoppedAt);
    store.setRoleMediaBinding(incoming.roleId, "image", importedService("image"), stoppedAt);
    saveSnapshot(store.db, { ...incoming, timelineFingerprint: preview.packageFingerprint }, incomingEvidence);
    store.db.prepare(`
      INSERT INTO role_transfer_selections (role_id, package_digest, target_fingerprint) VALUES (?, ?, ?)
      ON CONFLICT(role_id) DO UPDATE SET
        package_digest = excluded.package_digest, target_fingerprint = excluded.target_fingerprint
    `).run(incoming.roleId, incoming.digest, bindings.targetFingerprint);
  }, hook));
  return { ...preview, outcome: "published" };
}

function applyWithContext(
  config: BackendConfig,
  context: TransferContext,
  file: string,
  token: string,
  mapping: TransferMapping,
  choice: TransferChoice | undefined,
  hook: PublicationHook | undefined,
  options?: ReadRoleTransferPackageOptions,
) {
  return applyInspectPackage(config, context, readRoleTransferPackage(file, options), token, mapping, choice, hook);
}

export function applyRoleTransfer(
  config: BackendConfig,
  file: string,
  token: string,
  mapping: TransferMapping = {},
  choice?: TransferChoice,
  hook?: PublicationHook,
  options?: ReadRoleTransferPackageOptions,
) {
  return withInstallation(config, file, () =>
    applyWithContext(config, installationContext(config), file, token, mapping, choice, hook, options));
}

/** 运行态 HTTP 后端使用的导入：复用已打开的 `AppStore`，不获取安装锁。 */
export function applyRoleTransferWithStore(
  config: BackendConfig,
  store: AppStore,
  file: string,
  token: string,
  mapping: TransferMapping = {},
  choice?: TransferChoice,
  hook?: PublicationHook,
  options?: ReadRoleTransferPackageOptions,
) {
  assertPackageFileOutsideManagedDirs(config, file);
  const context = openedStoreContext(store);
  recoverPendingTransfer(config, context);
  return applyWithContext(config, context, file, token, mapping, choice, hook, options);
}

/**
 * 运行态 HTTP 导入（已读包）：调用方在异步读取前已完成路径检查与读取，
 * 本函数收敛残余事务，再以这份已校验快照完成令牌、守卫与发布。
 */
export function applyRoleTransferPackageWithStore(
  config: BackendConfig,
  store: AppStore,
  incoming: RoleTransferPackage,
  token: string,
  mapping: TransferMapping = {},
  choice?: TransferChoice,
  hook?: PublicationHook,
) {
  const context = openedStoreContext(store);
  recoverPendingTransfer(config, context);
  return applyInspectPackage(config, context, incoming, token, mapping, choice, hook);
}
