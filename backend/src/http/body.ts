import type { IncomingMessage } from "node:http";
import { HttpError } from "./errors.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 128 * 1024 * 1024;

/**
 * 请求体读完后的提交前校验（DL-148 / RA-R03）。
 *
 * 受保护的配置写入在入口校验之后还要读请求体，读体期间可能新增角色或改变
 * 活动状态。守卫在这里挂一个校验钩子，读完体、真正落库之前再验一次，
 * 避免「校验通过 → 期间新建活动角色 → 写入仍落到不一致的状态上」。
 */
const bodyReadHooks = new WeakMap<IncomingMessage, () => void>();

export function setBodyReadHook(
  request: IncomingMessage,
  hook: () => void,
): void {
  bodyReadHooks.set(request, hook);
}

function afterBodyRead(request: IncomingMessage): void {
  const hook = bodyReadHooks.get(request);
  if (hook === undefined) return;
  bodyReadHooks.delete(request);
  hook();
}

export interface MultipartFile {
  fileName: string;
  data: Buffer;
}

export interface MultipartForm {
  fields: Map<string, string>;
  files: Map<string, MultipartFile[]>;
}

export async function readMultipartForm(
  request: IncomingMessage,
): Promise<MultipartForm> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("multipart/form-data")
  ) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "请求必须使用 multipart/form-data",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_UPLOAD_BODY_BYTES) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "上传内容超过 128 MiB 上限");
    }
    chunks.push(buffer);
  }
  afterBodyRead(request);
  if (size === 0) {
    throw new HttpError(400, "EMPTY_BODY", "请求体不能为空");
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new HttpError(400, "INVALID_MULTIPART", "表单内容格式不正确");
  }
  const fields = new Map<string, string>();
  const files = new Map<string, MultipartFile[]>();
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields.set(key, value);
      continue;
    }
    const list = files.get(key) ?? [];
    list.push({
      fileName: value.name,
      data: Buffer.from(await value.arrayBuffer()),
    });
    files.set(key, list);
  }
  return { fields, files };
}

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
  afterBodyRead(request);
  if (size === 0) {
    throw new HttpError(400, "EMPTY_BODY", "请求体不能为空");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求体不是有效 JSON");
  }
}
