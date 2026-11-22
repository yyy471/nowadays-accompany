/** 带状态码与机器可读错误码的接口错误，供调用方区分下架、占用等场景。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** 后端结构化详情，例如本次维护实际暂停的角色。 */
  readonly details: unknown;

  constructor(message: string, status: number, code: string | null, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function readError(response: Response): Promise<ApiError> {
  let message = `请求失败（${response.status}）`;
  let code: string | null = null;
  let details: unknown;
  try {
    const body = await response.json() as { error?: { message?: string; code?: string; details?: unknown } };
    if (body.error?.message) message = body.error.message;
    if (body.error?.code) code = body.error.code;
    details = body.error?.details;
  } catch {
    // 非 JSON 错误沿用状态码提示。
  }
  return new ApiError(message, response.status, code, details);
}

function toRequestBody(body: unknown): { headers?: HeadersInit; body?: BodyInit } {
  if (body === undefined) return {};
  if (body instanceof FormData) return { body };
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const init = toRequestBody(options.body);
  const response = await fetch(path, {
    method: options.method,
    signal: options.signal,
    ...init
  });
  if (!response.ok) throw await readError(response);
  return await response.json() as T;
}

export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, { method: 'POST', body: form });
  if (!response.ok) throw await readError(response);
  return await response.json() as T;
}

/** 读取二进制响应，用于试听音频等非 JSON 接口。 */
export async function apiBinary(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Blob> {
  const init = toRequestBody(options.body);
  const response = await fetch(path, {
    method: options.method,
    signal: options.signal,
    ...init
  });
  if (!response.ok) throw await readError(response);
  return await response.blob();
}
