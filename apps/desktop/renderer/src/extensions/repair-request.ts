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

type RepairResult = { sent: boolean; notice: string };
type RepairRecord = {
  extId: string; fingerprint: string; submissionId: string;
  flight?: Promise<RepairResult>; result?: RepairResult;
};

export function createRepairSender(changed: () => void = () => {}) {
  const records = new Map<string, RepairRecord>();
  const keyFor = (seat: RoleListItem | undefined, item: FaultSnapshot) =>
    JSON.stringify([seat?.roleId, seat?.defaultWindowId, item.extId, faultFingerprint(item)]);
  function reconcile(items: FaultSnapshot[]) {
    for (const [key, record] of records) {
      const current = items.find(item => item.extId === record.extId);
      if (!current || !hasExtensionFault(current) || faultFingerprint(current) !== record.fingerprint) records.delete(key);
    }
  }
  const read = (seat: RoleListItem | undefined, item: FaultSnapshot) => records.get(keyFor(seat, item));
  function send(seat: RoleListItem | undefined, item: FaultSnapshot): Promise<RepairResult> {
    const key = keyFor(seat, item);
    let record = records.get(key);
    if (!record) {
      record = { extId: item.extId, fingerprint: faultFingerprint(item), submissionId: crypto.randomUUID() };
      records.set(key, record);
    }
    if (record.flight) return record.flight;
    if (record.result?.sent) return Promise.resolve(record.result);
    if (!seat?.defaultWindowId) {
      record.result = { sent: false, notice: '主角色尚未就绪' };
      changed();
      return Promise.resolve(record.result);
    }
    const path = `/v1/roles/${encodeURIComponent(seat.roleId)}/windows/${encodeURIComponent(seat.defaultWindowId)}/messages`;
    const current = record;
    current.result = undefined;
    current.flight = api(path, { method: 'POST', body: { content: repairMessage(item), submissionId: current.submissionId } })
      .then(() => ({ sent: true, notice: '已交给主角色排查' }), (error: unknown) => ({
        sent: false, notice: error instanceof ApiError && error.status === 409 && error.code === 'ROLE_ACTIVITY_STOPPED'
          ? '请先恢复主角色活动' : '暂未确认送达，请重试'
      })).then(result => {
        if (records.get(key) === current) {
          current.result = result;
          current.flight = undefined;
          changed();
        }
        return result;
      });
    changed();
    return current.flight;
  }
  return { read, send, reconcile };
}
