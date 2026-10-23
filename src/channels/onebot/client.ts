import WebSocket from 'ws';
import { ChannelError } from '../../core/errors.js';
import { Semaphore } from '../../core/concurrency.js';
import type { Logger } from '../../core/logger.js';
import type { ConversationRef } from '../../routing/identity.js';
import type { OutboundMessage } from '../../routing/message.js';
import type { ChannelContext, OutboundChannel } from '../contract.js';
import { normalizeEvent } from './normalize.js';

interface OneBotResponse<T> {
  status?: string;
  retcode?: number;
  data?: T;
  message?: string;
  wording?: string;
}

const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const STABLE_CONNECTION_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * 一条通道 = 一个实例的一条 OneBot 连接。
 * 事件走 WS，动作走 HTTP；重连带代际号，旧连接的回调不能影响新连接。
 */
export class OneBotChannel implements OutboundChannel {
  readonly kind = 'onebot';

  readonly #context: ChannelContext;
  readonly #logger: Logger;
  readonly #httpBaseUrl: string;
  readonly #wsUrl: string;
  readonly #httpToken?: string;
  readonly #wsToken?: string;
  readonly #actions: Semaphore;

  #socket: WebSocket | undefined;
  #connected = false;
  #closing = false;
  #generation = 0;
  #reconnectIndex = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #awaitingPong = false;
  #connectedAt: number | undefined;
  #connectPromise: Promise<void> | undefined;
  #selfId: string | undefined;

  constructor(context: ChannelContext) {
    this.#context = context;
    this.#logger = context.logger;
    this.#httpBaseUrl = context.endpoints.httpBaseUrl.replace(/\/+$/, '');
    this.#wsUrl = context.endpoints.wsUrl;
    this.#httpToken = context.endpoints.httpToken;
    this.#wsToken = context.endpoints.wsToken;
    this.#selfId = context.spec.accountId;
    this.#actions = new Semaphore(context.maxConcurrentActions ?? 8);
    context.signal?.addEventListener('abort', this.#onAbort, { once: true });
  }

  async connect(): Promise<void> {
    this.#context.signal?.throwIfAborted();
    if (this.#connected) return;
    if (this.#connectPromise) return this.#connectPromise;
    this.#closing = false;
    const task = (async () => {
      await this.#openSocket();
      await this.#refreshLogin();
    })();
    this.#connectPromise = task;
    try {
      await task;
    } finally {
      if (this.#connectPromise === task) this.#connectPromise = undefined;
    }
  }

  async disconnect(): Promise<void> {
    this.#context.signal?.removeEventListener('abort', this.#onAbort);
    this.#closing = true;
    this.#generation += 1;
    this.#clearReconnect();
    this.#stopHeartbeat();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#connectedAt = undefined;
    this.#setConnected(false);
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close(1000, 'client disconnect');
        setTimeout(resolve, 1_000).unref?.();
      });
    } else {
      socket?.terminate();
    }
    this.#closing = false;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  selfId(): string | undefined {
    return this.#selfId;
  }

  voiceDeliverySupport(): 'supported' | 'unsupported' | 'unknown' {
    return this.#context.spec.backendOptions?.voiceDelivery === true ? 'supported' : 'unknown';
  }

  pause(): void {
    this.#socket?.pause();
  }

  resume(): void {
    this.#socket?.resume();
  }

  async send(conversation: ConversationRef, message: OutboundMessage): Promise<{ messageId?: string }> {
    if (!this.#connected) throw new ChannelError('not_connected', `channel ${this.#context.instanceId} is not connected`);
    if (!/^\d+$/.test(conversation.peerId)) {
      throw new ChannelError('invalid_peer', `peerId must be numeric for QQ: ${conversation.peerId}`, { retryable: false });
    }
    const params =
      conversation.kind === 'group'
        ? { message_type: 'group', group_id: Number(conversation.peerId), message: message.segments }
        : { message_type: 'private', user_id: Number(conversation.peerId), message: message.segments };
    const data = await this.call<{ message_id?: number | string }>('send_msg', params, 60_000);
    return { messageId: data?.message_id !== undefined ? String(data.message_id) : undefined };
  }

  async call<T>(action: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T | undefined> {
    const release = await this.#actions.acquire();
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.#httpToken) headers.authorization = `Bearer ${this.#httpToken}`;
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (this.#context.signal) signals.push(this.#context.signal);
      let response: Response;
      try {
        response = await fetch(`${this.#httpBaseUrl}/${action}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(params),
          signal: AbortSignal.any(signals)
        });
      } catch (error) {
        if (this.#context.signal?.aborted) {
          throw new ChannelError('action_aborted', `${action} aborted`, { cause: error, retryable: false });
        }
        throw new ChannelError('action_transport', `${action} transport failure`, { cause: error });
      }
      if (!response.ok) {
        throw new ChannelError('action_http_status', `${action} -> HTTP ${response.status}`, {
          retryable: response.status >= 500
        });
      }
      const body = (await response.json()) as OneBotResponse<T>;
      if (body.retcode !== 0 || body.status === 'failed') {
        throw new ChannelError(
          'action_failed',
          `${action}: ${body.wording ?? body.message ?? 'failed'}`,
          { retcode: body.retcode, retryable: false }
        );
      }
      return body.data;
    } finally {
      release();
    }
  }

  async #openSocket(): Promise<void> {
    this.#context.signal?.throwIfAborted();
    this.#generation += 1;
    const generation = this.#generation;
    const socket = new WebSocket(this.#wsUrl, {
      headers: this.#wsToken ? { authorization: `Bearer ${this.#wsToken}` } : {}
    });
    this.#socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.terminate();
        reject(new ChannelError('ws_open_timeout', `ws open timeout: ${this.#context.instanceId}`));
      }, 10_000);
      timer.unref?.();
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new ChannelError('ws_open_failed', `ws open failed: ${this.#context.instanceId}`, { cause: error }));
      };
      const onAbort = (): void => {
        cleanup();
        socket.terminate();
        reject(new ChannelError('ws_aborted', `ws open aborted: ${this.#context.instanceId}`, { retryable: false }));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('open', onOpen);
        socket.off('error', onError);
        this.#context.signal?.removeEventListener('abort', onAbort);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
      this.#context.signal?.addEventListener('abort', onAbort, { once: true });
    });

    socket.on('message', (data) => {
      if (generation !== this.#generation) return;
      this.#onRawMessage(data.toString());
    });
    socket.on('pong', () => {
      if (generation !== this.#generation) return;
      this.#awaitingPong = false;
    });
    socket.on('close', (code, reason) => {
      if (generation !== this.#generation) return;
      this.#logger.warn('ws closed', { code, reason: reason.toString() });
      const stable = this.#connectedAt !== undefined && Date.now() - this.#connectedAt >= STABLE_CONNECTION_MS;
      this.#connectedAt = undefined;
      this.#stopHeartbeat();
      this.#setConnected(false);
      if (this.#closing || this.#context.signal?.aborted) return;
      if (stable) this.#reconnectIndex = 0;
      this.#scheduleReconnect();
    });
    socket.on('error', (error) => {
      if (generation !== this.#generation) return;
      this.#logger.warn('ws error', { message: error.message });
    });

    this.#setConnected(true);
    this.#connectedAt = Date.now();
    this.#startHeartbeat(socket, generation);
  }

  #startHeartbeat(socket: WebSocket, generation: number): void {
    this.#stopHeartbeat();
    this.#awaitingPong = false;
    const timer = setInterval(() => {
      if (generation !== this.#generation || socket.readyState !== WebSocket.OPEN) return;
      if (this.#awaitingPong) {
        this.#logger.warn('ws heartbeat missed, terminating', { instanceId: this.#context.instanceId });
        socket.terminate();
        return;
      }
      this.#awaitingPong = true;
      socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    this.#heartbeatTimer = timer;
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#awaitingPong = false;
  }

  #setConnected(connected: boolean): void {
    if (this.#connected === connected) return;
    this.#connected = connected;
    this.#context.onStatus?.({ connected, ...(this.#selfId ? { selfId: this.#selfId } : {}) });
  }

  #scheduleReconnect(): void {
    if (this.#closing || this.#context.signal?.aborted || this.#reconnectTimer) return;
    const base = RECONNECT_DELAYS[Math.min(this.#reconnectIndex, RECONNECT_DELAYS.length - 1)] ?? 30_000;
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.#reconnectIndex += 1;
    this.#logger.info('scheduling reconnect', { delayMs: delay });
    const timer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#closing || this.#context.signal?.aborted) return;
      void this.connect().catch((error: unknown) => {
        this.#logger.warn('reconnect failed', { message: error instanceof Error ? error.message : String(error) });
        this.#scheduleReconnect();
      });
    }, delay);
    timer.unref?.();
    this.#reconnectTimer = timer;
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #onRawMessage(raw: string): void {
    if (this.#context.signal?.aborted) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#logger.warn('ignoring non-json ws frame', { bytes: raw.length });
      return;
    }
    const event = normalizeEvent(parsed, this.#context.instanceId);
    if (!event) return;
    if ('selfId' in event && event.selfId && event.selfId !== this.#selfId) {
      this.#selfId = event.selfId;
    }
    this.#context.onEvent(event);
  }

  async #refreshLogin(): Promise<void> {
    try {
      const info = await this.call<{ user_id?: number | string; nickname?: string }>('get_login_info', {}, 5_000);
      if (info?.user_id !== undefined) {
        this.#selfId = String(info.user_id);
        this.#context.onStatus?.({ connected: this.#connected, selfId: this.#selfId });
      }
    } catch (error) {
      if (this.#context.signal?.aborted) throw error;
      // 登录信息通常在账号未登录时不可用；事件里的 self_id 会在之后补上
      this.#logger.warn('get_login_info unavailable', {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  readonly #onAbort = (): void => {
    this.#closing = true;
    this.#generation += 1;
    this.#clearReconnect();
    this.#stopHeartbeat();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#connectedAt = undefined;
    this.#setConnected(false);
    socket?.terminate();
  };
}
