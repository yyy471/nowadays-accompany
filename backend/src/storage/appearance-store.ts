import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError } from "../domain/errors.js";
import type {
  OutfitAssetRecord,
  OutfitAssetUsage,
  OutfitRecord,
} from "../domain/appearance.js";

interface OutfitRow {
  outfit_id: string;
  role_id: string;
  name: string;
  description: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AssetRow {
  asset_id: string;
  outfit_id: string;
  role_id: string;
  usage: OutfitAssetUsage;
  file_name: string;
  display_name: string;
  media_type: string;
  relative_path: string;
  deleted_at: string | null;
  created_at: string;
}

export interface NewAssetInput {
  assetId?: string;
  outfitId?: string;
  usage: OutfitAssetUsage;
  fileName: string;
  displayName: string;
  mediaType: string;
  relativePath: string;
  createdAt: string;
}

/**
 * 衣柜读视图只包含未删除的服饰与素材；`getAsset` 按素材标识读取，供历史
 * 句段回放使用，删除后仍可读到被保留的受管副本（DL-151）。
 */
export class AppearanceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly roleId: string,
  ) {}

  listOutfits(): OutfitRecord[] {
    const outfits = this.db
      .prepare(
        "SELECT * FROM outfits WHERE role_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, rowid ASC",
      )
      .all(this.roleId) as OutfitRow[];
    const assets = this.db
      .prepare(
        "SELECT * FROM outfit_assets WHERE role_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, rowid ASC",
      )
      .all(this.roleId) as AssetRow[];
    const byOutfit = new Map<string, OutfitAssetRecord[]>();
    for (const row of assets) {
      const list = byOutfit.get(row.outfit_id) ?? [];
      list.push(mapAsset(row));
      byOutfit.set(row.outfit_id, list);
    }
    return outfits.map((row) => {
      const items = byOutfit.get(row.outfit_id) ?? [];
      return {
        ...mapOutfit(row),
        home: items.find((asset) => asset.usage === "home") ?? null,
        sprites: items.filter((asset) => asset.usage === "sprite"),
      };
    });
  }

  /** 衣柜视图内的服饰；已删除的服饰视为不存在。 */
  getOutfit(outfitId: string): OutfitRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM outfits WHERE outfit_id = ? AND role_id = ? AND deleted_at IS NULL",
      )
      .get(outfitId, this.roleId) as OutfitRow | undefined;
    if (row === undefined) {
      return null;
    }
    const assets = (
      this.db
        .prepare(
          "SELECT * FROM outfit_assets WHERE outfit_id = ? AND role_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, rowid ASC",
        )
        .all(outfitId, this.roleId) as AssetRow[]
    ).map(mapAsset);
    return {
      ...mapOutfit(row),
      home: assets.find((asset) => asset.usage === "home") ?? null,
      sprites: assets.filter((asset) => asset.usage === "sprite"),
    };
  }

  findByName(name: string): { outfitId: string; name: string } | null {
    const row = this.db
      .prepare(
        "SELECT outfit_id, name FROM outfits WHERE role_id = ? AND name = ? AND deleted_at IS NULL",
      )
      .get(this.roleId, name) as
      | { outfit_id: string; name: string }
      | undefined;
    return row === undefined
      ? null
      : { outfitId: row.outfit_id, name: row.name };
  }

  /** 当前可用服饰数量；excludeId 用于排除即将删除的一套。 */
  countActiveOutfits(excludeId?: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM outfits
          WHERE role_id = ? AND deleted_at IS NULL AND outfit_id <> ?`,
      )
      .get(this.roleId, excludeId ?? "") as { count: number };
    return row.count;
  }

  /** 剩余服饰中最早创建的一套，用作删除当前服饰后的回退。 */
  earliestActiveOutfit(excludeId: string): { outfitId: string } | null {
    const row = this.db
      .prepare(
        `SELECT outfit_id FROM outfits
          WHERE role_id = ? AND deleted_at IS NULL AND outfit_id <> ?
          ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(this.roleId, excludeId) as { outfit_id: string } | undefined;
    return row === undefined ? null : { outfitId: row.outfit_id };
  }

  /** 按素材标识读取，不区分是否已从衣柜移除（历史回放用）。 */
  getAsset(assetId: string): OutfitAssetRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM outfit_assets WHERE asset_id = ? AND role_id = ?",
      )
      .get(assetId, this.roleId) as AssetRow | undefined;
    return row === undefined ? null : mapAsset(row);
  }

  countAssetReferences(assetId: string): number {
    const row = this.db
      .prepare(
        `SELECT (
           (SELECT COUNT(*) FROM message_segments WHERE home_asset_id = ?) +
           (SELECT COUNT(*) FROM message_segments WHERE sprite_asset_id = ?)
         ) AS count`,
      )
      .get(assetId, assetId) as { count: number };
    return row.count;
  }

  listAssetsForOutfit(outfitId: string): OutfitAssetRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM outfit_assets WHERE outfit_id = ? AND role_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(outfitId, this.roleId) as AssetRow[];
    return rows.map(mapAsset);
  }

  createOutfitWithAssets(input: {
    name: string;
    description: string | null;
    assets: readonly NewAssetInput[];
    now: string;
  }): OutfitRecord {
    const outfitId = randomUUID();
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO outfits
               (outfit_id, role_id, name, description, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            outfitId,
            this.roleId,
            input.name,
            input.description,
            input.now,
            input.now,
          );
        for (const asset of input.assets) {
          this.insertAsset({ ...asset, outfitId }, input.now);
        }
      })();
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new AppError(
          409,
          "OUTFIT_ALREADY_EXISTS",
          `已存在该服饰：${input.name}`,
          { name: input.name },
        );
      }
      throw error;
    }
    return this.getOutfit(outfitId)!;
  }

  /** 改名与用途说明；`description` 传 null 表示清空，undefined 表示保留。 */
  renameOutfit(
    outfitId: string,
    input: { name?: string; description?: string | null },
    now: string,
  ): OutfitRecord {
    try {
      this.db
        .prepare(
          `UPDATE outfits
              SET name = COALESCE(?, name),
                  description = CASE WHEN ? = 1 THEN ? ELSE description END,
                  updated_at = ?
            WHERE outfit_id = ? AND role_id = ? AND deleted_at IS NULL`,
        )
        .run(
          input.name ?? null,
          input.description === undefined ? 0 : 1,
          input.description ?? null,
          now,
          outfitId,
          this.roleId,
        );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new AppError(
          409,
          "OUTFIT_ALREADY_EXISTS",
          `已存在该服饰：${input.name ?? ""}`,
          { name: input.name ?? null },
        );
      }
      throw error;
    }
    const outfit = this.getOutfit(outfitId);
    if (outfit === null) {
      throw new AppError(404, "OUTFIT_NOT_FOUND", "服饰不存在", { outfitId });
    }
    return outfit;
  }

  /**
   * 主页立绘补传或替换：旧立绘标记删除，新立绘成为唯一主页立绘。
   * 服饰是否仍有效在写入事务里复验，避免解码等待期间服饰被删除后写入
   * 已删除服饰的素材（AD-R05）。
   */
  replaceHome(
    outfitId: string,
    asset: NewAssetInput,
    now: string,
  ): { home: OutfitAssetRecord; replaced: OutfitAssetRecord | null } {
    let replaced: AssetRow | undefined;
    this.db.transaction(() => {
      this.assertActiveOutfit(outfitId);
      replaced = this.db
        .prepare(
          `SELECT * FROM outfit_assets
            WHERE outfit_id = ? AND role_id = ? AND usage = 'home' AND deleted_at IS NULL`,
        )
        .get(outfitId, this.roleId) as AssetRow | undefined;
      if (replaced !== undefined) {
        this.db
          .prepare("UPDATE outfit_assets SET deleted_at = ? WHERE asset_id = ?")
          .run(now, replaced.asset_id);
      }
      this.insertAsset({ ...asset, outfitId, usage: "home" }, now);
    })();
    const home = this.db
      .prepare(
        `SELECT * FROM outfit_assets
          WHERE outfit_id = ? AND role_id = ? AND usage = 'home' AND deleted_at IS NULL`,
      )
      .get(outfitId, this.roleId) as AssetRow;
    return {
      home: mapAsset(home),
      replaced: replaced === undefined ? null : mapAsset(replaced),
    };
  }

  /** 软删除一套服饰；素材行先标记删除，未引用时由调用方硬删除并清理文件。 */
  deleteOutfit(outfitId: string, now: string): OutfitAssetRecord[] {
    const assets = this.listAssetsForOutfit(outfitId);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE outfits SET deleted_at = ?, updated_at = ?
            WHERE outfit_id = ? AND role_id = ? AND deleted_at IS NULL`,
        )
        .run(now, now, outfitId, this.roleId);
      this.db
        .prepare(
          `UPDATE outfit_assets SET deleted_at = ?
            WHERE outfit_id = ? AND role_id = ? AND deleted_at IS NULL`,
        )
        .run(now, outfitId, this.roleId);
    })();
    return assets;
  }

  softDeleteAsset(assetId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE outfit_assets SET deleted_at = ?
          WHERE asset_id = ? AND role_id = ? AND deleted_at IS NULL`,
      )
      .run(now, assetId, this.roleId);
  }

  deleteAssetRow(assetId: string): void {
    this.db
      .prepare("DELETE FROM outfit_assets WHERE asset_id = ? AND role_id = ?")
      .run(assetId, this.roleId);
  }

  /**
   * 新增素材。服饰是否仍有效与插入放在同一事务里复验：上传在异步解码后
   * 才入库，期间服饰可能已被删除（AD-R05）。
   */
  addAsset(input: NewAssetInput & { outfitId: string }): OutfitAssetRecord {
    const assetId = input.assetId ?? randomUUID();
    this.db.transaction(() => {
      this.assertActiveOutfit(input.outfitId);
      this.insertAsset({ ...input, assetId }, input.createdAt);
    })();
    return this.getAsset(assetId)!;
  }

  /** 服饰在衣柜中存在且未删除；否则 404。 */
  private assertActiveOutfit(outfitId: string): void {
    if (this.getOutfit(outfitId) === null) {
      throw new AppError(404, "OUTFIT_NOT_FOUND", "服饰不存在", { outfitId });
    }
  }

  private insertAsset(input: NewAssetInput, now: string): void {
    this.db
      .prepare(
        `INSERT INTO outfit_assets
           (asset_id, outfit_id, role_id, usage, file_name, display_name,
            media_type, relative_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.assetId ?? randomUUID(),
        input.outfitId,
        this.roleId,
        input.usage,
        input.fileName,
        input.displayName,
        input.mediaType,
        input.relativePath,
        now,
      );
  }
}

function mapOutfit(row: OutfitRow): Omit<OutfitRecord, "home" | "sprites"> {
  return {
    outfitId: row.outfit_id,
    roleId: row.role_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAsset(row: AssetRow): OutfitAssetRecord {
  return {
    assetId: row.asset_id,
    outfitId: row.outfit_id,
    roleId: row.role_id,
    usage: row.usage,
    fileName: row.file_name,
    displayName: row.display_name,
    mediaType: row.media_type,
    relativePath: row.relative_path,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

function isUniqueConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("UNIQUE constraint failed");
}
