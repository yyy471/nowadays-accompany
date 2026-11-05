import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HttpError,
  writeError,
  writeJson,
  type JsonResponse,
} from "./errors.js";

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type RouteHandler = (
  context: RouteContext,
) => JsonResponse | undefined | Promise<JsonResponse | undefined>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    const keys: string[] = [];
    const source = pattern
      .split("/")
      .map((segment) => {
        if (segment.startsWith(":")) {
          keys.push(segment.slice(1));
          return "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
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
          writeJson(response, result);
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
