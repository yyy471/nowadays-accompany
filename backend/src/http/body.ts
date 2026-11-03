import type { IncomingMessage } from "node:http";
import { HttpError } from "./errors.js";

const MAX_BODY_BYTES = 1024 * 1024;

export async function readJsonBody(
  request: IncomingMessage,
): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "请求必须使用 application/json",
    );
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "请求体超过 1 MiB 上限");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    throw new HttpError(400, "EMPTY_BODY", "请求体不能为空");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求体不是有效 JSON");
  }
}
