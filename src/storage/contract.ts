import type { ConversationRef } from '../routing/identity.js';
import type { MessageSegment } from '../routing/message.js';

export interface StoredMessage {
  id: string;
  at: number;
  direction: 'in' | 'out';
  senderId?: string;
  messageId?: string;
  segments: MessageSegment[];
  meta?: Record<string, unknown>;
  /** Explicit role binding epoch used to keep context separate after a role change. */
  contextEpoch?: string;
  /** 会话内单调序号，由存储层分配。 */
  seq?: number;
}

export interface AppendResult {
  seq: number;
  duplicate: boolean;
}

export interface ReadOptions {
  /** 只取最后 N 条 */
  limit?: number;
  afterSeq?: number;
  beforeSeq?: number;
  /** Return only messages from the selected explicit role binding epoch. */
  contextEpoch?: string;
}

export interface MessageStore {
  append(conversation: ConversationRef, message: StoredMessage): Promise<AppendResult>;
  read(conversation: ConversationRef, options?: ReadOptions): Promise<StoredMessage[]>;
  listConversations?(accountId?: string): Promise<ConversationRef[]>;
  dispose(): Promise<void>;
}
