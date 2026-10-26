export type QuitState = 'idle' | 'checking' | 'shuttingDown' | 'exited';
export interface QuitStateChange { requestId: string; state: 'cancelled' | 'shuttingDown' }

export interface QuitCoordinatorOptions {
  sendCheck: (requestId: string) => boolean;
  showUnavailableDialog: () => Promise<boolean>;
  shutdown: () => Promise<void>;
  requestId: () => string;
  /** 只约束“界面是否收到并确认请求”，不约束用户做决定的时长。 */
  ackTimeoutMs?: number;
  livenessTimeoutMs?: number;
  onStateChange?: (event: QuitStateChange) => void;
}

export class QuitCoordinator {
  private state: QuitState = 'idle';
  private pending: Promise<void> | undefined;
  private requestId: string | undefined;
  private acked = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settle: ((allowed: boolean) => void) | undefined;
  private fallback: (() => void) | undefined;

  private notify(requestId: string, state: QuitStateChange['state']): void {
    try { this.options.onStateChange?.({ requestId, state }); } catch { /* UI notification cannot block shutdown. */ }
  }

  private watchLiveness(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.unavailable(), this.options.livenessTimeoutMs ?? 15_000);
  }

  keepAlive(requestId: string): boolean {
    if (this.state !== 'checking' || this.requestId !== requestId || !this.acked) return false;
    this.watchLiveness();
    return true;
  }

  unavailable(): boolean {
    if (this.state !== 'checking' || !this.fallback) return false;
    this.fallback();
    return true;
  }

  constructor(private readonly options: QuitCoordinatorOptions) {}

  get current(): QuitState {
    return this.state;
  }

  request(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.state === 'shuttingDown' || this.state === 'exited') return Promise.resolve();
    this.state = 'checking';
    this.pending = this.run();
    return this.pending;
  }

  /** 界面回执：确认请求已送达并进入等待用户阶段，取消失联兜底。 */
  ack(rawRequestId: string): boolean {
    if (this.state !== 'checking' || !this.requestId || this.requestId !== rawRequestId || this.acked) return false;
    this.acked = true;
    this.watchLiveness();
    return true;
  }

  /** 只有在界面已回执、请求仍有效时才接受最终决策，忽略过期或迟到的回复。 */
  respond(rawRequestId: string, allowed: boolean): boolean {
    if (this.state !== 'checking' || !this.requestId || this.requestId !== rawRequestId || !this.acked) return false;
    const settle = this.settle;
    if (!settle) return false;
    settle(allowed);
    return true;
  }

  /** 通信失联（渲染进程消失等）时主动放弃本轮预检，回到空闲且不停止 Core。 */
  cancel(): boolean {
    if (this.state !== 'checking') return false;
    this.settle?.(false);
    return true;
  }

  private check(): Promise<boolean> {
    const requestId = this.options.requestId();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (allowed: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
        this.requestId = undefined;
        this.acked = false;
        this.settle = undefined;
        this.fallback = undefined;
        this.notify(requestId, allowed ? 'shuttingDown' : 'cancelled');
        resolve(allowed);
      };
      this.requestId = requestId;
      this.acked = false;
      this.settle = finish;
      const fallback = (): void => {
        if (settled || !this.fallback) return;
        this.fallback = undefined;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.requestId = undefined;
        this.notify(requestId, 'cancelled');
        void this.options.showUnavailableDialog().then(finish).catch(() => finish(false));
      };
      this.fallback = fallback;
      this.timer = setTimeout(() => {
        if (settled || this.acked) return;
        // 界面对象始终未回执：按通信失联处理，而不是用户思考过久。
        // 进入兜底后作废该请求，拒绝迟到的回执与决策。
        fallback();
      }, this.options.ackTimeoutMs ?? 8_000);
      let delivered = false;
      try {
        delivered = this.options.sendCheck(requestId);
      } catch {
        delivered = false;
      }
      if (!delivered) {
        fallback();
      }
    });
  }

  private async run(): Promise<void> {
    let allowed = false;
    try {
      allowed = await this.check();
    } catch {
      allowed = false;
    }
    if (!allowed) {
      this.state = 'idle';
      this.pending = undefined;
      return;
    }
    this.state = 'shuttingDown';
    try {
      await this.options.shutdown();
      this.state = 'exited';
    } catch {
      this.state = 'idle';
      this.pending = undefined;
    }
  }
}
