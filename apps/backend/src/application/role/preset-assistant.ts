import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { XIA_CHENG_BUILTIN_KEY } from "../../domain/admin-seat.js";
import type { RolePaths } from "../../bootstrap/config.js";
import type { OutfitAssetRecord, OutfitRecord } from "../../domain/appearance.js";
import type { AppStore, RoleIndexRecord } from "../../storage/core/app-store.js";
import {
  AppearanceStore,
  type NewAssetInput,
} from "../../storage/media/appearance-store.js";
import type { RoleStorage } from "../../storage/core/role-storage.js";
import { detectImageFormat } from "../media/image-inspect.js";
import type { RoleService } from "./role-service.js";

export { XIA_CHENG_BUILTIN_KEY };
export const XIA_CHENG_DISPLAY_NAME = "夏澄";

export const XIA_CHENG_BIO_TEXT =
  "夏澄是 Nowadays 的系统预置默认助手，既能在日常对话里随时聊聊，也能在你启用相应工具后协助调用工具与技能处理多步骤事务或整理其他角色配置。";

export const XIA_CHENG_DEFAULT_DEFINITION_TEXT = [
  "你是夏澄，清醒温和、条理分明。",
  "日常交流自然亲切，不端架子也不浮夸；协助用户处理事务时专注可靠，讲究事实依据与步骤清晰，完成一点反馈一点，遇到需要你拍板或补充的信息会及时停下确认。",
].join("\n");

export interface EnsurePresetAssistantDeps {
  appStore: AppStore;
  roleService: RoleService;
  presetAssetsDir: string;
  now?: () => Date;
}

interface PresetOutfitSource {
  slug: string;
  name: string;
  description: string | null;
  home: { fileName: string; data: Buffer } | null;
  sprites: Array<{ fileName: string; displayName: string; data: Buffer }>;
}

/** 首次初始化及失败恢复时播种，就绪后完全保留用户维护的外壳。 */
export function ensurePresetAssistant(deps: EnsurePresetAssistantDeps): RoleIndexRecord {
  let index = deps.appStore.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY);
  if (index?.initStatus === "ready") return index;
  if (index === null) {
    const roleId = randomUUID();
    index = deps.appStore.createRoleIndex({
      roleId,
      relativeDir: `roles/${roleId}`,
      initPayload: {
        builtinKey: XIA_CHENG_BUILTIN_KEY,
        displayName: XIA_CHENG_DISPLAY_NAME,
        bioText: XIA_CHENG_BIO_TEXT,
        definition: { text: XIA_CHENG_DEFAULT_DEFINITION_TEXT, payload: {} },
        state: {},
      },
    });
  }
  const { roleId } = index;
  deps.roleService.initializeRole(roleId, (storage) => {
    storage.business.syncBuiltinRoleIdentity({
      roleId, builtinKey: XIA_CHENG_BUILTIN_KEY, bioText: XIA_CHENG_BIO_TEXT,
    });
    syncPresetOutfits({
      roleId, storage, paths: storage.paths, presetAssetsDir: deps.presetAssetsDir,
      now: (deps.now?.() ?? new Date()).toISOString(),
    });
  });
  return deps.appStore.getRoleIndex(roleId)!;
}

function syncPresetOutfits(input: {
  roleId: string;
  storage: RoleStorage;
  paths: RolePaths;
  presetAssetsDir: string;
  now: string;
}): void {
  const sources = scanPresetOutfitSources(input.presetAssetsDir);
  if (sources.length === 0) {
    return;
  }
  const store = new AppearanceStore(input.storage.business.db, input.roleId);
  const currentState = input.storage.business.getState(input.roleId).state;
  const activeOutfitIds = new Set(
    store.listOutfits().map((item) => item.outfitId),
  );
  let defaultOutfitId: string | null =
    typeof currentState.outfitId === "string" &&
    activeOutfitIds.has(currentState.outfitId)
      ? currentState.outfitId
      : null;

  for (const source of sources) {
    if (source.home === null && source.sprites.length === 0) {
      continue;
    }
    const existingPreset = findExistingPresetOutfit(store, source);
    if (existingPreset === null) {
      const targetName = resolveNonConflictingPresetName(store, source.name);
      const writtenFiles: string[] = [];
      try {
        const assets: NewAssetInput[] = [];
        if (source.home !== null) {
          assets.push(
            writePresetImageFile(
              input.paths,
              source.home.fileName,
              source.home.fileName,
              source.home.data,
              "home",
              input.now,
              writtenFiles,
            ),
          );
        }
        for (const sprite of source.sprites) {
          assets.push(
            writePresetImageFile(
              input.paths,
              sprite.fileName,
              sprite.displayName,
              sprite.data,
              "sprite",
              input.now,
              writtenFiles,
            ),
          );
        }
        const created = store.createOutfitWithAssets({
          name: targetName,
          description: source.description,
          isPreset: true,
          presetKey: source.slug,
          assets,
          now: input.now,
        });
        if (defaultOutfitId === null && source.slug === "default") {
          defaultOutfitId = created.outfitId;
        } else if (defaultOutfitId === null) {
          defaultOutfitId = created.outfitId;
        }
      } catch (error) {
        cleanupFiles(writtenFiles);
        throw error;
      }
      continue;
    }

    const targetName = resolveNonConflictingPresetName(
      store,
      source.name,
      existingPreset.outfitId,
      existingPreset.name,
    );
    syncExistingPresetOutfit({
      store,
      paths: input.paths,
      existing: existingPreset,
      targetName,
      source,
      now: input.now,
    });
    if (defaultOutfitId === null && source.slug === "default") {
      defaultOutfitId = existingPreset.outfitId;
    } else if (defaultOutfitId === null) {
      defaultOutfitId = existingPreset.outfitId;
    }
  }

  if (
    defaultOutfitId !== null &&
    (typeof currentState.outfitId !== "string" ||
      !activeOutfitIds.has(currentState.outfitId))
  ) {
    input.storage.business.setState({
      roleId: input.roleId,
      state: {
        ...currentState,
        outfitId: defaultOutfitId,
      },
    });
  }
}

function syncExistingPresetOutfit(input: {
  store: AppearanceStore;
  paths: RolePaths;
  existing: OutfitRecord;
  targetName: string;
  source: PresetOutfitSource;
  now: string;
}): void {
  const { store, paths, existing, targetName, source, now } = input;
  if (
    existing.name !== targetName ||
    existing.description !== source.description
  ) {
    store.renameOutfit(
      existing.outfitId,
      {
        ...(existing.name === targetName ? {} : { name: targetName }),
        ...(existing.description === source.description
          ? {}
          : { description: source.description }),
      },
      now,
    );
  }
  const writtenFiles: string[] = [];
  try {
    if (source.home !== null) {
      const sameHome =
        existing.home !== null &&
        existing.home.fileName === source.home.fileName &&
        assetBytesMatch(paths, existing.home, source.home.data);
      if (!sameHome) {
        const homeAsset = writePresetImageFile(
          paths,
          source.home.fileName,
          source.home.fileName,
          source.home.data,
          "home",
          now,
          writtenFiles,
        );
        const { replaced } = store.replaceHome(
          existing.outfitId,
          homeAsset,
          now,
        );
        if (replaced !== null) {
          releaseOrRetainPresetAsset(store, paths, replaced, now);
        }
      }
    } else if (existing.home !== null) {
      releaseOrRetainPresetAsset(store, paths, existing.home, now);
    }

    const existingSpritesByFile = new Map<string, OutfitAssetRecord>();
    for (const sprite of existing.sprites) {
      if (!existingSpritesByFile.has(sprite.fileName)) {
        existingSpritesByFile.set(sprite.fileName, sprite);
      } else {
        // 清理历史重复差分项。
        releaseOrRetainPresetAsset(store, paths, sprite, now);
      }
    }

    const expectedSpriteNames = new Set(
      source.sprites.map((sprite) => sprite.fileName),
    );
    for (const oldSprite of existing.sprites) {
      if (!expectedSpriteNames.has(oldSprite.fileName)) {
        releaseOrRetainPresetAsset(store, paths, oldSprite, now);
      }
    }

    for (const sprite of source.sprites) {
      const current = existingSpritesByFile.get(sprite.fileName);
      if (
        current !== undefined &&
        assetBytesMatch(paths, current, sprite.data)
      ) {
        if (current.displayName !== sprite.displayName) {
          store.updateAssetDisplayName(current.assetId, sprite.displayName);
        }
        continue;
      }
      const nextAsset = writePresetImageFile(
        paths,
        sprite.fileName,
        sprite.displayName,
        sprite.data,
        "sprite",
        now,
        writtenFiles,
      );
      store.addAsset({
        ...nextAsset,
        outfitId: existing.outfitId,
      });
      if (current !== undefined) {
        releaseOrRetainPresetAsset(store, paths, current, now);
      }
    }
  } catch (error) {
    cleanupFiles(writtenFiles);
    throw error;
  }
}

function findExistingPresetOutfit(
  store: AppearanceStore,
  source: PresetOutfitSource,
): OutfitRecord | null {
  const byKey = store.findByPresetKey(source.slug);
  if (byKey !== null) {
    return byKey;
  }
  const legacy = store
    .listOutfits()
    .find(
      (item) =>
        item.isPreset &&
        item.presetKey === null &&
        (item.name === source.name ||
          item.name === `${source.name}（预置）` ||
          item.name.startsWith(`${source.name}（预置-`)),
    );
  if (legacy === undefined) {
    return null;
  }
  store.setPresetKey(legacy.outfitId, source.slug);
  return store.getOutfit(legacy.outfitId) ?? legacy;
}

function resolveNonConflictingPresetName(
  store: AppearanceStore,
  desiredName: string,
  excludeOutfitId?: string,
  currentName?: string,
): string {
  const conflicts = (candidate: string): boolean => {
    const found = store.findByName(candidate);
    return found !== null && found.outfitId !== excludeOutfitId;
  };
  if (!conflicts(desiredName)) {
    return desiredName;
  }
  const fallback = `${desiredName}（预置）`;
  if (!conflicts(fallback)) {
    return fallback;
  }
  if (
    currentName !== undefined &&
    currentName.startsWith(`${desiredName}（预置-`) &&
    !conflicts(currentName)
  ) {
    return currentName;
  }
  return `${desiredName}（预置-${randomUUID().slice(0, 6)}）`;
}

function scanPresetOutfitSources(presetAssetsDir: string): PresetOutfitSource[] {
  const outfitsRoot = path.join(
    presetAssetsDir,
    XIA_CHENG_BUILTIN_KEY,
    "outfits",
  );
  if (!fs.existsSync(outfitsRoot)) {
    return [];
  }
  const entries = fs
    .readdirSync(outfitsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => {
      if (left === "default" && right !== "default") return -1;
      if (right === "default" && left !== "default") return 1;
      return left.localeCompare(right, "zh-CN");
    });

  const results: PresetOutfitSource[] = [];
  for (const slug of entries) {
    const dir = path.join(outfitsRoot, slug);
    const meta = readPresetOutfitManifest(dir, slug);
    const home = readPresetHomeFile(dir);
    const sprites = readPresetSprites(dir, meta.spriteNames);
    results.push({
      slug,
      name: meta.name,
      description: meta.description,
      home,
      sprites,
    });
  }
  return results;
}

function readPresetOutfitManifest(
  dir: string,
  slug: string,
): {
  name: string;
  description: string | null;
  spriteNames: Record<string, string>;
} {
  const defaultName = slug === "default" ? "日常常服" : slug;
  const defaultDesc =
    slug === "default" ? "夏澄的系统预置日常服饰。" : null;
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return { name: defaultName, description: defaultDesc, spriteNames: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      name?: unknown;
      description?: unknown;
      spriteNames?: unknown;
    };
    const name =
      typeof parsed.name === "string" && parsed.name.trim().length > 0
        ? parsed.name.trim().slice(0, 100)
        : defaultName;
    const description =
      typeof parsed.description === "string"
        ? parsed.description.trim().slice(0, 500) || null
        : parsed.description === null
          ? null
          : defaultDesc;
    const spriteNames: Record<string, string> = {};
    if (
      parsed.spriteNames !== null &&
      typeof parsed.spriteNames === "object" &&
      !Array.isArray(parsed.spriteNames)
    ) {
      for (const [key, value] of Object.entries(
        parsed.spriteNames as Record<string, unknown>,
      )) {
        const cleanKey = key.trim();
        if (
          cleanKey.length > 0 &&
          typeof value === "string" &&
          value.trim().length > 0
        ) {
          spriteNames[cleanKey] = value.trim().slice(0, 100);
        }
      }
    }
    return { name, description, spriteNames };
  } catch {
    return { name: defaultName, description: defaultDesc, spriteNames: {} };
  }
}

function readPresetHomeFile(
  dir: string,
): { fileName: string; data: Buffer } | null {
  for (const candidate of ["home.png", "home.jpg", "home.jpeg", "home.webp"]) {
    const filePath = path.join(dir, candidate);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const data = fs.readFileSync(filePath);
    if (data.length > 0 && detectImageFormat(data) !== null) {
      return { fileName: candidate, data };
    }
  }
  return null;
}

function readPresetSprites(
  dir: string,
  spriteNames: Record<string, string>,
): Array<{ fileName: string; displayName: string; data: Buffer }> {
  const spritesDir = path.join(dir, "sprites");
  if (!fs.existsSync(spritesDir)) {
    return [];
  }
  const files = fs
    .readdirSync(spritesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN"));

  const sprites: Array<{ fileName: string; displayName: string; data: Buffer }> =
    [];
  for (const fileName of files) {
    const ext = path.extname(fileName).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
      continue;
    }
    const filePath = path.join(spritesDir, fileName);
    const data = fs.readFileSync(filePath);
    if (data.length === 0 || detectImageFormat(data) === null) {
      continue;
    }
    const stem = path.basename(fileName, path.extname(fileName)).trim();
    const displayName =
      spriteNames[fileName] ?? spriteNames[stem] ?? stem;
    if (displayName.length === 0) {
      continue;
    }
    sprites.push({ fileName, displayName, data });
  }
  return sprites;
}

function writePresetImageFile(
  paths: RolePaths,
  fileName: string,
  displayName: string,
  data: Buffer,
  usage: "home" | "sprite",
  createdAt: string,
  writtenFiles: string[],
): NewAssetInput {
  const format = detectImageFormat(data);
  if (format === null) {
    throw new Error(`INVALID_PRESET_IMAGE:${fileName}`);
  }
  const assetId = randomUUID();
  const relativePath = `appearance/${assetId}${format.extension}`;
  const absolutePath = path.join(paths.roleDir, relativePath);
  fs.mkdirSync(paths.appearanceDir, { recursive: true });
  fs.writeFileSync(absolutePath, data, { flag: "wx" });
  writtenFiles.push(absolutePath);
  const cleanDisplayName =
    usage === "home"
      ? path.basename(displayName, path.extname(displayName)).trim() || "home"
      : displayName;
  return {
    assetId,
    usage,
    fileName,
    displayName: cleanDisplayName,
    mediaType: format.mediaType,
    relativePath,
    isPreset: true,
    createdAt,
  };
}

function assetBytesMatch(
  paths: RolePaths,
  asset: OutfitAssetRecord,
  expected: Buffer,
): boolean {
  try {
    const filePath = path.join(paths.roleDir, asset.relativePath);
    const current = fs.readFileSync(filePath);
    return current.equals(expected);
  } catch {
    return false;
  }
}

function releaseOrRetainPresetAsset(
  store: AppearanceStore,
  paths: RolePaths,
  asset: OutfitAssetRecord,
  now: string,
): void {
  if (store.countAssetReferences(asset.assetId) > 0) {
    store.softDeleteAsset(asset.assetId, now);
    return;
  }
  try {
    store.deleteAssetRow(asset.assetId);
    fs.rmSync(path.join(paths.roleDir, asset.relativePath), { force: true });
  } catch {
    store.softDeleteAsset(asset.assetId, now);
  }
}

function cleanupFiles(filePaths: readonly string[]): void {
  for (const filePath of filePaths) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // 忽略回滚清理错误。
    }
  }
}
