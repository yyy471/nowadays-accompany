import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { BackendConfig } from "../../bootstrap/config.js";

export function checkedInstallEntry(target: string, kind: "directory" | "file"): boolean {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return false;
  if (stat.isSymbolicLink() ||
      (kind === "directory" ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    throw new Error("ROLE_TRANSFER_UNSAFE_INSTALLATION_PATH");
  }
  return true;
}

/** SQLite 持有独立文件的系统级排他写锁，进程异常退出时由操作系统释放。 */
export function lockInstallation(config: BackendConfig): () => void {
  if (path.resolve(config.dataRoot) !== path.resolve(config.appRoot, "data") ||
      path.resolve(config.appDatabasePath) !== path.resolve(config.dataRoot, "app.sqlite")) {
    throw new Error("ROLE_TRANSFER_UNSAFE_INSTALLATION_PATH");
  }
  if (!checkedInstallEntry(config.appRoot, "directory")) {
    fs.mkdirSync(config.appRoot, { recursive: true, mode: 0o700 });
  }
  if (!checkedInstallEntry(config.dataRoot, "directory")) {
    fs.mkdirSync(config.dataRoot, { recursive: true, mode: 0o700 });
  }
  const lockPath = path.join(config.dataRoot, ".installation-lock.sqlite");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) checkedInstallEntry(lockPath + suffix, "file");
  let db: Database.Database | undefined;
  try {
    db = new Database(lockPath, { timeout: 0 });
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db?.close();
    if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes((error as { code?: string }).code ?? "")) {
      throw new Error("INSTALLATION_BUSY");
    }
    throw error;
  }
  const connection = db;
  return () => { if (connection.open) connection.close(); };
}

export function checkAppDatabaseFiles(config: BackendConfig): boolean {
  const exists = checkedInstallEntry(config.appDatabasePath, "file");
  for (const suffix of ["-journal", "-wal", "-shm"]) checkedInstallEntry(config.appDatabasePath + suffix, "file");
  return exists;
}
