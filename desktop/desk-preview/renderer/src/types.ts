export interface AccountsResponse {
  accounts: Array<{ accountId: string; nickname: string; signature?: string; avatarDataUrl?: string; avatarSource?: 'local' | 'remote' }>;
}
export interface RoleListItem { roleId: string; displayName: string; status: string; initError: string | null }
export interface RoleDetail { roleId: string; displayName: string; definitionRevision: number; definition: { text: string; payload: Record<string, unknown> } }
export type InstanceState = 'provisioning' | 'starting' | 'awaiting_login' | 'online' | 'degraded' | 'awaiting_profile' | 'stopping' | 'stopped' | 'failed';
