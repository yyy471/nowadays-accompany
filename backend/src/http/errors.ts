import type { ServerResponse } from "node:http";
import { AppError } from "../domain/errors.js";

export class HttpError extends AppError {
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(status, code, message, details);
    this.name = "HttpError";
  }
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

export function writeJson(response: ServerResponse, result: JsonResponse): void {
  const payload = `${JSON.stringify(result.body)}\n`;
  response.writeHead(result.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, last-event-id",
  });
  response.end(payload);
}

export function writeError(response: ServerResponse, error: unknown): void {
  if (error instanceof AppError) {
    writeJson(response, {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    });
    return;
  }
  // 契约要求日志不输出堆栈、SQL 或完整请求体，避免内部细节与凭据外泄。
  console.error(error instanceof Error ? error.name : "UNKNOWN_ERROR");
  writeJson(response, {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "后端处理请求时发生内部错误",
      },
    },
  });
}
