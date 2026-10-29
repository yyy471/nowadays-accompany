import type { AgentMessageContext } from '../host/contract.js';
import type { Logger } from '../core/logger.js';
import type { ProviderRouter } from '../providers/router.js';
import type { MediaService } from '../media/service.js';
import type { MediaJobService } from '../jobs/service.js';
import type { MediaJob } from '../jobs/types.js';
import type { AudioGenerationRequest, ChatToolCall } from '../providers/contract.js';
import type {
  ToolHandlerContext,
  ToolHandlerOutcome,
  ToolHandlerResolver
} from '../extensions/execution/executor.js';
import { CapabilityUnavailableError } from '../providers/errors.js';
import { sanitizeErrorText } from '../platform/security/redaction.js';
import { textMessage } from '../routing/message.js';
import { capabilityNotice } from './capability-notice.js';

export const GENERATE_IMAGE_TOOL_ID = 'builtin.image.generate';
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';
export const GENERATE_AUDIO_TOOL_ID = 'builtin.audio.generate';
export const GENERATE_AUDIO_TOOL_NAME = 'generate_speech';
const BUILTIN_TOOL_GENERATION = 'builtin-media-v1';

export interface MediaToolHostOptions {
  accountId: string;
  providers: ProviderRouter;
  media: MediaService;
  jobs: MediaJobService;
  logger: Logger;
  /** Manual tests must keep job results but skip QQ delivery. */
  deliveryMode?: 'channel' | 'skip';
}

interface ImageJobOptions {
  prompt: string;
  count?: number;
  size?: string;
  actionKey: string;
  context: AgentMessageContext;
}

interface AudioJobOptions {
  text: string;
  voice?: string;
  format?: AudioGenerationRequest['format'];
  actionKey: string;
  context: AgentMessageContext;
}

interface Command {
  prompt: string;
  count?: number;
  size?: string;
}

/** Built-in media tools shared by the production Agent and the manual extension test host. */
export class MediaToolHost {
  readonly #options: MediaToolHostOptions;

  constructor(options: MediaToolHostOptions) {
    this.#options = options;
  }

  handlers(context: AgentMessageContext): ToolHandlerResolver {
    return (toolId) => {
      if (toolId === GENERATE_IMAGE_TOOL_ID) {
        return {
          generation: BUILTIN_TOOL_GENERATION,
          handler: (args: Record<string, unknown>, toolContext: ToolHandlerContext) =>
            this.#generateImageTool(context, args, toolContext.invocationKey)
        };
      }
      if (toolId === GENERATE_AUDIO_TOOL_ID) {
        return {
          generation: BUILTIN_TOOL_GENERATION,
          handler: (args: Record<string, unknown>, toolContext: ToolHandlerContext) =>
            this.#generateAudioTool(context, args, toolContext.invocationKey)
        };
      }
      return undefined;
    };
  }

  async submitImage(options: ImageJobOptions): Promise<{ job: MediaJob; duplicate: boolean }> {
    const context = options.context;
    const conversation = context.conversation;
    if (!(await turnCurrent(context))) throw new Error('conversation role binding or extension snapshot changed before tool execution');
    if (!this.#options.providers.availableTools(this.#options.accountId, conversation).some((tool) => tool.id === GENERATE_IMAGE_TOOL_ID)) {
      throw new CapabilityUnavailableError('image.generate', 'tool_not_authorized', '账号尚未允许 AI 调用生图工具。');
    }
    const resolution = this.#options.providers.resolve(this.#options.accountId, conversation, 'image.generate');
    if (!resolution.enabled) {
      throw new CapabilityUnavailableError(
        'image.generate',
        resolution.reason ?? 'not_configured',
        capabilityNotice('image.generate', resolution.reason ?? 'not_configured', resolution.detail)
      );
    }
    const actionId = `image:${this.#options.accountId}:${options.actionKey}`;
    return this.#options.jobs.submit({
      accountId: this.#options.accountId,
      conversation,
      capability: 'image.generate',
      turnId: context.turnId,
      sessionEpoch: context.sessionEpoch,
      cancelMode: resolution.cancelMode ?? 'none',
      actionId,
      ...(context.message.messageId ? { originMessageId: context.message.messageId } : {}),
      ...(resolution.providerId ? { providerId: resolution.providerId } : {}),
      ...(resolution.modelId ? { modelId: resolution.modelId } : {}),
      signal: context.sessionSignal,
      executor: async (jobContext) => {
        if (!(await turnCurrent(context))) throw new Error('conversation role binding or extension snapshot changed before image generation');
        if (!this.#options.providers.availableTools(this.#options.accountId, conversation).some((tool) => tool.id === GENERATE_IMAGE_TOOL_ID)) {
          throw new CapabilityUnavailableError('image.generate', 'tool_not_authorized', '生图工具授权已撤销。');
        }
        const executed = await this.#options.providers.imageGenerate(
          this.#options.accountId,
          conversation,
          {
            prompt: options.prompt,
            ...(options.count !== undefined ? { count: options.count } : {}),
            ...(options.size !== undefined ? { size: options.size } : {})
          },
          jobContext.signal,
          undefined,
          resolution,
          GENERATE_IMAGE_TOOL_ID,
          () => turnCurrent(context)
        );
        if (!(await turnCurrent(context))) {
          throw new Error('conversation role binding changed during image generation');
        }
        await jobContext.setProvider(executed.used.providerId, executed.used.modelId);
        const media = await this.#options.media.ingestGenerated(
          this.#options.accountId,
          conversation,
          jobContext.jobId,
          executed.result.images,
          jobContext.signal
        );
        return { media };
      },
      onComplete: (job) => this.#deliverGeneratedImages(context, job)
    }).then((result) => ({ job: result.job as MediaJob, duplicate: result.duplicate }));
  }

  async submitAudio(options: AudioJobOptions): Promise<{ job: MediaJob; duplicate: boolean }> {
    const context = options.context;
    const conversation = context.conversation;
    if (!(await turnCurrent(context))) throw new Error('conversation role binding or extension snapshot changed before tool execution');
    const isToolAllowed = (): boolean => this.#options.providers.availableTools(this.#options.accountId, conversation)
      .some((tool) => tool.id === GENERATE_AUDIO_TOOL_ID);
    if (!isToolAllowed()) throw new CapabilityUnavailableError('audio.generate', 'tool_not_authorized', '账号尚未允许 AI 调用语音生成工具。');
    const resolution = this.#options.providers.resolve(this.#options.accountId, conversation, 'audio.generate');
    if (!resolution.enabled) {
      throw new CapabilityUnavailableError(
        'audio.generate',
        resolution.reason ?? 'not_configured',
        capabilityNotice('audio.generate', resolution.reason ?? 'not_configured', resolution.detail)
      );
    }
    return this.#options.jobs.submit({
      accountId: this.#options.accountId,
      conversation,
      capability: 'audio.generate',
      turnId: context.turnId,
      sessionEpoch: context.sessionEpoch,
      cancelMode: resolution.cancelMode ?? 'none',
      actionId: `audio:${this.#options.accountId}:${options.actionKey}`,
      ...(context.message.messageId ? { originMessageId: context.message.messageId } : {}),
      ...(resolution.providerId ? { providerId: resolution.providerId } : {}),
      ...(resolution.modelId ? { modelId: resolution.modelId } : {}),
      signal: context.sessionSignal,
      executor: async (jobContext) => {
        if (!isToolAllowed()) throw new CapabilityUnavailableError('audio.generate', 'tool_not_authorized', '语音工具授权已撤销。');
        if (!(await turnCurrent(context))) throw new Error('conversation role binding or extension snapshot changed before audio generation');
        const executed = await this.#options.providers.audioGenerate(
          this.#options.accountId,
          conversation,
          { text: options.text, ...(options.voice ? { voice: options.voice } : {}), ...(options.format ? { format: options.format } : {}) },
          jobContext.signal,
          undefined,
          resolution,
          GENERATE_AUDIO_TOOL_ID,
          () => turnCurrent(context)
        );
        if (!(await turnCurrent(context))) throw new Error('conversation role binding changed during audio generation');
        if (!isToolAllowed()) throw new CapabilityUnavailableError('audio.generate', 'tool_not_authorized', '语音工具授权已撤销。');
        await jobContext.setProvider(executed.used.providerId, executed.used.modelId);
        const media = await this.#options.media.ingestGeneratedAudio(this.#options.accountId, conversation, jobContext.jobId, executed.result, jobContext.signal);
        return { media: [media] };
      },
      onComplete: (job) => this.#deliverGeneratedAudio(context, job)
    }).then((result) => ({ job: result.job as MediaJob, duplicate: result.duplicate }));
  }

  async #generateImageTool(
    context: AgentMessageContext,
    args: Record<string, unknown>,
    invocationId: string
  ): Promise<ToolHandlerOutcome> {
    const parsed = parseImageToolCall({ id: invocationId, name: GENERATE_IMAGE_TOOL_NAME, arguments: args });
    if ('error' in parsed) return { status: 'error', errorCode: 'invalid_arguments', text: `生图参数无效：${parsed.error}` };
    const submitted = await this.submitImage({
      prompt: parsed.prompt,
      ...(parsed.count !== undefined ? { count: parsed.count } : {}),
      ...(parsed.size !== undefined ? { size: parsed.size } : {}),
      actionKey: invocationId,
      context
    });
    return {
      status: 'submitted',
      text: submitted.duplicate ? '这个生图请求已经提交过，不会重复发起。' : '正在生成图片，完成后会发送。',
      jobId: submitted.job.id,
      data: { duplicate: submitted.duplicate }
    };
  }

  async #generateAudioTool(
    context: AgentMessageContext,
    args: Record<string, unknown>,
    invocationId: string
  ): Promise<ToolHandlerOutcome> {
    const parsed = parseAudioToolCall({ id: invocationId, name: GENERATE_AUDIO_TOOL_NAME, arguments: args });
    if ('error' in parsed) return { status: 'error', errorCode: 'invalid_arguments', text: `语音生成参数无效：${parsed.error}` };
    const submitted = await this.submitAudio({
      ...parsed,
      actionKey: invocationId,
      context
    });
    return {
      status: 'submitted',
      text: submitted.duplicate ? '这个语音请求已经提交过，不会重复发起。' : '正在生成语音；完成后会尝试按当前通道能力发送。',
      jobId: submitted.job.id,
      data: { duplicate: submitted.duplicate }
    };
  }

  async #deliverGeneratedAudio(context: AgentMessageContext, job: MediaJob): Promise<void> {
    if (this.#options.deliveryMode === 'skip') {
      await this.#options.jobs.markDelivery(job.accountId, job.id, 'skipped', '手动测试，不投递 QQ').catch(() => {});
      return;
    }
    const ref = job.result?.media?.find((media) => media.kind === 'audio');
    if (!ref) {
      await this.#options.jobs.markDelivery(job.accountId, job.id, 'skipped', 'audio generated without a persisted audio artifact').catch(() => {});
      return;
    }
    try {
      await context.enqueueConversation(async () => {
        if (!(await turnCurrent(context))) {
          await this.#options.jobs.markDelivery(job.accountId, job.id, 'skipped', 'conversation role binding changed before image delivery');
          return;
        }
        const effective = await this.#options.providers.effective(job.accountId, job.conversation);
        const permitted = this.#options.providers.availableTools(job.accountId, job.conversation).some((tool) => tool.id === GENERATE_AUDIO_TOOL_ID);
        if (!effective.agentEnabled || !permitted || !effective.capabilities.find((cap) => cap.capability === 'audio.generate')?.enabled) {
          await this.#options.jobs.markDelivery(job.accountId, job.id, 'skipped', 'audio generated but tool permission or capability was revoked before delivery');
          return;
        }
        if (context.voiceDeliverySupport !== 'supported') {
          const reason = context.voiceDeliverySupport === 'unsupported' ? 'channel does not support voice delivery' : 'channel voice delivery support is unknown';
          await this.#options.jobs.markDelivery(job.accountId, job.id, 'skipped', `audio generated; ${reason}`);
          if (await turnCurrent(context)) {
            await context.deliver(textMessage('语音已生成，但当前通道尚未确认支持语音交付。'), { idempotencyKey: `job:${job.id}:delivery-note` });
          }
          return;
        }
        if (!(await turnCurrent(context))) {
          await this.#options.jobs.markDelivery(job.accountId, job.id, 'skipped', 'role binding changed before voice delivery');
          return;
        }
        const audio = await this.#options.media.read(job.accountId, ref.mediaId);
        await context.deliver({ segments: [{ type: 'record', data: { file: `base64://${audio.data.toString('base64')}`, mediaId: ref.mediaId, mimeType: ref.mimeType } }] }, { idempotencyKey: `job:${job.id}` });
        await this.#options.jobs.markDelivery(job.accountId, job.id, 'sent');
      });
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : '';
      const skipped = code.includes('isolation') || code === 'auto_reply_paused';
      await this.#options.jobs.markDelivery(job.accountId, job.id, skipped ? 'skipped' : 'failed', shortError(error)).catch(() => {});
      this.#options.logger.warn('generated audio delivery failed', { jobId: job.id, error: shortError(error) });
    }
  }

  async #deliverGeneratedImages(context: AgentMessageContext, job: MediaJob): Promise<void> {
    const refs = job.result?.media ?? [];
    if (refs.length === 0) {
      await this.#options.jobs.markDelivery(job.accountId, job.id, 'skipped', 'no image output').catch(() => {});
      return;
    }
    if (this.#options.deliveryMode === 'skip') {
      await this.#options.jobs.markDelivery(job.accountId, job.id, 'skipped', '手动测试，不投递 QQ').catch(() => {});
      return;
    }
    try {
      await context.enqueueConversation(async () => {
        const effective = await this.#options.providers.effective(job.accountId, job.conversation);
        if (!effective.agentEnabled) {
          await this.#options.jobs.markDelivery(job.accountId, job.id, 'skipped', 'agent paused before image delivery');
          return;
        }
        if (!effective.capabilities.find((capability) => capability.capability === 'image.generate')?.enabled) {
          await this.#options.jobs.markDelivery(job.accountId, job.id, 'skipped', 'image generation disabled before delivery');
          return;
        }
        const segments = [];
        for (const ref of refs) {
          const media = await this.#options.media.read(job.accountId, ref.mediaId);
          segments.push({
            type: 'image' as const,
            data: {
              file: `base64://${media.data.toString('base64')}`,
              mediaId: ref.mediaId,
              mimeType: ref.mimeType
            }
          });
        }
        await context.deliver({ segments }, { idempotencyKey: `job:${job.id}` });
        await this.#options.jobs.markDelivery(job.accountId, job.id, 'sent');
      });
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : '';
      const skipped = code.includes('isolation') || code === 'auto_reply_paused';
      await this.#options.jobs
        .markDelivery(job.accountId, job.id, skipped ? 'skipped' : 'failed', shortError(error))
        .catch(() => {});
      this.#options.logger.warn('generated image delivery failed', {
        jobId: job.id,
        error: shortError(error)
      });
    }
  }
}

function parseImageToolCall(call: ChatToolCall): Command | { error: string } {
  const args = call.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'arguments must be an object' };
  const record = args as Record<string, unknown>;
  if (typeof record.prompt !== 'string' || !record.prompt.trim()) return { error: 'prompt is required' };
  if (record.prompt.length > 4_000) return { error: 'prompt is too long' };
  let count: number | undefined;
  if (record.count !== undefined) {
    if (typeof record.count !== 'number' || !Number.isInteger(record.count) || record.count < 1 || record.count > 4) {
      return { error: 'count must be an integer between 1 and 4' };
    }
    count = record.count;
  }
  let size: string | undefined;
  if (record.size !== undefined) {
    if (typeof record.size !== 'string' || !/^\d{2,5}x\d{2,5}$/.test(record.size)) return { error: 'size is invalid' };
    size = record.size;
  }
  return {
    prompt: record.prompt.trim(),
    ...(count !== undefined ? { count } : {}),
    ...(size ? { size } : {})
  };
}

function parseAudioToolCall(call: ChatToolCall): Omit<AudioJobOptions, 'actionKey' | 'context'> | { error: string } {
  const args = call.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'arguments must be an object' };
  const record = args as Record<string, unknown>;
  if (typeof record.text !== 'string' || !record.text.trim()) return { error: 'text is required' };
  if (record.text.length > 4_000) return { error: 'text is too long' };
  if (record.voice !== undefined && (typeof record.voice !== 'string' || record.voice.length > 80)) return { error: 'voice is invalid' };
  const formats = ['mp3', 'wav', 'opus', 'aac', 'flac'] as const;
  if (record.format !== undefined && !formats.includes(record.format as (typeof formats)[number])) return { error: 'format is invalid' };
  const format = typeof record.format === 'string' ? record.format as AudioGenerationRequest['format'] : undefined;
  return {
    text: record.text.trim(),
    ...(typeof record.voice === 'string' && record.voice ? { voice: record.voice } : {}),
    ...(format ? { format } : {})
  };
}

async function turnCurrent(context: AgentMessageContext): Promise<boolean> {
  return context.isTurnCurrent ? context.isTurnCurrent() : context.isRoleBindingCurrent();
}

function shortError(error: unknown): string {
  return sanitizeErrorText(error instanceof Error ? error.message : String(error), 160);
}
