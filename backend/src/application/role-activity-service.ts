import {
  RoleActivityConflictError,
  RoleActivityStoppedError,
  RoleNotStoppedError,
  RoleNotFoundError,
  RolesNotStoppedError,
} from "../domain/errors.js";
import type {
  ActivityRuntime,
  RoleActivityGate,
  RoleActivityState,
  RoleActivityStopResult,
  RoleActivityView,
} from "../domain/role-activity.js";
import type { AppStore } from "../storage/app-store.js";
import { RoleActivityStore } from "../storage/role-activity-store.js";

export interface RoleActivityServiceOptions {
  now?: () => Date;
}

/**
 * 角色活动状态与配置写入保护（DL-148 / 252 第一包）。
 *
 * 校验与写入用租约协调：guardRole / guardAll 在校验后到写入完成之间持有租约，
 * 期间的恢复会被拒绝，避免「校验通过 → 恢复 → 写入仍落到活动中的角色」。
 */
export class RoleActivityService {
  private readonly store: RoleActivityStore;
  private readonly now: () => Date;
  private runtime: ActivityRuntime | null = null;
  private readonly roleLeases = new Map<string, number>();
  /** 每个角色排队的配置写入尾结点；同一角色的写入与删除互斥执行。 */
  private readonly writeChains = new Map<string, Promise<void>>();
  private globalLeases = 0;
  readonly gate: RoleActivityGate;

  constructor(
    private readonly appStore: AppStore,
    options: RoleActivityServiceOptions = {},
  ) {
    this.store = new RoleActivityStore(appStore.db);
    this.now = options.now ?? (() => new Date());
    this.gate = {
      isStopRequested: (roleId) => this.store.get(roleId).state === "stopping",
      confirmStop: (roleId, executionId) => {
        this.store.confirmStop(roleId, executionId, this.iso());
      },
      canStart: (roleId) => this.store.get(roleId).state === "active",
    };
  }

  attachRuntime(runtime: ActivityRuntime): void {
    this.runtime = runtime;
  }

  /**
   * 启动恢复后收敛停止状态（RA-R05）：进程可能在请求停止与确认停止之间退出，
   * 持久化记录会停在 stopping。执行恢复完成后，没有在途执行或后台工具的角色
   * 自动确认停止；已存任务、任务链与工具调用证据一律原样保留。
   * 返回本次从 stopping 收敛到 stopped 的数量。
   */
  reconcileStartup(): number {
    let confirmed = 0;
    for (const record of this.store.listAll()) {
      if (record.state !== "stopping") continue;
      // 执行恢复可能已接回在途执行；它们会在下一个可保存节点自行确认停止。
      if (this.runtime?.isRunning(record.roleId) === true) continue;
      this.store.confirmStop(
        record.roleId,
        record.boundaryExecutionId,
        this.iso(),
      );
      if (this.store.get(record.roleId).state === "stopped") {
        confirmed += 1;
      }
    }
    return confirmed;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private assertRole(roleId: string): void {
    if (this.appStore.getRoleIndex(roleId) === null) {
      throw new RoleNotFoundError(roleId);
    }
  }

  /** 角色是否仍在管理列表；删除重试需要绕过活动校验直接进入处理器。 */
  roleExists(roleId: string): boolean {
    return this.appStore.getRoleIndex(roleId) !== null;
  }

  view(roleId: string): RoleActivityView {
    this.assertRole(roleId);
    const record = this.store.get(roleId);
    const index = this.appStore.getRoleIndex(roleId);
    return {
      ...record,
      initStatus: index?.initStatus ?? "initializing",
      running: this.runtime?.isRunning(roleId) ?? false,
    };
  }

  list(): RoleActivityView[] {
    const indexes = new Map(
      this.appStore.listRoleIndexes().map((index) => [index.roleId, index]),
    );
    return this.store.listAll().map((record) => ({
      ...record,
      initStatus: indexes.get(record.roleId)?.initStatus ?? "initializing",
      running: this.runtime?.isRunning(record.roleId) ?? false,
    }));
  }

  /** 请求停止。没有执行在跑时立即确认；否则等图的下一个可保存节点。 */
  requestStop(roleId: string): RoleActivityStopResult {
    this.assertRole(roleId);
    if (this.roleLeases.get(roleId) || this.globalLeases > 0) {
      throw new RoleActivityConflictError(
        roleId,
        this.store.get(roleId).state,
        "CONFIG_WRITE_IN_PROGRESS",
      );
    }
    if (this.store.get(roleId).state === "stopped") {
      return { activity: this.view(roleId), confirmed: true };
    }
    this.store.requestStop(roleId, this.iso());
    if (this.runtime?.isRunning(roleId) === true) {
      return { activity: this.view(roleId), confirmed: false };
    }
    this.store.confirmStop(roleId, null, this.iso());
    return { activity: this.view(roleId), confirmed: true };
  }

  /**
   * 恢复：状态改回 active 后接通已有调度，让停止时暂停的原任务链与到期
   * 待办继续推进。待办与自主额度原样保留（用户确认的 DL-148 恢复语义），
   * 这里只负责重新调度，不新建任务、不清空排队、不重置额度。
   */
  resume(roleId: string): RoleActivityView {
    this.assertRole(roleId);
    const current = this.store.get(roleId);
    if ((this.roleLeases.get(roleId) ?? 0) > 0 || this.globalLeases > 0) {
      throw new RoleActivityConflictError(
        roleId,
        current.state,
        "CONFIG_WRITE_IN_PROGRESS",
      );
    }
    if (current.state !== "stopped") {
      throw new RoleActivityConflictError(
        roleId,
        current.state,
        "NOT_STOPPED",
      );
    }
    this.store.activate(roleId, this.iso());
    try {
      this.runtime?.resumeWork?.(roleId);
    } catch {
      // 调度失败不回滚状态：活动已恢复，待办仍在，下一次调度或新消息会接上。
    }
    return this.view(roleId);
  }

  assertCanStart(roleId: string): void {
    this.assertRole(roleId);
    const state = this.store.get(roleId).state;
    if (state !== "active") {
      throw new RoleActivityStoppedError(roleId, state);
    }
  }

  assertStopped(roleId: string): void {
    this.assertRole(roleId);
    const state: RoleActivityState = this.store.get(roleId).state;
    if (state === "stopped") return;
    throw new RoleNotStoppedError({
      roleId,
      state,
      reason: state === "stopping" ? "STOPPING" : "ACTIVE",
    });
  }

  assertAllStopped(): void {
    const pending = this.list().filter((item) => item.state !== "stopped");
    if (pending.length > 0) {
      throw new RolesNotStoppedError(
        pending.map(({ roleId, state, running }) => ({ roleId, state, running })),
      );
    }
  }

  /**
   * 角色配置写入：校验与写入之间持租约，期间拒绝恢复；同一角色的配置写入
   * 按到达顺序串行执行。角色删除也走这条路径，因此会等在途上传结束后再
   * 移除索引并清理目录，避免上传把素材写回已删除角色（AD-R06）。
   */
  async guardRole<T>(
    roleId: string,
    action: () => T | Promise<T>,
  ): Promise<T> {
    this.assertStopped(roleId);
    const previous = this.writeChains.get(roleId);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writeChains.set(roleId, tail);
    this.roleLeases.set(roleId, (this.roleLeases.get(roleId) ?? 0) + 1);
    try {
      if (previous !== undefined) {
        await previous;
      }
      return await action();
    } finally {
      const left = (this.roleLeases.get(roleId) ?? 1) - 1;
      if (left <= 0) this.roleLeases.delete(roleId);
      else this.roleLeases.set(roleId, left);
      if (this.writeChains.get(roleId) === tail) {
        this.writeChains.delete(roleId);
      }
      release();
    }
  }

  /** 全局服务写入：所有角色都须已停止，且期间不允许任何角色恢复。 */
  async guardAll<T>(action: () => T | Promise<T>): Promise<T> {
    this.assertAllStopped();
    this.globalLeases += 1;
    try {
      return await action();
    } finally {
      this.globalLeases -= 1;
    }
  }
}
