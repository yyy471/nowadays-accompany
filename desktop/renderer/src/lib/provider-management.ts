import type { ProviderDto } from '../types.js';

export type ProviderEditDraft = { baseUrl: string; adapterId: string; modelIds: string[]; secret: string };
export const providerEditDraft = (provider: ProviderDto): ProviderEditDraft => ({
  baseUrl: provider.baseUrl, adapterId: provider.adapterId, modelIds: provider.models.map(model => model.id), secret: ''
});
function origin(value: string): string { try { return new URL(value).origin; } catch { return ''; } }

/** Build from the frozen edit baseline, retaining fields this small form does not edit. */
export function providerEditPayload(provider: ProviderDto, draft: ProviderEditDraft) {
  const baseUrl = draft.baseUrl.trim();
  if (!origin(baseUrl)) throw new Error('请输入有效的 Base URL。');
  if (provider.credential.configured && origin(baseUrl) !== origin(provider.baseUrl) && !draft.secret) {
    throw new Error('更换地址后请重新输入 API Key；旧凭据不会发送到新地址。');
  }
  const ids = draft.modelIds.map(id => id.trim());
  if (ids.length !== provider.models.length || ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('模型名不能为空或重复。');
  const options = structuredClone(provider.options);
  const markers = options.settingsModels;
  if (markers && typeof markers === 'object' && !Array.isArray(markers)) {
    options.settingsModels = Object.fromEntries(Object.entries(markers).map(([capability, id]) => {
      const index = provider.models.findIndex(model => model.id === id);
      return [capability, index < 0 ? id : ids[index]];
    }));
  }
  return {
    inferLocationFromUrl: true,
    provider: {
      id: provider.id, baseUrl, adapterId: draft.adapterId.trim(), location: provider.location,
      ...(provider.credential.ref && origin(baseUrl) === origin(provider.baseUrl) ? { credentialRef: provider.credential.ref } : {}),
      models: provider.models.map((model, index) => ({ ...structuredClone(model), id: ids[index]! })),
      mediaTransports: [...provider.mediaTransports], limits: { ...provider.limits }, timeouts: { ...provider.timeouts }, retry: { ...provider.retry }, options
    },
    ...(draft.secret ? { secret: draft.secret } : {})
  };
}

export type ProviderImpact = { ok: true; providerId: string; exists: boolean; affectedAccounts: string[] };
export type ProviderDeleteResult = { ok: true; removed: boolean; affectedAccounts: string[] };
export type ProviderRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

/** DELETE is reachable only after a successful read-only preview and explicit acceptance. */
export async function previewAndDeleteProvider(
  id: string, request: ProviderRequest, confirm: (impact: ProviderImpact) => Promise<boolean>, active: () => boolean = () => true
): Promise<ProviderDeleteResult | undefined> {
  const path = `/providers/${encodeURIComponent(id)}`;
  const impact = await request<ProviderImpact>(`${path}/impact`);
  if (impact.ok !== true || impact.providerId !== id || !Array.isArray(impact.affectedAccounts)) throw new Error('无法确认服务影响范围，请重试。');
  if (!active()) return;
  if (!impact.exists) throw new Error('该服务已不存在，请刷新服务列表。');
  if (!await confirm(impact) || !active()) return;
  return request<ProviderDeleteResult>(path, { method: 'DELETE' });
}
