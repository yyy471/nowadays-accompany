import fs from "node:fs";
import type { RolePaths } from "../bootstrap/config.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { RoleStore } from "./role-store.js";

export type RoleStorageMode = "initialize" | "open";

export class RoleStorage {
  readonly paths: RolePaths;
  readonly business: RoleStore;
  readonly checkpoint: CheckpointStore;
  private closed = false;

  constructor(paths: RolePaths, mode: RoleStorageMode = "initialize") {
    this.paths = paths;
    if (mode === "open") {
      assertExistingRolePaths(paths);
    } else {
      fs.mkdirSync(paths.workspaceDir, { recursive: true });
      fs.mkdirSync(paths.appearanceDir, { recursive: true });
      fs.mkdirSync(paths.voiceDir, { recursive: true });
    }
    const create = mode === "initialize";
    this.business = new RoleStore(paths.businessDatabasePath, { create });
    try {
      this.checkpoint = new CheckpointStore(paths.executionDatabasePath, {
        create,
      });
    } catch (error) {
      this.business.close();
      throw error;
    }
  }

  static openExisting(paths: RolePaths): RoleStorage {
    return new RoleStorage(paths, "open");
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.checkpoint.close();
    this.business.close();
  }
}

function assertExistingRolePaths(paths: RolePaths): void {
  assertPath(paths.roleDir, "directory", "role");
  assertPath(paths.workspaceDir, "directory", "workspace");
  assertPath(paths.businessDatabasePath, "file", "business");
  assertPath(paths.executionDatabasePath, "file", "execution");
}

function assertPath(
  target: string,
  kind: "file" | "directory",
  label: string,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`ROLE_STORAGE_PATH_MISSING:${label}`);
  }
  const valid = kind === "file" ? stat.isFile() : stat.isDirectory();
  if (!valid) {
    throw new Error(`ROLE_STORAGE_PATH_INVALID:${label}`);
  }
}