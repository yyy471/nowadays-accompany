import fs from "node:fs";
import { rolePaths } from "../bootstrap/config.js";
import { AppError } from "../domain/errors.js";
import type { AppStore } from "../storage/app-store.js";
import type { RoleAccess } from "./role-access.js";

export interface RoleDeletionRuntime {
  /** 等待并释放该角色的在途工作：事件流、定时器、场景任务与记忆队列。 */
  dispose(roleId: string): Promise<void>;
}

export interface RoleDeletionResult {
  roleId: string;
  /** true：保留记忆、对话与受管素材；false：连角色目录一并清理。 */
  keepHistory: boolean;
  /** 清理路径下角色目录是否已删除；保留路径恒为 false。 */
  filesRemoved: boolean;
}

export interface RoleDeletionServiceOptions {
  now?: () => Date;
}

/**
 * 删除角色（DL-148 / 252 第三包）。
 *
 * 两条路径都从管理列表移除角色并保留用户源目录与源文件：
 * - 保留记忆与对话数据：只移除索引与活动记录，角色目录原样保留；
 * - 一并删除：先提交「移除角色 + 待清理记录」，再删除角色目录。目录删除
 *   失败或进程中断时由启动恢复或同一删除接口重试继续清理。
 * 至少保留一个角色；清理路径之外的接口对已移除角色返回 404。
 */
export class RoleDeletionService {
  private readonly now: () => Date;
  /** 串行化删除请求，避免两个 DELETE 交错后都通过「至少保留一个」检查。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly appStore: AppStore,
    private readonly roleAccess: RoleAccess,
    private readonly runtime: RoleDeletionRuntime,
    private readonly dataRoot: string,
    options: RoleDeletionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async remove(
    roleId: string,
    keepHistory: boolean,
  ): Promise<RoleDeletionResult> {
    return this.serialized(() => this.removeInternal(roleId, keepHistory));
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action, action);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async removeInternal(
    roleId: string,
    keepHistory: boolean,
  ): Promise<RoleDeletionResult> {
    // 已经接受的清理删除：重试同一请求继续删除角色目录。
    if (this.appStore.isRoleDeletionPending(roleId)) {
      return this.finishCleanup(roleId);
    }
    this.roleAccess.getIndex(roleId);
    if (this.appStore.listRoleIndexes().length <= 1) {
      throw this.lastRoleError(roleId);
    }
    await this.runtime.dispose(roleId);
    // 运行时收尾期间可能有并发删除；「至少保留一个」在写事务里再复验一次，
    // 与移除索引同事务，避免两个请求各删一个后剩零个角色（AD-R01）。
    this.appStore.db.transaction(() => {
      if (this.appStore.listRoleIndexes().length <= 1) {
        throw this.lastRoleError(roleId);
      }
      if (!keepHistory) {
        this.appStore.recordRoleDeletion(roleId, this.now().toISOString());
      }
      this.appStore.deleteRole(roleId);
    })();
    if (keepHistory) {
      return { roleId, keepHistory: true, filesRemoved: false };
    }
    return this.finishCleanup(roleId);
  }

  private lastRoleError(roleId: string): AppError {
    return new AppError(
      409,
      "LAST_ROLE_REQUIRED",
      "至少保留一个角色，请先创建或预置角色",
      { roleId },
    );
  }

  /** 启动恢复：继续删除已接受但未删完的角色目录。返回完成数量。 */
  reconcilePendingDeletions(): number {
    let pending: string[];
    try {
      pending = this.appStore.listRoleDeletions();
    } catch {
      return 0;
    }
    let removed = 0;
    for (const roleId of pending) {
      try {
        if (this.cleanupDirectory(roleId)) {
          this.appStore.clearRoleDeletion(roleId);
          removed += 1;
        }
      } catch {
        // 单条失败保留记录，等下一次启动或重试继续。
      }
    }
    return removed;
  }

  private finishCleanup(roleId: string): RoleDeletionResult {
    const filesRemoved = this.cleanupDirectory(roleId);
    if (filesRemoved) {
      try {
        this.appStore.clearRoleDeletion(roleId);
      } catch {
        // 删除已接受：记录留待启动恢复或重试继续，按实际结果返回成功（AD-R03）。
      }
    }
    return { roleId, keepHistory: false, filesRemoved };
  }

  private cleanupDirectory(roleId: string): boolean {
    try {
      fs.rmSync(rolePaths(this.dataRoot, roleId).roleDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
      return true;
    } catch {
      return false;
    }
  }
}
