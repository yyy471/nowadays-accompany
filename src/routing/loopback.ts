export type LoopbackVerdict = 'accept' | 'self' | 'misattributed';

export interface LoopbackInput {
  postType: string;
  selfId?: string;
  senderId?: string;
}

/**
 * 每个实例只认自己的 selfId 集合。
 *
 * 关键语义（与 QQ-Agent 现状不同）：跨号消息必须放行。A 号发给 B 号时，B 侧事件的
 * senderId=A、selfId=B，A 不在 B 的集合里 —— 这是 B 的正常入站，不是回环。
 * 回环只看「这条事件是不是本实例自己发出/自己收到的回声」。
 */
export class LoopbackGuard {
  readonly #selfIds = new Set<string>();

  constructor(selfIds: Iterable<string> = []) {
    for (const id of selfIds) this.add(id);
  }

  add(selfId: string): void {
    if (selfId) this.#selfIds.add(String(selfId));
  }

  clear(): void {
    this.#selfIds.clear();
  }

  has(selfId: string): boolean {
    return this.#selfIds.has(String(selfId));
  }

  get size(): number {
    return this.#selfIds.size;
  }

  primary(): string | undefined {
    return this.#selfIds.values().next().value;
  }

  classify(input: LoopbackInput): LoopbackVerdict {
    if (input.postType === 'message_sent') return 'self';
    const selfId = input.selfId ? String(input.selfId) : '';
    if (selfId && this.#selfIds.size > 0 && !this.#selfIds.has(selfId)) return 'misattributed';
    const senderId = input.senderId ? String(input.senderId) : '';
    if (senderId && this.#selfIds.has(senderId)) return 'self';
    return 'accept';
  }
}
