import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { SkillFileInvalidError, SkillNotFoundError } from "../domain/errors.js";

export interface SkillMetadata {
  name: string;
  description: string;
  directory: string;
}

export interface SkillDocument extends SkillMetadata {
  body: string;
}

export class SkillLibrary {
  constructor(private readonly root: string) {}

  list(onInvalid?: (directory: string) => void): SkillMetadata[] {
    const root = path.resolve(this.root);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return [];
    }
    const direct = path.join(root, "SKILL.md");
    if (fs.statSync(direct, { throwIfNoEntry: false })?.isFile()) {
      return [readMetadata(safeChild(root, "SKILL.md"), path.basename(root))];
    }
    const items: SkillMetadata[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const file = path.join(root, entry.name, "SKILL.md");
        if (fs.statSync(file, { throwIfNoEntry: false })?.isFile())
          items.push(readMetadata(safeChild(safeChild(root, entry.name), "SKILL.md"), entry.name));
      } catch (error) {
        if (!onInvalid) throw error;
        onInvalid(entry.name);
      }
    }
    return items.sort((left, right) => left.name.localeCompare(right.name));
  }

  /** 只允许导入刚从该来源发现的包。兼容单技能和上一级技能库。 */
  discover() {
    const root = path.resolve(this.root);
    const single = fs.statSync(path.join(root, "SKILL.md"), { throwIfNoEntry: false })?.isFile();
    return this.list().map(item => ({
      ...item, sourcePath: single ? root : path.join(root, item.directory),
    }));
  }

  read(name: string): SkillDocument {
    const skillFile = this.skillFile(name);
    const text = fs.readFileSync(skillFile, "utf8");
    const parsed = splitFrontmatter(text);
    const metadata = readMetadata(skillFile, name);
    return {
      ...metadata,
      body: parsed.body,
    };
  }

  readFile(name: string, relativePath: string): {
    name: string;
    path: string;
    content: string;
  } {
    const skillDir = this.skillDirectory(name);
    let target: string;
    try {
      target = safeChild(skillDir, relativePath);
    } catch {
      throw new SkillFileInvalidError(name, relativePath);
    }
    if (target === path.resolve(skillDir)) {
      throw new SkillFileInvalidError(name, relativePath);
    }
    let content: string;
    try {
      const fd = fs.openSync(target, "r");
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new SkillFileInvalidError(name, relativePath);
        const buffer = Buffer.alloc(stat.size);
        let used = 0;
        while (used < buffer.length) {
          const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
          if (!count) break;
          used += count;
        }
        content = buffer.toString("utf8", 0, used);
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error instanceof SkillFileInvalidError) {
        throw error;
      }
      throw new SkillFileInvalidError(name, relativePath);
    }
    return {
      name,
      path: path.relative(skillDir, target).split(path.sep).join("/"),
      content,
    };
  }

  private skillDirectory(name: string): string {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new SkillNotFoundError(name);
    }
    const root = path.resolve(this.root);
    const direct = path.join(root, "SKILL.md");
    if (fs.statSync(direct, { throwIfNoEntry: false })?.isFile()) {
      if (name === path.basename(root) || name === readMetadata(safeChild(root, "SKILL.md"), path.basename(root)).name) return root;
      throw new SkillNotFoundError(name);
    }
    const items = this.list(() => {});
    const match = items.find(item => item.directory === name) ?? items.find(item => item.name === name);
    if (!match) throw new SkillNotFoundError(name);
    const directory = safeChild(root, match.directory);
    const skillFile = path.join(directory, "SKILL.md");
    if (!fs.existsSync(skillFile) || !fs.statSync(skillFile).isFile()) {
      throw new SkillNotFoundError(name);
    }
    return directory;
  }

  /**
   * 定位 Skill 包内脚本（GAP-05）：复用 safeChild 防路径逃逸，
   * 只允许已存在的 .mjs／.js 文件，由运行时用 node 解释执行。
   */
  resolveScript(
    name: string,
    relativePath: string,
  ): { absolutePath: string; directory: string } {
    const skillDir = this.skillDirectory(name);
    let target: string;
    try {
      target = safeChild(skillDir, relativePath);
    } catch {
      throw new SkillFileInvalidError(name, relativePath);
    }
    if (target === path.resolve(skillDir)) {
      throw new SkillFileInvalidError(name, relativePath);
    }
    const extension = path.extname(target).toLowerCase();
    if (extension !== ".js" && extension !== ".mjs") {
      throw new SkillFileInvalidError(name, relativePath);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      throw new SkillFileInvalidError(name, relativePath);
    }
    if (!stat.isFile()) {
      throw new SkillFileInvalidError(name, relativePath);
    }
    return {
      absolutePath: target,
      directory: skillDir,
    };
  }

  private skillFile(name: string): string {
    return safeChild(this.skillDirectory(name), "SKILL.md");
  }
}

function readMetadata(skillFile: string, directoryName: string): SkillMetadata {
  const text = fs.readFileSync(skillFile, "utf8");
  const parsed = splitFrontmatter(text);
  const name = parsed.fields.name?.trim() || directoryName;
  const description =
    parsed.fields.description?.trim() || firstDescriptionLine(parsed.body);
  return { name, description, directory: directoryName };
}

function splitFrontmatter(text: string): {
  fields: Record<string, string>;
  body: string;
} {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    text,
  );
  if (!match) {
    return { fields: {}, body: text.trim() };
  }
  const fields: Record<string, string> = {};
  try {
    const parsed = parseYaml(match[1] ?? "") as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (typeof value === "string") {
          fields[key] = value;
        } else if (typeof value === "number" || typeof value === "boolean") {
          fields[key] = String(value);
        }
      }
    }
  } catch {
    // Invalid YAML keeps the fallback metadata instead of rejecting the skill.
  }
  return { fields, body: text.slice(match[0].length).trim() };
}

function firstDescriptionLine(body: string): string {
  return (
    body
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function safeChild(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("SKILL_PATH_INVALID");
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (
    target !== resolvedRoot &&
    !target.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error("SKILL_PATH_INVALID");
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const realTarget = fs.realpathSync(target);
  const relative = path.relative(realRoot, realTarget);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("SKILL_PATH_INVALID");
  }
  return realTarget;
}
