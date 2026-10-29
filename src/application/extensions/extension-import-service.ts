import fs from 'node:fs/promises';
import path from 'node:path';
import { ArtifactImportService } from '../artifacts/artifact-import-service.js';
import { assertNoLinks, readFileBounded } from '../../artifacts/source-file.js';
import { AccompanyError, InvalidSpecError } from '../../core/errors.js';
import { SKILL_PROMPT_LIMITS } from '../../extensions/skill-selection.js';
import type { SkillConfig } from '../../extensions/types.js';
import { parseSkillDefinition } from '../../providers/types.js';
import { assertIdentifier } from '../../routing/identity.js';
import type {
  ExtensionImportInput,
  ExtensionImportPreview,
  ExtensionImportPreviewInput,
  ExtensionImportResult,
  ExtensionImportScanEntry,
  ExtensionImportScanResult,
  ExtensionImportTarget,
  ExtensionPluginImportPreview,
  ExtensionSkillImportPreview
} from '../../contracts/extension-access.js';
import type { SkillService } from './skill-service.js';

export interface ExtensionImportServiceOptions {
  dataRoot: string;
  publicRoot: string;
  skills: SkillService;
  accountDir: (accountId: string) => string;
  accountExists: (accountId: string) => Promise<boolean>;
}

const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SKILL_FILE_LIMIT = 64 * 1024;
const MAX_SCAN_ENTRIES = 200;
const SKILL_METADATA_KEYS = new Set(['id', 'name', 'description', 'tools', 'requires', 'kinds', 'peers']);

interface SkillDirectory {
  definition: SkillConfig;
  preview: ExtensionSkillImportPreview;
}

/**
 * Local file access for plugins and Skills. Plugin import reuses the existing artifact directory
 * importer; Skill import converts SKILL.md into the existing definition model and never executes
 * files, resolves dependencies or grants tools.
 */
export class ExtensionImportService {
  readonly #options: ExtensionImportServiceOptions;

  constructor(options: ExtensionImportServiceOptions) {
    this.#options = options;
  }

  get importsRoot(): string {
    return path.join(this.#options.dataRoot, 'imports');
  }

  async scan(): Promise<ExtensionImportScanResult> {
    const pluginsDirectory = path.join(this.importsRoot, 'plugins');
    const skillsDirectory = path.join(this.importsRoot, 'skills');
    const entries: ExtensionImportScanEntry[] = [];
    for (const name of await candidateDirectories(pluginsDirectory)) {
      if (entries.length >= MAX_SCAN_ENTRIES) break;
      const sourceDirectory = path.join(pluginsDirectory, name);
      try {
        const preview = await this.previewPlugin(sourceDirectory);
        entries.push({ kind: 'plugin', name, sourceDirectory, status: 'ready', plugin: preview });
      } catch (error) {
        entries.push({ kind: 'plugin', name, sourceDirectory, status: 'invalid', error: boundedError(error) });
      }
    }
    for (const name of await candidateDirectories(skillsDirectory)) {
      if (entries.length >= MAX_SCAN_ENTRIES) break;
      const sourceDirectory = path.join(skillsDirectory, name);
      try {
        const loaded = await this.#loadSkillDirectory(sourceDirectory);
        entries.push({ kind: 'skill', name, sourceDirectory, status: 'ready', skill: loaded.preview });
      } catch (error) {
        entries.push({ kind: 'skill', name, sourceDirectory, status: 'invalid', error: boundedError(error) });
      }
    }
    return { pluginsDirectory, skillsDirectory, entries };
  }

  async preview(input: ExtensionImportPreviewInput): Promise<ExtensionImportPreview> {
    const source = requireSourceDirectory(input.sourceDirectory);
    if (input.kind === 'plugin') return this.previewPlugin(source);
    if (input.kind === 'skill') return (await this.#loadSkillDirectory(source)).preview;
    throw new InvalidSpecError('导入类型必须是 plugin 或 skill。');
  }

  async import(input: ExtensionImportInput): Promise<ExtensionImportResult> {
    const source = requireSourceDirectory(input.sourceDirectory);
    const target = await this.#resolveTarget(input.target);
    if (input.kind === 'plugin') {
      const root = target.source === 'public' ? this.#options.publicRoot : this.#options.accountDir(target.accountId!);
      const preview = await new ArtifactImportService({ publicRoot: root }).import(source);
      return {
        kind: 'plugin',
        id: preview.id,
        revision: preview.revision,
        target,
        ...(preview.name ? { name: preview.name } : {})
      };
    }
    if (input.kind === 'skill') {
      if (typeof input.expectedRevision !== 'string' || !input.expectedRevision) {
        throw new InvalidSpecError('Skill 导入需要 expectedRevision。');
      }
      const loaded = await this.#loadSkillDirectory(source);
      let revision: string;
      if (target.source === 'public') {
        revision = (await this.#options.skills.savePublic(loaded.definition, input.expectedRevision)).revision;
      } else {
        revision = (await this.#options.skills.savePrivate(
          target.accountId!,
          loaded.definition,
          input.expectedRevision
        )).skills.revision;
      }
      return {
        kind: 'skill',
        id: loaded.definition.id,
        revision,
        target,
        name: loaded.definition.name,
        warnings: loaded.preview.warnings
      };
    }
    throw new InvalidSpecError('导入类型必须是 plugin 或 skill。');
  }

  async previewPlugin(sourceDirectory: string): Promise<ExtensionPluginImportPreview> {
    const preview = await new ArtifactImportService({ publicRoot: this.#options.publicRoot }).preview(
      sourceDirectory,
      { checkDestination: false }
    );
    return {
      kind: 'plugin',
      id: preview.id,
      revision: preview.revision,
      ...(preview.name ? { name: preview.name } : {}),
      fileCount: preview.fileCount,
      totalBytes: preview.bytes,
      targetPath: `artifacts/plugin/${preview.id}/${preview.revision}`,
      fingerprint: preview.fingerprint
    };
  }

  async #loadSkillDirectory(sourceDirectory: string): Promise<SkillDirectory> {
    await assertNoLinks(sourceDirectory, false);
    let directoryStat;
    try {
      directoryStat = await fs.lstat(sourceDirectory);
    } catch (error) {
      if (isCode(error, 'ENOENT')) throw new InvalidSpecError('所选 Skill 目录不存在。');
      throw error;
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new InvalidSpecError('请选择包含 SKILL.md 的 Skill 目录。');
    }
    const files = await listDirectoryFiles(sourceDirectory);
    let instructions: string;
    try {
      instructions = (await readFileBounded(path.join(sourceDirectory, 'SKILL.md'), SKILL_FILE_LIMIT, undefined, true)).text ?? '';
    } catch (error) {
      if (isCode(error, 'ENOENT')) throw new InvalidSpecError('所选 Skill 目录缺少 SKILL.md。');
      throw error;
    }
    instructions = instructions.replace(/^\uFEFF/, '');
    if (!instructions.trim()) throw new InvalidSpecError('SKILL.md 正文不能为空。');

    let metadata: Record<string, unknown> = {};
    let hasMetadata = false;
    try {
      const raw = await fs.readFile(path.join(sourceDirectory, 'skill.json'), 'utf8');
      hasMetadata = true;
      try {
        metadata = parseSkillMetadata(raw);
      } catch (error) {
        throw new InvalidSpecError(`skill.json 不是有效的 Skill 元数据：${boundedError(error)}`);
      }
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }

    const directoryName = path.basename(sourceDirectory);
    const id = metadata.id === undefined ? directoryName : requireText(metadata.id, 'skill.json.id');
    if (!SKILL_ID.test(id)) {
      throw new InvalidSpecError('Skill id 必须由1至64位字母、数字、点、下划线或短横线组成；请在 skill.json 中填写 id。');
    }
    const derivedName = metadata.name === undefined ? firstHeading(instructions) ?? directoryName : undefined;
    const name = metadata.name === undefined ? derivedName! : requireText(metadata.name, 'skill.json.name');
    const base = {
      id,
      name,
      ...(metadata.description !== undefined ? { description: requireText(metadata.description, 'skill.json.description') } : {}),
      instructions,
      tools: metadata.tools ?? [],
      ...(metadata.requires !== undefined ? { requires: metadata.requires } : {}),
      ...(metadata.kinds !== undefined ? { kinds: metadata.kinds } : {}),
      ...(metadata.peers !== undefined ? { peers: metadata.peers } : {}),
      // Imported Skills stay off until an account scope switch or the definition is edited.
      enabled: false
    };
    let definition: SkillConfig;
    try {
      definition = parseSkillDefinition(base, 'skill');
    } catch (error) {
      throw new InvalidSpecError(`Skill 元数据无效：${boundedError(error)}`);
    }
    if (definition.name.length > SKILL_PROMPT_LIMITS.maxNameChars) {
      throw new InvalidSpecError(`Skill 名称最多 ${SKILL_PROMPT_LIMITS.maxNameChars} 字符。`);
    }
    if (definition.instructions.length > SKILL_PROMPT_LIMITS.maxInstructionsChars) {
      throw new InvalidSpecError(`SKILL.md 正文最多 ${SKILL_PROMPT_LIMITS.maxInstructionsChars} 字符。`);
    }
    if (definition.tools.length > SKILL_PROMPT_LIMITS.maxTools) {
      throw new InvalidSpecError(`Skill 最多引用 ${SKILL_PROMPT_LIMITS.maxTools} 个工具。`);
    }
    const warnings = [
      '导入后默认关闭；请为该账号启用后再测试或使用。',
      ...(hasMetadata ? [] : ['未找到 skill.json，已按目录名和首个一级标题生成元数据。'])
    ];
    return {
      definition,
      preview: {
        kind: 'skill',
        id: definition.id,
        name: definition.name,
        ...(definition.description ? { description: definition.description } : {}),
        instructions: definition.instructions,
        tools: [...definition.tools],
        ...(definition.requires?.length ? { requires: [...definition.requires] } : {}),
        ...(definition.kinds?.length ? { kinds: [...definition.kinds] } : {}),
        ...(definition.peers?.length ? { peers: [...definition.peers] } : {}),
        sourceFormat: 'skill-md',
        fileCount: files.fileCount,
        totalBytes: files.totalBytes,
        warnings
      }
    };
  }

  async #resolveTarget(raw: ExtensionImportTarget): Promise<ExtensionImportTarget> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidSpecError('target 必须是导入目标对象。');
    }
    if (raw.source !== 'public' && raw.source !== 'private') {
      throw new InvalidSpecError('target.source 必须是 public 或 private。');
    }
    if (raw.source === 'public') return { source: 'public' };
    if (typeof raw.accountId !== 'string') throw new InvalidSpecError('私有导入目标必须指定 accountId。');
    const accountId = assertIdentifier(raw.accountId, 'accountId');
    if (!(await this.#options.accountExists(accountId))) {
      throw new AccompanyError('extension_account_not_found', `账号 ${accountId} 不存在，不能导入私有资源。`);
    }
    return { source: 'private', accountId };
  }
}

function parseSkillMetadata(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidSpecError('不是有效 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidSpecError('必须是 JSON 对象');
  }
  const value = parsed as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => !SKILL_METADATA_KEYS.has(key));
  if (unknown) throw new InvalidSpecError(`不支持字段 ${unknown}`);
  if (value.tools === undefined) value.tools = [];
  return value;
}

function firstHeading(markdown: string): string | undefined {
  const match = /^[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(markdown);
  const heading = match?.[1]?.trim();
  return heading ? heading : undefined;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new InvalidSpecError(`${label} 必须是非空文本。`);
  return value;
}

function requireSourceDirectory(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) {
    throw new InvalidSpecError('sourceDirectory 必须是本机目录路径。');
  }
  return path.resolve(value);
}

async function candidateDirectories(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    try {
      const stat = await fs.lstat(path.join(directory, name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) result.push(name);
    } catch {
      // A directory removed during the scan is simply not listed.
    }
  }
  return result;
}

async function listDirectoryFiles(directory: string): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 8) throw new InvalidSpecError('Skill 目录层级超过限制。');
    await assertNoLinks(current, false);
    for (const name of await fs.readdir(current)) {
      const file = path.join(current, name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new InvalidSpecError('Skill 目录不允许符号链接。');
      if (stat.isDirectory()) {
        await walk(file, depth + 1);
      } else if (stat.isFile()) {
        fileCount += 1;
        totalBytes += stat.size;
        if (fileCount > 1_000 || totalBytes > 32 * 1024 * 1024) {
          throw new InvalidSpecError('Skill 目录文件数量或大小超过限制。');
        }
      } else {
        throw new InvalidSpecError('Skill 目录只允许普通文件和目录。');
      }
    }
  };
  await walk(directory, 0);
  return { fileCount, totalBytes };
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
