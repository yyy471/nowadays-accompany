import type { InboundEvent } from '../events.js';
import { assertKind } from '../../routing/identity.js';
import { normalizeSegments } from '../../routing/message.js';

interface RawEvent {
  post_type?: unknown;
  message_type?: unknown;
  self_id?: unknown;
  user_id?: unknown;
  group_id?: unknown;
  message_id?: unknown;
  message?: unknown;
  time?: unknown;
  notice_type?: unknown;
  sub_type?: unknown;
  sender?: unknown;
}

function asId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text === '' ? undefined : text;
}

/**
 * 把 OneBot v11 原始事件收敛为核心事件；
 * 不认识的事件返回 null，由调用方直接丢弃（不透传给功能层）。
 */
export function normalizeEvent(raw: unknown, instanceId: string, now = Date.now()): InboundEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as RawEvent;
  const postType = typeof event.post_type === 'string' ? event.post_type : '';
  const selfId = asId(event.self_id);
  const at = Number.isFinite(Number(event.time)) ? Number(event.time) * 1000 : now;

  if (postType === 'message' || postType === 'message_sent') {
    const messageType = event.message_type;
    if (messageType !== 'group' && messageType !== 'private') return null;
    const kind = assertKind(String(messageType));
    const sender = event.sender && typeof event.sender === 'object' ? (event.sender as Record<string, unknown>) : {};
    const reportedSender = asId(event.user_id) ?? asId(sender.user_id);
    // message_sent：user_id 是对端，真正的发送者是自己
    const senderId = postType === 'message_sent' ? selfId ?? reportedSender : reportedSender;
    const peerId = kind === 'group' ? asId(event.group_id) : postType === 'message_sent' ? reportedSender : senderId;
    if (!senderId || !peerId) return null;
    return {
      type: 'message',
      instanceId,
      ...(selfId ? { selfId } : {}),
      kind,
      peerId,
      senderId,
      ...(asId(event.message_id) ? { messageId: asId(event.message_id) } : {}),
      at,
      segments: normalizeSegments(event.message),
      selfEcho: postType === 'message_sent'
    };
  }

  if (postType === 'notice') {
    return {
      type: 'notice',
      instanceId,
      ...(selfId ? { selfId } : {}),
      noticeType: typeof event.notice_type === 'string' ? event.notice_type : 'unknown',
      at,
      raw: event as Record<string, unknown>
    };
  }

  if (postType === 'meta_event') {
    return {
      type: 'lifecycle',
      instanceId,
      ...(selfId ? { selfId } : {}),
      subType: typeof event.sub_type === 'string' ? event.sub_type : 'unknown',
      at,
      raw: event as Record<string, unknown>
    };
  }

  return null;
}
