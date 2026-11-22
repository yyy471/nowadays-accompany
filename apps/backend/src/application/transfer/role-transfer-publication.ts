import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rolePaths, type BackendConfig, type RolePaths } from "../../bootstrap/config.js";
import type { AppStore } from "../../storage/core/app-store.js";
import { checkedInstallEntry } from "../../storage/core/installation-lock.js";
import { stageRoleTransfer, type RoleTransferBindings, type RoleTransferPackage } from "./role-transfer-package.js";

const transferDirectory = ".role-transfer";
const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type PublicationPoint = "staged" | "prepared" | "local-renamed" | "package-renamed" | "committed" | "rollback-unpublished" | "rollback-restored";
export type PublicationHook = (point: PublicationPoint) => void;

interface Journal {
  operation_id: string;
  role_id: string;
  had_local: 0 | 1;
  phase: "prepared" | "committed";
}

function operationPaths(config: BackendConfig, operationId: string) {
  if (!operationIdPattern.test(operationId)) throw new Error("ROLE_TRANSFER_JOURNAL_INVALID");
  const root = path.join(config.dataRoot, transferDirectory);
  checkedInstallEntry(root, "directory");
  const operation = path.join(root, operationId);
  checkedInstallEntry(operation, "directory");
  return {
    root,
    operation,
    backup: path.join(operation, "backup"),
    discarded: path.join(operation, "discarded"),
    stagedDir: path.join(operation, "incoming"),
  };
}

export function checkTransferRoleDirectory(config: BackendConfig, roleId: string): boolean {
  const folder = path.join(config.dataRoot, "roles");
  if (!checkedInstallEntry(folder, "directory")) return false;
  if (fs.readdirSync(folder).some((name) => name !== roleId && name.toLowerCase() === roleId.toLowerCase())) {
    throw new Error("ROLE_TRANSFER_ROLE_ID_ALIAS");
  }
  const paths = rolePaths(config.dataRoot, roleId);
  const exists = checkedInstallEntry(paths.roleDir, "directory");
  if (exists) {
    for (const db of [paths.businessDatabasePath, paths.executionDatabasePath]) {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) checkedInstallEntry(db + suffix, "file");
    }
  }
  return exists;
}

function syncDirectory(dir: string): void {
  // Windows 上 Node 无法打开目录句柄执行 fsync；业务库使用 SQLite FULL 持久化。
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function syncTree(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const target = path.join(dir, name);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      syncTree(target);
    } else {
      checkedInstallEntry(target, "file");
      const fd = fs.openSync(target, "r+");
      try { fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
  }
  syncDirectory(dir);
}

function renameDurably(source: string, destination: string): void {
  fs.renameSync(source, destination);
  syncDirectory(path.dirname(source));
  syncDirectory(path.dirname(destination));
}

function removeOperation(operation: string): void {
  if (!checkedInstallEntry(operation, "directory")) return;
  fs.rmSync(operation, { recursive: true, maxRetries: 3, retryDelay: 50 });
  syncDirectory(path.dirname(operation));
}

export function recoverRoleTransfer(config: BackendConfig, store: AppStore, hook?: PublicationHook): void {
  const pending = store.db.prepare(
    "SELECT operation_id, role_id, had_local, phase FROM role_transfer_publication WHERE singleton = 1",
  ).get() as Journal | undefined;
  if (pending) {
    const { operation, backup, discarded, stagedDir } = operationPaths(config, pending.operation_id);
    const live = rolePaths(config.dataRoot, pending.role_id).roleDir;
    const liveExists = checkTransferRoleDirectory(config, pending.role_id);
    const backupExists = checkedInstallEntry(backup, "directory");
    const discardedExists = checkedInstallEntry(discarded, "directory");
    const stagedExists = checkedInstallEntry(stagedDir, "directory");

    if (pending.phase === "committed") {
      if (!liveExists || stagedExists || discardedExists) throw new Error("ROLE_TRANSFER_COMMITTED_FILES_MISSING");
    } else if (pending.had_local === 1) {
      if (backupExists) {
        if (liveExists) {
          if (discardedExists || stagedExists) throw new Error("ROLE_TRANSFER_ROLLBACK_FILES_INVALID");
          renameDurably(live, discarded);
          hook?.("rollback-unpublished");
        }
        renameDurably(backup, live);
        hook?.("rollback-restored");
      } else if (!liveExists) {
        throw new Error("ROLE_TRANSFER_ROLLBACK_FILES_MISSING");
      }
    } else if (liveExists) {
      if (stagedExists || backupExists || discardedExists) throw new Error("ROLE_TRANSFER_ROLLBACK_FILES_INVALID");
      renameDurably(live, discarded);
      hook?.("rollback-unpublished");
    }

    removeOperation(operation);
    store.db.prepare("DELETE FROM role_transfer_publication WHERE singleton = 1").run();
  }

  // 暂存后、写日志前退出，只会留下可识别的空闲事务目录。
  const root = path.join(config.dataRoot, transferDirectory);
  if (!checkedInstallEntry(root, "directory")) return;
  for (const entry of fs.readdirSync(root)) {
    if (operationIdPattern.test(entry)) removeOperation(path.join(root, entry));
  }
}

export function publishRoleTransfer(
  config: BackendConfig,
  store: AppStore,
  pkg: RoleTransferPackage,
  bindings: RoleTransferBindings,
  commit: () => void,
  hook?: PublicationHook,
): void {
  const operationId = randomUUID();
  const { root, operation, backup, stagedDir } = operationPaths(config, operationId);
  const live = rolePaths(config.dataRoot, pkg.roleId).roleDir;
  // 暂存目录保持短路径，兼容 Windows SQLite 文件名长度限制。
  const staged: RolePaths = {
    roleId: pkg.roleId,
    roleDir: stagedDir,
    businessDatabasePath: path.join(stagedDir, "business.sqlite"),
    executionDatabasePath: path.join(stagedDir, "execution.sqlite"),
    workspaceDir: path.join(stagedDir, "workspace"),
    appearanceDir: path.join(stagedDir, "appearance"),
    voiceDir: path.join(stagedDir, "voice"),
    sceneImageDir: path.join(stagedDir, "scene-images"),
  };
  const hadLocal = checkTransferRoleDirectory(config, pkg.roleId);
  try {
    fs.mkdirSync(operation, { recursive: true, mode: 0o700 });
    stageRoleTransfer(staged, pkg, bindings);
    syncTree(operation);
    syncDirectory(root);
    syncDirectory(config.dataRoot);
    hook?.("staged");

    if (!checkedInstallEntry(path.dirname(live), "directory")) {
      fs.mkdirSync(path.dirname(live), { mode: 0o700 });
      syncDirectory(config.dataRoot);
    }
    // 角色索引、活动标记与发布提交标记同事务，恢复只依赖持久化状态。
    store.db.pragma("synchronous = FULL");
    store.db.prepare(`
      INSERT INTO role_transfer_publication (singleton, operation_id, role_id, had_local, phase)
      VALUES (1, ?, ?, ?, 'prepared')
    `).run(operationId, pkg.roleId, hadLocal ? 1 : 0);
    hook?.("prepared");
    if (hadLocal) {
      renameDurably(live, backup);
      hook?.("local-renamed");
    }
    renameDurably(staged.roleDir, live);
    hook?.("package-renamed");
    store.db.transaction(() => {
      commit();
      store.db.prepare("UPDATE role_transfer_publication SET phase = 'committed' WHERE singleton = 1").run();
    })();
    hook?.("committed");
    recoverRoleTransfer(config, store);
  } catch (error) {
    recoverRoleTransfer(config, store, hook);
    throw error;
  }
}
