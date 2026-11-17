export interface AccountsResponse {
  accounts: Array<{ accountId: string; nickname: string; signature?: string; avatarDataUrl?: string; avatarSource?: 'local' | 'remote' }>;
}
export interface RoleListItem {
  roleId: string;
  displayName: string;
  status: string;
  initError: string | null;
  defaultWindowId?: string | null;
  /** 后端标记的内置角色（夏澄）；普通角色为 false。 */
  isBuiltin?: boolean;
  builtinKey?: string | null;
  /** 只读预置人物介绍；与可编辑的角色卡正文分开保存。 */
  bio?: string;
}
export interface RoleDetail {
  roleId: string;
  displayName: string;
  definitionRevision: number;
  defaultWindowId?: string;
  definition: { text: string; payload: Record<string, unknown> };
  isBuiltin?: boolean;
  builtinKey?: string | null;
  bio?: string;
}
export interface RoleStateResponse { state: Record<string, unknown>; stateVersion: number; updatedAt: string }
export interface OutfitAsset { assetId: string; outfitId: string; usage: 'home' | 'sprite'; fileName: string; displayName: string; mediaType: string; relativePath: string; createdAt: string; isPreset?: boolean }
export interface Outfit { outfitId: string; roleId: string; name: string; description: string | null; home: OutfitAsset | null; sprites: OutfitAsset[]; createdAt: string; updatedAt: string; isPreset?: boolean; presetKey?: string | null }
export function appearanceAssetUrl(roleId: string, assetId: string): string {
  return `/v1/roles/${encodeURIComponent(roleId)}/appearance/assets/${encodeURIComponent(assetId)}`;
}
export type InstanceState = 'provisioning' | 'starting' | 'awaiting_login' | 'online' | 'degraded' | 'awaiting_profile' | 'stopping' | 'stopped' | 'failed';
