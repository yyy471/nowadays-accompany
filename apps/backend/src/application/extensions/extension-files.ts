import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../domain/errors.js";

function component(value: string) {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value) && !value.endsWith(".") &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
export const extIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).refine(component);
const relativeFile = z.string().max(240).refine(s => s.split("/").every(component));
const sourceFile = relativeFile.refine(s => s.endsWith(".mjs") || s.startsWith("ui/"),
  "文件名须使用原始相对路径，例如 index.mjs 或 ui/index.html，并与清单一致");
export const sourceQuery = z.object({
  extId: extIdSchema, file: sourceFile.optional(), version: z.string().max(64).refine(component).optional(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});
export const definition = z.object({
  version: z.string().max(64).refine(component),
  entry: relativeFile.refine(s => s.endsWith(".mjs")),
  ui: z.array(z.object({ slot: z.string().min(1), file: relativeFile.refine(s => s.startsWith("ui/")) })).default([]),
});
export const upsertSchema = z.object({
  extId: extIdSchema, manifest: definition,
  files: z.record(sourceFile, z.string()),
});
export const uiActionPayloadBytes = 16 * 1024;
export const uiActionSchema = z.object({
  version: definition.shape.version,
  action: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/),
  payload: z.json(),
});
export const toolSpec = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  description: z.string().min(1), inputSchema: z.record(z.string(), z.unknown()).refine(s => s.type === "object"),
  scope: z.enum(["admin_only", "all_roles"]),
});
export type ToolSpec = z.infer<typeof toolSpec>;
const manifestSchema = definition.extend({
  status: z.enum(["enabled", "disabled", "failed"]),
  tools: z.array(toolSpec),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  // KV 与版本指针在同一扩展内原子落盘，状态查询只投影公开字段。
  kv: z.record(z.string(), z.unknown()).default({}),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type Definition = z.infer<typeof definition>;

export class ExtensionFiles {
  private readonly root: string;
  constructor(appRoot: string, private readonly directory: "extensions" | "extensions-work" = "extensions") { this.root = fs.realpathSync.native(appRoot); }

  // 对不存在的尾部逐级核实最近父目录。拒绝链接本身，包括悬空 junction。
  private checked(...parts: string[]): string {
    let current = this.root;
    for (const part of [this.directory, ...parts.flatMap(s => s.split("/"))]) {
      if (!component(part)) throw new AppError(400, "EXTENSION_PATH_INVALID", "扩展路径包含非法分量");
      current = path.join(current, part);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (stat && (stat.isSymbolicLink() || fs.realpathSync.native(current) !== current ||
          (stat.isFile() && stat.nlink !== 1))) {
        throw new AppError(400, "EXTENSION_PATH_INVALID", "扩展路径必须位于独立受管目录中", { part });
      }
    }
    return current;
  }
  private draftParts(id: string, jobId?: string) {
    extIdSchema.parse(id);
    return jobId === undefined ? [id] : ["0-pi-jobs", z.uuid().parse(jobId), id];
  }
  workspacePath(id: string, jobId?: string) {
    return this.checked(...this.draftParts(id, jobId));
  }
  workspace(id: string, jobId?: string) {
    const target = this.workspacePath(id, jobId);
    fs.mkdirSync(target, { recursive: true });
    return this.workspacePath(id, jobId);
  }
  discardJob(jobId: string) {
    fs.rmSync(this.checked("0-pi-jobs", z.uuid().parse(jobId)), { recursive: true, force: true });
  }
  draft(id: string, jobId?: string) {
    const parts = this.draftParts(id, jobId);
    const manifest = definition.parse(JSON.parse(fs.readFileSync(this.checked(...parts, "manifest.json"), "utf8")));
    const files: Record<string, Buffer> = Object.create(null);
    const collect = (prefix: string) => {
      for (const entry of fs.readdirSync(this.checked(...parts, ...prefix.split("/").filter(Boolean)), { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const file = this.checked(...parts, name);
        if (entry.isDirectory()) collect(name + "/");
        else if (sourceFile.safeParse(name).success) {
          if (!fs.statSync(file).isFile()) throw new AppError(400, "EXTENSION_PATH_INVALID", "草稿包含非普通文件");
          files[name] = fs.readFileSync(file);
        }
      }
    };
    collect("");
    return { manifest, files };
  }
  ids() {
    const root = this.checked();
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(id => extIdSchema.safeParse(id).success);
  }
  read(id: string): Manifest | undefined {
    const file = this.checked(id, "manifest.json");
    if (!fs.existsSync(file)) return;
    return manifestSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  }
  uiAsset(id: string, spec: Manifest, file: string) {
    const missing = () => new AppError(404, "EXTENSION_ASSET_NOT_FOUND", "此扩展资源不可用");
    if (!file.startsWith("ui/") || /\.mjs$/i.test(file) || file === spec.entry ||
        !spec.ui.some(item => item.file === file)) throw missing();
    try {
      const target = this.checked(id, "versions", spec.version, file);
      if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) throw missing();
      return fs.readFileSync(target);
    } catch (error) {
      if (error instanceof AppError && error.code === "EXTENSION_PATH_INVALID") throw missing();
      throw error;
    }
  }
  save(id: string, record: Manifest) {
    const target = this.checked(id, "manifest.json");
    const temp = this.checked(id, randomUUID() + ".tmp");
    fs.writeFileSync(temp, JSON.stringify(record), { flag: "wx" });
    try { fs.renameSync(temp, target); }
    finally { fs.rmSync(this.checked(id, path.basename(temp)), { force: true }); }
  }
  private verifyTree(parts: string[], visit?: (parts: string[]) => void): void {
    const base = this.checked(...parts);
    for (const name of fs.readdirSync(base)) {
      const child = [...parts, name];
      const stat = fs.statSync(this.checked(...child));
      if (stat.isDirectory()) this.verifyTree(child, visit);
      else if (!stat.isFile()) throw new AppError(400, "EXTENSION_PATH_INVALID", "扩展目录包含非普通文件");
      else visit?.(child);
    }
  }
  source(id: string, version: string, file: string | undefined, offset: number) {
    const parts = [id, "versions", version];
    if (file === undefined) {
      const names: string[] = [];
      this.verifyTree(parts, child => {
        const name = child.slice(parts.length).join("/");
        if (sourceFile.safeParse(name).success) names.push(name);
      });
      names.sort();
      const files = names.slice(offset, offset + 50);
      const end = offset + files.length;
      return { extId: id, version, files, nextOffset: end < names.length ? end : null };
    }
    const target = this.checked(...parts, file);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new AppError(404, "EXTENSION_FILE_MISSING", "此版本没有该源码文件", { file });
    const invalidOffset = () => new AppError(400, "EXTENSION_SOURCE_OFFSET_INVALID", "请使用上一页返回的 UTF-8 字节偏移");
    if (offset > stat.size) throw invalidOffset();
    const fd = fs.openSync(target, "r");
    try {
      // 多读一字节以判断分页边缘，完整保留中文和非 BMP 字符。
      const buffer = Buffer.alloc(Math.min(6001, stat.size - offset));
      const size = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (size && (buffer[0]! & 0xc0) === 0x80) throw invalidOffset();
      let end = Math.min(6000, size);
      while (end < size && (buffer[end]! & 0xc0) === 0x80) end--;
      return { extId: id, version, file, content: buffer.toString("utf8", 0, end),
        nextOffset: offset + end < stat.size ? offset + end : null };
    } finally { fs.closeSync(fd); }
  }
  entry(id: string, spec: Definition) {
    const parts = [id, "versions", spec.version];
    this.verifyTree(parts);
    for (const file of [spec.entry, ...spec.ui.map(item => item.file)]) {
      if (!fs.statSync(this.checked(...parts, file), { throwIfNoEntry: false })?.isFile())
        throw new AppError(400, "EXTENSION_FILE_MISSING", "扩展声明的文件不存在", { file });
    }
    return { dir: this.checked(...parts), entry: this.checked(...parts, spec.entry) };
  }
  stage(id: string, spec: Definition, files: Record<string, string | Buffer>) {
    const parts = [id, "versions", spec.version];
    const dir = this.checked(...parts);
    fs.mkdirSync(this.checked(id, "versions"), { recursive: true });
    if (fs.existsSync(dir)) throw new AppError(409, "EXTENSION_VERSION_EXISTS", "请为新版选择独立的版本目录");
    fs.mkdirSync(dir);
    try {
      for (const [file, source] of Object.entries(files)) {
        const target = this.checked(...parts, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source, { flag: "wx" });
      }
      this.entry(id, spec);
    } catch (error) { this.remove(id, spec.version); throw error; }
  }
  remove(id: string, version?: string) {
    const parts = version === undefined ? [id] : [id, "versions", version];
    this.verifyTree(parts);
    fs.rmSync(this.checked(...parts), { recursive: true });
  }
}
