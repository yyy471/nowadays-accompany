import type { ArtifactRef, SlotsResponse } from '../types';

export interface BindingTarget { accountId: string; kind: 'private' | 'group'; peerId: string }
export interface HomeRoleBinding extends BindingTarget { roleCard: ArtifactRef; state: 'ready' | 'missing'; cardName?: string; revision: string }
export interface HomeBindingsResponse { bindings: HomeRoleBinding[] }

export function bindingElementId(target: BindingTarget): string {
  return `role-binding-${encodeURIComponent(JSON.stringify([target.accountId,target.kind,target.peerId]))}`;
}
export function homeConnection(accountId: string, slots?: SlotsResponse, error?: string): { label: string; connected: boolean; tone: 'ok' | 'warn' | 'idle' } {
  if (!slots || error) return { label: error ? '连接状态待更新' : '正在读取连接状态', connected: false, tone: 'idle' };
  const matches = slots.slots.filter(slot => slot.accountId === accountId);
  if (matches.some(slot => slot.state === 'online' && slot.connected)) return { label: 'QQ 已连接', connected: true, tone: 'ok' };
  if (matches.some(slot => slot.connected || ['starting','awaiting_login','degraded'].includes(slot.state))) return { label: '连接准备中', connected: false, tone: 'warn' };
  return { label: 'QQ 未连接', connected: false, tone: 'idle' };
}
const ACCOUNT_KEY = 'nowadays.home-account.v1';
export function readHomeAccount(): string { try { return window.sessionStorage.getItem(ACCOUNT_KEY) ?? ''; } catch { return ''; } }
export function rememberHomeAccount(id: string): void { try { window.sessionStorage.setItem(ACCOUNT_KEY,id); } catch { /* UI preference is optional. */ } }
