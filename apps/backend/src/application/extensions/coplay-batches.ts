import { randomUUID } from "node:crypto";

type Batch = {
  extId: string; roleId: string; count: number; inFlight: number; latest: string;
  timer: NodeJS.Timeout | null;
};

export class CoplayBatches {
  private readonly batches = new Map<string, Batch>();

  constructor(private readonly eligible: (roleId: string) => boolean,
    private readonly onDue: (roleId: string) => void, private readonly windowMs = 5000) {}

  begin(extId: string, roleId: string, label: string) {
    if (!this.eligible(roleId)) return;
    const key = extId + "/" + roleId;
    let batch = this.batches.get(key);
    if (!batch) {
      const first: Batch = { extId, roleId, count: 0, inFlight: 0, latest: "", timer: null };
      this.batches.set(key, first);
      first.timer = setTimeout(() => {
        first.timer = null;
        if (first.count && !first.inFlight) this.onDue(roleId);
      }, this.windowMs).unref();
      batch = first;
    }
    batch.inFlight++;
    return (summary?: string) => {
      // 停机、撤版或耗尽额度会撤掉整批；旧进程的迟到结果仍可回显游戏数据。
      if (this.batches.get(key) !== batch) return;
      batch.inFlight--;
      if (summary) {
        batch.count++;
        const result = summary.length <= 512 ? summary : summary.slice(0, 255) + "…" + summary.slice(-256);
        batch.latest = label + "：" + result;
      }
      if (batch.inFlight) return;
      if (!batch.count) {
        if (batch.timer) clearTimeout(batch.timer);
        this.batches.delete(key);
      } else if (batch.timer === null) this.onDue(roleId);
    };
  }

  hasDue(roleId: string) {
    return [...this.batches.values()].some(batch => batch.roleId === roleId && !batch.timer && !batch.inFlight && batch.count);
  }

  budgetChanged(roleId: string) {
    if ([...this.batches.values()].some(batch => batch.roleId === roleId) && !this.eligible(roleId))
      this.discard(batch => batch.roleId === roleId);
  }

  due(roleId: string) {
    for (const [key, batch] of this.batches) {
      if (batch.roleId !== roleId || batch.timer || batch.inFlight || !batch.count) continue;
      if (!this.eligible(roleId)) {
        this.discard(item => item.roleId === roleId);
        return;
      }
      return { taskId: null, wakeId: "coplay/" + randomUUID(),
        intent: `用户与你在扩展 ${batch.extId} 共玩 ${batch.count} 次。最后一次${batch.latest}。你可以视情况主动分享感想。`,
        claimed: () => this.batches.delete(key) };
    }
  }

  discard(matches: (batch: Batch) => boolean) {
    for (const [key, batch] of this.batches) {
      if (!matches(batch)) continue;
      if (batch.timer) clearTimeout(batch.timer);
      this.batches.delete(key);
    }
  }
}
