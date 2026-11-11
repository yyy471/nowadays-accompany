export type OutfitAssetUsage = "home" | "sprite";

export interface OutfitAssetRecord {
  assetId: string;
  outfitId: string;
  roleId: string;
  usage: OutfitAssetUsage;
  fileName: string;
  displayName: string;
  mediaType: string;
  relativePath: string;
  /** 素材已从衣柜移除但为历史句段保留时为删除时间；正常衣柜项为 null。 */
  deletedAt: string | null;
  createdAt: string;
}

export interface OutfitRecord {
  outfitId: string;
  roleId: string;
  name: string;
  description: string | null;
  home: OutfitAssetRecord | null;
  sprites: OutfitAssetRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface UploadedImage {
  fileName: string;
  data: Buffer;
}

export interface InspectedImage {
  mediaType: string;
  extension: string;
  width: number;
  height: number;
}
