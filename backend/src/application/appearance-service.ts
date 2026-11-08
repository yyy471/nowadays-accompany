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
