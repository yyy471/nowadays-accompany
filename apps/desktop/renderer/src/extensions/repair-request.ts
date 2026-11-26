import { api, ApiError } from '../api';
import type { RoleListItem } from '../types';
import type { Extension } from './ExtensionSlotFrame';

type FaultSnapshot = Pick<Extension, 'extId' | 'version' | 'status' | 'lastError'>;

export function hasExtensionFault(item: Pick<FaultSnapshot, 'status' | 'lastError'>) {
  return item.status === 'failed' || item.lastError != null;
}

export function faultFingerprint({ version, status, lastError }: FaultSnapshot) {
  return JSON.stringify([version, status, lastError?.code, lastError?.message]);
}

export function repairMessage({ extId, version, status, lastError }: FaultSnapshot) {
  const summary = lastError?.message.trim().split(/\r?\n/, 1)[0].slice(0, 240) || '暂无错误摘要';
  const diagnostic = lastError?.code ? `${lastError.code} · ${summary}` : summary;
  return ['请排查并修复这个扩展。', `extId：${extId}`, `version：${version}`,
    `status：${status}`, `最近错误（扩展原始诊断文本）：${diagnostic}`].join('\n');
}

export function createRepairSender() {
  // 回执未确认时保留提交标识，扩展事件流重连并重建行后也能重试。
  const pending = new Map<string, { extId: string; fingerprint: string; submissionId: string }>();
  function reconcile(items: FaultSnapshot[]) {
    for (const [key, record] of pending) {
      const current = items.find(item => item.extId === record.extId);
      if (!current || !hasExtensionFault(current) || faultFingerprint(current) !== record.fingerprint) pending.delete(key);
    }
  }
  async function send(seat: RoleListItem | undefined, item: FaultSnapshot) {
    if (!seat?.defaultWindowId) return { sent: false, notice: '主角色尚未就绪' };
    const path = `/v1/roles/${encodeURIComponent(seat.roleId)}/windows/${encodeURIComponent(seat.defaultWindowId)}/messages`;
    const key = JSON.stringify([path, item.extId]);
    const fingerprint = faultFingerprint(item);
    const previous = pending.get(key);
    const record = previous?.fingerprint === fingerprint ? previous : { extId: item.extId, fingerprint, submissionId: crypto.randomUUID() };
    pending.set(key, record);
    try {
      await api(path, { method: 'POST', body: { content: repairMessage(item), submissionId: record.submissionId } });
      if (pending.get(key) === record) pending.delete(key);
      return { sent: true, notice: '已交给主角色排查' };
    } catch (error) {
      const stopped = error instanceof ApiError && error.status === 409 && error.code === 'ROLE_ACTIVITY_STOPPED';
      return { sent: false, notice: stopped ? '请先恢复主角色活动' : '暂未确认送达，请重试' };
    }
  }
  return { send, reconcile };
}
