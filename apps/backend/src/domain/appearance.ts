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
  /** 是否为系统随应用预置的外观素材，仅标记来源。 */
  isPreset: boolean;
  /** 素材已从衣柜移除但为历史句段保留时为删除时间；正常衣柜项为 null。 */
  deletedAt: string | null;
  createdAt: string;
}

export interface OutfitRecord {
  outfitId: string;
  roleId: string;
  name: string;
  description: string | null;
  /** 是否为系统随应用预置的服饰，仅标记来源。 */
  isPreset: boolean;
  /** 系统预置来源目录标识（如 "default" / "02_weaver"）；用户自定义服饰为 null。 */
  presetKey: string | null;
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
