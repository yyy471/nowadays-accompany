import type { InboundEvent } from '../channels/events.js';
import type { ProfileSummary } from '../artifacts/types.js';
import type { InstanceState } from './state.js';
import type { ConversationRef } from '../routing/identity.js';
import type { ExtractionTurnCompletion } from './extraction-events.js';

export interface CoreEvents extends Record<string, unknown> {
  'instance:state': { instanceId: string; from: InstanceState; to: InstanceState; at: number };
  'instance:error': {
    instanceId: string;
    code: string;
    message: string;
    retryable?: boolean;
    at: number;
  };
  'channel:inbound': { instanceId: string; event: InboundEvent; seq?: number; at: number };
  'channel:outbound': {
    instanceId: string;
    conversation: ConversationRef;
    messageId?: string;
    seq?: number;
    operationId?: string;
    at: number;
  };
  'channel:status': { instanceId: string; connected: boolean; selfId?: string; at: number };
  'provider:changed': { providerId: string; action: 'upsert' | 'remove' | 'credential'; at: number };
  'provider:usage': {
    accountId: string;
    capability: string;
    providerId: string;
    modelId: string;
    ok: boolean;
    durationMs: number;
    code?: string;
    at: number;
  };
  'policy:changed': { accountId?: string; at: number };
  'job:update': {
    accountId: string;
    jobId: string;
    state: string;
    capability: string;
    delivery: string;
    at: number;
  };
  'agent:turn': {
    instanceId: string;
    accountId: string;
    conversation: ConversationRef;
    turnId: string;
    status: string;
    durationMs: number;
    capability?: string;
    providerId?: string;
    modelId?: string;
    jobId?: string;
    code?: string;
    at: number;
  };
  'media:cleanup': { deleted: number; skippedInUse: number; failed: number; at: number };
  'memory:extraction-candidate': ExtractionTurnCompletion;
  'instance:profile': {
    instanceId: string;
    accountId: string;
    state: 'ready' | 'missing';
    at: number;
    revision?: string;
    roleCard?: ProfileSummary['roleCard'];
    plugins?: ProfileSummary['plugins'];
    sessionEpoch?: number;
    hostEpoch?: number;
    profileFingerprint?: string;
    error?: string;
  };
}
