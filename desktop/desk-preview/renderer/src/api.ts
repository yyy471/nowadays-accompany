export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method,
    signal: options.signal,
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `请求失败（${response.status}）`);
  return body as T;
}

export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `请求失败（${response.status}）`);
  return body as T;
}
