import fs from "node:fs";
import path from "node:path";
import { sha256, type TransferTables } from "./role-transfer-data.js";
import type { RoleTransferCredentialFilter } from "./role-transfer-credentials.js";

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
    ["outfit_assets", "appearance"], ["voice_assets", "voice"], ["scene_image_assets", "scene-images"],
  ] as const) {
    for (const row of tables[table]) {
      const relative = row.relative_path;
      if (typeof relative !== "string" || !relative.startsWith(`${root}/`) || components(relative).length < 2) badPath();
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

export function captureTransferFiles(roleDir: string, tables: TransferTables, credentials: RoleTransferCredentialFilter): TransferFile[] {
  const files: TransferFile[] = [];
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
    const data = fs.readFileSync(source);
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
