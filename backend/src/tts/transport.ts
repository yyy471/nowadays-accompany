import {
  TtsCanceledError,
  TtsServiceUnavailableError,
  TtsSynthesisFailedError,
  TtsTimeoutError,
} from "../domain/errors.js";
import { isPcmWav } from "../application/audio-inspect.js";
import type { SynthesizedAudio } from "../domain/voice.js";

export const DEFAULT_TTS_TIMEOUT_MS = 90_000;
export const MAX_TTS_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

const WAV_MEDIA_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave"]);

export interface TtsRequestScope {
  readonly baseUrl: string;
  readonly callerSignal: AbortSignal | undefined;
  readonly signal: AbortSignal;
  timedOut(): boolean;
  error(): Error;
  abortUpstream(): void;
  cleanup(): void;
}

export function createRequestScope(
  baseUrl: string,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number = DEFAULT_TTS_TIMEOUT_MS,
): TtsRequestScope {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort();
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  return {
    baseUrl,
    callerSignal,
    signal: controller.signal,
    timedOut: () => timedOut,
    error: () => transportError(baseUrl, callerSignal, timedOut),
    abortUpstream: () => controller.abort(),
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

export function endpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}/${path}`;
  return url.toString();
}

/** 读取成功音频响应，校验媒体类型、缓冲上限和 PCM WAV 完整性。 */
export async function readWavResponse(
  response: Response,
  scope: TtsRequestScope,
  maxBytes: number,
): Promise<SynthesizedAudio> {
  const mediaType =
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
    "";
  if (!WAV_MEDIA_TYPES.has(mediaType)) {
    scope.abortUpstream();
    throw new TtsSynthesisFailedError("语音服务返回的不是 WAV 音频");
  }
  let data: Buffer;
  try {
    data = await readResponseBody(response, maxBytes);
  } catch (error) {
    if (error instanceof TtsSynthesisFailedError) {
      throw error;
    }
    throw scope.error();
  }
  if (data.length === 0) {
    throw new TtsSynthesisFailedError("语音服务返回了空音频");
  }
  if (!isPcmWav(data)) {
    throw new TtsSynthesisFailedError("语音服务返回的 WAV 无效");
  }
  return { data, mediaType: "audio/wav" };
}

export interface UpstreamFailure {
  detail: string;
  /** 上游可选的机器可读错误码，用于把「音色不存在」等状态映射成明确错误。 */
  code: string | null;
}

export async function responseFailure(
  response: Response,
): Promise<UpstreamFailure> {
  let raw: Buffer;
  try {
    raw = await readResponseBody(response, MAX_ERROR_BODY_BYTES);
  } catch (error) {
    if (error instanceof TtsSynthesisFailedError) {
      return {
        detail: `语音服务返回 HTTP ${response.status}`,
        code: null,
      };
    }
    throw error;
  }
  let detail = `语音服务返回 HTTP ${response.status}`;
  let code: string | null = null;
  try {
    const body = JSON.parse(raw.toString("utf8")) as {
      detail?: unknown;
      code?: unknown;
      error?: unknown;
    };
    if (typeof body.detail === "string" && body.detail.trim().length > 0) {
      detail = body.detail;
    }
    if (typeof body.code === "string" && body.code.length > 0) {
      code = body.code;
    } else if (
      typeof body.error === "object" &&
      body.error !== null &&
      typeof (body.error as { code?: unknown }).code === "string"
    ) {
      code = (body.error as { code: string }).code;
    }
  } catch {
    // 非 JSON 错误体使用状态码说明。
  }
  return { detail, code };
}

export async function responseDetail(response: Response): Promise<string> {
  return (await responseFailure(response)).detail;
}

export async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (response.body === null) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TtsSynthesisFailedError("语音响应超过大小上限", { maxBytes });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function transportError(
  baseUrl: string,
  callerSignal: AbortSignal | undefined,
  timedOut: boolean,
): Error {
  if (callerSignal?.aborted === true) {
    return new TtsCanceledError();
  }
  if (timedOut) {
    return new TtsTimeoutError();
  }
  return new TtsServiceUnavailableError(baseUrl);
}
