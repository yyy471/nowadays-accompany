import crypto from 'node:crypto';
import { isCapabilityId, type CapabilityId } from '../policy/capabilities.js';
import { HttpBodyError, readResponseText } from '../platform/http/bounded-body.js';
import { ConfigError, ProviderError } from './errors.js';
import { parseProvider, type ProviderConfig, type ProviderLocation } from './types.js';

export interface SimpleModelSetup {
  providerId?: string;
  capability: CapabilityId;
  baseUrl: string;
  modelId: string;
  secret?: string;
  adapterId?: string;
  supportsTools?: boolean;
  parameters?: Record<string, unknown>;
  confirmCost?: boolean;
}

export function parseModelSetup(raw: unknown): SimpleModelSetup {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('模型配置必须是对象');
  const v = raw as Record<string, unknown>;
  if (!isCapabilityId(v.capability)) throw new ConfigError('请选择模型类型');
  if (typeof v.baseUrl !== 'string' || !v.baseUrl.trim()) throw new ConfigError('请填写 Base URL');
  if (typeof v.modelId !== 'string' || !v.modelId.trim()) throw new ConfigError('请填写模型名称');
  if (v.secret !== undefined && (typeof v.secret !== 'string' || v.secret.length > 8192 || /[\r\n\0]/.test(v.secret))) throw new ConfigError('API Key 格式无效');
  if (v.providerId !== undefined && (typeof v.providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.providerId))) throw new ConfigError('服务不存在或标识无效');
  if (v.supportsTools !== undefined && typeof v.supportsTools !== 'boolean') throw new ConfigError('工具调用选项无效');
  if (v.parameters !== undefined && (!v.parameters || typeof v.parameters !== 'object' || Array.isArray(v.parameters))) throw new ConfigError('模型参数必须是对象');
  return { ...(v.providerId ? { providerId: v.providerId as string } : {}), capability: v.capability, baseUrl: v.baseUrl.trim(), modelId: v.modelId.trim(),
    ...(v.secret ? { secret: v.secret as string } : {}), ...(typeof v.adapterId === 'string' ? { adapterId: v.adapterId } : {}),
    ...(typeof v.supportsTools === 'boolean' ? { supportsTools: v.supportsTools } : {}), ...(v.parameters ? { parameters: v.parameters as Record<string, unknown> } : {}), confirmCost: v.confirmCost === true };
}

/** The UI asks for one URL; network location remains internal policy metadata. */
export function inferProviderLocation(baseUrl: string): ProviderLocation {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ConfigError('Base URL 无效'); }
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const parts = h.split('.').map(Number);
  const privateV4 = parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 169 && parts[1] === 254));
  return h === 'localhost' || h === '::1' || privateV4 || /\.(localhost|local|lan|internal)$/.test(h) || (h.includes(':') && /^(fc|fd|fe80:)/i.test(h)) ? 'local' : 'cloud';
}

export function buildSimpleProvider(input: SimpleModelSetup, existing?: ProviderConfig): ProviderConfig {
  if (input.providerId && !existing) throw new ConfigError('该服务已被删除，请重新选择');
  const location = inferProviderLocation(input.baseUrl);
  const model = existing?.models.find((entry) => entry.id === input.modelId);
  const inputType = input.capability === 'image.understand' ? 'image' : input.capability === 'video.understand' ? 'video' : 'text';
  const selected = { id: input.modelId, capabilities: [...new Set([...(model?.capabilities ?? []), input.capability])],
    input: [...new Set([...(model?.input ?? ['text'] as const), inputType])],
    supportsTools: input.supportsTools ?? model?.supportsTools ?? false, parameters: { ...model?.parameters, ...input.parameters } };
  const sameOrigin = existing && new URL(existing.baseUrl).origin === new URL(input.baseUrl).origin;
  const { credentialRef: _ref, ...preserved } = existing ?? {};
  return parseProvider({ ...preserved,
    id: existing?.id ?? `model-${input.capability.replace(/\./g, '-')}-${crypto.randomBytes(4).toString('hex')}`,
    adapterId: input.adapterId ?? existing?.adapterId ?? 'openai-compatible-v1', baseUrl: input.baseUrl,
    location, ...(sameOrigin && existing?.credentialRef ? { credentialRef: existing.credentialRef } : {}),
    models: [...(existing?.models.filter((entry) => entry.id !== input.modelId) ?? []), selected]
  });
}

export async function discoverProviderModels(provider: ProviderConfig, credential?: string): Promise<string[]> {
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl}/models`, { headers: credential ? { authorization: `Bearer ${credential}` } : {}, redirect: 'error', signal });
  } catch { throw new ProviderError('provider_discovery_failed', '无法获取模型列表，请检查地址、网络或手动输入模型名称。', { providerId: provider.id, retryable: true }); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError('provider_discovery_failed', response.status === 401 || response.status === 403 ? `API Key 验证失败（HTTP ${response.status}）` : `模型列表不可用（HTTP ${response.status}），可手动输入模型名称。`, { providerId: provider.id, retryable: false, httpStatus: response.status });
  }
  let text: string;
  try {
    text = await readResponseText(response, { maxBytes: 1024 * 1024, signal, label: 'model list response' });
  } catch (error) {
    if (error instanceof HttpBodyError && error.code === 'http_body_too_large') {
      throw new ConfigError('模型列表响应过大，请手动输入模型名称');
    }
    throw new ProviderError('provider_discovery_failed', '无法读取模型列表，请检查地址、网络或手动输入模型名称。', { providerId: provider.id, retryable: true, cause: error });
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ConfigError('服务未返回有效模型列表，可手动输入模型名称'); }
  const payload = raw as { data?: unknown; models?: unknown } | null;
  const list = payload?.data ?? payload?.models;
  if (!Array.isArray(list)) throw new ConfigError('服务不支持模型列表，可手动输入模型名称');
  return [...new Set(list.slice(0, 2048).map((entry) => typeof entry === 'string' ? entry : entry?.id ?? entry?.name ?? entry?.model)
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id)))].sort();
}
