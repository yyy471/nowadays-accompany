/**
 * 状态流变更通知（ARCH-02 R8b）。
 *
 * 只广播「哪个角色的哪一类数据变了」，前端据此按需重取，不携带业务快照，
 * 避免把消息正文、记忆内容等私密细节复制到事件流里。实例级计数与监听集合
 * 都不放在模块作用域，测试与多实例并发时互不串扰。
 */
export type FeedTopic =
  | "activity"
  | "wake"
  | "exchange"
  | "memory"
  | "role_activity";

export interface FeedChangeEvent {
  seq: number;
  topic: FeedTopic;
  roleId?: string;
  at: string;
}

export class FeedEventHub {
  private seq = 0;
  private readonly listeners = new Set<(event: FeedChangeEvent) => void>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** 最近一次广播的序号；新连接据此判断是否需要全量刷新。 */
  currentSeq(): number {
    return this.seq;
  }

  emit(topic: FeedTopic, roleId?: string): void {
    this.seq += 1;
    const event: FeedChangeEvent = {
      seq: this.seq,
      topic,
      ...(roleId === undefined ? {} : { roleId }),
      at: this.now().toISOString(),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者（例如已关闭的响应流）异常不影响其他订阅者。
      }
    }
  }

  subscribe(listener: (event: FeedChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
