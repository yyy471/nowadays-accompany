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

export class AppearanceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly roleId: string,
  ) {}

  listOutfits(): OutfitRecord[] {
    const outfits = this.db
      .prepare(
        "SELECT * FROM outfits WHERE role_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(this.roleId) as OutfitRow[];
    const assets = this.db
      .prepare(
        "SELECT * FROM outfit_assets WHERE role_id = ? ORDER BY created_at ASC, rowid ASC",
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

  getOutfit(outfitId: string): OutfitRecord | null {
    const row = this.db
      .prepare("SELECT * FROM outfits WHERE outfit_id = ? AND role_id = ?")
      .get(outfitId, this.roleId) as OutfitRow | undefined;
    if (row === undefined) {
      return null;
    }
    const assets = (
      this.db
        .prepare(
          "SELECT * FROM outfit_assets WHERE outfit_id = ? AND role_id = ? ORDER BY created_at ASC, rowid ASC",
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
        "SELECT outfit_id, name FROM outfits WHERE role_id = ? AND name = ?",
      )
      .get(this.roleId, name) as
      | { outfit_id: string; name: string }
      | undefined;
    return row === undefined
      ? null
      : { outfitId: row.outfit_id, name: row.name };
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

  addAsset(input: NewAssetInput & { outfitId: string }): OutfitAssetRecord {
    const assetId = input.assetId ?? randomUUID();
    this.insertAsset({ ...input, assetId }, input.createdAt);
    return this.getAsset(assetId)!;
  }

  getAsset(assetId: string): OutfitAssetRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM outfit_assets WHERE asset_id = ? AND role_id = ?",
      )
      .get(assetId, this.roleId) as AssetRow | undefined;
    return row === undefined ? null : mapAsset(row);
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
    createdAt: row.created_at,
  };
}

function isUniqueConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("UNIQUE constraint failed");
}
