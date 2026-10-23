import type { ConversationRef } from '../routing/identity.js';
import type { OutboundMessage } from '../routing/message.js';
import type { RuntimeEndpoints } from '../injection/contract.js';
import type { NormalizedInstanceSpec } from '../instances/spec.js';
import type { InboundEvent } from './events.js';
import type { Logger } from '../core/logger.js';

export interface ChannelContext {
  spec: NormalizedInstanceSpec;
  instanceId: string;
  endpoints: RuntimeEndpoints;
  logger: Logger;
  signal?: AbortSignal;
  maxConcurrentActions?: number;
  onEvent: (event: InboundEvent) => void;
  /** 连接状态变化（含重连与登录信息回报），实例据此迁移状态 */
  onStatus?: (status: { connected: boolean; selfId?: string; nickname?: string }) => void;
}

/** 一个通道对象只服务一个实例；发送目标必须属于本实例的账号。 */
export interface OutboundChannel {
  readonly kind: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(conversation: ConversationRef, message: OutboundMessage): Promise<{ messageId?: string }>;
  isConnected(): boolean;
  selfId(): string | undefined;
  /** Unknown is fail-closed: callers must not claim voice delivery without an explicit protocol contract. */
  voiceDeliverySupport?(): 'supported' | 'unsupported' | 'unknown';
  /** 可选背压钩子：入站队列高水位时暂停读取。 */
  pause?(): void;
  resume?(): void;
}

export type ChannelFactory = (context: ChannelContext) => OutboundChannel;
