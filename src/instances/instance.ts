import {
  AccompanyError,
  BackendError,
  IsolationError,
  InvalidSpecError,
  InvalidStateTransitionError,
  ProfileNotReadyError,
  errorRetryable
} from '../core/errors.js';
import { AbortScope } from '../core/abort.js';
import { sleep, withTimeout } from '../core/concurrency.js';
import type { Metrics } from '../core/metrics.js';
import { isLoopbackHost } from '../core/net.js';
import type { TypedEventBus } from '../core/bus.js';
import type { CoreEvents } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { InstanceStateMachine } from '../core/state.js';
import { DEFAULT_LIMITS, type Limits } from '../core/limits.js';
import type { ConfigLayer, ScopeContext } from '../config/layered.js';
import type { InjectionBackend, RuntimeEndpoints } from '../injection/contract.js';
import type { OutboundChannel } from '../channels/contract.js';
import type { InboundEvent, InboundMessageEvent } from '../channels/events.js';
import type { MessageStore, StoredMessage } from '../storage/contract.js';
import { summarizeProfile, type ResolvedProfile } from '../artifacts/types.js';
import type { ResolvedConversationRoleBinding } from '../profiles/role-bindings.js';
import type { AgentHost, AgentMessageContext, AgentPluginState, AgentSessionContext } from '../host/contract.js';
import type { PluginStateStore } from '../host/state.js';
import { LoopbackGuard } from '../routing/loopback.js';
import { conversationKey, type ConversationRef } from '../routing/identity.js';
import type { MessageSegment, OutboundMessage } from '../routing/message.js';
import type { InstanceSpec, InstanceStatus, NormalizedInstanceSpec } from './spec.js';
import { ConversationQueues } from '../work/conversation-queues.js';
import { TokenBucket } from '../work/rate-limiter.js';

export interface ChannelHandlers {
  onEvent: (event: InboundEvent) => void;
  onStatus: (status: { connected: boolean; selfId?: string }) => void;
}

export type InstanceChannelFactory = (
  endpoints: RuntimeEndpoints,
  handlers: ChannelHandlers,
  signal?: AbortSignal
) => OutboundChannel;

export interface SendOptions {
  idempotencyKey?: string;
  operationId?: string;
}

export interface SendResult {
  messageId?: string;
  seq?: number;
  duplicate?: boolean;
}

export interface QqInstanceOptions {
  spec: NormalizedInstanceSpec;
  backend: InjectionBackend;
  createChannel: InstanceChannelFactory;
  /** 身份确定后才解析存储；同一账号重复调用应返回同一个 store。 */
  resolveStore: (accountId: string) => MessageStore;
  bus: TypedEventBus<CoreEvents>;
  logger: Logger;
  limits?: Limits;
  metrics?: Metrics;
  now?: () => number;
  recordId?: () => string;
  /** 旧的单宿主入口，仅供直接构造或轻量部署使用。 */
  host?: AgentHost;
  /** 公共暂停闸门：所有宿主的自动回复与自动发送都必须先经过它；人工发送不经过。 */
  automaticReplyAllowed?: (accountId: string, conversation: ConversationRef) => boolean | Promise<boolean>;
  /** Resolves an explicit per-conversation role. Core-backed instances fail closed when it is absent. */
  resolveConversationRole?: (accountId: string, conversation: ConversationRef) => Promise<ResolvedConversationRoleBinding | undefined>;
  /** 按账号组装宿主；与 profile 一起用于热部署和每账号隔离。 */
  createHost?: (input: {
    instanceId: string;
    accountId: string;
    profile: ResolvedProfile;
    logger: Logger;
    signal: AbortSignal;
    sessionEpoch: number;
    hostEpoch: number;
    profileFingerprint: string;
  }) => AgentHost | undefined | Promise<AgentHost | undefined>;
  /** 行为配置指纹：provider/policy 改变时由 Core 注入；默认使用 profile.revision。 */
  profileFingerprint?: (profile: ResolvedProfile) => string;
  /** 状态页展示的回复者与配置可用性。 */
  agentStatus?: (profile: ResolvedProfile) => { mode: 'agent' | 'plugins' | 'custom'; configured: boolean };
  /** 角色卡/插件档案解析；不设置时不做 profile 门禁（直接构造场景）。 */
  resolveProfile?: (accountId: string) => Promise<ResolvedProfile>;
  stateFor?: (accountId: string) => PluginStateStore;
  configResolver?: (scope: ScopeContext) => ConfigLayer;
  claimAccount?: (accountId: string) => void;
  releaseAccount?: (accountId: string) => void;
  runtimeKey?: string;
}

interface CachedSend {
  at: number;
  promise: Promise<SendResult>;
}

interface HostEntry {
  host: AgentHost;
  owned: boolean;
  profile?: ResolvedProfile;
  context: AgentSessionContext;
  active: number;
  retired: boolean;
  sessionStarted: boolean;
  epoch: number;
  fingerprint: string;
}

const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const IDEMPOTENCY_MAX = 1_000;

/**
 * 一个 AccountSession = 一个 QQ 号 × 一条通道 × 一份存储命名空间。
 * 生命周期、身份、回环、队列、限流、宿主回调都归它所有；跨实例共享的东西必须显式传入。
 */
export class QqInstance {
  readonly spec: NormalizedInstanceSpec;
  readonly state: InstanceStateMachine;
  readonly runtimeKey: string;

  readonly #backend: InjectionBackend;
  readonly #createChannel: InstanceChannelFactory;
  readonly #resolveStore: (accountId: string) => MessageStore;
  readonly #bus: TypedEventBus<CoreEvents>;
  readonly #logger: Logger;
  readonly #limits: Limits;
  readonly #metrics?: Metrics;
  readonly #now: () => number;
  readonly #recordId: () => string;
  readonly #legacyHost?: AgentHost;
  readonly #createHost?: QqInstanceOptions['createHost'];
  readonly #automaticReplyAllowed?: QqInstanceOptions['automaticReplyAllowed'];
  readonly #resolveConversationRole?: QqInstanceOptions['resolveConversationRole'];
  readonly #fingerprintFor?: QqInstanceOptions['profileFingerprint'];
  readonly #agentStatusFor?: QqInstanceOptions['agentStatus'];
  readonly #resolveProfile?: QqInstanceOptions['resolveProfile'];
  readonly #stateFor?: QqInstanceOptions['stateFor'];
  readonly #ephemeralState = new Map<string, Record<string, unknown>>();
  readonly #configResolver?: (scope: ScopeContext) => ConfigLayer;
  readonly #claimAccount?: (accountId: string) => void;
  readonly #releaseAccount?: (accountId: string) => void;
  readonly #configuredAccountId: string | undefined;
  readonly #loopback = new LoopbackGuard();
  readonly #ingress: ConversationQueues;
  readonly #egress: ConversationQueues;
  readonly #rate: TokenBucket;
  readonly #idempotency = new Map<string, CachedSend>();

  #channel: OutboundChannel | undefined;
  #endpoints: RuntimeEndpoints | undefined;
  #store: MessageStore | undefined;
  #accountId: string | undefined;
  #desiredState: 'running' | 'stopped' = 'running';
  #restartAttempts = 0;
  #lastError: { code: string; message: string; at: number; retryable: boolean } | undefined;
  #scope: AbortScope | undefined;
  #generation = 0;
  #teardownPromise: Promise<void> | undefined;
  #healthFailures = 0;
  #healthCheckInFlight = false;
  #pausedForBackpressure = false;
  #profileBlocked = false;
  #pluginState: PluginStateStore | undefined;
  #stateRevision: string | undefined;
  #profile: ResolvedProfile | undefined;
  #profileState: 'idle' | 'loading' | 'ready' | 'missing' = 'idle';
  #profileError: string | undefined;
  #hostEntry: HostEntry | undefined;
  #readiness: Promise<void> | undefined;
  #sessionEpoch = 0;
  #hostEpoch = 0;
  #profileFingerprint: string | undefined;
  #agentStatus: { mode: 'agent' | 'plugins' | 'custom'; configured: boolean } | undefined;

  constructor(options: QqInstanceOptions) {
    this.spec = options.spec;
    this.#backend = options.backend;
    this.#createChannel = options.createChannel;
    this.#resolveStore = options.resolveStore;
    this.#bus = options.bus;
    this.#logger = options.logger;
    this.#limits = options.limits ?? DEFAULT_LIMITS;
    this.#metrics = options.metrics;
    this.#now = options.now ?? Date.now;
    this.#recordId = options.recordId ?? (() => crypto.randomUUID());
    this.#legacyHost = options.host;
    this.#createHost = options.createHost;
    this.#automaticReplyAllowed = options.automaticReplyAllowed;
    this.#resolveConversationRole = options.resolveConversationRole;
    this.#fingerprintFor = options.profileFingerprint;
    this.#agentStatusFor = options.agentStatus;
    this.#resolveProfile = options.resolveProfile;
    this.#stateFor = options.stateFor;
    this.#configResolver = options.configResolver;
    this.#claimAccount = options.claimAccount;
    this.#releaseAccount = options.releaseAccount;
    this.runtimeKey = options.runtimeKey ?? `fake:${options.spec.id}`;
    this.#configuredAccountId = options.spec.accountId;
    for (const selfId of options.spec.selfIds) this.#loopback.add(selfId);
    if (this.#configuredAccountId) this.#loopback.add(this.#configuredAccountId);

    this.#ingress = new ConversationQueues({
      maxPending: this.#limits.maxIngressQueue,
      maxPerConversation: this.#limits.maxConversationQueue,
      onHighWater: () => this.#pauseIngress(),
      onLowWater: () => this.#resumeIngress(),
      onOverflow: () => this.#inc('ingress.overflow')
    });
    this.#egress = new ConversationQueues({
      maxPending: this.#limits.maxIngressQueue,
      maxPerConversation: this.#limits.maxConversationQueue
    });
    this.#rate = new TokenBucket(this.#limits.sendRatePerSecond, this.#limits.sendBurst, this.#now);

    this.state = new InstanceStateMachine('stopped', (from, to) => {
      this.#logger.info('instance state', { from, to });
      this.#bus.emit('instance:state', { instanceId: this.spec.id, from, to, at: this.#now() });
      this.#inc('instance.state.transitions', 1, { from, to });
      this.#gauge('instance.online', to === 'online' ? 1 : 0);
      if (to === 'online') this.#restartAttempts = 0;
      if (to === 'stopped' || to === 'failed') {
        void this.#retireCurrentHost();
      }
    });
  }

  get id(): string {
    return this.spec.id;
  }

  get accountId(): string | undefined {
    return this.#accountId;
  }

  setDesiredState(state: 'running' | 'stopped'): void {
    this.#desiredState = state;
  }

  get desiredState(): 'running' | 'stopped' {
    return this.#desiredState;
  }

  async start(): Promise<void> {
    if (this.state.is('online', 'provisioning', 'starting', 'awaiting_login', 'degraded')) return;
    if (!this.state.is('stopped', 'failed')) {
      throw new InvalidStateTransitionError(this.state.state, 'provisioning');
    }
    if (this.#teardownPromise) await this.#teardownPromise.catch(() => {});
    this.#pausedForBackpressure = false;
    this.#gauge('instance.paused', 0);
    this.state.transition('provisioning');

    const scope = new AbortScope();
    this.#scope = scope;
    const generation = this.#generation + 1;
    this.#generation = generation;
    try {
      if (this.#configuredAccountId) this.#bindAccount(this.#configuredAccountId);
      scope.throwIfAborted();
      const endpoints = await this.#backend.start(this.#effectiveSpec(), scope.signal);
      this.#assertTrustedEndpoints(endpoints);
      if (generation !== this.#generation || scope.aborted) throw new AccompanyError('start_aborted', 'start was aborted');
      this.#endpoints = endpoints;
      this.state.transition('starting');
      const channel = this.#createChannel(
        endpoints,
        {
          onEvent: (event) => this.#onEvent(event, generation),
          onStatus: (status) => this.#onStatus(status, generation)
        },
        scope.signal
      );
      this.#channel = channel;
      await channel.connect();
      scope.throwIfAborted();
      if (generation !== this.#generation) throw new AccompanyError('start_aborted', 'start was superseded');
      const selfId = channel.selfId() ?? this.#accountId;
      if (selfId) {
        this.#adoptSelfId(selfId);
        await this.#ensureProfileReady(selfId, generation);
      } else {
        this.#markAwaitingLogin();
      }
      this.#healthFailures = 0;
      this.#inc('instance.start');
    } catch (error) {
      // 先进入 failed，让监督器仍能看到账号并查询按账号熔断；拆除在操作链内完成。
      if (generation === this.#generation) this.#fail(error);
      const teardownErrors = await this.#beginTeardown(scope);
      for (const teardownError of teardownErrors) {
        this.#logger.warn('teardown after start failure failed', {
          message: teardownError instanceof Error ? teardownError.message : String(teardownError)
        });
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state.is('stopped')) return;
    if (this.state.is('stopping')) {
      await this.#teardownPromise?.catch(() => {});
      return;
    }
    this.state.transition('stopping');
    this.#channel?.pause?.();
    await this.#drainQueues();
    await this.#retireCurrentHost();
    const scope = this.#scope;
    this.#scope = undefined;
    const errors = await this.#beginTeardown(scope);
    if (errors.length > 0) {
      const error = errors[0];
      this.#fail(error, true);
      throw error;
    }
    this.state.transition('stopped');
    this.#inc('instance.stop');
  }

  async send(conversation: ConversationRef, message: OutboundMessage, options: SendOptions = {}): Promise<SendResult> {
    return this.#send(conversation, message, options);
  }

  async #send(
    conversation: ConversationRef,
    message: OutboundMessage,
    options: SendOptions = {},
    contextEpoch?: string
  ): Promise<SendResult> {
    if (this.state.is('stopped', 'failed')) {
      throw new AccompanyError('not_connected', `instance ${this.id} is not running`);
    }
    const account = this.#accountId;
    const store = this.#store;
    if (!account || !store) throw new IsolationError(`instance ${this.id}: account unknown, refusing to send`);
    if (conversation.accountId !== account) {
      throw new IsolationError(`instance ${this.id} owns account ${account}, refusing to send as ${conversation.accountId}`);
    }
    this.#assertMessageSize(message);
    const channel = this.#channel;
    if (!channel || !channel.isConnected()) {
      throw new AccompanyError('not_connected', `instance ${this.id} is not connected`);
    }
    const generation = this.#generation;

    const idempotencyKey = options.idempotencyKey;
    if (idempotencyKey) {
      const cached = this.#idempotency.get(idempotencyKey);
      if (cached && this.#now() - cached.at <= IDEMPOTENCY_TTL_MS) {
        const result = await cached.promise;
        return { ...result, duplicate: true };
      }
      if (cached) this.#idempotency.delete(idempotencyKey);
    }

    const task = this.#egress.enqueue(conversationKey(conversation), async () => {
      if (generation !== this.#generation) {
        throw new AccompanyError('not_connected', `instance ${this.id} session changed before send`);
      }
      await this.#rate.acquire(this.#scope?.signal);
      const activeChannel = this.#channel;
      if (!activeChannel || !activeChannel.isConnected()) {
        throw new AccompanyError('not_connected', `instance ${this.id} is not connected`);
      }
      if (contextEpoch && !(await this.#automaticAllowed(account, conversation, contextEpoch))) {
        throw new IsolationError(`instance ${this.id}: role binding changed before queued delivery`);
      }
      const result = await activeChannel.send(conversation, message);
      const now = this.#now();
      let seq: number | undefined;
      try {
        const appended = await store.append(conversation, {
          id: this.#recordId(),
          at: now,
          direction: 'out',
          ...(contextEpoch ? { contextEpoch } : {}),
          segments: compactSegmentsForStorage(message.segments),
          ...(result.messageId ? { messageId: result.messageId } : {}),
          meta: {
            ...(idempotencyKey ? { idempotencyKey } : {}),
            ...(options.operationId ? { operationId: options.operationId } : {})
          }
        });
        seq = appended.seq;
      } catch (error) {
        // 消息已经发出，存储失败不能反过来让调用方重试造成重复发送。
        this.#reportError('persist_failed', error, true);
        this.#inc('outbound.persist_failed');
      }
      this.#bus.emit('channel:outbound', {
        instanceId: this.id,
        conversation,
        ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
        ...(seq !== undefined ? { seq } : {}),
        ...(options.operationId ? { operationId: options.operationId } : {}),
        at: now
      });
      this.#inc('outbound.sent');
      this.#gauge('egress.pending', this.#egress.pending);
      return { messageId: result.messageId, ...(seq !== undefined ? { seq } : {}) } satisfies SendResult;
    });

    if (idempotencyKey) {
      this.#idempotency.set(idempotencyKey, { at: this.#now(), promise: task });
      task.catch(() => this.#idempotency.delete(idempotencyKey));
      this.#trimIdempotency();
    }
    return task;
  }

  /** 后端/健康检查发现运行时崩溃时调用。 */
  handleExternalFailure(error: unknown): void {
    if (!this.state.is('online', 'degraded', 'awaiting_login', 'starting', 'provisioning')) return;
    this.#inc('instance.external_failure');
    this.#fail(error);
    const scope = this.#scope;
    this.#scope = undefined;
    void this.#beginTeardown(scope);
  }

  async checkHealth(): Promise<void> {
    if (this.#healthCheckInFlight) return;
    if (!this.state.is('online', 'degraded', 'awaiting_login')) return;
    const generation = this.#generation;
    this.#healthCheckInFlight = true;
    try {
      if (!this.#channel?.isConnected()) {
        this.#failHealthCheck(new BackendError('channel_unhealthy', `channel for ${this.id} is not connected`));
        return;
      }
      const status = await this.#backend.status(this.#effectiveSpec());
      if (generation !== this.#generation) return;
      if (!this.state.is('online', 'degraded', 'awaiting_login')) return;
      if (status.running) {
        this.#healthFailures = 0;
        return;
      }
      this.#failHealthCheck(
        new BackendError('runtime_unhealthy', `runtime for ${this.id} reported not running ${this.#healthFailures + 1} times`)
      );
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#failHealthCheck(error);
    } finally {
      this.#healthCheckInFlight = false;
    }
  }

  #failHealthCheck(error: unknown): void {
    this.#healthFailures += 1;
    this.#inc('instance.health_failures');
    if (this.#healthFailures >= this.#limits.unhealthyThreshold) this.handleExternalFailure(error);
  }

  /** 立即取消在途 start/connect，让排队中的 stop 不必等超时；已上线会话先走排空。 */
  requestStop(): void {
    if (!this.state.is('provisioning', 'starting', 'awaiting_login')) return;
    this.#scope?.abort(new AccompanyError('stop_requested', `stop requested for ${this.id}`));
  }

  setRestartAttempts(attempts: number): void {
    this.#restartAttempts = attempts;
  }

  status(): InstanceStatus {
    return {
      id: this.id,
      ...(this.#accountId !== undefined ? { accountId: this.#accountId } : {}),
      backend: this.spec.backend,
      runtimeKey: this.runtimeKey,
      desiredState: this.#desiredState,
      state: this.state.state,
      selfIds: [...(this.#accountId ? [this.#accountId] : []), ...this.spec.selfIds].filter(
        (value, index, all) => all.indexOf(value) === index
      ),
      connected: this.#channel?.isConnected() ?? false,
      ...(this.#endpoints
        ? {
            endpoints: {
              httpBaseUrl: this.#endpoints.httpBaseUrl,
              wsUrl: this.#endpoints.wsUrl
            }
          }
        : {}),
      ingress: { pending: this.#ingress.pending, paused: this.#pausedForBackpressure },
      egress: { pending: this.#egress.pending },
      restartAttempts: this.#restartAttempts,
      sessionEpoch: this.#sessionEpoch,
      hostEpoch: this.#hostEpoch,
      ...(this.#profileFingerprint ? { profileFingerprint: this.#profileFingerprint } : {}),
      ...(this.#agentStatus ? { agent: this.#agentStatus } : {}),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      ...(this.#resolveProfile ? { profileState: this.#profileState } : {}),
      ...(this.#profile ? { profile: summarizeProfile(this.#profile) } : {}),
      ...(this.#profileError ? { profileError: this.#profileError } : {})
    };
  }

  #onEvent(event: InboundEvent, generation: number): void {
    if (generation !== this.#generation || this.#scope?.aborted || this.state.is('stopping', 'stopped', 'failed')) return;
    if (event.type !== 'message') {
      if (event.selfId && this.#loopback.size > 0 && !this.#loopback.has(event.selfId)) {
        this.#reportError('event_misattributed', `event self_id ${event.selfId} does not belong to ${this.id}`, false);
        return;
      }
      this.#bus.emit('channel:inbound', { instanceId: this.id, event, at: this.#now() });
      return;
    }
    const verdict = this.#loopback.classify({
      postType: event.selfEcho ? 'message_sent' : 'message',
      ...(event.selfId ? { selfId: event.selfId } : {}),
      senderId: event.senderId
    });
    if (verdict === 'self') {
      this.#logger.debug('dropped self message', { kind: event.kind, peerId: event.peerId });
      this.#inc('inbound.self_echo');
      return;
    }
    if (verdict === 'misattributed') {
      this.#reportError('event_misattributed', `event self_id ${event.selfId} does not belong to ${this.id}`, false);
      return;
    }
    try {
      if (event.selfId) this.#adoptSelfId(event.selfId);
    } catch (error) {
      this.#failAndTeardown(error);
      return;
    }
    const account = this.#accountId ?? this.spec.accountId;
    if (!account) {
      this.#reportError('account_unknown', `cannot attribute message for instance ${this.id}`, false);
      return;
    }
    const conversation: ConversationRef = { accountId: account, kind: event.kind, peerId: event.peerId };
    const accepted = this.#ingress.tryEnqueue(conversationKey(conversation), async () => {
      await this.#handleInbound(conversation, event, generation);
    });
    this.#gauge('ingress.pending', this.#ingress.pending);
    if (!accepted) {
      this.#inc('inbound.dropped');
      if (!this.#pausedForBackpressure) {
        this.#pauseIngress();
        this.#reportError('ingress_overflow', `inbound queue for ${this.id} is full; channel paused`, false);
      }
    }
  }

  async #handleInbound(conversation: ConversationRef, event: InboundMessageEvent, generation: number): Promise<void> {
    const store = this.#store;
    if (!store) {
      this.#reportError('account_unknown', `cannot attribute message for instance ${this.id}`, false);
      return;
    }
    if (generation !== this.#generation || this.#scope?.aborted || this.state.is('stopped', 'failed')) return;
    let roleBinding: ResolvedConversationRoleBinding | undefined;
    try {
      roleBinding = await this.#resolveConversationRole?.(conversation.accountId, conversation);
    } catch (error) {
      this.#logger.warn('conversation role binding lookup failed; automatic reply suppressed', {
        accountId: conversation.accountId,
        kind: conversation.kind,
        peerId: conversation.peerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    let seq: number | undefined;
    try {
      const appended = await store.append(conversation, {
        id: this.#recordId(),
        at: event.at,
        direction: 'in',
        ...(roleBinding ? { contextEpoch: roleBinding.revision } : {}),
        senderId: event.senderId,
        ...(event.messageId ? { messageId: event.messageId } : {}),
        segments: event.segments
      });
      if (appended.duplicate) {
        this.#inc('inbound.duplicate');
        return;
      }
      seq = appended.seq;
      this.#inc('inbound.persisted');
    } catch (error) {
      this.#reportError('persist_failed', error, true);
      this.#inc('inbound.persist_failed');
    }
    if (generation !== this.#generation || this.state.is('stopped', 'failed') || this.#scope?.aborted) return;
    this.#bus.emit('channel:inbound', {
      instanceId: this.id,
      event,
      at: this.#now(),
      ...(seq !== undefined ? { seq } : {})
    });
    await this.#dispatchHost(conversation, event, seq, roleBinding);
    this.#gauge('ingress.pending', this.#ingress.pending);
  }

  async #dispatchHost(
    conversation: ConversationRef,
    event: InboundMessageEvent,
    seq?: number,
    capturedRoleBinding?: ResolvedConversationRoleBinding
  ): Promise<void> {
    const entry = this.#hostEntry;
    const scope = this.#scope;
    if (!entry || !scope) return;
    const account = this.#accountId ?? this.spec.accountId;
    if (!account) return;
    const roleBinding = capturedRoleBinding;
    if (this.#resolveConversationRole && !roleBinding) {
      this.#inc('auto_reply.suppressed');
      return;
    }
    if (!(await this.#automaticAllowed(account, conversation, roleBinding?.revision))) {
      this.#inc('auto_reply.suppressed');
      return;
    }
    const generation = this.#generation;
    const sessionEpoch = this.#sessionEpoch;
    const turnId = `turn-${this.#recordId()}`;

    entry.active += 1;
    const timeoutError = new AccompanyError('host_timeout', `host timed out after ${this.#limits.hostTimeoutMs}ms`);
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(timeoutError), this.#limits.hostTimeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([scope.signal, timeoutController.signal]);
    const context: AgentMessageContext = {
      instanceId: this.id,
      accountId: account,
      ...(entry.profile
        ? {
            profile: roleBinding
              ? { ...entry.profile, roleCard: roleBinding.card }
              : entry.profile
          }
        : {}),
      ...(roleBinding ? { roleBinding: { revision: roleBinding.revision, card: roleBinding.card } } : {}),
      conversation,
      voiceDeliverySupport: this.#channel?.voiceDeliverySupport?.() ?? 'unknown',
      message: event,
      turnId,
      ...(seq !== undefined ? { sequence: seq } : {}),
      sessionSignal: scope.signal,
      isRoleBindingCurrent: () => this.#automaticAllowed(account, conversation, roleBinding?.revision),
      sessionEpoch: entry.context.sessionEpoch,
      hostEpoch: entry.epoch,
      ...(entry.fingerprint ? { profileFingerprint: entry.fingerprint } : {}),
      logger: this.#logger.child('host'),
      signal,
      send: async (message, options) => {
        if (signal.aborted) {
          throw signal.reason instanceof Error ? signal.reason : timeoutError;
        }
        if (!(await this.#automaticAllowed(account, conversation, roleBinding?.revision))) {
          this.#inc('auto_reply.suppressed');
          return Promise.resolve({ duplicate: true });
        }
        return this.#send(conversation, message, options, roleBinding?.revision);
      },
      deliver: (message, options) =>
        this.#deliver(conversation, message, options, generation, sessionEpoch, roleBinding?.revision),
      enqueueConversation: (task) => this.#enqueueConversation(conversation, task, generation, sessionEpoch, scope.signal),
      resolveConfig: () => this.#resolveConfig(conversation),
      history: (options) => this.#readHistory(conversation, options, roleBinding?.revision),
      state: (pluginId) =>
        this.#stateAccessor(pluginId, {
          revision: entry.profile?.revision,
          hostEpoch: entry.epoch,
          sessionEpoch: entry.context.sessionEpoch
        })
    };
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : timeoutError);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const reply = await Promise.race([Promise.resolve(entry.host.onMessage(context, event)), aborted]);
      if (!reply) return;
      if (scope.aborted || signal.aborted) return;
      if (!(await this.#automaticAllowed(account, conversation, roleBinding?.revision))) {
        this.#inc('auto_reply.suppressed');
        return;
      }
      const key = event.messageId ? `reply:${event.messageId}` : seq !== undefined ? `reply:${seq}` : undefined;
      await this.#send(conversation, reply, {
        ...(key ? { idempotencyKey: key, operationId: key } : {})
      }, roleBinding?.revision);
    } catch (error) {
      const code = error instanceof AccompanyError && error.code === 'host_timeout' ? 'host_timeout' : 'host_failed';
      this.#reportError(code, error, false);
      this.#inc('host.failed');
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      entry.active = Math.max(0, entry.active - 1);
    }
  }

  async #deliver(
    conversation: ConversationRef,
    message: OutboundMessage,
    options: SendOptions | undefined,
    generation: number,
    sessionEpoch: number,
    roleBindingRevision?: string
  ): Promise<SendResult> {
    if (
      generation !== this.#generation ||
      sessionEpoch !== this.#sessionEpoch ||
      this.#scope?.aborted ||
      !this.state.is('online', 'degraded')
    ) {
      throw new IsolationError(
        `instance ${this.id}: refusing stale delivery from session ${sessionEpoch} (current ${this.#sessionEpoch})`
      );
    }
    const account = this.#accountId;
    if (!account || conversation.accountId !== account) {
      throw new IsolationError(`instance ${this.id}: delivery conversation does not belong to ${account ?? 'unknown'}`);
    }
    if (!(await this.#automaticAllowed(account, conversation, roleBindingRevision))) {
      this.#inc('auto_reply.suppressed');
      throw new AccompanyError('auto_reply_paused', 'automatic replies are paused in this scope');
    }
    return this.#send(conversation, message, options, roleBindingRevision);
  }

  async #automaticAllowed(
    accountId: string,
    conversation: ConversationRef,
    expectedRoleRevision?: string
  ): Promise<boolean> {
    try {
      if (this.#automaticReplyAllowed && !(await this.#automaticReplyAllowed(accountId, conversation))) return false;
      if (!this.#resolveConversationRole) return true;
      const current = await this.#resolveConversationRole(accountId, conversation);
      return Boolean(current && (expectedRoleRevision === undefined || current.revision === expectedRoleRevision));
    } catch (error) {
      this.#logger.warn('automatic reply policy check failed; failing closed', {
        accountId,
        message: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  /** 只能在 turn 结束后调用；若在 turn 内调用会和当前 ingress 链互相等待。 */
  async #enqueueConversation(
    conversation: ConversationRef,
    task: () => Promise<void>,
    generation: number,
    sessionEpoch: number,
    sessionSignal: AbortSignal
  ): Promise<void> {
    await this.#ingress.enqueue(conversationKey(conversation), async () => {
      if (
        generation !== this.#generation ||
        sessionEpoch !== this.#sessionEpoch ||
        sessionSignal.aborted ||
        this.state.is('stopping', 'stopped', 'failed')
      ) {
        throw new IsolationError(
          `instance ${this.id}: refusing stale conversation follow-up from session ${sessionEpoch}`
        );
      }
      await task();
    });
  }

  async #readHistory(
    conversation: ConversationRef,
    options?: { limit?: number; beforeSeq?: number },
    contextEpoch?: string
  ): Promise<StoredMessage[]> {
    const store = this.#store;
    if (!store) return [];
    const requested = options?.limit ?? this.#limits.maxHostHistory;
    const limit = Math.max(0, Math.min(requested, this.#limits.maxHostHistory));
    return store.read(conversation, {
      limit,
      ...(contextEpoch ? { contextEpoch } : {}),
      ...(options?.beforeSeq !== undefined ? { beforeSeq: options.beforeSeq } : {})
    });
  }

  #stateAccessor(
    pluginId: string,
    guard?: { revision?: string; hostEpoch?: number; sessionEpoch?: number }
  ): AgentPluginState {
    const store = this.#pluginState;
    const stale = (): boolean => {
      if (guard?.revision !== undefined && guard.revision !== this.#stateRevision) return true;
      if (guard?.hostEpoch !== undefined && guard.hostEpoch !== this.#hostEpoch) return true;
      if (guard?.sessionEpoch !== undefined && guard.sessionEpoch !== this.#sessionEpoch) return true;
      return false;
    };
    if (store) {
      return {
        read: <T>() => store.read(pluginId) as unknown as Promise<T>,
        write: async (value) => {
          if (stale()) {
            this.#inc('plugin_state.stale_write');
            return;
          }
          await store.write(pluginId, value);
        }
      };
    }
    return {
      read: async <T>() => (this.#ephemeralState.get(pluginId) ?? {}) as T,
      write: async (value) => {
        if (stale()) {
          this.#inc('plugin_state.stale_write');
          return;
        }
        this.#ephemeralState.set(pluginId, value);
      }
    };
  }

  #onStatus(status: { connected: boolean; selfId?: string }, generation: number): void {
    if (generation !== this.#generation || this.#scope?.aborted || this.state.is('stopping', 'stopped', 'failed')) return;
    if (status.selfId) {
      try {
        this.#adoptSelfId(status.selfId);
      } catch (error) {
        this.#failAndTeardown(error);
        return;
      }
    }
    this.#bus.emit('channel:status', {
      instanceId: this.id,
      connected: status.connected,
      ...(this.#accountId ? { selfId: this.#accountId } : {}),
      at: this.#now()
    });
    if (!status.connected) {
      if (this.state.is('online')) this.state.transition('degraded');
      return;
    }
    const account = this.#accountId;
    if (account) {
      void this.#ensureProfileReady(account, generation).catch((error: unknown) => this.#failAndTeardown(error));
    } else {
      this.#markAwaitingLogin();
    }
  }

  #adoptSelfId(selfId: string): void {
    this.#bindAccount(String(selfId));
  }

  #bindAccount(raw: string): void {
    const id = String(raw);
    if (this.#accountId) {
      if (this.#accountId !== id) {
        throw new IsolationError(`instance ${this.id} bound to ${this.#accountId} but channel reported ${id}`);
      }
      return;
    }
    if (this.#configuredAccountId && this.#configuredAccountId !== id) {
      throw new IsolationError(`instance ${this.id} configured for ${this.#configuredAccountId} but logged in as ${id}`);
    }
    try {
      this.#claimAccount?.(id);
      const store = this.#resolveStore(id);
      this.#store = store;
      this.#pluginState = this.#stateFor?.(id);
      this.#accountId = id;
      this.#sessionEpoch += 1;
      this.#hostEpoch = 0;
      this.#stateRevision = undefined;
      this.#profile = undefined;
      this.#profileFingerprint = undefined;
      this.#agentStatus = undefined;
      this.#profileState = 'idle';
      this.#profileError = undefined;
      this.#loopback.add(id);
      this.#idempotency.clear();
    } catch (error) {
      this.#store = undefined;
      this.#pluginState = undefined;
      this.#releaseAccount?.(id);
      throw error;
    }
  }

  #unbindAccount(): void {
    const account = this.#accountId;
    if (!account) return;
    // 先推进代际再清理：旧 host 的晚到结果不能再写状态或发送。
    this.#sessionEpoch += 1;
    this.#hostEpoch += 1;
    this.#accountId = undefined;
    this.#store = undefined;
    this.#pluginState = undefined;
    this.#stateRevision = undefined;
    this.#profile = undefined;
    this.#profileFingerprint = undefined;
    this.#agentStatus = undefined;
    this.#profileState = 'idle';
    this.#profileError = undefined;
    this.#profileBlocked = false;
    this.#ephemeralState.clear();
    this.#idempotency.clear();
    const entry = this.#hostEntry;
    this.#hostEntry = undefined;
    if (entry) void this.#retireEntry(entry, true);
    this.#releaseAccount?.(account);
    this.#loopback.clear();
    for (const selfId of this.spec.selfIds) this.#loopback.add(selfId);
    if (this.#configuredAccountId) this.#loopback.add(this.#configuredAccountId);
  }

  async #drainQueues(): Promise<void> {
    if (this.#ingress.pending === 0 && this.#egress.pending === 0) return;
    try {
      await withTimeout(
        Promise.all([this.#ingress.drain(), this.#egress.drain()]),
        this.#limits.drainTimeoutMs,
        `drain timed out after ${this.#limits.drainTimeoutMs}ms`
      );
    } catch (error) {
      const dropped = this.#ingress.pending + this.#egress.pending;
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn('instance drain timed out; pending work will be discarded', {
        instanceId: this.id,
        dropped,
        message
      });
      this.#inc('instance.drain_dropped', dropped);
      this.#bus.emit('instance:error', {
        instanceId: this.id,
        code: 'drain_timeout',
        message,
        retryable: true,
        at: this.#now()
      });
    }
  }

  get currentProfile(): ResolvedProfile | undefined {
    return this.#profile;
  }

  /** 只解析不切换；滚动部署先校验目标账号，失败时保留旧宿主。 */
  async validateProfile(): Promise<ResolvedProfile> {
    const account = this.#accountId;
    if (!account) throw new IsolationError(`instance ${this.id}: account unknown`);
    if (!this.#resolveProfile) throw new AccompanyError('profile_unsupported', `instance ${this.id} has no profile resolver`);
    return this.#resolveProfile(account);
  }

  /** 原子切换角色卡/插件快照；新宿主就绪后才替换旧宿主。 */
  async applyProfile(profile: ResolvedProfile): Promise<void> {
    const account = this.#accountId;
    if (!account || profile.accountId !== account) {
      throw new IsolationError(`instance ${this.id} cannot apply profile for ${profile.accountId}`);
    }
    if (!this.state.is('online', 'degraded', 'awaiting_profile')) {
      throw new AccompanyError('invalid_state', `instance ${this.id} is ${this.state.state}; cannot apply profile`);
    }
    if (this.#readiness) await this.#readiness.catch(() => {});
    const generation = this.#generation;
    await this.#runProfileTask(() => this.#applyResolvedProfile(profile, generation));
  }

  async reloadProfile(): Promise<ResolvedProfile> {
    const profile = await this.validateProfile();
    await this.applyProfile(profile);
    return profile;
  }

  async #ensureProfileReady(account: string, generation: number): Promise<void> {
    if (!this.#resolveProfile) {
      await this.#ensureLegacyHost(account, generation);
      return;
    }
    if (this.#profileState === 'ready') {
      this.#markOnline();
      return;
    }
    if (this.#profileState === 'missing') return;
    if (this.#readiness) return this.#readiness;
    await this.#runProfileTask(() => this.#prepareProfile(account, generation));
  }

  #runProfileTask(task: () => Promise<void>): Promise<void> {
    const previous = this.#readiness ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    this.#readiness = run;
    void run
      .finally(() => {
        if (this.#readiness === run) this.#readiness = undefined;
      })
      .catch(() => {});
    return run;
  }

  async #prepareProfile(account: string, generation: number): Promise<void> {
    this.#profileState = 'loading';
    let profile: ResolvedProfile;
    try {
      profile = await this.#resolveProfile!(account);
    } catch (error) {
      if (error instanceof ProfileNotReadyError || error instanceof InvalidSpecError) {
        if (generation !== this.#generation || this.#accountId !== account) return;
        await this.#enterAwaitingProfile(account, error.message);
        return;
      }
      throw error;
    }
    await this.#applyResolvedProfile(profile, generation);
  }

  async #applyResolvedProfile(profile: ResolvedProfile, generation: number): Promise<void> {
    if (generation !== this.#generation || this.#scope?.aborted || this.#accountId !== profile.accountId) return;
    const previousRevision = this.#stateRevision;
    this.#stateRevision = profile.revision;
    let entry: HostEntry | undefined;
    try {
      entry = await this.#startHost(profile);
    } catch (error) {
      this.#stateRevision = previousRevision;
      throw error;
    }
    if (generation !== this.#generation || this.#scope?.aborted || this.#accountId !== profile.accountId) {
      this.#stateRevision = undefined;
      if (entry) await this.#retireEntry(entry, true);
      return;
    }
    const previous = this.#hostEntry;
    this.#hostEntry = entry;
    this.#profile = profile;
    this.#profileFingerprint = entry?.fingerprint ?? this.#fingerprintFor?.(profile) ?? profile.revision;
    this.#agentStatus = this.#agentStatusFor?.(profile);
    this.#profileState = 'ready';
    this.#profileError = undefined;
    this.#profileBlocked = false;
    this.#resumeIngress();
    this.#emitProfile(profile.accountId, 'ready', profile);
    this.#inc('instance.profile_ready');
    this.#markOnline();
    if (previous) void this.#retireEntry(previous, false, this.#limits.hostDrainTimeoutMs);
  }

  async #startHost(profile: ResolvedProfile): Promise<HostEntry | undefined> {
    const signal = this.#scope?.signal ?? new AbortController().signal;
    const epoch = this.#hostEpoch + 1;
    this.#hostEpoch = epoch;
    const fingerprint = this.#fingerprintFor?.(profile) ?? profile.revision;
    let host: AgentHost | undefined;
    let owned = false;
    if (this.#createHost) {
      host = await this.#createHost({
        instanceId: this.id,
        accountId: profile.accountId,
        profile,
        logger: this.#logger.child('host'),
        signal,
        sessionEpoch: this.#sessionEpoch,
        hostEpoch: epoch,
        profileFingerprint: fingerprint
      });
      owned = true;
    } else {
      host = this.#legacyHost;
    }
    if (!host) return undefined;
    const context = this.#sessionContext(profile, epoch, fingerprint);
    const entry: HostEntry = {
      host,
      owned,
      profile,
      context,
      active: 0,
      retired: false,
      sessionStarted: false,
      epoch,
      fingerprint
    };
    try {
      await withTimeout(
        Promise.resolve(host.onSessionStart?.(context)),
        this.#limits.hostTimeoutMs,
        `host session start timed out after ${this.#limits.hostTimeoutMs}ms`
      );
      entry.sessionStarted = true;
      return entry;
    } catch (error) {
      if (owned) await Promise.resolve(host.dispose?.()).catch(() => {});
      throw error;
    }
  }

  async #ensureLegacyHost(account: string, generation: number): Promise<void> {
    if (!this.#legacyHost) {
      this.#profileState = 'ready';
      this.#markOnline();
      return;
    }
    if (this.#hostEntry) {
      this.#markOnline();
      return;
    }
    const epoch = this.#hostEpoch + 1;
    this.#hostEpoch = epoch;
    const fingerprint = 'legacy-v1';
    this.#profileFingerprint = fingerprint;
    this.#agentStatus = { mode: 'plugins', configured: true };
    const entry: HostEntry = {
      host: this.#legacyHost,
      owned: false,
      context: this.#sessionContext(undefined, epoch, fingerprint),
      active: 0,
      retired: false,
      sessionStarted: false,
      epoch,
      fingerprint
    };
    try {
      await withTimeout(
        Promise.resolve(entry.host.onSessionStart?.(entry.context)),
        this.#limits.hostTimeoutMs,
        `host session start timed out after ${this.#limits.hostTimeoutMs}ms`
      );
      entry.sessionStarted = true;
    } catch (error) {
      this.#reportError('host_start_failed', error, false);
    }
    if (generation !== this.#generation || this.#accountId !== account) {
      await this.#retireEntry(entry, true);
      return;
    }
    this.#hostEntry = entry;
    this.#profileState = 'ready';
    this.#markOnline();
  }

  async #enterAwaitingProfile(account: string, message: string): Promise<void> {
    this.#profile = undefined;
    this.#profileState = 'missing';
    this.#profileError = message;
    this.#profileBlocked = true;
    this.#stateRevision = undefined;
    this.#logger.warn('instance is waiting for a complete account profile', {
      instanceId: this.id,
      accountId: account,
      message
    });
    this.#inc('instance.profile_missing');
    this.#pauseIngress();
    const previous = this.#hostEntry;
    this.#hostEntry = undefined;
    if (previous) void this.#retireEntry(previous);
    if (this.state.is('starting', 'awaiting_login', 'online', 'degraded')) {
      this.state.transition('awaiting_profile');
    }
    this.#emitProfile(account, 'missing', undefined, message);
  }

  async #retireCurrentHost(): Promise<void> {
    const entry = this.#hostEntry;
    this.#hostEntry = undefined;
    if (entry) await this.#retireEntry(entry);
  }

  async #retireEntry(
    entry: HostEntry,
    force = false,
    waitMs = this.#limits.drainTimeoutMs
  ): Promise<void> {
    if (entry.retired) return;
    entry.retired = true;
    const deadline = this.#now() + (force ? 0 : waitMs);
    while (entry.active > 0 && this.#now() < deadline) await sleep(10);
    if (entry.sessionStarted) {
      try {
        await withTimeout(
          Promise.resolve(entry.host.onSessionStop?.(entry.context)),
          5_000,
          'host session stop timed out'
        );
      } catch (error) {
        this.#reportError('host_stop_failed', error, false);
      }
    }
    if (entry.owned) {
      try {
        await Promise.resolve(entry.host.dispose?.());
      } catch (error) {
        this.#reportError('host_dispose_failed', error, false);
      }
    }
  }

  #emitProfile(
    accountId: string,
    state: 'ready' | 'missing',
    profile?: ResolvedProfile,
    error?: string
  ): void {
    this.#bus.emit('instance:profile', {
      instanceId: this.id,
      accountId,
      state,
      at: this.#now(),
      sessionEpoch: this.#sessionEpoch,
      hostEpoch: this.#hostEpoch,
      ...(profile
        ? {
            revision: profile.revision,
            plugins: profile.plugins.map((plugin) => plugin.ref)
          }
        : {}),
      ...(this.#profileFingerprint ? { profileFingerprint: this.#profileFingerprint } : {}),
      ...(error ? { error } : {})
    });
  }

  #markOnline(): void {
    if (this.state.is('starting', 'awaiting_login', 'awaiting_profile', 'degraded')) {
      this.#healthFailures = 0;
      this.state.transition('online');
    }
  }

  #markAwaitingLogin(): void {
    if (this.state.is('starting')) this.state.transition('awaiting_login');
  }

  #failAndTeardown(error: unknown): void {
    this.#fail(error);
    const scope = this.#scope;
    this.#scope = undefined;
    void this.#beginTeardown(scope);
  }

  #fail(error: unknown, final = false): void {
    const code = error instanceof AccompanyError ? error.code : 'instance_failed';
    const message = error instanceof Error ? error.message : String(error);
    this.#reportError(code, message, errorRetryable(error));
    if (final) this.state.failFinal();
    else this.state.fail();
  }

  #reportError(code: string, error: unknown, retryable: boolean): void {
    const message = error instanceof Error ? error.message : String(error);
    const at = this.#now();
    this.#lastError = { code, message, at, retryable };
    this.#logger.warn('instance error', { code, message, retryable });
    this.#bus.emit('instance:error', { instanceId: this.id, code, message, retryable, at });
    this.#inc('instance.errors', 1, { code });
  }

  async #beginTeardown(scope: AbortScope | undefined): Promise<unknown[]> {
    const promise = this.#teardown(scope);
    this.#teardownPromise = promise.then(() => undefined);
    return promise;
  }

  async #teardown(scope: AbortScope | undefined): Promise<unknown[]> {
    const errors: unknown[] = [];
    const effectiveSpec = this.#effectiveSpec();
    const channel = this.#channel;
    this.#channel = undefined;
    this.#endpoints = undefined;
    scope?.abort(new AccompanyError('session_teardown', 'session teardown'));
    if (channel) {
      try {
        await channel.disconnect();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.#backend.stop(effectiveSpec);
    } catch (error) {
      errors.push(error);
    } finally {
      this.#unbindAccount();
    }
    return errors;
  }

  #effectiveSpec(): InstanceSpec {
    return this.#accountId ? { ...this.spec, accountId: this.#accountId } : this.spec;
  }

  #assertTrustedEndpoints(endpoints: RuntimeEndpoints): void {
    for (const [label, raw] of [
      ['http', endpoints.httpBaseUrl],
      ['ws', endpoints.wsUrl]
    ] as const) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new BackendError('invalid_endpoint', `${label} endpoint is not a valid URL: ${raw}`, { retryable: false });
      }
      if (url.protocol !== 'http:' && url.protocol !== 'ws:') {
        throw new BackendError('invalid_endpoint', `${label} endpoint must use http/ws: ${raw}`, { retryable: false });
      }
      if (!isLoopbackHost(url.hostname)) {
        throw new BackendError('endpoint_non_loopback', `${label} endpoint must be loopback: ${raw}`, {
          retryable: false
        });
      }
    }
  }

  #assertMessageSize(message: OutboundMessage): void {
    if (!Array.isArray(message.segments) || message.segments.length === 0) {
      throw new AccompanyError('empty_message', 'message must contain at least one segment');
    }
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(message.segments), 'utf8');
    } catch (error) {
      throw new AccompanyError('invalid_message', `message segments are not serializable: ${String(error)}`);
    }
    const hasImage = message.segments.some((segment) => segment.type === 'image');
    const hasVideo = message.segments.some((segment) => segment.type === 'video');
    const limit = hasVideo
      ? Math.max(this.#limits.maxMessageBytes, this.#limits.maxVideoBytes * 2)
      : hasImage
        ? Math.max(this.#limits.maxMessageBytes, this.#limits.maxImageBytes * 2)
        : this.#limits.maxMessageBytes;
    if (bytes > limit) {
      throw new AccompanyError(
        'message_too_large',
        `message is ${bytes} bytes, limit is ${limit}`
      );
    }
  }

  #resolveConfig(conversation: ConversationRef): ConfigLayer {
    const accountId = this.#accountId ?? this.spec.accountId;
    if (!accountId || !this.#configResolver) return {};
    return this.#configResolver({ accountId, kind: conversation.kind, peerId: conversation.peerId });
  }

  #pauseIngress(): void {
    if (this.#pausedForBackpressure) return;
    this.#pausedForBackpressure = true;
    this.#channel?.pause?.();
    this.#gauge('instance.paused', 1);
  }

  #resumeIngress(): void {
    if (!this.#pausedForBackpressure || this.#profileBlocked) return;
    this.#pausedForBackpressure = false;
    this.#channel?.resume?.();
    this.#gauge('instance.paused', 0);
  }

  #trimIdempotency(): void {
    if (this.#idempotency.size <= IDEMPOTENCY_MAX) return;
    const now = this.#now();
    for (const [key, cached] of this.#idempotency) {
      if (now - cached.at > IDEMPOTENCY_TTL_MS || this.#idempotency.size > IDEMPOTENCY_MAX) {
        this.#idempotency.delete(key);
      }
      if (this.#idempotency.size <= IDEMPOTENCY_MAX) break;
    }
  }

  #sessionContext(profile?: ResolvedProfile, hostEpoch?: number, fingerprint?: string): AgentSessionContext {
    const epoch = hostEpoch ?? this.#hostEpoch;
    return {
      instanceId: this.id,
      ...(this.#accountId ? { accountId: this.#accountId } : {}),
      ...(profile ? { profile } : {}),
      logger: this.#logger.child('host'),
      signal: this.#scope?.signal ?? new AbortController().signal,
      sessionEpoch: this.#sessionEpoch,
      hostEpoch: epoch,
      ...(fingerprint || this.#profileFingerprint
        ? { profileFingerprint: fingerprint ?? this.#profileFingerprint }
        : {}),
      state: (pluginId) =>
        this.#stateAccessor(pluginId, {
          revision: profile?.revision,
          hostEpoch: epoch,
          sessionEpoch: this.#sessionEpoch
        })
    };
  }

  #inc(name: string, value = 1, labels?: Record<string, string | number | boolean | undefined>): void {
    this.#metrics?.inc(name, value, { instance: this.id, ...(labels ?? {}) });
  }

  #gauge(name: string, value: number, labels?: Record<string, string | number | boolean | undefined>): void {
    this.#metrics?.set(name, value, { instance: this.id, ...(labels ?? {}) });
  }
}

/** 发出去的是完整媒体；历史里只保留 mediaId，避免把 base64 写进 JSONL。 */
function compactSegmentsForStorage(segments: MessageSegment[]): MessageSegment[] {
  return segments.map((segment) => {
    if (segment.type !== 'image' && segment.type !== 'video') return segment;
    const data = segment.data as { file?: unknown; mediaId?: unknown };
    const file = typeof data.file === 'string' ? data.file : '';
    const mediaId = typeof data.mediaId === 'string' ? data.mediaId : undefined;
    const largeInline = file.startsWith('base64://') || file.startsWith('data:') || file.length > 2_048;
    if (!largeInline) return segment;
    return {
      type: segment.type,
      data: {
        ...(mediaId ? { mediaId } : {}),
        file: mediaId ? `media://${mediaId}` : '[media omitted]'
      }
    };
  });
}
