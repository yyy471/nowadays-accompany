import type { DraftRegistry, DraftScope, DraftSnapshot } from './registry.js';

export interface TransitionConfirmOptions {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: 'default' | 'danger';
  signal?: AbortSignal;
}

export type TransitionConfirm = (options: TransitionConfirmOptions) => Promise<boolean>;

export interface TransitionOptions {
  scope: DraftScope;
  actionLabel: string;
  confirm: TransitionConfirm;
  title?: string;
  description?: string;
  confirmLabel?: string;
  discardOnAccept?: boolean;
  signal?: AbortSignal;
}

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'cancelled' | 'changed'; message?: string };

function labels(entries: DraftSnapshot[]): string {
  return entries.map((entry) => entry.label).join('、');
}

function sameState(before: DraftSnapshot[], after: DraftSnapshot[]): boolean {
  if (before.length !== after.length) return false;
  return before.every((entry, index) => {
    const next = after[index];
    return next !== undefined
      && next.id === entry.id
      && next.dirty === entry.dirty
      && next.busy === entry.busy
      && next.revision === entry.revision;
  });
}

export class TransitionController {
  private active = false;

  constructor(private readonly registry: DraftRegistry) {}

  get pending(): boolean {
    return this.active;
  }

  async request(options: TransitionOptions): Promise<TransitionResult> {
    if (this.active) return { ok: false, reason: 'busy', message: '另一个离开确认正在进行，请稍后再试。' };
    this.active = true;
    try {
      if (options.signal?.aborted) return { ok: false, reason: 'cancelled' };
      const before = this.registry.snapshot(options.scope);
      const busy = before.filter((entry) => entry.busy);
      if (busy.length > 0) {
        return { ok: false, reason: 'busy', message: `正在保存或读取：${labels(busy)}。请稍后再试。` };
      }
      const dirty = before.filter((entry) => entry.dirty);
      if (dirty.length === 0) return { ok: true };

      const accepted = await options.confirm({
        title: options.title ?? '放弃未保存的修改？',
        description: options.description ?? `以下编辑尚未保存：${labels(dirty)}。${options.actionLabel}后这些草稿会丢失。`,
        confirmLabel: options.confirmLabel ?? '放弃修改并继续',
        cancelLabel: '继续编辑',
        tone: 'danger',
        signal: options.signal
      });
      if (!accepted || options.signal?.aborted) return { ok: false, reason: 'cancelled' };

      const after = this.registry.snapshot(options.scope);
      const busyAfter = after.filter((entry) => entry.busy);
      if (busyAfter.length > 0) {
        return { ok: false, reason: 'busy', message: `正在保存或读取：${labels(busyAfter)}。请稍后再试。` };
      }
      if (!sameState(before, after)) {
        return { ok: false, reason: 'changed', message: '编辑状态已变化，请重新操作。' };
      }
      try {
        if (options.discardOnAccept !== false) {
          for (const entry of after) if (entry.dirty) entry.discard();
        }
      } catch {
        return { ok: false, reason: 'changed', message: '无法完成离开，请重试。' };
      }
      return { ok: true };
    } finally {
      this.active = false;
    }
  }
}
