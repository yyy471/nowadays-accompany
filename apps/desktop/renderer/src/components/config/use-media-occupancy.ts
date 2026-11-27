import { errorText } from '../../lib/error-text';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { RoleListItem } from '../../types';

type Activity = { roleId: string; state: 'active' | 'stopping' | 'stopped' };
export function useMediaOccupancy(kind: 'voice' | 'image', serviceId: string, roles: RoleListItem[], activities: Activity[]) {
  const [result, setResult] = useState<{ ids: string[]; error: string } | null>(null);
  const readyRoles = roles.filter(role => role.status !== 'initializing' && role.status !== 'failed');
  const roleKey = JSON.stringify(readyRoles.map(role => role.roleId));
  useEffect(() => {
    const request = new AbortController();
    const { signal } = request;
    if (!serviceId) { setResult({ ids: [], error: '' }); return; }
    setResult(null);
    Promise.all(readyRoles.map(async role => {
      const path = kind === 'voice' ? 'voice' : 'scene-image';
      const data = await api<{ voice?: { serviceId?: string | null } | null; settings?: { serviceId?: string } | null }>(`/v1/roles/${encodeURIComponent(role.roleId)}/${path}`, { signal });
      return (kind === 'voice' ? data.voice?.serviceId : data.settings?.serviceId) === serviceId ? role.roleId : null;
    })).then(ids => { if (!signal.aborted) setResult({ ids: ids.filter((id): id is string => id !== null), error: '' }); })
      .catch(error => { if (!signal.aborted) setResult({ ids: [], error: errorText(error) }); });
    return () => request.abort();
    // ID 列表变化才重新读取；状态变化由下方派生。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, serviceId, roleKey]);
  const names = (result?.ids ?? []).map(id => roles.find(role => role.roleId === id)?.displayName || id);
  const activeIds = (result?.ids ?? []).filter(id => activities.find(item => item.roleId === id)?.state !== 'stopped');
  return { loading: result === null, error: result?.error || '', ids: result?.ids ?? [], names, activeIds };
}
