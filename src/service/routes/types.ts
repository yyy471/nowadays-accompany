import type http from 'node:http';
import type { CoreView } from '../../application/ports/control-api.js';
import type { Logger } from '../../core/logger.js';
import type { Metrics } from '../../core/metrics.js';
import type { InstanceStatus } from '../../instances/spec.js';
import type { SseHub } from '../http/sse.js';

export interface AuditContext {
  action: string;
  id: string;
  requestId: string;
  remote?: string;
}

export interface RouteContext {
  core: CoreView;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  url: URL;
  pathname: string;
  requestId: string;
  maxBody: number;
  metrics: Metrics;
  sse: SseHub;
  logger?: Logger;
  readJson(request: http.IncomingMessage): Promise<Record<string, unknown>>;
  sendJson(response: http.ServerResponse, status: number, body: unknown): void;
  runAudited<T>(context: AuditContext, task: () => Promise<T>): Promise<T>;
  findInstance(id: string): InstanceStatus;
  remote(): string | undefined;
}

/** 返回 true 表示该路由已处理请求；路由只调用 CoreView 用例，不直接持有领域实现。 */
export type Route = (context: RouteContext) => boolean | Promise<boolean>;
