import { ChannelError } from '../core/errors.js';
import type { ConversationRef } from '../routing/identity.js';
import type { OutboundMessage } from '../routing/message.js';
import type { ChannelContext, OutboundChannel } from './contract.js';
import type { InboundEvent } from './events.js';

export interface FakeChannelOptions {
  selfId?: string;
  failOnSend?: boolean;
  /** Defaults to `supported`; other values model channels that cannot confirm voice delivery. */
  voiceDeliverySupport?: 'supported' | 'unsupported' | 'unknown';
}

export class FakeChannel implements OutboundChannel {
  readonly kind = 'fake';
  readonly sent: Array<{ conversation: ConversationRef; message: OutboundMessage }> = [];

  readonly #context: ChannelContext;
  readonly #options: FakeChannelOptions;
  #connected = false;
  #selfId: string | undefined;

  constructor(context: ChannelContext, options: FakeChannelOptions = {}) {
    this.#context = context;
    this.#options = options;
    this.#selfId = options.selfId ?? context.spec.accountId ?? '10001';
  }

  async connect(): Promise<void> {
    this.#connected = true;
    this.#context.onStatus?.({ connected: true, selfId: this.#selfId });
  }

  async disconnect(): Promise<void> {
    this.#connected = false;
    this.#context.onStatus?.({ connected: false, ...(this.#selfId ? { selfId: this.#selfId } : {}) });
  }

  async send(conversation: ConversationRef, message: OutboundMessage): Promise<{ messageId?: string }> {
    if (!this.#connected) throw new ChannelError('not_connected', 'fake channel is not connected');
    if (this.#options.failOnSend) throw new ChannelError('fake_send_failed', 'fake channel refused to send');
    this.sent.push({ conversation, message });
    return { messageId: `fake-${this.sent.length}` };
  }

  isConnected(): boolean {
    return this.#connected;
  }

  selfId(): string | undefined {
    return this.#selfId;
  }

  voiceDeliverySupport(): 'supported' | 'unsupported' | 'unknown' {
    return this.#options.voiceDeliverySupport ?? 'supported';
  }

  /** 测试入口：模拟从协议侧收到一条事件 */
  emitInbound(event: InboundEvent): void {
    this.#context.onEvent(event);
  }
}
