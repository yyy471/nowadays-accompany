import { InvalidStateTransitionError } from './errors.js';

export const INSTANCE_STATES = [
  'stopped',
  'provisioning',
  'starting',
  'awaiting_login',
  'awaiting_profile',
  'online',
  'degraded',
  'stopping',
  'failed'
] as const;

export type InstanceState = (typeof INSTANCE_STATES)[number];

/**
 * failed 只能回到 provisioning（重启）或停止；online 不能直接回 starting。
 * 允许自迁移（from === to）由调用方决定，状态机本身视为非法。
 */
const TRANSITIONS: Record<InstanceState, readonly InstanceState[]> = {
  stopped: ['provisioning'],
  provisioning: ['starting', 'failed', 'stopping'],
  starting: ['awaiting_login', 'awaiting_profile', 'online', 'failed', 'stopping'],
  awaiting_login: ['awaiting_profile', 'online', 'degraded', 'failed', 'stopping'],
  awaiting_profile: ['online', 'failed', 'stopping'],
  online: ['degraded', 'awaiting_profile', 'failed', 'stopping'],
  degraded: ['online', 'awaiting_profile', 'failed', 'stopping'],
  stopping: ['stopped', 'failed'],
  failed: ['provisioning', 'stopping']
};

export function canTransition(from: InstanceState, to: InstanceState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InstanceStateMachine {
  #state: InstanceState;
  readonly #onChange?: (from: InstanceState, to: InstanceState) => void;

  constructor(initial: InstanceState = 'stopped', onChange?: (from: InstanceState, to: InstanceState) => void) {
    this.#state = initial;
    this.#onChange = onChange;
  }

  get state(): InstanceState {
    return this.#state;
  }

  is(...states: InstanceState[]): boolean {
    return states.includes(this.#state);
  }

  transition(to: InstanceState): void {
    const from = this.#state;
    if (!canTransition(from, to)) throw new InvalidStateTransitionError(from, to);
    this.#state = to;
    this.#onChange?.(from, to);
  }

  /** 仅用于致命错误：任意非 stopped/stopping 状态都可跳到 failed。 */
  fail(): void {
    const from = this.#state;
    if (from === 'failed' || from === 'stopped' || from === 'stopping') return;
    this.#state = 'failed';
    this.#onChange?.(from, 'failed');
  }

  /** 停止过程本身失败时使用：stopping 也必须能进入 failed，否则会永远卡住。 */
  failFinal(): void {
    const from = this.#state;
    if (from === 'failed' || from === 'stopped') return;
    this.#state = 'failed';
    this.#onChange?.(from, 'failed');
  }
}
