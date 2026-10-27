import crypto from 'node:crypto';
import { assertIdentifier, type ChatKind } from '../routing/identity.js';
import { CAPABILITY_IDS, isCapabilityId, type CapabilityId } from '../policy/capabilities.js';
import type { SkillConfig } from '../extensions/types.js';
import { isPluginKey, isPluginSkillId, isToolId } from '../extensions/contracts.js';
import { ConfigError } from './errors.js';

export const CONFIG_SCHEMA_VERSION = 2;
export const DEFAULT_MEDIA_RETENTION_DAYS = 7;

export const MEDIA_TRANSPORTS = ['inline', 'url'] as const;
export type MediaTransport = (typeof MEDIA_TRANSPORTS)[number];

export type InputModality = 'text' | 'image' | 'video';
export type ProviderLocation = 'local' | 'cloud';
export type VisionMode = 'external' | 'direct';
export type CancelMode = 'remote' | 'localOnly' | 'none';

export interface ProviderModelConfig {
  id: string;
  capabilities: CapabilityId[];
  input: InputModality[];
  supportsTools: boolean;
  parameters: Record<string, unknown>;
}

export interface ProviderLimits {
  maxConcurrent: number;
  maxQueue: number;
}

export interface ProviderTimeouts {
  requestMs: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

export interface ProviderRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface ProviderConfig {
  id: string;
  adapterId: string;
  baseUrl: string;
  credentialRef?: string;
  location: ProviderLocation;
  models: ProviderModelConfig[];
  mediaTransports: MediaTransport[];
  limits: ProviderLimits;
  timeouts: ProviderTimeouts;
  retry: ProviderRetryPolicy;
  options: Record<string, unknown>;
}

export interface CapabilityTarget {
  providerId: string;
  modelId: string;
  parameters?: Record<string, unknown>;
}

export interface CapabilityBinding extends CapabilityTarget {
  fallback?: CapabilityTarget[];
}

export interface ScopePolicy {
  agentEnabled?: boolean;
  /** 普通开关：细作用域可显式覆盖，账号硬授权不在此处。 */
  capabilities?: Partial<Record<CapabilityId, boolean>>;
  bindings?: Partial<Record<CapabilityId, CapabilityBinding>>;
  visionMode?: VisionMode;
}

export interface AccountMediaPolicy {
  allowCloudUpload: boolean;
}

/** 公用 Skill 定义之外，账号可选择启用/禁用，并用同 id 定义覆盖为私有版本。 */
export interface AccountSkillPolicy {
  /** Legacy input only; parsed policies migrate these to extension run switches. */
  enabled?: string[];
  /** Legacy input only; parsed policies migrate these to extension run switches. */
  disabled?: string[];
  definitions?: SkillConfig[];
}

export type ExtensionSwitch = 'inherit' | 'on' | 'off';

/** Per-scope soft switches for plugins, tools and skills. Absent/inherit keeps the lower layer. */
export interface ExtensionRunPolicy {
  plugins?: Record<string, ExtensionSwitch>;
  tools?: Record<string, ExtensionSwitch>;
  skills?: Record<string, ExtensionSwitch>;
  /** Account-shared plugin state is valid only when the plugin manifest declares it. */
  state?: Record<string, ExtensionSwitch>;
}

/**
 * The account extension subtree. It owns hard tool authorization as well as run switches;
 * profile installation stays in the account profile.
 */
export interface AccountExtensionPolicy {
  /** Hard tool authorization; a session switch can only narrow this list, never extend it. */
  authorizedTools?: string[];
  defaults: ExtensionRunPolicy;
  byKind: Partial<Record<ChatKind, ExtensionRunPolicy>>;
  byConversation: Record<string, ExtensionRunPolicy>;
}

export interface AccountPolicy extends ScopePolicy {
  allowedProviders: string[];
  crossProviderFallback: boolean;
  media: AccountMediaPolicy;
  skills?: AccountSkillPolicy;
  extensions?: AccountExtensionPolicy;
  byKind: Partial<Record<ChatKind, ScopePolicy>>;
  byConversation: Record<string, ScopePolicy>;
}

export interface MediaConfig {
  retentionDays: number;
}

export interface RuntimeConfigV2 {
  schemaVersion: 2;
  providers: ProviderConfig[];
  accountPolicies: Record<string, AccountPolicy>;
  skills: SkillConfig[];
  media: MediaConfig;
}

export interface ProviderDto {
  id: string;
  adapterId: string;
  baseUrl: string;
  location: ProviderLocation;
  credential: { ref?: string; configured: boolean };
  models: ProviderModelConfig[];
  capabilities: CapabilityId[];
  mediaTransports: MediaTransport[];
  limits: ProviderLimits;
  timeouts: ProviderTimeouts;
  retry: ProviderRetryPolicy;
  options: Record<string, unknown>;
}

export const DEFAULT_PROVIDER_LIMITS: ProviderLimits = { maxConcurrent: 2, maxQueue: 8 };
export const DEFAULT_PROVIDER_TIMEOUTS: ProviderTimeouts = {
  requestMs: 60_000,
  pollIntervalMs: 1_000,
  pollTimeoutMs: 120_000
};
export const DEFAULT_PROVIDER_RETRY: ProviderRetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 500,
  maxDelayMs: 4_000
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CREDENTIAL_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const INPUT_MODALITIES = new Set<InputModality>(['text', 'image', 'video']);
const LOCATIONS = new Set<ProviderLocation>(['local', 'cloud']);
const VISION_MODES = new Set<VisionMode>(['external', 'direct']);
const MEDIA_TRANSPORT_SET = new Set<string>(MEDIA_TRANSPORTS);
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const FORBIDDEN_SECRET_KEYS = new Set([
  'apikey',
  'accesstoken',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'password',
  'privatekey',
  'secret',
  'token',
  'authorization',
  'credential',
  'credentials'
]);

function fail(path: string, message: string): never {
  throw new ConfigError(`${path}: ${message}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path, `unknown field "${key}"`);
  }
}

function boolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function positiveInt(value: unknown, path: string, fallback: number, max = 1_000_000): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    fail(path, `must be an integer between 1 and ${max}`);
  }
  return value as number;
}

function nonNegativeInt(value: unknown, path: string, fallback: number, max = 1_000_000): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
    fail(path, `must be an integer between 0 and ${max}`);
  }
  return value as number;
}

function normalizeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/** 配置只允许 credentialRef；发现疑似明文密钥直接拒绝，避免静默落盘。 */
export function assertNoInlineSecrets(value: unknown, path = 'config'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoInlineSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,})$/i.test(value.trim())) {
      fail(path, 'looks like an inline credential; use credentialRef');
    }
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeKey(key);
    if (FORBIDDEN_SECRET_KEYS.has(normalized) && !normalized.endsWith('ref')) {
      fail(`${path}.${key}`, 'inline credentials are not allowed; use credentialRef');
    }
    if (typeof entry === 'string' && /^https?:\/\//i.test(entry)) {
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        fail(`${path}.${key}`, 'must be a valid URL');
      }
      if (url.username || url.password) fail(`${path}.${key}`, 'URL must not contain credentials');
      for (const param of url.searchParams.keys()) {
        const name = normalizeKey(param);
        if (FORBIDDEN_SECRET_KEYS.has(name) || name.endsWith('signature')) {
          fail(`${path}.${key}`, 'URL must not contain credentials in query parameters');
        }
      }
    }
    assertNoInlineSecrets(entry, `${path}.${key}`);
  }
}

export function normalizeBaseUrl(raw: unknown, path: string, location: ProviderLocation): string {
  if (typeof raw !== 'string' || !raw.trim()) fail(path, 'baseUrl is required');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    fail(path, 'baseUrl must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(path, 'baseUrl must use http or https');
  if (url.username || url.password) fail(path, 'baseUrl must not contain credentials');
  if (url.hash) fail(path, 'baseUrl must not contain a fragment');
  if (url.search) fail(path, 'baseUrl must not contain query parameters');
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

function parseModel(raw: unknown, path: string): ProviderModelConfig {
  const value = object(raw, path);
  exactKeys(value, ['id', 'capabilities', 'input', 'supportsTools', 'parameters'], path);
  const id = typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256 && value.id.trim() === value.id && !/[\u0000-\u001f\u007f]/.test(value.id) ? value.id : fail(`${path}.id`, 'must be a model name between 1 and 256 characters');
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    fail(`${path}.capabilities`, 'must contain at least one capability');
  }
  const capabilities: CapabilityId[] = [];
  for (const entry of value.capabilities) {
    if (!isCapabilityId(entry)) fail(`${path}.capabilities`, `unsupported capability ${String(entry)}`);
    if (!capabilities.includes(entry)) capabilities.push(entry);
  }
  const input: InputModality[] = [];
  if (value.input !== undefined) {
    if (!Array.isArray(value.input) || value.input.length === 0) fail(`${path}.input`, 'must be a non-empty array');
    for (const entry of value.input) {
      if (typeof entry !== 'string' || !INPUT_MODALITIES.has(entry as InputModality)) {
        fail(`${path}.input`, `unsupported modality ${String(entry)}`);
      }
      if (!input.includes(entry as InputModality)) input.push(entry as InputModality);
    }
  } else {
    input.push('text');
  }
  if (capabilities.some((capability) => capability !== 'chat') && !input.includes('text')) {
    // 媒体能力本身仍由输入媒体驱动；这里不强制，但 UI 会提示。
  }
  return {
    id,
    capabilities,
    input,
    supportsTools: boolean(value.supportsTools, `${path}.supportsTools`, false),
    parameters: value.parameters === undefined ? {} : object(value.parameters, `${path}.parameters`)
  };
}

export function parseProvider(raw: unknown, path = 'provider'): ProviderConfig {
  assertNoInlineSecrets(raw, path);
  const value = object(raw, path);
  exactKeys(
    value,
    [
      'id',
      'adapterId',
      'baseUrl',
      'credentialRef',
      'location',
      'models',
      'mediaTransports',
      'limits',
      'timeouts',
      'retry',
      'options'
    ],
    path
  );
  const id = typeof value.id === 'string' && ID.test(value.id) ? value.id : fail(`${path}.id`, `must match ${ID}`);
  const adapterId =
    typeof value.adapterId === 'string' && ID.test(value.adapterId)
      ? value.adapterId
      : fail(`${path}.adapterId`, `must match ${ID}`);
  if (typeof value.location !== 'string' || !LOCATIONS.has(value.location as ProviderLocation)) {
    fail(`${path}.location`, 'must be local or cloud');
  }
  const location = value.location as ProviderLocation;
  const baseUrl = normalizeBaseUrl(value.baseUrl, `${path}.baseUrl`, location);

  let credentialRef: string | undefined;
  if (value.credentialRef !== undefined) {
    if (typeof value.credentialRef !== 'string' || !CREDENTIAL_REF.test(value.credentialRef)) {
      fail(`${path}.credentialRef`, 'must be a credential reference, never a secret');
    }
    credentialRef = value.credentialRef;
  }

  if (!Array.isArray(value.models) || value.models.length === 0) {
    fail(`${path}.models`, 'must contain at least one model');
  }
  const models = value.models.map((entry, index) => parseModel(entry, `${path}.models[${index}]`));
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) fail(`${path}.models`, `duplicate model id ${model.id}`);
    modelIds.add(model.id);
  }

  const mediaTransports: MediaTransport[] = [];
  if (value.mediaTransports !== undefined) {
    if (!Array.isArray(value.mediaTransports)) fail(`${path}.mediaTransports`, 'must be an array');
    for (const entry of value.mediaTransports) {
      if (typeof entry !== 'string' || !MEDIA_TRANSPORT_SET.has(entry)) {
        fail(`${path}.mediaTransports`, `unsupported transport ${String(entry)}`);
      }
      if (!mediaTransports.includes(entry as MediaTransport)) mediaTransports.push(entry as MediaTransport);
    }
  } else {
    mediaTransports.push('inline');
  }
  if (mediaTransports.length === 0) fail(`${path}.mediaTransports`, 'must contain at least one transport');

  const limits = value.limits === undefined ? {} : object(value.limits, `${path}.limits`);
  exactKeys(limits, ['maxConcurrent', 'maxQueue'], `${path}.limits`);
  const timeouts = value.timeouts === undefined ? {} : object(value.timeouts, `${path}.timeouts`);
  exactKeys(timeouts, ['requestMs', 'pollIntervalMs', 'pollTimeoutMs'], `${path}.timeouts`);
  const retry = value.retry === undefined ? {} : object(value.retry, `${path}.retry`);
  exactKeys(retry, ['maxAttempts', 'baseDelayMs', 'maxDelayMs'], `${path}.retry`);

  return {
    id,
    adapterId,
    baseUrl,
    ...(credentialRef ? { credentialRef } : {}),
    location,
    models,
    mediaTransports,
    limits: {
      maxConcurrent: positiveInt(limits.maxConcurrent, `${path}.limits.maxConcurrent`, DEFAULT_PROVIDER_LIMITS.maxConcurrent, 64),
      maxQueue: nonNegativeInt(limits.maxQueue, `${path}.limits.maxQueue`, DEFAULT_PROVIDER_LIMITS.maxQueue, 1_000)
    },
    timeouts: {
      requestMs: positiveInt(timeouts.requestMs, `${path}.timeouts.requestMs`, DEFAULT_PROVIDER_TIMEOUTS.requestMs, 600_000),
      pollIntervalMs: positiveInt(
        timeouts.pollIntervalMs,
        `${path}.timeouts.pollIntervalMs`,
        DEFAULT_PROVIDER_TIMEOUTS.pollIntervalMs,
        60_000
      ),
      pollTimeoutMs: positiveInt(
        timeouts.pollTimeoutMs,
        `${path}.timeouts.pollTimeoutMs`,
        DEFAULT_PROVIDER_TIMEOUTS.pollTimeoutMs,
        3_600_000
      )
    },
    retry: {
      maxAttempts: positiveInt(retry.maxAttempts, `${path}.retry.maxAttempts`, DEFAULT_PROVIDER_RETRY.maxAttempts, 8),
      baseDelayMs: positiveInt(retry.baseDelayMs, `${path}.retry.baseDelayMs`, DEFAULT_PROVIDER_RETRY.baseDelayMs, 60_000),
      maxDelayMs: positiveInt(retry.maxDelayMs, `${path}.retry.maxDelayMs`, DEFAULT_PROVIDER_RETRY.maxDelayMs, 300_000)
    },
    options: value.options === undefined ? {} : object(value.options, `${path}.options`)
  };
}

function parseTarget(raw: unknown, path: string): CapabilityTarget {
  const value = object(raw, path);
  exactKeys(value, ['providerId', 'modelId', 'parameters'], path);
  const providerId =
    typeof value.providerId === 'string' && ID.test(value.providerId)
      ? value.providerId
      : fail(`${path}.providerId`, `must match ${ID}`);
  const modelId =
    typeof value.modelId === 'string' && value.modelId.length > 0 && value.modelId.length <= 256 && value.modelId.trim() === value.modelId && !/[\u0000-\u001f\u007f]/.test(value.modelId)
      ? value.modelId
      : fail(`${path}.modelId`, 'must be a model name between 1 and 256 characters');
  return {
    providerId,
    modelId,
    ...(value.parameters === undefined ? {} : { parameters: object(value.parameters, `${path}.parameters`) })
  };
}

function parseBinding(raw: unknown, path: string): CapabilityBinding {
  const value = object(raw, path);
  exactKeys(value, ['providerId', 'modelId', 'parameters', 'fallback'], path);
  const target = parseTarget(
    {
      providerId: value.providerId,
      modelId: value.modelId,
      ...(value.parameters === undefined ? {} : { parameters: value.parameters })
    },
    path
  );
  if (value.fallback === undefined) return target;
  if (!Array.isArray(value.fallback) || value.fallback.length > 4) {
    fail(`${path}.fallback`, 'must be an array of at most 4 targets');
  }
  return { ...target, fallback: value.fallback.map((entry, index) => parseTarget(entry, `${path}.fallback[${index}]`)) };
}

export function parseScopePolicy(raw: unknown, path: string): ScopePolicy {
  const value = object(raw, path);
  exactKeys(value, ['agentEnabled', 'capabilities', 'bindings', 'visionMode'], path);
  const policy: ScopePolicy = {};
  if (value.agentEnabled !== undefined) {
    if (typeof value.agentEnabled !== 'boolean') fail(`${path}.agentEnabled`, 'must be a boolean');
    policy.agentEnabled = value.agentEnabled;
  }
  if (value.capabilities !== undefined) {
    const switches = object(value.capabilities, `${path}.capabilities`);
    const capabilities: Partial<Record<CapabilityId, boolean>> = {};
    for (const [key, entry] of Object.entries(switches)) {
      if (!isCapabilityId(key)) fail(`${path}.capabilities`, `unsupported capability ${key}`);
      if (typeof entry !== 'boolean') fail(`${path}.capabilities.${key}`, 'must be a boolean');
      capabilities[key] = entry;
    }
    policy.capabilities = capabilities;
  }
  if (value.bindings !== undefined) {
    const bindings = object(value.bindings, `${path}.bindings`);
    const parsed: Partial<Record<CapabilityId, CapabilityBinding>> = {};
    for (const [key, entry] of Object.entries(bindings)) {
      if (!isCapabilityId(key)) fail(`${path}.bindings`, `unsupported capability ${key}`);
      parsed[key] = parseBinding(entry, `${path}.bindings.${key}`);
    }
    policy.bindings = parsed;
  }
  if (value.visionMode !== undefined) {
    if (typeof value.visionMode !== 'string' || !VISION_MODES.has(value.visionMode as VisionMode)) {
      fail(`${path}.visionMode`, 'must be external or direct');
    }
    policy.visionMode = value.visionMode as VisionMode;
  }
  return policy;
}

function parseExtensionSwitch(raw: unknown, path: string): ExtensionSwitch {
  if (raw !== 'inherit' && raw !== 'on' && raw !== 'off') fail(path, 'must be inherit, on or off');
  return raw;
}

function parseExtensionRunPolicy(raw: unknown, path: string): ExtensionRunPolicy {
  const value = object(raw, path);
  exactKeys(value, ['plugins', 'tools', 'skills', 'state'], path);
  const policy: ExtensionRunPolicy = {};
  const sections = [
    ['plugins', (key: string) => isPluginKey(key)],
    ['tools', (key: string) => isToolId(key)],
    ['skills', (key: string) => ID.test(key) || isPluginSkillId(key)],
    ['state', (key: string) => isPluginKey(key)]
  ] as const;
  for (const [section, validKey] of sections) {
    const entriesRaw = value[section];
    if (entriesRaw === undefined) continue;
    const entries = object(entriesRaw, `${path}.${section}`);
    if (Object.keys(entries).length > 128) fail(`${path}.${section}`, 'must contain at most 128 entries');
    const parsed: Record<string, 'on' | 'off'> = {};
    for (const [key, switchRaw] of Object.entries(entries)) {
      if (!validKey(key)) fail(`${path}.${section}`, `invalid key ${key}`);
      const resolved = parseExtensionSwitch(switchRaw, `${path}.${section}.${key}`);
      if (resolved !== 'inherit') parsed[key] = resolved;
    }
    if (Object.keys(parsed).length > 0) policy[section] = parsed;
  }
  return policy;
}

function parseAccountExtensions(raw: unknown, path: string): AccountExtensionPolicy | undefined {
  const value = object(raw, path);
  exactKeys(value, ['authorizedTools', 'defaults', 'byKind', 'byConversation'], path);
  const authorizedTools: string[] = [];
  if (value.authorizedTools !== undefined) {
    if (!Array.isArray(value.authorizedTools)) fail(`${path}.authorizedTools`, 'must be an array');
    for (const entry of value.authorizedTools) {
      if (typeof entry !== 'string' || !isToolId(entry)) {
        fail(`${path}.authorizedTools`, `invalid tool id ${String(entry)}`);
      }
      if (!authorizedTools.includes(entry)) authorizedTools.push(entry);
    }
  }
  const defaults = value.defaults === undefined ? {} : parseExtensionRunPolicy(value.defaults, `${path}.defaults`);
  const byKindRaw = value.byKind === undefined ? {} : object(value.byKind, `${path}.byKind`);
  exactKeys(byKindRaw, ['private', 'group'], `${path}.byKind`);
  const byKind: Partial<Record<ChatKind, ExtensionRunPolicy>> = {};
  for (const kind of ['private', 'group'] as const) {
    if (byKindRaw[kind] === undefined) continue;
    const parsed = parseExtensionRunPolicy(byKindRaw[kind], `${path}.byKind.${kind}`);
    if (!extensionRunPolicyEmpty(parsed)) byKind[kind] = parsed;
  }
  const byConversationRaw = value.byConversation === undefined ? {} : object(value.byConversation, `${path}.byConversation`);
  const byConversation: Record<string, ExtensionRunPolicy> = {};
  for (const [key, entry] of Object.entries(byConversationRaw)) {
    const [kind, peerId, ...rest] = key.split('/');
    if (rest.length > 0 || (kind !== 'private' && kind !== 'group') || !peerId || !ID.test(peerId)) {
      fail(`${path}.byConversation`, `invalid conversation key ${key}; expected private/<peerId> or group/<peerId>`);
    }
    const parsed = parseExtensionRunPolicy(entry, `${path}.byConversation.${key}`);
    if (!extensionRunPolicyEmpty(parsed)) byConversation[key] = parsed;
  }
  return pruneAccountExtensionPolicy({
    ...(authorizedTools.length > 0 ? { authorizedTools } : {}),
    defaults,
    byKind,
    byConversation
  });
}

function migrateLegacySkillSwitches(
  base: AccountExtensionPolicy | undefined,
  enabled: string[],
  disabled: string[]
): AccountExtensionPolicy | undefined {
  if (enabled.length === 0 && disabled.length === 0) return base;
  const next: AccountExtensionPolicy = base
    ? structuredClone(base)
    : { defaults: {}, byKind: {}, byConversation: {} };
  const switches = { ...(next.defaults.skills ?? {}) };
  for (const id of enabled) if (switches[id] === undefined) switches[id] = 'on';
  for (const id of disabled) if (switches[id] === undefined) switches[id] = 'off';
  next.defaults = {
    ...next.defaults,
    ...(Object.keys(switches).length > 0 ? { skills: switches } : {})
  };
  return pruneAccountExtensionPolicy(next);
}

function pruneAccountExtensionPolicy(policy: AccountExtensionPolicy): AccountExtensionPolicy | undefined {
  const authorizedTools = policy.authorizedTools && policy.authorizedTools.length > 0
    ? [...policy.authorizedTools]
    : undefined;
  const byKind = Object.fromEntries(
    Object.entries(policy.byKind).filter(([, entry]) => !extensionRunPolicyEmpty(entry))
  ) as AccountExtensionPolicy['byKind'];
  const byConversation = Object.fromEntries(
    Object.entries(policy.byConversation).filter(([, entry]) => !extensionRunPolicyEmpty(entry))
  );
  if (extensionRunPolicyEmpty(policy.defaults)
    && Object.keys(byKind).length === 0
    && Object.keys(byConversation).length === 0) {
    if (!authorizedTools) return undefined;
    return { authorizedTools, defaults: {}, byKind: {}, byConversation: {} };
  }
  return {
    ...(authorizedTools ? { authorizedTools } : {}),
    defaults: policy.defaults,
    byKind,
    byConversation
  };
}

function extensionRunPolicyEmpty(policy: ExtensionRunPolicy): boolean {
  return !policy.plugins && !policy.tools && !policy.skills && !policy.state;
}

export function parseAccountPolicy(raw: unknown, path = 'accountPolicy'): AccountPolicy {
  const value = object(raw, path);
  exactKeys(
    value,
    ['allowedProviders', 'crossProviderFallback', 'media', 'enabledTools', 'skills', 'extensions', 'byKind', 'byConversation', 'agentEnabled', 'capabilities', 'bindings', 'visionMode'],
    path
  );
  const scope = parseScopePolicy(
    {
      ...(value.agentEnabled === undefined ? {} : { agentEnabled: value.agentEnabled }),
      ...(value.capabilities === undefined ? {} : { capabilities: value.capabilities }),
      ...(value.bindings === undefined ? {} : { bindings: value.bindings }),
      ...(value.visionMode === undefined ? {} : { visionMode: value.visionMode })
    },
    path
  );
  const allowedProviders: string[] = [];
  if (value.allowedProviders !== undefined) {
    if (!Array.isArray(value.allowedProviders)) fail(`${path}.allowedProviders`, 'must be an array');
    for (const entry of value.allowedProviders) {
      if (typeof entry !== 'string' || !ID.test(entry)) fail(`${path}.allowedProviders`, `invalid provider id ${String(entry)}`);
      if (!allowedProviders.includes(entry)) allowedProviders.push(entry);
    }
  }
  const media = value.media === undefined ? {} : object(value.media, `${path}.media`);
  exactKeys(media, ['allowCloudUpload'], `${path}.media`);
  const legacyAuthorizedTools: string[] = [];
  if (value.enabledTools !== undefined) {
    if (!Array.isArray(value.enabledTools)) fail(`${path}.enabledTools`, 'must be an array');
    for (const entry of value.enabledTools) {
      if (typeof entry !== 'string' || !isToolId(entry)) fail(`${path}.enabledTools`, `invalid tool id ${String(entry)}`);
      if (!legacyAuthorizedTools.includes(entry)) legacyAuthorizedTools.push(entry);
    }
  }
  let parsedExtensions = value.extensions === undefined
    ? undefined
    : parseAccountExtensions(value.extensions, `${path}.extensions`);
  if (legacyAuthorizedTools.length > 0) {
    if (parsedExtensions?.authorizedTools?.length) {
      fail(path, 'enabledTools and extensions.authorizedTools cannot both be set; use extensions.authorizedTools');
    }
    parsedExtensions = pruneAccountExtensionPolicy({
      ...(parsedExtensions ?? { defaults: {}, byKind: {}, byConversation: {} }),
      authorizedTools: legacyAuthorizedTools
    });
  }
  let skills: AccountSkillPolicy | undefined;
  const legacySkillEnabled: string[] = [];
  const legacySkillDisabled: string[] = [];
  if (value.skills !== undefined) {
    const skillsRaw = object(value.skills, `${path}.skills`);
    exactKeys(skillsRaw, ['enabled', 'disabled', 'definitions'], `${path}.skills`);
    for (const [key, target] of [['enabled', legacySkillEnabled], ['disabled', legacySkillDisabled]] as const) {
      const rawList = skillsRaw[key];
      if (rawList === undefined) continue;
      if (!Array.isArray(rawList)) fail(`${path}.skills.${key}`, 'must be an array');
      for (const entry of rawList) {
        if (typeof entry !== 'string' || !ID.test(entry)) {
          fail(`${path}.skills.${key}`, `invalid skill id ${String(entry)}`);
        }
        if (!target.includes(entry)) target.push(entry);
      }
    }
    const overlap = legacySkillEnabled.find((id) => legacySkillDisabled.includes(id));
    if (overlap) fail(`${path}.skills`, `skill ${overlap} cannot be both enabled and disabled`);
    const definitions: SkillConfig[] = [];
    if (skillsRaw.definitions !== undefined) {
      if (!Array.isArray(skillsRaw.definitions)) fail(`${path}.skills.definitions`, 'must be an array');
      for (const [index, entry] of skillsRaw.definitions.entries()) {
        const definition = parseSkillDefinition(entry, `${path}.skills.definitions[${index}]`);
        // A private definition may keep enabled=false as its default; scope switches still override it.
        definitions.push(definition);
      }
      const ids = new Set<string>();
      for (const definition of definitions) {
        if (ids.has(definition.id)) fail(`${path}.skills.definitions`, `duplicate skill id ${definition.id}`);
        ids.add(definition.id);
      }
    }
    skills = definitions.length > 0 ? { definitions } : undefined;
  }
  const extensions = migrateLegacySkillSwitches(parsedExtensions, legacySkillEnabled, legacySkillDisabled);
  const byKindRaw = value.byKind === undefined ? {} : object(value.byKind, `${path}.byKind`);
  exactKeys(byKindRaw, ['private', 'group'], `${path}.byKind`);
  const byKind: Partial<Record<ChatKind, ScopePolicy>> = {};
  for (const kind of ['private', 'group'] as const) {
    if (byKindRaw[kind] !== undefined) byKind[kind] = parseScopePolicy(byKindRaw[kind], `${path}.byKind.${kind}`);
  }
  const byConversationRaw =
    value.byConversation === undefined ? {} : object(value.byConversation, `${path}.byConversation`);
  const byConversation: Record<string, ScopePolicy> = {};
  for (const [key, entry] of Object.entries(byConversationRaw)) {
    const [kind, peerId, ...rest] = key.split('/');
    if (rest.length > 0 || (kind !== 'private' && kind !== 'group') || !peerId || !ID.test(peerId)) {
      fail(`${path}.byConversation`, `invalid conversation key ${key}; expected private/<peerId> or group/<peerId>`);
    }
    byConversation[key] = parseScopePolicy(entry, `${path}.byConversation.${key}`);
  }
  return {
    ...scope,
    allowedProviders,
    crossProviderFallback: boolean(value.crossProviderFallback, `${path}.crossProviderFallback`, false),
    media: { allowCloudUpload: boolean(media.allowCloudUpload, `${path}.media.allowCloudUpload`, false) },
    ...(skills ? { skills } : {}),
    ...(extensions ? { extensions } : {}),
    byKind,
    byConversation
  };
}

export function parseSkillDefinition(raw: unknown, path: string): SkillConfig {
  const value = object(raw, path);
  exactKeys(value, ['id', 'name', 'description', 'instructions', 'tools', 'requires', 'kinds', 'peers', 'enabled'], path);
  const id = typeof value.id === 'string' && ID.test(value.id) ? value.id : fail(`${path}.id`, `must match ${ID}`);
  if (typeof value.name !== 'string' || !value.name.trim()) fail(`${path}.name`, 'is required');
  if (typeof value.instructions !== 'string' || !value.instructions.trim()) fail(`${path}.instructions`, 'is required');
  if (!Array.isArray(value.tools)) fail(`${path}.tools`, 'must be an array');
  const tools: string[] = [];
  for (const entry of value.tools) {
    if (typeof entry !== 'string' || !(ID.test(entry) || isToolId(entry))) fail(`${path}.tools`, `invalid tool ${String(entry)}`);
    // Earlier configs referenced image.generate as a Skill tool id. Keep that
    // spelling as an explicit compatibility alias for the now-namespaced tool.
    const toolId = entry === 'image.generate' ? 'builtin.image.generate' : entry;
    if (!tools.includes(toolId)) tools.push(toolId);
  }
  const requires: CapabilityId[] = [];
  if (value.requires !== undefined) {
    if (!Array.isArray(value.requires)) fail(`${path}.requires`, 'must be an array');
    for (const entry of value.requires) {
      if (!isCapabilityId(entry)) fail(`${path}.requires`, `unsupported capability ${String(entry)}`);
      if (!requires.includes(entry)) requires.push(entry);
    }
  }
  const kinds: ChatKind[] = [];
  if (value.kinds !== undefined) {
    if (!Array.isArray(value.kinds)) fail(`${path}.kinds`, 'must be an array');
    for (const entry of value.kinds) {
      if (entry !== 'private' && entry !== 'group') fail(`${path}.kinds`, `invalid kind ${String(entry)}`);
      if (!kinds.includes(entry)) kinds.push(entry);
    }
  }
  const peers: string[] = [];
  if (value.peers !== undefined) {
    if (!Array.isArray(value.peers)) fail(`${path}.peers`, 'must be an array');
    for (const entry of value.peers) {
      if (typeof entry !== 'string' || !ID.test(entry)) fail(`${path}.peers`, `invalid peer ${String(entry)}`);
      if (!peers.includes(entry)) peers.push(entry);
    }
  }
  return {
    id,
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    instructions: value.instructions,
    tools,
    ...(requires.length > 0 ? { requires } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(peers.length > 0 ? { peers } : {}),
    ...(value.enabled === undefined ? {} : { enabled: boolean(value.enabled, `${path}.enabled`, true) })
  };
}

export function parseRuntimeConfig(raw: unknown, source = 'config'): RuntimeConfigV2 {
  assertNoInlineSecrets(raw, source);
  const value = object(raw, source);
  exactKeys(value, ['schemaVersion', 'providers', 'accountPolicies', 'skills', 'media'], source);
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    fail(`${source}.schemaVersion`, `must be ${CONFIG_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.providers)) fail(`${source}.providers`, 'must be an array');
  const providers = value.providers.map((entry, index) => parseProvider(entry, `${source}.providers[${index}]`));
  const providerIds = new Set<string>();
  for (const provider of providers) {
    if (providerIds.has(provider.id)) fail(`${source}.providers`, `duplicate provider id ${provider.id}`);
    providerIds.add(provider.id);
  }
  const accountPoliciesRaw =
    value.accountPolicies === undefined ? {} : object(value.accountPolicies, `${source}.accountPolicies`);
  const accountPolicies: Record<string, AccountPolicy> = {};
  for (const [accountId, entry] of Object.entries(accountPoliciesRaw)) {
    if (!ACCOUNT_ID.test(accountId)) fail(`${source}.accountPolicies`, `invalid account id ${accountId}`);
    accountPolicies[accountId] = parseAccountPolicy(entry, `${source}.accountPolicies.${accountId}`);
  }
  const skillsRaw = value.skills === undefined ? [] : value.skills;
  if (!Array.isArray(skillsRaw)) fail(`${source}.skills`, 'must be an array');
  const skills = skillsRaw.map((entry, index) => parseSkillDefinition(entry, `${source}.skills[${index}]`));
  const skillIds = new Set<string>();
  for (const skill of skills) {
    if (skillIds.has(skill.id)) fail(`${source}.skills`, `duplicate skill id ${skill.id}`);
    skillIds.add(skill.id);
  }
  const mediaRaw = value.media === undefined ? {} : object(value.media, `${source}.media`);
  exactKeys(mediaRaw, ['retentionDays'], `${source}.media`);
  return {
    schemaVersion: 2,
    providers,
    accountPolicies,
    skills,
    media: {
      retentionDays: positiveInt(mediaRaw.retentionDays, `${source}.media.retentionDays`, DEFAULT_MEDIA_RETENTION_DAYS, 365)
    }
  };
}

export function emptyRuntimeConfig(): RuntimeConfigV2 {
  return {
    schemaVersion: 2,
    providers: [],
    accountPolicies: {},
    skills: [],
    media: { retentionDays: DEFAULT_MEDIA_RETENTION_DAYS }
  };
}

export function defaultAccountPolicy(): AccountPolicy {
  return {
    allowedProviders: [],
    crossProviderFallback: false,
    media: { allowCloudUpload: false },
    byKind: {},
    byConversation: {}
  };
}

export function accountPolicyFor(config: RuntimeConfigV2, accountId: string): AccountPolicy {
  return config.accountPolicies[accountId] ?? defaultAccountPolicy();
}

export function providerCapabilities(provider: ProviderConfig): CapabilityId[] {
  const result: CapabilityId[] = [];
  for (const capability of CAPABILITY_IDS) {
    if (provider.models.some((model) => model.capabilities.includes(capability))) result.push(capability);
  }
  return result;
}

function redactOptions(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((entry) => redactOptions(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeKey(key);
    if (FORBIDDEN_SECRET_KEYS.has(normalized) || normalized.endsWith('secret') || normalized.endsWith('password')) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = redactOptions(entry, depth + 1);
  }
  return output;
}

export function redactProvider(provider: ProviderConfig, credentialConfigured: boolean): ProviderDto {
  return {
    id: provider.id,
    adapterId: provider.adapterId,
    baseUrl: provider.baseUrl,
    location: provider.location,
    credential: {
      ...(provider.credentialRef ? { ref: provider.credentialRef } : {}),
      configured: credentialConfigured
    },
    models: provider.models.map((model) => ({
      ...model,
      capabilities: [...model.capabilities],
      input: [...model.input],
      parameters: { ...model.parameters }
    })),
    capabilities: providerCapabilities(provider),
    mediaTransports: [...provider.mediaTransports],
    limits: { ...provider.limits },
    timeouts: { ...provider.timeouts },
    retry: { ...provider.retry },
    options: (redactOptions(provider.options) as Record<string, unknown>) ?? {}
  };
}

/** 稳定序列化，确保配置指纹不受对象键顺序影响。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

export function configFingerprint(config: RuntimeConfigV2): string {
  return crypto.createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16);
}

export function conversationScopeKey(kind: ChatKind, peerId: string): string {
  return `${kind}/${assertIdentifier(peerId, 'peerId')}`;
}

export function isProviderId(value: string): boolean {
  return ID.test(value);
}
