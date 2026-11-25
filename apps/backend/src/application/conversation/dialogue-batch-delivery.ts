import { XIA_CHENG_BUILTIN_KEY } from "../../domain/admin-seat.js";
import { AutonomyStore } from "../../storage/conversation/autonomy-store.js";
import { pendingDialogueBatches } from "../../storage/conversation/dialogue-batches.js";
import type { AppStore } from "../../storage/core/app-store.js";
import type { RoleAccess } from "../role/role-access.js";

export class DialogueBatchDelivery {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(
    private readonly app: AppStore,
    private readonly access: RoleAccess,
    private readonly now: () => Date,
    private readonly wakeChanged: (roleId: string) => void,
    private readonly onDelivered?: (batch: object) => void,
  ) {}

  recover(): void {
    for (const role of this.app.listRoleIndexes()) {
      if (role.initStatus === "ready" && !role.isBuiltin) this.notify(role.roleId);
    }
  }

  notify(roleId: string, delayMs = 0): void {
    if (this.closed || this.timers.has(roleId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(roleId);
      try {
        if (this.app.getRoleIndex(roleId)) this.drain(roleId);
      } catch (error) {
        console.warn("DIALOGUE_BATCH_DELIVERY_RETRY", roleId, error);
        this.notify(roleId, 5000);
      }
    }, delayMs);
    this.timers.set(roleId, timer.unref());
  }

  private drain(roleId: string): void {
    const now = this.now().toISOString();
    const seat = this.app.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY);
    if (!seat) return;
    this.access.withStore(roleId, source => {
      const db = source.business.db;
      const due = pendingDialogueBatches(db, roleId, now);
      if (due.length) {
        const roleName = source.business.getRole(roleId).displayName;
        this.access.withStore(seat.roleId, target => {
          const receiver = target.business.db;
          const wakes = new AutonomyStore(receiver, seat.roleId);
          for (const batch of due) {
            // 先在收端幂等登记，再确认源端。两次落盘之间退出可安全重放。
            receiver.transaction(() => {
              if (!receiver.prepare("SELECT 1 FROM autonomy_wakes WHERE wake_id = ?").get(batch.batchId)) {
                const facts = JSON.stringify({ ...batch, roleName });
                wakes.createWake({
                  wakeId: batch.batchId, kind: "scheduled", scheduledAt: now, now,
                  intent: `其他角色窗口已完成一批对话。批次事实：${facts}。可忽略，或使用 app_role_records_query 按此批次查阅。`,
                });
              }
            }).immediate();
            this.wakeChanged(seat.roleId);
            db.prepare("UPDATE observed_dialogue_batches SET delivered_at = ? WHERE batch_id = ?").run(now, batch.batchId);
            this.onDelivered?.({ ...batch, roleName });
          }
        });
      }
      const next = db.prepare(`SELECT due_at FROM observed_dialogue_batches
        WHERE role_id = ? AND delivered_at IS NULL ORDER BY due_at LIMIT 1`).get(roleId) as {due_at: string} | undefined;
      if (next) this.notify(roleId, Math.max(0, Date.parse(next.due_at) - this.now().getTime()));
    });
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
