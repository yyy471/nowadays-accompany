import { InputStateInvalidError } from "../domain/errors.js";
import type { ConversationInputState } from "../domain/conversation.js";

export interface InputStateRegistryOptions {
  typingMs?: number;
  now?: () => Date;
  onExpire?: (roleId: string, windowId: string) => void;
}

const DEFAULT_TYPING_MS = 1000;

export class InputStateRegistry {
  private readonly typingMs: number;
  private readonly now: () => Date;
  private readonly onExpire: ((roleId: string, windowId: string) => void) | null;
  private readonly entries = new Map<string, ConversationInputState>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: InputStateRegistryOptions = {}) {
    this.typingMs = options.typingMs ?? DEFAULT_TYPING_MS;
    this.now = options.now ?? (() => new Date());
    this.onExpire = options.onExpire ?? null;
  }

  update(input: {
    roleId: string;
    windowId: string;
    clientId: string;
    typing: boolean;
  }): ConversationInputState | null {
    this.assertInput(input.roleId, input.windowId, input.clientId);
    const key = entryKey(input.roleId, input.windowId, input.clientId);
    if (!input.typing) {
      this.entries.delete(key);
      this.refreshTimer();
      return null;
    }
    const expiresAt = new Date(this.now().getTime() + this.typingMs).toISOString();
    const state = {
      roleId: input.roleId,
      windowId: input.windowId,
      clientId: input.clientId,
      expiresAt,
    };
    this.entries.set(key, state);
    this.refreshTimer();
    return state;
  }

  clearWindow(roleId: string, windowId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.roleId === roleId && entry.windowId === windowId) {
        this.entries.delete(key);
      }
    }
    this.refreshTimer();
  }

  clearClient(roleId: string, windowId: string, clientId: string): void {
    this.assertInput(roleId, windowId, clientId);
    this.entries.delete(entryKey(roleId, windowId, clientId));
    this.refreshTimer();
  }

  clearRole(roleId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.roleId === roleId) {
        this.entries.delete(key);
      }
    }
    this.refreshTimer();
  }

  isTyping(roleId: string, windowId: string): boolean {
    this.sweep();
    for (const entry of this.entries.values()) {
      if (entry.roleId === roleId && entry.windowId === windowId) {
        return true;
      }
    }
    return false;
  }

  list(roleId?: string): ConversationInputState[] {
    this.sweep();
    return [...this.entries.values()]
      .filter((entry) => roleId === undefined || entry.roleId === roleId)
      .map((entry) => ({ ...entry }))
      .sort(
        (left, right) =>
          left.roleId.localeCompare(right.roleId) ||
          left.windowId.localeCompare(right.windowId) ||
          left.clientId.localeCompare(right.clientId),
      );
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.entries.clear();
  }

  private sweep(): void {
    const now = this.now().getTime();
    const expired: Array<{ roleId: string; windowId: string }> = [];
    for (const [key, entry] of this.entries) {
      if (Date.parse(entry.expiresAt) <= now) {
        this.entries.delete(key);
        expired.push({ roleId: entry.roleId, windowId: entry.windowId });
      }
    }
    for (const item of expired) {
      this.onExpire?.(item.roleId, item.windowId);
    }
    this.refreshTimer();
  }

  private refreshTimer(): void {
    if (this.closed) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.entries.size === 0) {
      return;
    }
    const earliest = Math.min(
      ...[...this.entries.values()].map((entry) => Date.parse(entry.expiresAt)),
    );
    const delay = Math.max(0, earliest - this.now().getTime());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sweep();
    }, delay);
    this.timer.unref?.();
  }

  private assertInput(roleId: string, windowId: string, clientId: string): void {
    if (roleId.trim().length === 0) {
      throw new InputStateInvalidError("roleId 不能为空");
    }
    if (windowId.trim().length === 0) {
      throw new InputStateInvalidError("windowId 不能为空");
    }
    if (clientId.trim().length === 0) {
      throw new InputStateInvalidError("clientId 不能为空");
    }
  }
}

function entryKey(roleId: string, windowId: string, clientId: string): string {
  return `${roleId}\u0000${windowId}\u0000${clientId}`;
}
