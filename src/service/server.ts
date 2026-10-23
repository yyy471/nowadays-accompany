import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import type { TypedEventBus } from '../core/bus.js';
import type { CoreEvents } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { AccompanyError, BackpressureError, ChannelError, BackendError, InvalidSpecError } from '../core/errors.js';
import { isLoopbackHost } from '../core/net.js';
import type { AuditLog } from '../core/audit.js';
import type { EventLog, LoggedEvent } from '../core/event-log.js';
import type { Metrics } from '../core/metrics.js';
import type { InstanceSpec, InstanceStatus } from '../instances/spec.js';
import type {
  AccountProfileFile,
  ArtifactRef,
  ArtifactKind,
  ProfileSummary,
  ResolvedArtifact
} from '../artifacts/types.js';
import type { DeploymentRecord } from '../artifacts/deploy.js';
import type { ConversationRef } from '../routing/identity.js';
import { assertIdentifier, assertKind } from '../routing/identity.js';
import type { OutboundMessage } from '../routing/message.js';
import { textMessage } from '../routing/message.js';
import type { SendOptions, SendResult } from '../instances/instance.js';
import type { ReadOptions, StoredMessage } from '../storage/contract.js';
import type { AccountPolicy, ProviderDto } from '../providers/types.js';
import type { ProviderTestResult } from '../providers/contract.js';
import type { EffectiveCapabilitiesDto } from '../providers/router.js';
import type { CapabilityId } from '../policy/capabilities.js';
import { isCapabilityId } from '../policy/capabilities.js';
import type { JobDto } from '../jobs/types.js';
import type { MediaData, MediaRef } from '../media/types.js';
import type { InjectionSettings } from '../injection/settings.js';
import type { InjectionOperationDto, ManualInjectionResumeResult } from '../injection/manual.js';
import type { SnowLumaProcess, SnowLumaRuntimeStatus } from '../injection/snowluma/manager.js';
import type { ConversationRoleBinding } from '../profiles/role-bindings.js';
import type { AccountDisplayProfile } from '../profiles/display.js';

export interface AccountSummary {
  accountId: string;
  dir: string;
  state: 'ready' | 'invalid';
  file?: AccountProfileFile;
  profile?: ProfileSummary;
  error?: string;
  slots: string[];
  /** 本地展示资料；没有 display.json 时省略。 */
  nickname?: string;
  signature?: string;
  /** 本地展示头像优先；缺失时回退到 QQ 公开头像。 */
  avatarDataUrl?: string;
  avatarSource?: 'local' | 'qq';
}

export interface CoreView {
  bus: TypedEventBus<CoreEvents>;
  metrics: Metrics;
  eventLog: EventLog;
  auditLog: AuditLog;
  status(): { instances: InstanceStatus[]; apiUrl?: string; dataRoot?: string };
  startInstance(id: string): Promise<void>;
  stopInstance(id: string): Promise<void>;
  send(instanceId: string, conversation: ConversationRef, message: OutboundMessage, options?: SendOptions): Promise<SendResult>;
  listConversations(accountId?: string): Promise<ConversationRef[]>;
  readMessages(accountId: string, conversation: ConversationRef, options?: ReadOptions): Promise<StoredMessage[]>;
  diagnostics(): unknown;
  listPublicArtifacts(): Promise<ResolvedArtifact[]>;
  listAccountArtifacts(accountId: string): Promise<ResolvedArtifact[]>;
  artifactCatalog(): Promise<Record<string, string>>;
  listAccounts(options?: { avatars?: boolean }): Promise<AccountSummary[]>;
  slotSpecs(): InstanceSpec[];
  getAccountProfile(accountId: string): Promise<AccountProfileFile | undefined>;
  getAccountDisplay(accountId: string): Promise<AccountDisplayProfile>;
  saveAccountDisplay(accountId: string, raw: unknown): Promise<AccountDisplayProfile>;
  saveAccountProfile(
    accountId: string,
    raw: unknown
  ): Promise<{ profile: AccountProfileFile; reload?: { ok: boolean; error?: string } }>;
  listConversationRoleBindings(
    accountId: string
  ): Promise<Array<ConversationRoleBinding & { state: 'ready' | 'missing'; cardName?: string }>>;
  setConversationRoleBinding(
    conversation: ConversationRef,
    roleCard: ArtifactRef | null
  ): Promise<ConversationRoleBinding | undefined>;
  reloadAccount(accountId: string): Promise<Array<{ instanceId: string; ok: boolean; error?: string }>>;
  deployArtifact(kind: ArtifactKind, id: string, revision: string): Promise<DeploymentRecord>;
  rollbackArtifacts(): Promise<DeploymentRecord>;
  deployments(): DeploymentRecord[];
  addSlot(spec: InstanceSpec): Promise<InstanceStatus>;
  removeSlot(id: string): Promise<void>;
  injectionSettings(): InjectionSettings;
  setInjectionSettings(raw: unknown, secret?: string): Promise<{ settings: InjectionSettings; status: SnowLumaRuntimeStatus }>;
  clearInjectionPassword(): Promise<{ status: SnowLumaRuntimeStatus }>;
  injectionStatus(): Promise<SnowLumaRuntimeStatus>;
  testInjectionConnection(): Promise<{ runtime: SnowLumaRuntimeStatus; processCount: number }>;
  retrySnowLumaRuntime(): Promise<SnowLumaRuntimeStatus>;
  resumeInjectionListening(): Promise<ManualInjectionResumeResult>;
  injectionResumeCandidates(): Array<{ slotId: string; accountId: string }>;
  injectionProcesses(options?: { avatars?: boolean }): Promise<SnowLumaProcess[]>;
  injectAndListen(raw: unknown): Promise<InjectionOperationDto>;
  listenInjection(raw: unknown): Promise<InjectionOperationDto>;
  refreshInjection(raw: unknown): Promise<InjectionOperationDto>;
  unloadInjection(raw: unknown): Promise<InjectionOperationDto>;
  injectionOperation(id: string): InjectionOperationDto | undefined;
  credentialStore(): { kind: string; available: boolean };
  listProviders(): Promise<ProviderDto[]>;
  upsertProvider(raw: unknown, secret?: string): Promise<ProviderDto>;
  configureSimpleModel(raw: unknown): Promise<ProviderDto>;
  discoverModels(raw: unknown): Promise<string[]>;
  validateSimpleModel(raw: unknown): Promise<ProviderTestResult>;
  deleteProvider(id: string): Promise<{ removed: boolean; affectedAccounts: string[] }>;
  setProviderCredential(id: string, secret: string): Promise<ProviderDto>;
  deleteProviderCredential(id: string): Promise<ProviderDto>;
  testProvider(id: string, capability: CapabilityId, modelId?: string, confirmCost?: boolean): Promise<ProviderTestResult>;
  testAccountCapability(accountId: string, capability: CapabilityId, confirmCost?: boolean): Promise<ProviderTestResult>;
  getAccountPolicy(accountId: string): AccountPolicy;
  setAccountPolicy(accountId: string, raw: unknown): Promise<AccountPolicy>;
  patchAgentEnabled(accountId: string, enabled: boolean, scope?: { kind?: 'private' | 'group'; peerId?: string }): Promise<AccountPolicy>;
  patchCapabilityEnabled(
    accountId: string,
    capability: CapabilityId,
    enabled: boolean,
    scope?: { kind?: 'private' | 'group'; peerId?: string }
  ): Promise<AccountPolicy>;
  effectiveCapabilities(accountId: string, conversation: ConversationRef): Promise<EffectiveCapabilitiesDto>;
  listJobs(accountId?: string): Promise<JobDto[]>;
  getJob(accountId: string, jobId: string): Promise<JobDto | undefined>;
  cancelJob(accountId: string, jobId: string): Promise<JobDto>;
  listMedia(accountId: string): Promise<MediaRef[]>;
  readMedia(accountId: string, mediaId: string): Promise<MediaData>;
  deleteMedia(accountId: string, mediaId: string): Promise<boolean>;
  cleanupMedia(): Promise<{ deleted: number; skippedInUse: number; failed: number }>;
}

export interface ApiHandle {
  url: string;
  close(): Promise<void>;
}

export interface ApiServerOptions {
  core: CoreView;
  host?: string;
  port?: number;
  token?: string;
  logger?: Logger;
  maxBodyBytes?: number;
  maxSseClients?: number;
  metrics?: Metrics;
  eventLog?: EventLog;
  auditLog?: AuditLog;
  /** 静态 UI 目录；静态资源免 token，API 仍需要授权。 */
  uiDir?: string;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable?: boolean;

  constructor(status: number, message: string, code = 'http_error', retryable?: boolean) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const MAX_SSE_BUFFER_BYTES = 1_000_000;

const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const API_PREFIXES = new Set([
  'health',
  'instances',
  'conversations',
  'accounts',
  'artifacts',
  'deployments',
  'slots',
  'metrics',
  'diagnostics',
  'events',
  'providers',
  'jobs',
  'media',
  'injection'
]);

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

async function readJson(request: http.IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, 'request body too large', 'body_too_large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'body must be a json object', 'invalid_body');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid json body', 'invalid_json');
  }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  response.end(payload);
}

function writeSse(response: http.ServerResponse, event: LoggedEvent): boolean {
  if (response.writableEnded) return false;
  if (response.writableLength > MAX_SSE_BUFFER_BYTES) return false;
  response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  return true;
}

/** 本地控制面：默认只监听回环地址；非回环必须显式提供 Bearer token。 */
export async function createApiServer(options: ApiServerOptions): Promise<ApiHandle> {
  const core = options.core;
  const host = options.host ?? '127.0.0.1';
  const token = options.token;
  if (!isLoopbackHost(host) && !token) {
    throw new AccompanyError('api_requires_token', `refusing to bind control API to non-loopback host ${host} without a token`);
  }
  const maxBody = options.maxBodyBytes ?? 1_048_576;
  const maxSseClients = options.maxSseClients ?? 32;
  const logger = options.logger;
  const metrics = options.metrics ?? core.metrics;
  const eventLog = options.eventLog ?? core.eventLog;
  const auditLog = options.auditLog ?? core.auditLog;
  const sseClients = new Set<http.ServerResponse>();
  const uiDir = options.uiDir ? path.resolve(options.uiDir) : undefined;

  /**
   * UI 与 API 同源，静态资源不需要 token（页面在拿到 preload 注入的 token 前就要能加载）。
   * API 前缀一律放行给后面的路由，避免 SPA fallback 吞掉接口。
   */
  const serveUi = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    pathname: string
  ): Promise<boolean> => {
    if (!uiDir) return false;
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    const prefix = pathname.split('/')[1] ?? '';
    if (API_PREFIXES.has(prefix)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (decoded.includes('\0')) return false;
    const target = path.resolve(uiDir, `.${decoded}`);
    const relative = path.relative(uiDir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    let file = target;
    let stat = await statFile(file);
    if (!stat?.isFile()) {
      if (path.extname(decoded)) return false;
      file = path.join(uiDir, 'index.html');
      stat = await statFile(file);
      if (!stat?.isFile()) return false;
    }
    const body = await fs.readFile(file);
    const extension = path.extname(file).toLowerCase();
    const headers: http.OutgoingHttpHeaders = {
      'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff'
    };
    if (extension === '.html') headers['content-security-policy'] = UI_CSP;
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  };

  const authorize = (request: http.IncomingMessage, pathname: string): void => {
    if (!token || pathname === '/health' || pathname === '/health/ready') return;
    const header = request.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided || !safeEqual(provided, token)) throw new HttpError(401, 'unauthorized', 'unauthorized');
  };

  const findInstance = (id: string): InstanceStatus => {
    const instance = core.status().instances.find((item) => item.id === id);
    if (!instance) throw new HttpError(404, `unknown instance: ${id}`, 'unknown_instance');
    return instance;
  };

  const requestIdFor = (request: http.IncomingMessage): string => {
    const raw = request.headers['x-request-id'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value && value.length <= 128 ? value : crypto.randomUUID();
  };

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error instanceof HttpError ? error.status : statusForError(error);
      const code =
        error instanceof HttpError
          ? error.code
          : error instanceof AccompanyError
            ? error.code
            : 'internal_error';
      const retryable =
        error instanceof HttpError
          ? error.retryable
          : error instanceof BackendError || error instanceof ChannelError
            ? error.retryable
            : error instanceof BackpressureError
              ? true
              : undefined;
      metrics.inc('api.errors', 1, { status, code });
      if (status >= 500) logger?.error('api request failed', { message: error instanceof Error ? error.message : String(error) });
      sendJson(response, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code,
        ...(retryable !== undefined ? { retryable } : {})
      });
    });
  });

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestId = requestIdFor(request);
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-api-version', '1');
    const url = new URL(request.url ?? '/', `http://${host}`);
    let pathname = url.pathname;
    if (pathname === '/v1') pathname = '/';
    else if (pathname.startsWith('/v1/')) pathname = pathname.slice(3);
    metrics.inc('api.requests', 1, { method: request.method ?? 'GET' });
    if (await serveUi(request, response, pathname)) return;
    authorize(request, pathname);

    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { ok: true, instances: core.status().instances.length });
      return;
    }

    if (request.method === 'GET' && pathname === '/health/ready') {
      const instances = core.status().instances;
      const online = instances.filter((instance) => instance.state === 'online').length;
      const ready = instances.length === 0 || online > 0;
      sendJson(response, ready ? 200 : 503, {
        ok: ready,
        ready,
        instances: { total: instances.length, online }
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/instances') {
      sendJson(response, 200, { ok: true, instances: core.status().instances });
      return;
    }

    if (request.method === 'GET' && pathname === '/accounts') {
      const avatars = url.searchParams.get('avatars') === '1';
      const accounts = await core.listAccounts(avatars ? { avatars: true } : {});
      sendJson(response, 200, { ok: true, accounts });
      return;
    }

    if (request.method === 'GET' && pathname === '/providers') {
      sendJson(response, 200, {
        ok: true,
        providers: await core.listProviders(),
        credentialStore: core.credentialStore()
      });
      return;
    }

    if (request.method === 'POST' && ['/providers/simple', '/providers/models', '/providers/validate'].includes(pathname)) {
      const body = await readJson(request, maxBody);
      const remote = request.socket.remoteAddress;
      if (pathname === '/providers/models') {
        const models = await core.discoverModels(body);
        sendJson(response, 200, { ok: true, models });
      } else if (pathname === '/providers/validate') {
        const result = await runAudited({ action: 'validate_model', id: String(body.providerId ?? body.capability ?? 'draft'), requestId, ...(remote ? { remote } : {}) }, () => core.validateSimpleModel(body));
        sendJson(response, 200, { ok: true, result });
      } else {
        const provider = await runAudited({ action: 'configure_model', id: String(body.providerId ?? body.capability ?? 'model'), requestId, ...(remote ? { remote } : {}) }, () => core.configureSimpleModel(body));
        sendJson(response, 200, { ok: true, provider });
      }
      return;
    }

    if (request.method === 'POST' && pathname === '/providers') {
      const body = await readJson(request, maxBody);
      const { provider, secret } = providerPayload(body);
      const remote = request.socket.remoteAddress;
      const saved = await runAudited(
        {
          action: 'upsert_provider',
          id: typeof provider.id === 'string' ? provider.id : 'provider',
          requestId,
          ...(remote ? { remote } : {})
        },
        () => core.upsertProvider(provider, secret)
      );
      sendJson(response, 201, { ok: true, provider: saved });
      return;
    }

    const providerMatch = /^\/providers\/([A-Za-z0-9._-]{1,64})$/.exec(pathname);
    if (providerMatch && request.method === 'PUT') {
      const id = providerMatch[1] as string;
      const body = await readJson(request, maxBody);
      const { provider, secret } = providerPayload(body);
      if (provider.id !== undefined && provider.id !== id) {
        throw new HttpError(400, 'provider id does not match the URL', 'invalid_provider');
      }
      provider.id = id;
      const remote = request.socket.remoteAddress;
      const saved = await runAudited(
        { action: 'upsert_provider', id, requestId, ...(remote ? { remote } : {}) },
        () => core.upsertProvider(provider, secret)
      );
      sendJson(response, 200, { ok: true, provider: saved });
      return;
    }

    if (providerMatch && request.method === 'DELETE') {
      const id = providerMatch[1] as string;
      const remote = request.socket.remoteAddress;
      const result = await runAudited(
        { action: 'remove_provider', id, requestId, ...(remote ? { remote } : {}) },
        () => core.deleteProvider(id)
      );
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    const providerCredentialMatch = /^\/providers\/([A-Za-z0-9._-]{1,64})\/credential$/.exec(pathname);
    if (providerCredentialMatch && request.method === 'PUT') {
      const id = providerCredentialMatch[1] as string;
      const body = await readJson(request, maxBody);
      if (typeof body.secret !== 'string' || body.secret.length === 0) {
        throw new HttpError(400, 'secret is required', 'invalid_credential');
      }
      const remote = request.socket.remoteAddress;
      const provider = await runAudited(
        { action: 'set_provider_credential', id, requestId, ...(remote ? { remote } : {}) },
        () => core.setProviderCredential(id, body.secret as string)
      );
      sendJson(response, 200, { ok: true, provider });
      return;
    }

    if (providerCredentialMatch && request.method === 'DELETE') {
      const id = providerCredentialMatch[1] as string;
      const remote = request.socket.remoteAddress;
      const provider = await runAudited(
        { action: 'delete_provider_credential', id, requestId, ...(remote ? { remote } : {}) },
        () => core.deleteProviderCredential(id)
      );
      sendJson(response, 200, { ok: true, provider });
      return;
    }

    const providerTestMatch = /^\/providers\/([A-Za-z0-9._-]{1,64})\/test$/.exec(pathname);
    if (providerTestMatch && request.method === 'POST') {
      const id = providerTestMatch[1] as string;
      const body = await readJson(request, maxBody);
      const capability = parseCapability(body.capability);
      const modelId = typeof body.modelId === 'string' ? body.modelId : undefined;
      const confirmCost = body.confirmCost === true;
      const remote = request.socket.remoteAddress;
      const result = await runAudited(
        { action: 'test_provider', id, requestId, ...(remote ? { remote } : {}) },
        () => core.testProvider(id, capability, modelId, confirmCost)
      );
      sendJson(response, 200, { ok: true, result });
      return;
    }

    const accountCapabilityTestMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/capabilities\/test$/.exec(pathname);
    if (accountCapabilityTestMatch && request.method === 'POST') {
      const accountId = assertIdentifier(accountCapabilityTestMatch[1] as string, 'accountId');
      const body = await readJson(request, maxBody);
      const capability = parseCapability(body.capability);
      const confirmCost = body.confirmCost === true;
      const remote = request.socket.remoteAddress;
      const result = await runAudited(
        { action: 'test_account_capability', id: `${accountId}:${capability}`, requestId, ...(remote ? { remote } : {}) },
        () => core.testAccountCapability(accountId, capability, confirmCost)
      );
      sendJson(response, 200, { ok: true, result });
      return;
    }

    const policyMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/policy$/.exec(pathname);
    if (policyMatch) {
      const accountId = assertIdentifier(policyMatch[1] as string, 'accountId');
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, policy: core.getAccountPolicy(accountId) });
        return;
      }
      if (request.method === 'PUT') {
        const body = await readJson(request, maxBody);
        const raw = body.policy && typeof body.policy === 'object' && !Array.isArray(body.policy) ? body.policy : body;
        const remote = request.socket.remoteAddress;
        const policy = await runAudited(
          { action: 'set_account_policy', id: accountId, requestId, ...(remote ? { remote } : {}) },
          () => core.setAccountPolicy(accountId, raw)
        );
        sendJson(response, 200, { ok: true, policy });
        return;
      }
    }

    const effectiveMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/effective$/.exec(pathname);
    if (effectiveMatch && request.method === 'GET') {
      const accountId = assertIdentifier(effectiveMatch[1] as string, 'accountId');
      const kind = url.searchParams.get('kind') ?? 'private';
      const peerId = url.searchParams.get('peerId') ?? '0';
      const conversation: ConversationRef = {
        accountId,
        kind: assertKind(kind),
        peerId: assertIdentifier(peerId, 'peerId')
      };
      sendJson(response, 200, { ok: true, effective: await core.effectiveCapabilities(accountId, conversation) });
      return;
    }

    const agentToggleMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/agent$/.exec(pathname);
    if (agentToggleMatch && request.method === 'POST') {
      const accountId = assertIdentifier(agentToggleMatch[1] as string, 'accountId');
      const body = await readJson(request, maxBody);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean', 'invalid_body');
      const scope = parseScope(body);
      const remote = request.socket.remoteAddress;
      const policy = await runAudited(
        { action: 'toggle_agent', id: accountId, requestId, ...(remote ? { remote } : {}) },
        () => core.patchAgentEnabled(accountId, body.enabled as boolean, scope)
      );
      sendJson(response, 200, { ok: true, policy });
      return;
    }

    const capabilityToggleMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/capabilities\/([a-z.]+)$/.exec(pathname);
    if (capabilityToggleMatch && request.method === 'POST') {
      const accountId = assertIdentifier(capabilityToggleMatch[1] as string, 'accountId');
      const capability = parseCapability(capabilityToggleMatch[2]);
      const body = await readJson(request, maxBody);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean', 'invalid_body');
      const scope = parseScope(body);
      const remote = request.socket.remoteAddress;
      const policy = await runAudited(
        { action: 'toggle_capability', id: accountId, requestId, ...(remote ? { remote } : {}) },
        () => core.patchCapabilityEnabled(accountId, capability, body.enabled as boolean, scope)
      );
      sendJson(response, 200, { ok: true, policy });
      return;
    }

    if (request.method === 'GET' && pathname === '/jobs') {
      const accountId = url.searchParams.get('accountId') ?? undefined;
      const state = url.searchParams.get('state') ?? undefined;
      let jobs = await core.listJobs(accountId);
      if (state) jobs = jobs.filter((job) => job.state === state);
      sendJson(response, 200, { ok: true, jobs });
      return;
    }

    const jobMatch = /^\/jobs\/([A-Za-z0-9._-]{1,96})$/.exec(pathname);
    if (jobMatch && request.method === 'GET') {
      const jobId = jobMatch[1] as string;
      const accountId = url.searchParams.get('accountId');
      if (!accountId) throw new HttpError(400, 'accountId is required for job isolation', 'account_required');
      const job = await core.getJob(accountId, jobId);
      if (!job) throw new HttpError(404, `unknown job: ${jobId}`, 'job_not_found');
      sendJson(response, 200, { ok: true, job });
      return;
    }

    const jobCancelMatch = /^\/jobs\/([A-Za-z0-9._-]{1,96})\/cancel$/.exec(pathname);
    if (jobCancelMatch && request.method === 'POST') {
      const jobId = jobCancelMatch[1] as string;
      const body = await readJson(request, maxBody);
      if (typeof body.accountId !== 'string') {
        throw new HttpError(400, 'accountId is required for job isolation', 'account_required');
      }
      const accountId = assertIdentifier(body.accountId, 'accountId');
      const remote = request.socket.remoteAddress;
      const job = await runAudited(
        { action: 'cancel_job', id: jobId, requestId, ...(remote ? { remote } : {}) },
        () => core.cancelJob(accountId, jobId)
      );
      sendJson(response, 200, { ok: true, job });
      return;
    }

    const mediaListMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/media$/.exec(pathname);
    if (mediaListMatch && request.method === 'GET') {
      const accountId = assertIdentifier(mediaListMatch[1] as string, 'accountId');
      sendJson(response, 200, { ok: true, media: await core.listMedia(accountId) });
      return;
    }

    if (request.method === 'POST' && pathname === '/media/cleanup') {
      const remote = request.socket.remoteAddress;
      const result = await runAudited(
        { action: 'cleanup_media', id: 'media', requestId, ...(remote ? { remote } : {}) },
        () => core.cleanupMedia()
      );
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    const mediaMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/media\/([a-f0-9-]{36})$/.exec(pathname);
    if (mediaMatch) {
      const accountId = assertIdentifier(mediaMatch[1] as string, 'accountId');
      const mediaId = mediaMatch[2] as string;
      if (request.method === 'GET') {
        const media = await core.readMedia(accountId, mediaId);
        response.writeHead(200, {
          'content-type': media.ref.mimeType,
          'content-length': media.data.length,
          'cache-control': 'private, no-store',
          'content-disposition': 'inline',
          'x-content-type-options': 'nosniff',
          etag: `"${media.ref.sha256}"`
        });
        response.end(media.data);
        return;
      }
      if (request.method === 'DELETE') {
        const remote = request.socket.remoteAddress;
        const deleted = await runAudited(
          { action: 'delete_media', id: mediaId, requestId, ...(remote ? { remote } : {}) },
          () => core.deleteMedia(accountId, mediaId)
        );
        sendJson(response, 200, { ok: true, deleted });
        return;
      }
    }

    if (request.method === 'GET' && pathname === '/conversations') {
      const accountId = url.searchParams.get('accountId') ?? undefined;
      const conversations = await core.listConversations(accountId);
      sendJson(response, 200, { ok: true, conversations });
      return;
    }

    const historyMatch =
      /^\/accounts\/([A-Za-z0-9_-]{1,64})\/conversations\/(group|private)\/([A-Za-z0-9._-]{1,64})\/messages$/.exec(
        pathname
      );
    if (historyMatch && request.method === 'GET') {
      const accountId = assertIdentifier(historyMatch[1] as string, 'accountId');
      const kind = assertKind(historyMatch[2] as string);
      const peerId = assertIdentifier(historyMatch[3] as string, 'peerId');
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? 100 : Math.min(500, Math.max(1, Number(limitRaw) || 0));
      const afterRaw = url.searchParams.get('afterSeq');
      const beforeRaw = url.searchParams.get('beforeSeq');
      const options: ReadOptions = { limit };
      if (afterRaw !== null && Number.isFinite(Number(afterRaw))) options.afterSeq = Math.max(0, Number(afterRaw));
      if (beforeRaw !== null && Number.isFinite(Number(beforeRaw))) options.beforeSeq = Math.max(0, Number(beforeRaw));
      const messages = await core.readMessages(accountId, { accountId, kind, peerId }, options);
      sendJson(response, 200, { ok: true, accountId, conversation: { accountId, kind, peerId }, messages });
      return;
    }

    if (request.method === 'GET' && pathname === '/artifacts') {
      const [artifacts, current] = await Promise.all([core.listPublicArtifacts(), core.artifactCatalog()]);
      sendJson(response, 200, {
        ok: true,
        current,
        artifacts: artifacts.map((artifact) => ({ ref: artifact.ref, manifest: artifact.manifest }))
      });
      return;
    }

    const privateArtifactsMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/artifacts$/.exec(pathname);
    if (request.method === 'GET' && privateArtifactsMatch) {
      const accountId = assertIdentifier(privateArtifactsMatch[1] as string, 'accountId');
      const artifacts = await core.listAccountArtifacts(accountId);
      sendJson(response, 200, { ok: true, accountId, artifacts: artifacts.map((artifact) => ({ ref: artifact.ref, manifest: artifact.manifest })) });
      return;
    }

    if (request.method === 'GET' && pathname === '/deployments') {
      sendJson(response, 200, { ok: true, deployments: core.deployments() });
      return;
    }

    if (request.method === 'POST' && pathname === '/artifacts/rollback') {
      const remote = request.socket.remoteAddress;
      const deployment = await runAudited(
        { action: 'rollback_artifacts', id: 'artifacts', requestId, ...(remote ? { remote } : {}) },
        () => core.rollbackArtifacts()
      );
      sendJson(response, 200, { ok: true, deployment });
      return;
    }

    const artifactMatch = /^\/artifacts\/(plugin|role-card)\/([A-Za-z0-9._-]{1,64})\/deploy$/.exec(pathname);
    if (artifactMatch && request.method === 'POST') {
      const kind = artifactMatch[1] as ArtifactKind;
      const id = artifactMatch[2] as string;
      const body = await readJson(request, maxBody);
      if (typeof body.revision !== 'string' || !body.revision) {
        throw new HttpError(400, 'revision is required', 'invalid_revision');
      }
      const remote = request.socket.remoteAddress;
      const deployment = await runAudited(
        { action: 'deploy_artifact', id: `${kind}:${id}`, requestId, ...(remote ? { remote } : {}) },
        () => core.deployArtifact(kind, id, body.revision as string)
      );
      sendJson(response, 200, { ok: true, deployment });
      return;
    }

    const roleBindingsMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/role-bindings$/.exec(pathname);
    if (roleBindingsMatch && request.method === 'GET') {
      const accountId = assertIdentifier(roleBindingsMatch[1] as string, 'accountId');
      sendJson(response, 200, {
        ok: true,
        accountId,
        bindings: await core.listConversationRoleBindings(accountId)
      });
      return;
    }

    const roleBindingMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/role-bindings\/(group|private)\/([A-Za-z0-9._-]{1,64})$/.exec(pathname);
    if (roleBindingMatch && ['PUT', 'DELETE'].includes(request.method ?? '')) {
      const accountId = assertIdentifier(roleBindingMatch[1] as string, 'accountId');
      const conversation: ConversationRef = {
        accountId,
        kind: assertKind(roleBindingMatch[2] as string),
        peerId: assertIdentifier(roleBindingMatch[3] as string, 'peerId')
      };
      let roleCard: ArtifactRef | null = null;
      if (request.method === 'PUT') {
        const body = await readJson(request, maxBody);
        if (!body.roleCard || typeof body.roleCard !== 'object' || Array.isArray(body.roleCard)) {
          throw new HttpError(400, 'roleCard is required', 'invalid_role_card');
        }
        const candidate = body.roleCard as Partial<ArtifactRef>;
        if (
          (candidate.source !== 'public' && candidate.source !== 'private') ||
          typeof candidate.id !== 'string' ||
          (candidate.revision !== undefined && typeof candidate.revision !== 'string')
        ) {
          throw new HttpError(400, 'roleCard must be an artifact reference', 'invalid_role_card');
        }
        roleCard = {
          source: candidate.source,
          id: candidate.id,
          ...(candidate.revision ? { revision: candidate.revision } : {})
        };
      }
      const remote = request.socket.remoteAddress;
      const binding = await runAudited(
        {
          action: request.method === 'PUT' ? 'set_conversation_role' : 'clear_conversation_role',
          id: `${accountId}/${conversation.kind}/${conversation.peerId}`,
          requestId,
          ...(remote ? { remote } : {})
        },
        () => core.setConversationRoleBinding(conversation, roleCard)
      );
      sendJson(response, 200, { ok: true, accountId, conversation, binding: binding ?? null });
      return;
    }

    const profileMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/profile$/.exec(pathname);
    if (profileMatch) {
      const accountId = assertIdentifier(profileMatch[1] as string, 'accountId');
      if (request.method === 'GET') {
        const profile = await core.getAccountProfile(accountId);
        sendJson(response, 200, { ok: true, profile: profile ?? null });
        return;
      }
      if (request.method === 'PUT') {
        const body = await readJson(request, maxBody);
        const raw = body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)
          ? body.profile
          : body;
        const remote = request.socket.remoteAddress;
        const result = await runAudited(
          { action: 'save_profile', id: accountId, requestId, ...(remote ? { remote } : {}) },
          () => core.saveAccountProfile(accountId, raw)
        );
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
    }

    const displayMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/display$/.exec(pathname);
    if (displayMatch) {
      const accountId = assertIdentifier(displayMatch[1] as string, 'accountId');
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, display: await core.getAccountDisplay(accountId) });
        return;
      }
      if (request.method === 'PUT') {
        const body = await readJson(request, maxBody);
        const raw = body.display && typeof body.display === 'object' && !Array.isArray(body.display) ? body.display : body;
        const remote = request.socket.remoteAddress;
        const display = await runAudited(
          { action: 'save_account_display', id: accountId, requestId, ...(remote ? { remote } : {}) },
          () => core.saveAccountDisplay(accountId, raw)
        );
        sendJson(response, 200, { ok: true, display });
        return;
      }
    }

    const reloadMatch = /^\/accounts\/([A-Za-z0-9_-]{1,64})\/reload$/.exec(pathname);
    if (reloadMatch && request.method === 'POST') {
      const accountId = assertIdentifier(reloadMatch[1] as string, 'accountId');
      const remote = request.socket.remoteAddress;
      const results = await runAudited(
        { action: 'reload_profile', id: accountId, requestId, ...(remote ? { remote } : {}) },
        () => core.reloadAccount(accountId)
      );
      sendJson(response, 200, { ok: results.every((item) => item.ok), results });
      return;
    }

    if (request.method === 'GET' && pathname === '/slots') {
      sendJson(response, 200, {
        ok: true,
        slots: core.status().instances,
        specs: core.slotSpecs(),
        resumable: core.injectionResumeCandidates()
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/slots') {
      const body = await readJson(request, maxBody);
      if (typeof body.id !== 'string') throw new HttpError(400, 'slot id is required', 'invalid_spec');
      const remote = request.socket.remoteAddress;
      const instance = await runAudited(
        { action: 'add_slot', id: body.id, requestId, ...(remote ? { remote } : {}) },
        () => core.addSlot(body as unknown as InstanceSpec)
      );
      sendJson(response, 201, { ok: true, instance });
      return;
    }

    const slotMatch = /^\/slots\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
    if (slotMatch && request.method === 'DELETE') {
      const id = assertIdentifier(slotMatch[1] as string, 'slotId');
      const remote = request.socket.remoteAddress;
      await runAudited(
        { action: 'remove_slot', id, requestId, ...(remote ? { remote } : {}) },
        () => core.removeSlot(id)
      );
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && pathname === '/injection/runtime') {
      sendJson(response, 200, { ok: true, runtime: await core.injectionStatus() });
      return;
    }

    if (request.method === 'POST' && pathname === '/injection/connection/test') {
      const result = await core.testInjectionConnection();
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (request.method === 'POST' && pathname === '/injection/resume') {
      const remote = request.socket.remoteAddress;
      const result = await runAudited(
        { action: 'resume_snowluma_listening', id: 'snowluma', requestId, ...(remote ? { remote } : {}) },
        () => core.resumeInjectionListening()
      );
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (request.method === 'POST' && pathname === '/injection/runtime/retry') {
      const remote = request.socket.remoteAddress;
      const runtime = await runAudited(
        { action: 'retry_snowluma_runtime', id: 'snowluma', requestId, ...(remote ? { remote } : {}) },
        () => core.retrySnowLumaRuntime()
      );
      sendJson(response, 200, { ok: true, runtime });
      return;
    }

    if (request.method === 'GET' && pathname === '/injection/processes') {
      const avatars = url.searchParams.get('avatars') === '1';
      sendJson(response, 200, { ok: true, processes: await core.injectionProcesses(avatars ? { avatars: true } : {}) });
      return;
    }

    const injectionMatch = /^\/injection\/processes\/(\d{1,7})\/(inject-and-listen|listen|refresh|unload)$/.exec(
      pathname
    );
    if (injectionMatch && request.method === 'POST') {
      const pid = Number(injectionMatch[1]);
      if (!Number.isInteger(pid) || pid <= 0 || pid > 4_194_304) {
        throw new HttpError(400, 'invalid process id', 'injection_request_invalid');
      }
      const action = injectionMatch[2] as 'inject-and-listen' | 'listen' | 'refresh' | 'unload';
      const body = await readJson(request, maxBody);
      if (!body.identity || typeof body.identity !== 'object' || Array.isArray(body.identity)) {
        throw new HttpError(400, 'identity is required', 'injection_request_invalid');
      }
      const identity = body.identity as Record<string, unknown>;
      if (identity.pid !== undefined && Number(identity.pid) !== pid) {
        throw new HttpError(400, 'identity pid does not match the path', 'injection_request_invalid');
      }
      const payload = { ...body, identity: { ...identity, pid } };
      const remote = request.socket.remoteAddress;
      const operation = await runAudited(
        {
          action: `injection_${action}`,
          id: typeof body.slotId === 'string' ? body.slotId : String(pid),
          requestId,
          ...(remote ? { remote } : {})
        },
        async () => {
          if (action === 'inject-and-listen') return core.injectAndListen(payload);
          if (action === 'listen') return core.listenInjection(payload);
          if (action === 'refresh') return core.refreshInjection(payload);
          return core.unloadInjection(payload);
        }
      );
      sendJson(response, 200, { ok: operation.state === 'succeeded', operation });
      return;
    }

    const operationMatch = /^\/injection\/operations\/([A-Za-z0-9-]{1,80})$/.exec(pathname);
    if (operationMatch && request.method === 'GET') {
      const operation = core.injectionOperation(operationMatch[1] as string);
      if (!operation) throw new HttpError(404, 'unknown injection operation', 'injection_operation_not_found');
      sendJson(response, 200, { ok: true, operation });
      return;
    }

    if (request.method === 'GET' && pathname === '/injection/settings') {
      sendJson(response, 200, { ok: true, settings: core.injectionSettings() });
      return;
    }

    if (request.method === 'PUT' && pathname === '/injection/settings') {
      const body = await readJson(request, maxBody);
      const password = body.password;
      if (password !== undefined && typeof password !== 'string') {
        throw new HttpError(400, 'password must be a string', 'invalid_settings');
      }
      const settings: Record<string, unknown> = {};
      if (body.runtimeDir !== undefined) {
        if (typeof body.runtimeDir !== 'string') throw new HttpError(400, 'runtimeDir must be a string', 'invalid_settings');
        settings.runtimeDir = body.runtimeDir;
      }
      if (body.baseUrl !== undefined) {
        if (typeof body.baseUrl !== 'string') throw new HttpError(400, 'baseUrl must be a string', 'invalid_settings');
        settings.baseUrl = body.baseUrl;
      }
      if (body.resumeLastListen !== undefined) {
        if (typeof body.resumeLastListen !== 'boolean') throw new HttpError(400, 'resumeLastListen must be a boolean', 'invalid_settings');
        settings.resumeLastListen = body.resumeLastListen;
      }
      const updated = await core.setInjectionSettings(settings, password);
      sendJson(response, 200, {
        ok: true,
        settings: updated.settings,
        runtime: updated.status,
        credentialConfigured: updated.status.passwordConfigured
      });
      return;
    }

    if (request.method === 'DELETE' && pathname === '/injection/password') {
      sendJson(response, 200, { ok: true, ...(await core.clearInjectionPassword()) });
      return;
    }

    if (request.method === 'GET' && pathname === '/metrics') {
      sendJson(response, 200, { ok: true, metrics: metrics.snapshot() });
      return;
    }

    if (request.method === 'GET' && pathname === '/diagnostics') {
      sendJson(response, 200, { ok: true, ...(core.diagnostics() as Record<string, unknown>) });
      return;
    }

    if (request.method === 'GET' && pathname === '/events') {
      if (sseClients.size >= maxSseClients) {
        throw new HttpError(503, `too many SSE clients (limit ${maxSseClients})`, 'sse_limit');
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive'
      });
      response.write(': connected\n\n');
      sseClients.add(response);
      metrics.set('sse.clients', sseClients.size);
      const lastHeader = request.headers['last-event-id'];
      const lastQuery = url.searchParams.get('lastEventId');
      const resumeRaw = Array.isArray(lastHeader) ? lastHeader[0] : lastHeader ?? lastQuery;
      let lastWritten = eventLog.latestId;
      let missed: LoggedEvent[] = [];
      if (resumeRaw !== undefined && resumeRaw !== null && resumeRaw !== '') {
        const sinceId = Number(resumeRaw);
        if (Number.isFinite(sinceId)) {
          lastWritten = Math.max(0, sinceId);
          missed = eventLog.since(lastWritten);
        }
      }
      for (const event of missed) {
        if (!writeSse(response, event)) break;
        lastWritten = event.id;
      }
      if (missed.length > 0) metrics.inc('sse.replayed', missed.length);
      const unsubscribe = eventLog.onAppend((event) => {
        if (event.id <= lastWritten) return;
        if (!writeSse(response, event)) {
          response.end();
          return;
        }
        lastWritten = event.id;
        metrics.inc('sse.events_sent');
      });
      const heartbeat = setInterval(() => {
        if (response.writableLength > MAX_SSE_BUFFER_BYTES) {
          response.end();
          return;
        }
        response.write(': ping\n\n');
      }, 15_000);
      heartbeat.unref?.();
      request.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        sseClients.delete(response);
        metrics.set('sse.clients', sseClients.size);
      });
      return;
    }

    const match = /^\/(?:instances|slots)\/([A-Za-z0-9_-]{1,64})\/(start|stop|send)$/.exec(pathname);
    if (match && request.method === 'POST') {
      const id = match[1] as string;
      const action = match[2] as 'start' | 'stop' | 'send';
      findInstance(id);
      const remote = request.socket.remoteAddress;

      if (action === 'start' || action === 'stop') {
        const operation = runAudited({ action, id, requestId, remote }, async () => {
          if (action === 'start') await core.startInstance(id);
          else await core.stopInstance(id);
        });
        const preferAsync = String(request.headers.prefer ?? '').includes('respond-async');
        if (preferAsync) {
          void operation.catch((error: unknown) => {
            logger?.error('async control operation failed', {
              instanceId: id,
              action,
              requestId,
              message: error instanceof Error ? error.message : String(error)
            });
          });
          sendJson(response, 202, { ok: true, accepted: true, operationId: requestId });
          return;
        }
        await operation;
        const instance = core.status().instances.find((item) => item.id === id);
        sendJson(response, 200, { ok: true, operationId: requestId, instance: instance ?? null, removed: !instance });
        return;
      }

      const body = await readJson(request, maxBody);
      const kind = assertKind(typeof body.kind === 'string' ? body.kind : '');
      const peerId = assertIdentifier(typeof body.peerId === 'string' ? body.peerId : '', 'peerId');
      const instance = findInstance(id);
      const accountId = instance.accountId ?? (typeof body.accountId === 'string' ? body.accountId : '');
      if (!accountId) throw new InvalidSpecError('instance has no account yet; pass accountId explicitly');
      const message: OutboundMessage =
        typeof body.text === 'string'
          ? textMessage(body.text)
          : Array.isArray(body.segments)
            ? { segments: body.segments as OutboundMessage['segments'] }
            : (() => {
                throw new HttpError(400, 'send requires text or segments', 'invalid_message');
              })();
      const headerKey = request.headers['idempotency-key'];
      const idempotencyKey =
        (Array.isArray(headerKey) ? headerKey[0] : headerKey) ??
        (typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined);
      const result = await runAudited({ action: 'send', id, requestId, remote }, () =>
        core.send(id, { accountId, kind, peerId }, message, {
          ...(idempotencyKey ? { idempotencyKey } : {}),
          operationId: requestId
        })
      );
      sendJson(response, 200, { ok: true, operationId: requestId, ...result });
      return;
    }

    sendJson(response, 404, { ok: false, error: 'not found', code: 'not_found' });
  }

  async function runAudited<T>(
    context: { action: string; id: string; requestId: string; remote?: string },
    task: () => Promise<T>
  ): Promise<T> {
    try {
      const result = await task();
      auditLog.record({
        at: Date.now(),
        action: context.action,
        ok: true,
        requestId: context.requestId,
        instanceId: context.id,
        ...(context.remote ? { remote: context.remote } : {})
      });
      return result;
    } catch (error) {
      auditLog.record({
        at: Date.now(),
        action: context.action,
        ok: false,
        requestId: context.requestId,
        instanceId: context.id,
        ...(context.remote ? { remote: context.remote } : {}),
        detail: { error: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('api server failed to bind');
  const url = `http://${host}:${address.port}`;

  return {
    url,
    close: async () => {
      for (const client of sseClients) client.end();
      sseClients.clear();
      metrics.set('sse.clients', 0);
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function providerPayload(body: Record<string, unknown>): {
  provider: Record<string, unknown>;
  secret?: string;
} {
  const nested =
    body.provider && typeof body.provider === 'object' && !Array.isArray(body.provider)
      ? (body.provider as Record<string, unknown>)
      : undefined;
  let provider: Record<string, unknown>;
  let credential: unknown;
  if (nested) {
    provider = { ...nested };
    credential = body.credential ?? body.secret;
  } else {
    const { credential: rawCredential, secret: rawSecret, ...rest } = body;
    provider = rest;
    credential = rawCredential ?? rawSecret;
  }
  return {
    provider,
    ...(typeof credential === 'string' && credential.length > 0 ? { secret: credential } : {})
  };
}

function parseCapability(value: unknown): CapabilityId {
  if (!isCapabilityId(value)) throw new HttpError(400, `unsupported capability ${String(value)}`, 'invalid_capability');
  return value;
}

function parseScope(body: Record<string, unknown>): { kind?: 'private' | 'group'; peerId?: string } {
  const kind = body.kind === undefined ? undefined : assertKind(String(body.kind));
  const peerId = body.peerId === undefined ? undefined : assertIdentifier(String(body.peerId), 'peerId');
  if (peerId && !kind) throw new HttpError(400, 'kind is required when peerId is provided', 'invalid_scope');
  return {
    ...(kind ? { kind } : {}),
    ...(peerId ? { peerId } : {})
  };
}

function statusForError(error: unknown): number {
  if (error instanceof BackpressureError) return 429;
  if (!(error instanceof AccompanyError)) return 500;
  switch (error.code) {
    case 'message_too_large':
    case 'media_too_large':
    case 'body_too_large':
      return 413;
    case 'media_unsupported_type':
      return 415;
    case 'job_backpressure':
    case 'backpressure':
      return 429;
    case 'job_state_invalid':
    case 'credential_store_unavailable':
    case 'capability_unavailable':
    case 'snowluma_runtime_unavailable':
    case 'snowluma_password_missing':
    case 'snowluma_version_incompatible':
    case 'snowluma_autoload_enabled':
    case 'snowluma_autoload_unknown':
    case 'snowluma_auth_failed':
    case 'snowluma_consent_required':
    case 'snowluma_totp_required':
    case 'snowluma_password_change_required':
    case 'injection_slot_busy':
    case 'injection_settings_busy':
    case 'injection_slot_bound':
    case 'injection_backend_unsupported':
    case 'injection_identity_mismatch':
    case 'injection_not_loaded':
    case 'injection_account_in_use':
      return 409;
    case 'snowluma_unreachable':
    case 'snowluma_http_error':
    case 'snowluma_process_action_failed':
    case 'injection_failed':
    case 'injection_login_timeout':
      return 503;
    case 'media_not_found':
    case 'job_not_found':
    case 'unknown_provider':
    case 'injection_slot_not_found':
    case 'injection_process_stale':
    case 'injection_operation_not_found':
      return 404;
    default:
      return 400;
  }
}

async function statFile(file: string): Promise<Awaited<ReturnType<typeof fs.stat>> | undefined> {
  try {
    return await fs.stat(file);
  } catch {
    return undefined;
  }
}
