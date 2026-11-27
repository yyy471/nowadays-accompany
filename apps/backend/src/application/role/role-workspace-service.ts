import fs from "node:fs";
import path from "node:path";
import { rolePaths } from "../../bootstrap/config.js";
import { AppError } from "../../domain/errors.js";
import type { RoleAccess } from "../role/role-access.js";

export interface RoleWorkspaceServiceDeps {
  dataRoot: string;
  roleAccess: RoleAccess;
}

export interface WorkspaceNoteEntry {
  relativePath: string;
  name: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface WorkspaceNote extends WorkspaceNoteEntry {
  content: string;
}

const MAX_WALK_DEPTH = 6;
const MAX_NOTE_ENTRIES = 500;
const MAX_NOTE_BYTES = 512 * 1024;
const NOTE_EXTENSIONS = [".md", ".markdown"] as const;

function invalidNotePath(): AppError {
  return new AppError(400, "WORKSPACE_NOTE_PATH_INVALID", "笔记路径无效");
}

function noteNotFound(): AppError {
  return new AppError(404, "WORKSPACE_NOTE_NOT_FOUND", "未找到对应笔记");
}

function isNoteExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return NOTE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * 把请求里的相对路径拆成安全段。
 *
 * 只接受工作空间内的相对笔记路径：拒绝绝对路径、盘符、空段、`.`/`..`
 * 以及非 Markdown 扩展名，避免借由路径穿越读取角色目录之外的文件。
 */
function splitNotePath(relativePath: string): string[] {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0")) {
    throw invalidNotePath();
  }
  if (relativePath.startsWith("/") || relativePath.startsWith("\\")) throw invalidNotePath();
  // Windows 盘符与 UNC 前缀都视为绝对路径。
  if (/^[A-Za-z]:/.test(relativePath) || relativePath.startsWith("\\\\")) throw invalidNotePath();
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw invalidNotePath();
  }
  if (!isNoteExtension(segments[segments.length - 1]!)) throw invalidNotePath();
  return segments;
}

/**
 * 角色工作空间 Markdown 笔记的只读浏览（409 UX-05）。
 *
 * 不跟随符号链接，不越过工作空间根目录，并对预览大小与列表规模设上限；
 * 路径一律返回 POSIX 形式，方便前端与跨平台界面统一展示。
 */
export class RoleWorkspaceService {
  constructor(private readonly deps: RoleWorkspaceServiceDeps) {}

  getWorkspaceDir(roleId: string): string {
    this.deps.roleAccess.requireReady(roleId);
    const dir = rolePaths(this.deps.dataRoot, roleId).workspaceDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const info = fs.lstatSync(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AppError(400, "WORKSPACE_PATH_INVALID", "角色工作空间路径无效");
    }
    return fs.realpathSync(dir);
  }

  listNotes(roleId: string): WorkspaceNoteEntry[] {
    const root = this.getWorkspaceDir(roleId);
    const items: WorkspaceNoteEntry[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth >= MAX_WALK_DEPTH || items.length >= MAX_NOTE_ENTRIES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (items.length >= MAX_NOTE_ENTRIES) return;
        // 隐藏项与符号链接都不进入浏览范围。
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        let info: fs.Stats;
        try {
          info = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        if (!info.isFile() || !isNoteExtension(entry.name)) continue;
        items.push({
          relativePath: path.relative(root, full).split(path.sep).join("/"),
          name: entry.name,
          sizeBytes: info.size,
          updatedAt: info.mtime.toISOString(),
        });
      }
    };
    walk(root, 0);
    items.sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
      return left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0;
    });
    return items;
  }

  readNote(roleId: string, relativePath: string): WorkspaceNote {
    const segments = splitNotePath(relativePath);
    const root = this.getWorkspaceDir(roleId);
    let target = root;
    for (const segment of segments) {
      target = path.join(target, segment);
      let info: fs.Stats;
      try {
        info = fs.lstatSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw noteNotFound();
        throw error;
      }
      if (info.isSymbolicLink()) throw invalidNotePath();
    }
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw noteNotFound();
    const real = fs.realpathSync(target);
    const relative = path.relative(root, real);
    if (relative === "" || relative === ".." || path.isAbsolute(relative) ||
        relative.startsWith(`..${path.sep}`)) {
      throw invalidNotePath();
    }
    if (stat.size > MAX_NOTE_BYTES) {
      throw new AppError(413, "WORKSPACE_NOTE_TOO_LARGE", "笔记文件超过 512 KiB 预览上限");
    }
    return {
      relativePath: segments.join("/"),
      name: path.basename(real),
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      content: fs.readFileSync(real, "utf8"),
    };
  }
}
