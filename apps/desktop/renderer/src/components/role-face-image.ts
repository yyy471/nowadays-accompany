import { appearanceAssetUrl, type OutfitAsset } from '../types';

export interface RoleFaceImage { roleId: string; url: string; preset: boolean }

export function roleFaceImage(roleId: string, home: Pick<OutfitAsset, 'assetId' | 'isPreset'> | null | undefined): RoleFaceImage | undefined {
  if (!home?.assetId) return undefined;
  return { roleId, url: appearanceAssetUrl(roleId, home.assetId), preset: home.isPreset === true };
}
