/**
 * 外观写入策略（310 §2 / DL-153）：预置服饰与预置素材只读，自添服饰开放。
 * 前端据此禁用操作，后端仍会以 PRESET_APPEARANCE_LOCKED 兜底。
 */

/** @param {{isPreset?: boolean} | null | undefined} outfit */
export function outfitWritePolicy(outfit) {
  // 没有选中的服饰时不存在任何可执行操作。
  if (!outfit) return { rename: false, replaceHome: false, remove: false, uploadSprite: false };
  const preset = outfit.isPreset === true;
  return {
    rename: !preset,
    replaceHome: !preset,
    remove: !preset,
    uploadSprite: !preset,
  };
}

/** 单张素材（主页图或差分）是否随应用预置、因此不可删除。 */
export function assetLocked(asset) {
  return asset?.isPreset === true;
}
