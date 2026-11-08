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
