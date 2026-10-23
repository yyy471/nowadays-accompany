import type { StreamEvent } from './types';

interface BridgeInfo {
  chooseRuntimeDirectory?: () => Promise<string | null>;
  openRuntimeDirectory?: () => Promise<boolean>;
  apiBaseUrl: string;
  token: string;
  version: string;
  platform: string;
}

declare global {
  interface Window {
    nowadays?: BridgeInfo;
    accompany?: BridgeInfo;
  }
}

const bridge = window.nowadays ?? window.accompany;
const params = new URLSearchParams(window.location.search);
const tokenFromUrl = params.get('token') ?? '';
if (tokenFromUrl && !bridge?.token) sessionStorage.setItem('nowadays.token', tokenFromUrl);

export const apiBaseUrl = (bridge?.apiBaseUrl || window.location.origin).replace(/\/$/, '');
export const appVersion = bridge?.version || 'dev';
export const appPlatform = bridge?.platform || 'web';
export const apiToken =
  bridge?.token || tokenFromUrl || sessionStorage.getItem('nowadays.token') || '';
export const hasToken = apiToken.length > 0;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable?: boolean;

  constructor(message: string, status: number, code = 'http_error', retryable?: boolean) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (apiToken) headers.set('authorization', `Bearer ${apiToken}`);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${pathname}`, { ...init, headers });
  } catch (error) {
    throw new ApiError(
      `无法连接本地核心：${error instanceof Error ? error.message : String(error)}`,
      0,
      'network_error',
      true
    );
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const payload = body as { error?: string; code?: string; retryable?: boolean } | undefined;
    throw new ApiError(
      payload?.error ?? `HTTP ${response.status}`,
      response.status,
      payload?.code ?? 'http_error',
      payload?.retryable
    );
  }
  return body as T;
}

/** 媒体字节需要带 bearer token，不能直接放进 <img src>。调用方负责 revokeObjectURL。 */
export async function fetchMediaBlob(accountId: string, mediaId: string): Promise<Blob> {
  const response = await fetch(
    `${apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/media/${encodeURIComponent(mediaId)}`,
    { headers: { authorization: `Bearer ${apiToken}` } }
  );
  if (!response.ok) throw new ApiError(`媒体读取失败（HTTP ${response.status}）`, response.status);
  return response.blob();
}

export type StreamStatus = 'connecting' | 'open' | 'retrying';

export function subscribeEvents(
  onEvent: (event: StreamEvent) => void,
  onStatus: (status: StreamStatus) => void
): () => void {
  let stopped = false;
  let controller: AbortController | undefined;
  let lastId = 0;
  let retry = 800;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = async (): Promise<void> => {
    if (stopped) return;
    controller = new AbortController();
    onStatus('connecting');
    try {
      const response = await fetch(`${apiBaseUrl}/events?lastEventId=${lastId}`, {
        headers: { authorization: `Bearer ${apiToken}` },
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(`event stream refused (${response.status})`);
      onStatus('open');
      retry = 800;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          let id = lastId;
          let type = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) id = Number(line.slice(3).trim()) || id;
            else if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          if (data.length === 0) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(data.join('\n')) as Record<string, unknown>;
          } catch {
            continue;
          }
          lastId = Math.max(lastId, id);
          const at = typeof payload.at === 'number' ? payload.at : Date.now();
          onEvent({ id, type, payload, at });
        }
      }
      throw new Error('event stream closed');
    } catch (error) {
      if (stopped) return;
      onStatus('retrying');
      timer = setTimeout(() => void connect(), retry);
      retry = Math.min(Math.round(retry * 1.7), 8000);
    }
  };

  void connect();
  return () => {
    stopped = true;
    controller?.abort();
    if (timer) clearTimeout(timer);
  };
}
