import type { ChatKind } from '../routing/identity.js';
import type { MessageSegment } from '../routing/message.js';

export interface InboundMessageEvent {
  type: 'message';
  instanceId: string;
  selfId?: string;
  kind: ChatKind;
  peerId: string;
  senderId: string;
  messageId?: string;
  at: number;
  segments: MessageSegment[];
  /** post_type === 'message_sent'：自己发出的回声 */
  selfEcho: boolean;
}

export interface InboundNoticeEvent {
  type: 'notice';
  instanceId: string;
  selfId?: string;
  noticeType: string;
  at: number;
  raw: Record<string, unknown>;
}

export interface InboundLifecycleEvent {
  type: 'lifecycle';
  instanceId: string;
  selfId?: string;
  subType: string;
  at: number;
  raw: Record<string, unknown>;
}

export type InboundEvent = InboundMessageEvent | InboundNoticeEvent | InboundLifecycleEvent;
