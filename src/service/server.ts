import crypto from 'node:crypto';
import http from 'node:http';
import type { CoreView } from '../application/ports/control-api.js';
import type { AccountSummary } from '../contracts/accounts.js';
import type { AuditLog } from '../core/audit.js';
import { AccompanyError, BackpressureError, BackendError, ChannelError } from '../core/errors.js';
import type { EventLog } from '../core/event-log.js';
import type { Logger } from '../core/logger.js';
import type { Metrics } from '../core/metrics.js';
import { isLoopbackHost } from '../core/net.js';
import type { InstanceStatus } from '../instances/spec.js';
import { authorize } from './http/auth.js';
import { HttpError, statusForError } from './http/errors.js';
import { readJson, sendJson } from './http/io.js';
import { SseHub } from './http/sse.js';
import { createUiHandler } from './http/static.js';
import { createRoutes } from './routes/index.js';
import type { AuditContext, RouteContext } from './routes/types.js';

export type { CoreView };
export type { AccountSummary };

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
  const sse = new SseHub({ eventLog, metrics, maxClients: maxSseClients });
  const serveUi = createUiHandler(options.uiDir);
  const routes = createRoutes();

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

  async function runAudited<T>(context: AuditContext, task: () => Promise<T>): Promise<T> {
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
    authorize(request, pathname, token);

    const context: RouteContext = {
      core,
      request,
      response,
      url,
      pathname,
      requestId,
      maxBody,
      metrics,
      sse,
      ...(logger ? { logger } : {}),
      readJson: (incoming) => readJson(incoming, maxBody),
      sendJson,
      runAudited,
      findInstance,
      remote: () => request.socket.remoteAddress
    };
    for (const route of routes) {
      if (await route(context)) return;
    }

    sendJson(response, 404, { ok: false, error: 'not found', code: 'not_found' });
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
      sse.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
