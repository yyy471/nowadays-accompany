import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../domain/errors.js";
import type {
  OutfitAssetRecord,
  OutfitRecord,
  UploadedImage,
} from "../domain/appearance.js";
import type { RolePaths } from "../bootstrap/config.js";
import { AppearanceStore, type NewAssetInput } from "../storage/appearance-store.js";
import { SceneImageSettingsStore } from "../storage/scene-image-settings-store.js";
import type { RoleStorage } from "../storage/role-storage.js";
import type { RoleAccess } from "./role-access.js";
import { inspectImage } from "./image-inspect.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_OUTFIT_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

export interface AppearanceImportInput {
  name: string;
  description?: string | null;
  home?: UploadedImage | null;
  sprites?: readonly UploadedImage[];
}

export interface AppearanceAssetFile {
  data: Buffer;
  mediaType: string;
  fileName: string;
}

export interface AppearanceRenameInput {
  name?: string | undefined;
  description?: string | null | undefined;
}

/** 删除服饰后的素材去向：历史句段引用的保留，其余清理。 */
export interface AppearanceDeleteResult {
  outfitId: string;
  removedAssets: number;
  retainedAssets: number;
}

export interface SpriteDeleteResult {
  assetId: string;
  /** 仍被历史句段引用时为 true：从衣柜移除，但保留素材行与文件供回放。 */
  retained: boolean;
}

export class AppearanceService {
  constructor(private readonly roleAccess: RoleAccess) {}

  list(roleId: string): { items: OutfitRecord[] } {
    return this.roleAccess.withStore(roleId, (storage) => ({
      items: new AppearanceStore(storage.business.db, roleId).listOutfits(),
    }));
  }

  getOutfit(roleId: string, outfitId: string): OutfitRecord {
    return this.roleAccess.withStore(roleId, (storage) => {
      const outfit = new AppearanceStore(
        storage.business.db,
        roleId,
      ).getOutfit(outfitId);
      if (outfit === null) {
        throw new AppError(404, "OUTFIT_NOT_FOUND", "服饰不存在", {
          outfitId,
        });
      }
      return outfit;
    });
  }

  async importOutfit(
    roleId: string,
    input: AppearanceImportInput,
  ): Promise<OutfitRecord> {
    const name = normalizeName(input.name);
    const description = normalizeDescription(input.description);
    return this.roleAccess.withStoreAsync(roleId, async (storage) => {
      const store = new AppearanceStore(storage.business.db, roleId);
      if (store.findByName(name) !== null) {
        throw new AppError(
          409,
          "OUTFIT_ALREADY_EXISTS",
          `已存在该服饰：${name}`,
          { name },
        );
      }
      const written: string[] = [];
      try {
        const assets: NewAssetInput[] = [];
        if (input.home !== null && input.home !== undefined) {
          assets.push(
            await writeImage(storage.paths, input.home, "home", written),
          );
        }
        for (const sprite of input.sprites ?? []) {
          assets.push(
            await writeImage(storage.paths, sprite, "sprite", written),
          );
        }
        const now = new Date().toISOString();
        return store.createOutfitWithAssets({
          name,
          description,
          assets,
          now,
        });
      } catch (error) {
        for (const filePath of written) {
          fs.rmSync(filePath, { force: true });
        }
        throw error;
      }
    });
  }

  async addSprite(
    roleId: string,
    outfitId: string,
    sprite: UploadedImage,
  ): Promise<OutfitAssetRecord> {
    return this.roleAccess.withStoreAsync(roleId, async (storage) => {
      const store = new AppearanceStore(storage.business.db, roleId);
      if (store.getOutfit(outfitId) === null) {
        throw new AppError(404, "OUTFIT_NOT_FOUND", "服饰不存在", {
          outfitId,
        });
      }
      const written: string[] = [];
      try {
        const asset = await writeImage(
          storage.paths,
          sprite,
          "sprite",
          written,
        );
        return store.addAsset({ ...asset, outfitId, createdAt: new Date().toISOString() });
      } catch (error) {
        for (const filePath of written) {
          fs.rmSync(filePath, { force: true });
        }
        throw error;
      }
    });
  }

  /** 改名与用途说明；服饰 ID 不变，历史句段与生图提示词键保持有效。 */
  async renameOutfit(
    roleId: string,
    outfitId: string,
    input: AppearanceRenameInput,
  ): Promise<OutfitRecord> {
    const name =
      input.name === undefined ? undefined : normalizeName(input.name);
    const description =
      input.description === undefined
        ? undefined
        : normalizeDescription(input.description);
    return this.roleAccess.withStoreAsync(roleId, async (storage) => {
      const store = new AppearanceStore(storage.business.db, roleId);
      if (store.getOutfit(outfitId) === null) {
        throw new AppError(404, "OUTFIT_NOT_FOUND", "服饰不存在", {
          outfitId,
        });
      }
      return store.renameOutfit(
        outfitId,
        {
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
        },
        new Date().toISOString(),
      );
    });
  }

  /**
   * 主页立绘补传或替换：旧立绘标记删除。旧图仍被历史句段引用时保留行与
   * 文件，句段继续按 home_asset_id 读取原图；未引用时清理行与文件。
   */
  async replaceHome(
    roleId: string,
    outfitId: string,
    image: UploadedImage,
  ): Promise<OutfitAssetRecord> {
    return this.roleAccess.withStoreAsync(roleId, async (storage) => {
      const store = new AppearanceStore(storage.business.db, roleId);
      if (store.getOutfit(outfitId) === null) {
        throw new AppError(404, "OUTFIT_NOT_FOUND", "服饰不存在", {
          outfitId,
        });
      }
      const written: string[] = [];
      try {
        const asset = await writeImage(storage.paths, image, "home", written);
        const now = new Date().toISOString();
        const { home, replaced } = store.replaceHome(outfitId, asset, now);
        if (replaced !== null) {
          releaseUnreferencedAsset(storage, store, replaced);
        }
        return home;
      } catch (error) {
        for (const filePath of written) {
          fs.rmSync(filePath, { force: true });
        }
        throw error;
      }
    });
  }

  /**
   * 删除一套服饰：从衣柜、管理列表和 Agent 候选移除，并切换当前服饰到
   * 最早创建的另一套。历史句段引用的素材保留，其余清理（DL-151）。
   */
  deleteOutfit(roleId: string, outfitId: string): AppearanceDeleteResult {
    return this.roleAccess.withStore(roleId, (storage) => {
      const store = new AppearanceStore(storage.business.db, roleId);
      if (store.getOutfit(outfitId) === null) {
        throw new AppError(404, "OUTFIT_NOT_FOUND", "服饰不存在", {
          outfitId,
        });
      }
      if (store.countActiveOutfits(outfitId) === 0) {
        throw new AppError(
          409,
          "LAST_OUTFIT_REQUIRED",
          "至少保留一套服饰，请先导入新服饰",
          { roleId },
        );
      }
      const now = new Date().toISOString();
      let assets: OutfitAssetRecord[] = [];
      storage.business.db.transaction(() => {
        assets = store.deleteOutfit(outfitId, now);
        new SceneImageSettingsStore(
          storage.business.db,
          roleId,
        ).removeOutfitPrompt(outfitId, now);
        const current = storage.business.getState(roleId).state;
        if (current.outfitId === outfitId) {
          const earliest = store.earliestActiveOutfit(outfitId);
          const nextState: Record<string, unknown> = {
            ...current,
            outfitId: earliest?.outfitId ?? null,
          };
          delete nextState.outfitReviewedOn;
          storage.business.setState({ roleId, state: nextState });
        }
      })();

      let removedAssets = 0;
      let retainedAssets = 0;
      for (const asset of assets) {
        if (releaseUnreferencedAsset(storage, store, asset)) {
          removedAssets += 1;
        } else {
          retainedAssets += 1;
        }
      }
      return { outfitId, removedAssets, retainedAssets };
    });
  }

  /** 删除单张差分；被历史句段引用时只从衣柜移除。 */
  deleteSprite(
    roleId: string,
    outfitId: string,
    assetId: string,
  ): SpriteDeleteResult {
    return this.roleAccess.withStore(roleId, (storage) => {
      const store = new AppearanceStore(storage.business.db, roleId);
      if (store.getOutfit(outfitId) === null) {
        throw new AppError(404, "OUTFIT_NOT_FOUND", "服饰不存在", {
          outfitId,
        });
      }
      const asset = store.getAsset(assetId);
      if (
        asset === null ||
        asset.outfitId !== outfitId ||
        asset.deletedAt !== null
      ) {
        throw new AppError(404, "ASSET_NOT_FOUND", "外观素材不存在", {
          assetId,
        });
      }
      if (asset.usage !== "sprite") {
        throw new AppError(
          409,
          "ASSET_NOT_SPRITE",
          "主页立绘请使用替换接口，差分才能单独删除",
          { assetId, usage: asset.usage },
        );
      }
      if (store.countAssetReferences(assetId) > 0) {
        store.softDeleteAsset(assetId, new Date().toISOString());
        return { assetId, retained: true };
      }
      try {
        store.deleteAssetRow(assetId);
        removeAssetFile(storage.paths, asset);
        return { assetId, retained: false };
      } catch {
        // 物理清理失败时保留为已删除素材：衣柜不再展示，文件与行留待后续清理。
        store.softDeleteAsset(assetId, new Date().toISOString());
        return { assetId, retained: true };
      }
    });
  }

  readAsset(roleId: string, assetId: string): AppearanceAssetFile {
    return this.roleAccess.withStore(roleId, (storage) => {
      const asset = new AppearanceStore(
        storage.business.db,
        roleId,
      ).getAsset(assetId);
      if (asset === null) {
        throw new AppError(404, "ASSET_NOT_FOUND", "外观素材不存在", {
          assetId,
        });
      }
      const filePath = resolveAssetPath(storage.paths, asset.relativePath);
      let data: Buffer;
      try {
        data = fs.readFileSync(filePath);
      } catch {
        throw new AppError(404, "ASSET_FILE_MISSING", "外观素材文件缺失", {
          assetId,
        });
      }
      return { data, mediaType: asset.mediaType, fileName: asset.fileName };
    });
  }
}

async function writeImage(
  paths: RolePaths,
  image: UploadedImage,
  usage: "home" | "sprite",
  written: string[],
): Promise<NewAssetInput> {
  if (image.data.length === 0) {
    throw new AppError(400, "IMAGE_DECODE_FAILED", "图片无法解码", {
      fileName: image.fileName,
    });
  }
  if (image.data.length > MAX_IMAGE_BYTES) {
    throw new AppError(413, "IMAGE_TOO_LARGE", "图片超过 32 MiB 上限", {
      fileName: image.fileName,
    });
  }
  const inspected = await inspectImage(image.data, image.fileName);
  const baseName = path.basename(image.fileName);
  const displayName = removeExtension(baseName).trim();
  if (displayName.length === 0) {
    throw new AppError(400, "IMAGE_NAME_INVALID", "图片文件名不能为空", {
      fileName: image.fileName,
    });
  }
  const assetId = randomUUID();
  const relativePath = `appearance/${assetId}${inspected.extension}`;
  const absolutePath = path.join(paths.roleDir, relativePath);
  fs.mkdirSync(paths.appearanceDir, { recursive: true });
  fs.writeFileSync(absolutePath, image.data, { flag: "wx" });
  written.push(absolutePath);
  return {
    assetId,
    usage,
    fileName: baseName,
    displayName,
    mediaType: inspected.mediaType,
    relativePath,
    createdAt: new Date().toISOString(),
  };
}

function resolveAssetPath(paths: RolePaths, relativePath: string): string {
  const root = path.resolve(paths.appearanceDir);
  const target = path.resolve(paths.roleDir, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new AppError(404, "ASSET_NOT_FOUND", "外观素材不存在");
  }
  return target;
}

/** 未被任何历史句段引用的素材才删除行与文件；引用中或清理失败时保留。 */
function releaseUnreferencedAsset(
  storage: RoleStorage,
  store: AppearanceStore,
  asset: OutfitAssetRecord,
): boolean {
  try {
    if (store.countAssetReferences(asset.assetId) > 0) {
      return false;
    }
    store.deleteAssetRow(asset.assetId);
    removeAssetFile(storage.paths, asset);
    return true;
  } catch {
    // 清理可延后：素材行已按删除状态过滤，失败不推翻已提交的替换或删除。
    return false;
  }
}

function removeAssetFile(paths: RolePaths, asset: OutfitAssetRecord): void {
  try {
    fs.rmSync(resolveAssetPath(paths, asset.relativePath), { force: true });
  } catch {
    // 文件已缺失或暂不可删除：素材行已清理，残留文件不影响读取。
  }
}

function normalizeName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new AppError(400, "OUTFIT_NAME_REQUIRED", "服饰名称不能为空");
  }
  if (name.length > MAX_OUTFIT_NAME_LENGTH) {
    throw new AppError(400, "OUTFIT_NAME_TOO_LONG", "服饰名称过长");
  }
  return name;
}

function normalizeDescription(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const description = raw.trim();
  if (description.length === 0) {
    return null;
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new AppError(400, "OUTFIT_DESCRIPTION_TOO_LONG", "服饰用途说明过长");
  }
  return description;
}

function removeExtension(fileName: string): string {
  const extension = path.extname(fileName);
  return extension.length === 0 ? fileName : fileName.slice(0, -extension.length);
}
