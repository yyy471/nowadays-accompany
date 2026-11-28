import fs from "node:fs";
import path from "node:path";
import { sha256, type TransferTables } from "./role-transfer-data.js";
import type { RoleTransferCredentialFilter } from "./role-transfer-credentials.js";
import { detectImageFormat } from "../media/image-inspect.js";
import { MAX_SCENE_REFERENCE_BYTES } from "../../storage/media/scene-reference.js";

export type TransferFile =
  | { path: string; kind: "directory" }
  | { path: string; kind: "file"; sha256: string; byteSize: number; data: string };

function badPath(): never { throw new Error("ROLE_TRANSFER_UNSAFE_PATH"); }

function components(relative: string): string[] {
  const parts = relative.split("/");
  for (const part of parts) {
    if (part === "" || part.length > 255 || /[<>:"\\|?*\x00-\x1f\x7f]/u.test(part) ||
        /[ .]$/u.test(part) || /~[0-9]+(?:\.|$)/u.test(part) ||
        /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?: *\.|$)/iu.test(part)) badPath();
  }
  return parts;
}

/**
 * 有界读取普通文件。
 *
 * 先用 fd 的 stat 结果校验体积，再只为声明大小分配缓冲区并读取至多
 * `stat.size + 1` 字节。这样即便文件在 stat 与读取之间被替换或增长，
 * 也不会一次性分配超过上限的内存，并能立即识别增长绕过。
 */
export function readBoundedFile(file: string, maxBytes: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("ROLE_TRANSFER_UNSAFE_PATH");
    if (stat.size > maxBytes) throw new Error("ROLE_TRANSFER_PACKAGE_TOO_LARGE");
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = fs.readSync(fd, buffer, total, buffer.length - total, total);
      if (read === 0) break;
      total += read;
    }
    if (total > stat.size) throw new Error("ROLE_TRANSFER_PACKAGE_TOO_LARGE");
    if (total < stat.size) throw new Error("ROLE_TRANSFER_PACKAGE_INVALID");
    return buffer.subarray(0, total);
  } finally {
    fs.closeSync(fd);
  }
}

export function assertRegularPath(root: string, relative: string, directory: boolean): string {
  const parts = components(relative);
  let visible = root;
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) badPath();
  for (const [index, part] of parts.entries()) {
    visible = path.join(visible, part);
    const info = fs.lstatSync(visible, { throwIfNoEntry: false });
    if (!info || info.isSymbolicLink()) badPath();
    if (directory || index < parts.length - 1) {
      if (!info.isDirectory()) badPath();
    } else if (!info.isFile() || info.nlink !== 1) badPath();
  }
  return visible;
}

function materialPaths(tables: TransferTables): Set<string> {
  const paths = new Set<string>();
  for (const [table, root] of [
    ["outfit_assets", "appearance"], ["role_scene_references", "appearance"], ["voice_assets", "voice"], ["scene_image_assets", "scene-images"],
  ] as const) {
    for (const row of tables[table] ?? []) {
      const relative = row.relative_path;
      if (typeof relative !== "string" || !relative.startsWith(`${root}/`) || components(relative).length < 2) badPath();
      if (table === "role_scene_references") {
        const extension = row.media_type === "image/png" ? "png" : row.media_type === "image/jpeg" ? "jpg" : row.media_type === "image/webp" ? "webp" : null;
        if (!extension || typeof row.asset_id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.asset_id) ||
            relative !== `appearance/${row.asset_id}.${extension}`) badPath();
      }
      if (paths.has(relative)) throw new Error("ROLE_TRANSFER_DUPLICATE_FILE");
      paths.add(relative);
    }
  }
  for (const row of tables.diaries) {
    if (typeof row.relative_path !== "string") badPath();
    components(row.relative_path);
  }
  return paths;
}

/** Base64 与路径都是最终 JSON 的确定子集，可作为超限判定的保守下界。 */
function projectedFileBytes(relative: string, byteSize: number): number {
  return Math.ceil(byteSize / 3) * 4 + Buffer.byteLength(relative, "utf8");
}

export function captureTransferFiles(
  roleDir: string,
  tables: TransferTables,
  credentials: RoleTransferCredentialFilter,
  maxBytes = Number.POSITIVE_INFINITY,
): TransferFile[] {
  const files: TransferFile[] = [];
  let projectedBytes = 0;
  function capture(relative: string, directory: boolean): void {
    const location = `files:${files.length + 1}`;
    credentials.assertSafeData(Buffer.from(relative), location);
    const source = assertRegularPath(roleDir, relative, directory);
    if (directory) {
      files.push({ path: relative, kind: "directory" });
      const entries = fs.readdirSync(source, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => comparePath(a.name, b.name))) {
        capture(`${relative}/${entry.name}`, entry.isDirectory());
      }
      return;
    }
    // 先按 stat 预估 Base64 后的累计体积；明显超限时在读取和编码前终止。
    const projected = projectedFileBytes(relative, fs.statSync(source).size);
    if (projectedBytes + projected > maxBytes) throw new Error("ROLE_TRANSFER_PACKAGE_TOO_LARGE");
    // 剩余预算按 Base64 膨胀比折算回原始字节，读取期间文件增长也不能越过总预算。
    const remaining = Math.max(0, Math.floor((maxBytes - projectedBytes) * 3 / 4));
    projectedBytes += projected;
    const data = readBoundedFile(source, remaining);
    credentials.assertSafeData(data, location);
    files.push({ path: relative, kind: "file", sha256: sha256(data), byteSize: data.length, data: data.toString("base64") });
  }
  capture("workspace", true);
  for (const asset of materialPaths(tables)) capture(asset, false);
  return files.sort((a, b) => comparePath(a.path, b.path));
}

function comparePath(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function validateTransferFiles(files: TransferFile[], tables: TransferTables): void {
  const required = materialPaths(tables);
  const references = new Map((tables.role_scene_references ?? []).map(row => [row.relative_path, row.media_type]));
  const registry = new Map<string, { path: string; kind: TransferFile["kind"]; seen: boolean }>();
  for (const entry of files) {
    const parts = components(entry.path);
    const workspace = parts[0] === "workspace";
    if ((!workspace && (entry.kind !== "file" || !required.delete(entry.path))) ||
        (parts.length === 1 && (!workspace || entry.kind !== "directory"))) throw new Error("ROLE_TRANSFER_UNMANAGED_FILE");
    for (let index = 1; index <= parts.length; index++) {
      const componentPath = parts.slice(0, index).join("/");
      const windowsKey = componentPath.normalize("NFC").toUpperCase();
      const explicit = index === parts.length;
      const kind = explicit ? entry.kind : "directory";
      const previous = registry.get(windowsKey);
      if (previous !== undefined && (previous.path !== componentPath || previous.kind !== kind || (explicit && previous.seen))) {
        throw new Error("ROLE_TRANSFER_DUPLICATE_FILE");
      }
      registry.set(windowsKey, { path: componentPath, kind, seen: explicit || (previous?.seen ?? false) });
    }
    if (entry.kind === "file") {
      const data = Buffer.from(entry.data, "base64");
      if (data.length !== entry.byteSize || data.toString("base64") !== entry.data || sha256(data) !== entry.sha256) {
        throw new Error("ROLE_TRANSFER_FILE_DIGEST_MISMATCH");
      }
      if (references.has(entry.path) && (data.length > MAX_SCENE_REFERENCE_BYTES || detectImageFormat(data)?.mediaType !== references.get(entry.path))) {
        throw new Error("ROLE_TRANSFER_REFERENCE_INVALID");
      }
    }
  }
  if (required.size || !registry.get("WORKSPACE")?.seen) throw new Error("ROLE_TRANSFER_FILE_MISSING");
}

export function stageTransferFiles(roleDir: string, entries: TransferFile[]): void {
  for (const { path: relative, ...entry } of entries) {
    const target = path.join(roleDir, ...components(relative));
    if (entry.kind === "directory") {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(entry.data, "base64"), { flag: "wx", mode: 0o600, flush: true });
    }
  }
}
