import type { ExtensionRegistry } from '../extensions/registry.js';
import type { ToolHandlerContext, ToolHandlerOutcome, ToolHandlerResolver } from '../extensions/execution/executor.js';
import type { AgentMessageContext } from '../host/contract.js';
import type { MediaService } from '../media/service.js';
import type { MediaRef } from '../media/types.js';
import type { MessageSegment } from '../routing/message.js';
import type { StoredMessage } from '../storage/contract.js';
import { messageText } from '../routing/message.js';
import { sanitizeErrorText } from '../platform/security/redaction.js';
import { formatMessageTime } from './clock.js';

export const RECALL_HISTORY_TOOL_ID = 'builtin.history.recall';
export const RECALL_HISTORY_TOOL_NAME = 'recall_history';
export const SEND_MEDIA_TOOL_ID = 'builtin.media.send';
export const SEND_MEDIA_TOOL_NAME = 'send_media';

const BUILTIN_HOST_GENERATION = 'builtin-host-v1';
const MAX_RECALL_LIMIT = 20;
const MAX_RECALL_TEXT_CHARS = 400;
const MAX_RECALL_TOTAL_CHARS = 6_000;
const MAX_CAPTION_CHARS = 500;
const MAX_RESEND_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_RESEND_AUDIO_BYTES = 20 * 1024 * 1024;

export interface BuiltinToolHostOptions {
  accountId: string;
  media: MediaService;
  timeZone: string;
  /** Manual tests must validate the tool without claiming delivery. */
  deliveryMode?: 'channel' | 'skip';
  now?: () => number;
}

export function registerBuiltinHostTools(extensions: ExtensionRegistry): void {
  if (!extensions.tool(RECALL_HISTORY_TOOL_ID)) {
    extensions.registerTool({
      id: RECALL_HISTORY_TOOL_ID,
      name: RECALL_HISTORY_TOOL_NAME,
      description:
        'Search earlier messages in this conversation when the visible history is not enough. ' +
        'Returns newest matches first. Read-only; only the current conversation is searched.',
      effect: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Case-insensitive text to find. Omit to page recent messages.',
            maxLength: 200
          },
          limit: {
            type: 'integer',
            description: 'Maximum matches to return.',
            minimum: 1,
            maximum: MAX_RECALL_LIMIT
          },
          beforeSeq: {
            type: 'integer',
            description: 'Only search messages older than this conversation seq.',
            minimum: 1
          }
        },
        additionalProperties: false
      }
    });
  }
  if (!extensions.tool(SEND_MEDIA_TOOL_ID)) {
    extensions.registerTool({
      id: SEND_MEDIA_TOOL_ID,
      name: SEND_MEDIA_TOOL_NAME,
      description:
        'Resend an image or voice message that already exists in this account media library. ' +
        'Use it when the user asks to see or hear something again; it cannot generate new media. ' +
        'Without mediaId, sends the most recent media of that kind from this conversation.',
      effect: 'action',
      inputSchema: {
        type: 'object',
        properties: {
          mediaId: { type: 'string', description: 'Exact media id from a previous tool result.', maxLength: 200 },
          kind: {
            type: 'string',
            enum: ['image', 'audio'],
            description: 'When mediaId is omitted, resend the most recent media of this kind.'
          },
          caption: { type: 'string', description: 'Optional text sent together with the media.', maxLength: MAX_CAPTION_CHARS }
        },
        additionalProperties: false
      }
    });
  }
}

/** Built-in host tools executed in-process; no provider or Worker access is involved. */
export class BuiltinToolHost {
  readonly #options: BuiltinToolHostOptions;

  constructor(options: BuiltinToolHostOptions) {
    this.#options = options;
  }

  handlers(context: AgentMessageContext): ToolHandlerResolver {
    return (toolId) => {
      if (toolId === RECALL_HISTORY_TOOL_ID) {
        return {
          generation: BUILTIN_HOST_GENERATION,
          handler: (args: Record<string, unknown>) => this.#recall(context, args)
        };
      }
      if (toolId === SEND_MEDIA_TOOL_ID) {
        return {
          generation: BUILTIN_HOST_GENERATION,
          handler: (args: Record<string, unknown>, toolContext: ToolHandlerContext) =>
            this.#sendMedia(context, args, toolContext)
        };
      }
      return undefined;
    };
  }

  async #recall(context: AgentMessageContext, args: Record<string, unknown>): Promise<ToolHandlerOutcome> {
    const search = context.searchHistory;
    if (!search) {
      return { status: 'error', errorCode: 'history_unavailable', text: '当前宿主不支持历史检索。' };
    }
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : undefined;
    const beforeSeq = typeof args.beforeSeq === 'number' && Number.isFinite(args.beforeSeq) ? Math.trunc(args.beforeSeq) : undefined;
    let records: StoredMessage[];
    try {
      records = await search.call(context, {
        ...(query ? { query } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(beforeSeq !== undefined ? { beforeSeq } : {})
      });
    } catch (error) {
      return { status: 'error', errorCode: 'history_unavailable', text: `历史检索失败：${shortError(error)}` };
    }
    if (records.length === 0) {
      return { status: 'ok', text: query ? '没有找到包含该关键词的历史消息。' : '没有更早的历史消息。' };
    }
    const lines: string[] = [];
    let usedChars = 0;
    for (const record of records) {
      const speaker = record.direction === 'out' ? '我' : record.senderId ? `对方(${record.senderId})` : '对方';
      const text = messageText(record.segments).replace(/\s+/g, ' ').trim().slice(0, MAX_RECALL_TEXT_CHARS);
      const line = `#${record.seq ?? '?'} ${formatMessageTime(record.at, this.#options.timeZone)} ${speaker}：${text || '[非文本消息]'}`;
      if (lines.length > 0 && usedChars + line.length > MAX_RECALL_TOTAL_CHARS) break;
      lines.push(line);
      usedChars += line.length + 1;
    }
    const truncated = lines.length < records.length ? '\n（结果较多，仅显示最近的部分；可缩小关键词或减少条数。）' : '';
    return {
      status: 'ok',
      text: `检索到 ${records.length} 条历史消息（新的在前）：\n${lines.join('\n')}${truncated}`,
      data: { count: records.length, returned: lines.length }
    };
  }

  async #sendMedia(
    context: AgentMessageContext,
    args: Record<string, unknown>,
    toolContext: ToolHandlerContext
  ): Promise<ToolHandlerOutcome> {
    const mediaId = typeof args.mediaId === 'string' ? args.mediaId.trim() : '';
    const kind = args.kind === 'image' || args.kind === 'audio' ? args.kind : undefined;
    if (!mediaId && !kind) {
      return { status: 'error', errorCode: 'invalid_arguments', text: '需要提供 mediaId 或 kind。' };
    }
    if (args.kind !== undefined && kind === undefined) {
      return { status: 'error', errorCode: 'invalid_arguments', text: 'kind 只能是 image 或 audio。' };
    }
    const caption = typeof args.caption === 'string' ? args.caption.trim() : '';
    if (caption.length > MAX_CAPTION_CHARS) {
      return { status: 'error', errorCode: 'invalid_arguments', text: `说明文字最多 ${MAX_CAPTION_CHARS} 字符。` };
    }
    let refs: MediaRef[];
    try {
      refs = await this.#options.media.list(this.#options.accountId);
    } catch (error) {
      return { status: 'error', errorCode: 'media_unavailable', text: `读取媒体库失败：${shortError(error)}` };
    }
    const now = this.#options.now?.() ?? Date.now();
    const picked = pickMedia(refs, {
      mediaId,
      kind,
      conversation: context.conversation,
      now
    });
    if ('error' in picked) return picked.error;
    const ref = picked.ref;
    if (ref.kind !== 'image' && ref.kind !== 'audio') {
      return { status: 'error', errorCode: 'unsupported_media', text: '只能重发图片或语音。' };
    }
    const limit = ref.kind === 'image' ? MAX_RESEND_IMAGE_BYTES : MAX_RESEND_AUDIO_BYTES;
    if (ref.bytes > limit) {
      return { status: 'error', errorCode: 'media_too_large', text: '这个媒体文件过大，无法通过当前通道发送。' };
    }
    if (ref.kind === 'audio' && context.voiceDeliverySupport !== 'supported') {
      return {
        status: 'error',
        errorCode: 'voice_unsupported',
        text: '当前通道尚未确认支持语音发送，未发送。'
      };
    }
    if (this.#options.deliveryMode === 'skip') {
      return {
        status: 'ok',
        text: '手动测试模式：媒体未实际发送。',
        data: { mediaId: ref.mediaId, delivery: 'skipped' }
      };
    }
    if (toolContext.guard && !(await toolContext.guard())) {
      return { status: 'error', errorCode: 'guard_changed', text: '会话上下文已变化，未发送。' };
    }
    try {
      const data = await this.#options.media.read(this.#options.accountId, ref.mediaId);
      const file = `base64://${data.data.toString('base64')}`;
      const media: MessageSegment =
        ref.kind === 'image'
          ? { type: 'image', data: { file, mediaId: ref.mediaId, mimeType: ref.mimeType } }
          : { type: 'record', data: { file, mediaId: ref.mediaId, mimeType: ref.mimeType } };
      const segments: MessageSegment[] = caption
        ? [{ type: 'text', data: { text: caption } }, media]
        : [media];
      const delivered = await context.deliver({ segments }, { idempotencyKey: `tool:${toolContext.invocationKey}:media` });
      return {
        status: 'ok',
        text: delivered.duplicate
          ? '同一媒体的发送请求已经处理过。'
          : ref.kind === 'image' ? '图片已发送。' : '语音已发送。',
        data: { mediaId: ref.mediaId, ...(delivered.messageId ? { messageId: delivered.messageId } : {}) }
      };
    } catch (error) {
      return { status: 'error', errorCode: errorCodeOf(error), text: `发送失败：${shortError(error)}` };
    }
  }
}

function pickMedia(
  refs: MediaRef[],
  input: {
    mediaId: string;
    kind?: 'image' | 'audio';
    conversation: AgentMessageContext['conversation'];
    now: number;
  }
): { ref: MediaRef } | { error: ToolHandlerOutcome } {
  if (input.mediaId) {
    const ref = refs.find((entry) => entry.mediaId === input.mediaId);
    if (!ref) {
      return { error: { status: 'error', errorCode: 'media_not_found', text: '媒体库中没有这个 mediaId。' } };
    }
    if (input.kind && ref.kind !== input.kind) {
      return { error: { status: 'error', errorCode: 'media_kind_mismatch', text: '该 mediaId 的类型与请求不一致。' } };
    }
    if (ref.expiresAt <= input.now) {
      return { error: { status: 'error', errorCode: 'media_expired', text: '这个媒体已经过期。' } };
    }
    return { ref };
  }
  const kind = input.kind!;
  const candidates = refs
    .filter((entry) =>
      entry.kind === kind
      && entry.expiresAt > input.now
      && sameConversation(entry.source.conversation, input.conversation))
    .sort((left, right) => right.createdAt - left.createdAt);
  const ref = candidates[0];
  if (!ref) {
    return {
      error: {
        status: 'error',
        errorCode: 'media_not_found',
        text: kind === 'image' ? '本会话还没有可重发的图片。' : '本会话还没有可重发的语音。'
      }
    };
  }
  return { ref };
}

function sameConversation(
  left: AgentMessageContext['conversation'],
  right: AgentMessageContext['conversation']
): boolean {
  return left.accountId === right.accountId && left.kind === right.kind && left.peerId === right.peerId;
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code)) return code;
  }
  return 'send_failed';
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeErrorText(message, 120);
}
