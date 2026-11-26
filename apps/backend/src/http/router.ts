import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HttpError,
  isBinaryResponse,
  writeBinary,
  writeError,
  writeJson,
  type RouteResponse,
} from "./errors.js";

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type RouteHandler = (
  context: RouteContext,
) => RouteResponse | undefined | Promise<RouteResponse | undefined>;

/** 注册时的统一包装，用于把配置写入挂到同一套状态校验上。 */
export type RouteGuard = (
  method: string,
  pattern: string,
  handler: RouteHandler,
) => RouteHandler;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Route[] = [];
  private guard: RouteGuard | null = null;

  constructor(private readonly hostToken?: string) {}

  setGuard(guard: RouteGuard): this {
    this.guard = guard;
    return this;
  }

  add(method: string, pattern: string, rawHandler: RouteHandler): this {
    const keys: string[] = [];
    const source = pattern
      .split("/")
      .map((segment) => {
        if (segment.startsWith("*")) {
          keys.push(segment.slice(1));
          return "(.+)";
        }
        if (segment.startsWith(":")) {
          keys.push(segment.slice(1));
          return "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    const handler =
      this.guard === null ? rawHandler : this.guard(method, pattern, rawHandler);
    this.routes.push({
      method,
      regex: new RegExp(`^${source}$`),
      keys,
      handler,
    });
    return this;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      writeError(
        response,
        new HttpError(400, "INVALID_URL", "请求地址格式不正确"),
      );
      return;
    }
    const origin = request.headers.origin;
    response.setHeader("vary", "Origin");
    if (origin !== undefined) {
      const local = /^(?:http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?|desk:\/\/bundle|file:\/\/|app:\/\/[a-z0-9.-]*)$/i.test(origin);
      if (!local) {
        writeError(response, new HttpError(403, "ORIGIN_DENIED", "请求来源不受支持"));
        return;
      }
      response.setHeader("access-control-allow-origin", origin);
    }
    // 资产请求必须按清单中的原路径匹配，避免 URL 规范化先将其改写为其他路由。
    const rawPath = request.url?.split("?", 1)[0];
    if (rawPath && /^\/v1\/extensions\/[^/]+\/ui\//.test(rawPath) && rawPath !== url.pathname) {
      writeError(response, new HttpError(404, "EXTENSION_ASSET_NOT_FOUND", "此扩展资源不可用"));
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, last-event-id, x-nowadays-host-token",
      });
      response.end();
      return;
    }
    if (this.hostToken && url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/v1/internal/")) {
      const actual = Buffer.from(String(request.headers["x-nowadays-host-token"] ?? ""));
      const expected = Buffer.from(this.hostToken);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        writeError(response, new HttpError(401, "HOST_TOKEN_INVALID", "宿主会话凭证无效"));
        return;
      }
    }
    for (const route of this.routes) {
      if (route.method !== request.method) {
        continue;
      }
      const match = route.regex.exec(url.pathname);
      if (!match) {
        continue;
      }
      try {
        const params: Record<string, string> = {};
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1] ?? "");
        });
        const result = await route.handler({ request, response, url, params });
        if (result !== undefined) {
          if (isBinaryResponse(result)) {
            writeBinary(response, result);
          } else {
            writeJson(response, result);
          }
        }
      } catch (error) {
        if (response.headersSent) {
          response.end();
          return;
        }
        writeError(response, error);
      }
      return;
    }
    writeError(
      response,
      new HttpError(404, "NOT_FOUND", "未找到请求的接口"),
    );
  }
}
