import type { z } from "zod";
import { HttpError } from "./errors.js";

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, "INVALID_REQUEST", "请求结构不正确", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function queryInt(
  url: URL,
  name: string,
  options: { min: number; max: number; defaultValue?: number },
): number {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    if (options.defaultValue === undefined) {
      throw new HttpError(400, "INVALID_QUERY", `缺少查询参数 ${name}`);
    }
    return options.defaultValue;
  }
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, "INVALID_QUERY", `查询参数 ${name} 必须是整数`);
  }
  const value = Number(raw);
  if (value < options.min || value > options.max) {
    throw new HttpError(
      400,
      "INVALID_QUERY",
      `查询参数 ${name} 超出范围 ${options.min}～${options.max}`,
    );
  }
  return value;
}
