import type { Outfit, OutfitAsset } from '../../types';

export interface OutfitWritePolicy {
  rename: boolean;
  replaceHome: boolean;
  remove: boolean;
  uploadSprite: boolean;
}

export function outfitWritePolicy(outfit: Pick<Outfit, 'isPreset'> | null | undefined): OutfitWritePolicy;
export function assetLocked(asset: Pick<OutfitAsset, 'isPreset'> | null | undefined): boolean;
