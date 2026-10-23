import { sleep } from '../../core/concurrency.js';
import type { CapabilityId } from '../../policy/capabilities.js';
import type {
  ProviderAdapter,
  ProviderCallContext,
  ProviderMedia,
  VideoObservation,
  VideoObservationSegment
} from '../contract.js';
import { abortReason } from '../contract.js';
import { ProviderError, sanitizeErrorText } from '../errors.js';
import { HttpBodyError, readResponseText } from '../../platform/http/bounded-body.js';
import type { CancelMode } from '../types.js';

const MAX_JSON_BYTES = 8 * 1024 * 1024;

interface VideoPayload {
  id?: string;
  status?: string;
  result?: {
    summary?: string;
    segments?: Array<{ startMs?: number; endMs?: number; text?: string }>;
    coverage?: string;
  };
  error?: { message?: string; code?: string } | string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * 视频理解适配器的明确协议（不是万能 HTTP 客户端）：
 *   POST   {baseUrl}/video/understand      {model, prompt, video:{mimeType,dataBase64}}
 *   GET    {baseUrl}/video/understand/{id} {status,result,error}
 *   DELETE {baseUrl}/video/understand/{id} 取消（尽力而为）
 */
export class VideoPollingAdapter implements ProviderAdapter {
  readonly id = 'video-polling-v1';

  supports(capability: CapabilityId): boolean {
    return capability === 'video.understand';
  }

  cancelMode(capability: CapabilityId): CancelMode {
    return capability === 'video.understand' ? 'remote' : 'none';
  }

  async videoUnderstand(
    context: ProviderCallContext,
    media: ProviderMedia,
    prompt: string,
    parameters?: Record<string, unknown>,
    onProgress?: (state: 'submitted' | 'waiting_remote') => void
  ): Promise<VideoObservation> {
    const base = `${context.provider.baseUrl.replace(/\/+$/, '')}/video/understand`;
    const submitted = await this.#request(context, base, {
      method: 'POST',
      body: JSON.stringify({
        ...(parameters ?? {}),
        model: context.model.id,
        prompt,
        video: {
          mimeType: media.mimeType,
          dataBase64: media.data.toString('base64')
        }
      })
    }, 'submit');
    onProgress?.('submitted');
    const immediate = this.#parseResult(context, submitted);
    if (immediate) return immediate;
    const remoteId = submitted.id;
    if (!remoteId) {
      throw new ProviderError('provider_protocol', 'video service accepted the task without a remote id', {
        providerId: context.provider.id,
        capability: 'video.understand',
        retryable: false
      });
    }
    const deadline = Date.now() + context.provider.timeouts.pollTimeoutMs;
    const remoteUrl = `${base}/${encodeURIComponent(remoteId)}`;
    let polls = 0;
    try {
      while (Date.now() < deadline) {
        if (context.signal.aborted) break;
        onProgress?.('waiting_remote');
        await sleep(context.provider.timeouts.pollIntervalMs, context.signal);
        polls += 1;
        if (polls > 1_000) break;
        const payload = await this.#request(context, remoteUrl, { method: 'GET' }, 'poll');
        const parsed = this.#parseResult(context, payload);
        if (parsed) return parsed;
        if (payload.status === 'failed') {
          throw new ProviderError('provider_upstream', this.#errorText(payload) ?? 'video service reported failure', {
            providerId: context.provider.id,
            capability: 'video.understand',
            retryable: false
          });
        }
      }
    } catch (error) {
      if (context.signal.aborted) {
        await this.#cancelRemote(context, remoteUrl);
        throw abortReason(context.signal);
      }
      throw error;
    }
    await this.#cancelRemote(context, remoteUrl);
    if (context.signal.aborted) throw abortReason(context.signal);
    throw new ProviderError(
      'provider_job_unknown',
      `video task ${remoteId} did not finish before the poll timeout; it was not resubmitted`,
      {
        providerId: context.provider.id,
        capability: 'video.understand',
        retryable: false
      }
    );
  }

  #parseResult(context: ProviderCallContext, payload: VideoPayload): VideoObservation | undefined {
    if (payload.result?.summary) {
      const segments: VideoObservationSegment[] = [];
      for (const segment of payload.result.segments ?? []) {
        if (typeof segment.text !== 'string') continue;
        segments.push({
          startMs: typeof segment.startMs === 'number' ? segment.startMs : 0,
          endMs: typeof segment.endMs === 'number' ? segment.endMs : 0,
          text: segment.text
        });
      }
      return {
        summary: payload.result.summary,
        ...(segments.length > 0 ? { segments } : {}),
        coverage: payload.result.coverage ?? 'remote video analysis',
        ...(payload.usage
          ? {
              usage: {
                ...(payload.usage.prompt_tokens !== undefined ? { promptTokens: payload.usage.prompt_tokens } : {}),
                ...(payload.usage.completion_tokens !== undefined
                  ? { completionTokens: payload.usage.completion_tokens }
                  : {}),
                ...(payload.usage.total_tokens !== undefined ? { totalTokens: payload.usage.total_tokens } : {})
              }
            }
          : {})
      };
    }
    if (payload.status === 'failed') {
      throw new ProviderError('provider_upstream', this.#errorText(payload) ?? 'video service reported failure', {
        providerId: context.provider.id,
        capability: 'video.understand',
        retryable: false
      });
    }
    return undefined;
  }

  #errorText(payload: VideoPayload): string | undefined {
    if (typeof payload.error === 'string') return sanitizeErrorText(payload.error);
    if (payload.error?.message) return sanitizeErrorText(payload.error.message);
    return undefined;
  }

  async #request(
    context: ProviderCallContext,
    url: string,
    init: { method: string; body?: string },
    phase: 'submit' | 'poll'
  ): Promise<VideoPayload> {
    const headers: Record<string, string> = {};
    if (init.body) headers['content-type'] = 'application/json';
    if (context.credential) headers.authorization = `Bearer ${context.credential}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers,
        ...(init.body ? { body: init.body } : {}),
        signal: context.signal
      });
    } catch (error) {
      if (context.signal.aborted) {
        if (phase === 'submit') {
          throw new ProviderError('provider_submit_unknown', 'video submission was interrupted; remote state is unknown', {
            providerId: context.provider.id,
            capability: 'video.understand',
            retryable: false,
            cause: error
          });
        }
        throw new ProviderError('provider_job_unknown', 'video polling was interrupted; remote state is unknown', {
          providerId: context.provider.id,
          capability: 'video.understand',
          retryable: false,
          cause: error
        });
      }
      throw new ProviderError('provider_transport', `video service transport failure: ${sanitizeErrorText(String(error))}`, {
        providerId: context.provider.id,
        capability: 'video.understand',
        retryable: phase !== 'submit',
        cause: error
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError('provider_auth', `video service authentication failed (HTTP ${response.status})`, {
          providerId: context.provider.id,
          capability: 'video.understand',
          retryable: false,
          httpStatus: response.status
        });
      }
      if (response.status === 429) {
        throw new ProviderError('provider_rate_limit', 'video service rate limit', {
          providerId: context.provider.id,
          capability: 'video.understand',
          retryable: true,
          httpStatus: response.status
        });
      }
      throw new ProviderError('provider_rejected', `video service returned HTTP ${response.status}`, {
        providerId: context.provider.id,
        capability: 'video.understand',
        retryable: false,
        httpStatus: response.status
      });
    }
    let text: string;
    try {
      text = await readResponseText(response, {
        maxBytes: MAX_JSON_BYTES,
        signal: context.signal,
        label: 'video service response'
      });
    } catch (error) {
      if (error instanceof HttpBodyError && error.code === 'http_body_too_large') {
        throw new ProviderError('provider_protocol', `video service response exceeded ${MAX_JSON_BYTES} bytes`, {
          providerId: context.provider.id,
          capability: 'video.understand',
          retryable: false,
          cause: error
        });
      }
      throw new ProviderError(
        phase === 'submit' ? 'provider_submit_unknown' : 'provider_job_unknown',
        phase === 'submit'
          ? 'video submission response was interrupted; remote state is unknown'
          : 'video polling response was interrupted; remote state is unknown',
        {
          providerId: context.provider.id,
          capability: 'video.understand',
          retryable: false,
          cause: error
        }
      );
    }
    try {
      return JSON.parse(text) as VideoPayload;
    } catch (error) {
      throw new ProviderError('provider_protocol', 'video service returned invalid JSON', {
        providerId: context.provider.id,
        capability: 'video.understand',
        retryable: false,
        cause: error
      });
    }
  }

  async #cancelRemote(context: ProviderCallContext, url: string): Promise<void> {
    try {
      await fetch(url, {
        method: 'DELETE',
        ...(context.credential ? { headers: { authorization: `Bearer ${context.credential}` } } : {}),
        signal: AbortSignal.timeout(3_000)
      });
    } catch {
      // 远端取消失败只影响“远端已取消”的声明；任务记录仍标明本地已取消/远端未知。
    }
  }
}
