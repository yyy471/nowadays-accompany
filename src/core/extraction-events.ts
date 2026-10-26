import type { ConversationRef } from '../routing/identity.js';

/**
 * Internal notification that one built-in Agent turn produced a final pure-text reply which was
 * already sent through the channel and persisted. It is never accepted from HTTP or plugins.
 */
export interface ExtractionTurnCompletion {
  instanceId: string;
  accountId: string;
  conversation: ConversationRef;
  contextEpoch: string;
  turnId: string;
  /** Persisted inbound message seq; extraction never trusts an unpersisted trigger. */
  inboundSeq: number;
  /** Persisted outbound reply seq. */
  outboundSeq: number;
  inboundMessageId?: string;
  sessionEpoch: number;
  /** MEM02 guard captured for the turn; the coordinator rechecks it before any model call/commit. */
  memoryGuard: string;
  at: number;
}
