import type { ResolvedProfile, ResolvedRoleCard } from '../artifacts/types.js';
import type { ConfigLayer } from '../config/layered.js';
import type { Logger } from '../core/logger.js';
import type { InboundMessageEvent } from '../channels/events.js';
import type { ConversationRef } from '../routing/identity.js';
import type { OutboundMessage } from '../routing/message.js';
import type { StoredMessage } from '../storage/contract.js';
import type { MemorySnapshot } from '../memory/types.js';

export interface AgentSessionContext {
  readonly instanceId: string;
  readonly accountId?: string;
  readonly profile?: ResolvedProfile;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly sessionEpoch: number;
  readonly hostEpoch: number;
  readonly profileFingerprint?: string;
  state(pluginId: string): AgentPluginState;
}

export interface AgentSendOptions {
  idempotencyKey?: string;
  operationId?: string;
}

export interface AgentTurnOutcome {
  outcome: 'sent' | 'suppressed' | 'failed';
  replyText?: string;
  errorCode?: string;
}

export interface AgentHistoryOptions {
  limit?: number;
  beforeSeq?: number;
}

/** 每个插件只能读写自己的命名空间；实现由宿主注入。 */
export interface AgentPluginState {
  read<T = Record<string, unknown>>(): Promise<T>;
  write(value: Record<string, unknown>): Promise<void>;
}

export interface AgentMessageContext extends AgentSessionContext {
  /** Per-message role snapshot; the session-level profile intentionally has no default role card. */
  readonly profile?: ResolvedProfile & { roleCard?: ResolvedRoleCard };
  readonly conversation: ConversationRef;
  /** Explicit card resolved for this account/kind/peer binding. Account profile cards are not fallbacks. */
  readonly roleBinding?: {
    revision: string;
    /** Role + resolved card identity; scopes plugin state and tool invocation keys. */
    contextEpoch?: string;
    card: ResolvedRoleCard;
    worldbook?: import('../worldbook/types.js').WorldbookOptions;
    worldbookSnapshot?: { book?: import('../worldbook/types.js').Worldbook };
  };
  /** Read-only memory captured from the same history epoch as the role; absent when no memory resolver is wired. */
  readonly memory?: MemorySnapshot;
  readonly voiceDeliverySupport: 'supported' | 'unsupported' | 'unknown';
  readonly message: InboundMessageEvent;
  readonly turnId: string;
  /** Stable host key for tool idempotency, derived from the inbound message id or persisted seq. */
  readonly invocationMessageId?: string;
  /** 当前入站消息在会话中的 seq；历史读取应排除当前输入，避免重复。 */
  readonly sequence?: number;
  /** 会话级取消信号，不受单 turn 超时影响；异步媒体任务用它。 */
  readonly sessionSignal: AbortSignal;
  /** True only while this turn's explicit role binding and captured memory guard still match. */
  isRoleBindingCurrent(): Promise<boolean>;
  /** Current role/memory and effective extension snapshot, when an extension snapshot is installed. */
  isTurnCurrent?(): Promise<boolean>;
  /** Installed by the Agent after it captures the effective extension snapshot. */
  setExtensionGuard?(guard: () => boolean | Promise<boolean>): void;
  /** Installed by the Agent; invoked only after the Instance learns the real final send outcome. */
  setAfterTurnHandler?(handler: (outcome: AgentTurnOutcome) => void | Promise<void>): void;
  /**
   * Marks this turn as a pure-text completion candidate. The instance notifies MEM03 only after the
   * final reply is sent and persisted; calling it does not itself trigger extraction or a model call.
   */
  markExtractable?(): void;
  send(message: OutboundMessage, options?: AgentSendOptions): Promise<{ messageId?: string; duplicate?: boolean }>;
  /** 异步任务完成后的受代际保护的延迟发送；不会绕过 QqInstance.send。 */
  deliver(message: OutboundMessage, options?: AgentSendOptions): Promise<{ messageId?: string; duplicate?: boolean }>;
  /** 把回包任务重新排回原会话链；用于媒体任务完成事件，保证同会话顺序。 */
  enqueueConversation(task: () => Promise<void>): Promise<void>;
  resolveConfig(): ConfigLayer;
  history(options?: AgentHistoryOptions): Promise<StoredMessage[]>;
  state(pluginId: string): AgentPluginState;
}

export interface AgentHostFactoryInput {
  instanceId: string;
  accountId: string;
  profile: ResolvedProfile;
  logger: Logger;
  signal: AbortSignal;
  sessionEpoch: number;
  hostEpoch: number;
  profileFingerprint: string;
}

export type AgentHostFactory = (input: AgentHostFactoryInput) => AgentHost | undefined | Promise<AgentHost | undefined>;

/**
 * 功能层的唯一入口。宿主拿不到 bus、store、backend、token；
 * 只能通过 ctx.send 发消息，通过 resolveConfig 读取行为配置，
 * 通过 profile/history/state 读取已解析档案、会话历史和本插件状态。
 */
export interface AgentHost {
  onSessionStart?(context: AgentSessionContext): void | Promise<void>;
  onSessionStop?(context: AgentSessionContext): void | Promise<void>;
  onMessage(context: AgentMessageContext, event: InboundMessageEvent): void | OutboundMessage | Promise<void | OutboundMessage>;
  dispose?(): void | Promise<void>;
}
