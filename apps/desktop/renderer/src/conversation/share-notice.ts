export interface ShareNotice {
  source: 'autonomy_share';
  roleId: string;
  windowId: string;
  messageId: string;
  summary: string;
  homeAssetId?: string | null;
}

export function receiveShare(value: Partial<ShareNotice> | null, seatId: string, mainWindow: string,
  visibleWindow: string | null, seen: Set<string>): ShareNotice | null {
  if (value?.source !== 'autonomy_share' || value.roleId !== seatId || value.windowId !== mainWindow ||
      typeof value.summary !== 'string' || typeof value.messageId !== 'string' || !value.messageId ||
      seen.has(value.messageId)) return null;
  seen.add(value.messageId);
  return visibleWindow === mainWindow ? null : value as ShareNotice;
}

export function receiveCoplayShare(value: Partial<ShareNotice> | null, visibleWindow: string | null, seen: Set<string>) {
  if (!value?.roleId || !value.windowId) return null;
  return receiveShare(value, value.roleId, value.windowId, visibleWindow, seen);
}
