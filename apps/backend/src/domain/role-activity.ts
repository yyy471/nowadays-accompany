import type { RoleInitStatus } from "../storage/app-store.js";

/** 角色活动的三态。active 表示允许活动，不等于「此刻正在执行」。 */
export type RoleActivityState = "active" | "stopping" | "stopped";

/** 因请求停止而暂停的任务链标记；恢复时据此把原任务接回调度。 */
export const ROLE_STOP_TASK_END_REASON = "ROLE_STOP_REQUESTED";

export interface RoleActivityRecord {
  roleId: string;
  state: RoleActivityState;
  requestedAt: string | null;
  confirmedAt: string | null;
  /** 停止边界所在执行；没有执行时直接确认，为 null。 */
  boundaryExecutionId: string | null;
  /** 没有持久化记录时为 null，此时状态视为 active。 */
  updatedAt: string | null;
}

export interface RoleActivityView extends RoleActivityRecord {
  /** DL-148：初始化状态与活动状态分别返回，前端开关不能替代后端确认。 */
  initStatus: RoleInitStatus;
  /** 此刻是否有执行在跑；用于区分「请求停止但尚未到边界」。 */
  running: boolean;
}

export interface RoleActivityStopResult {
  activity: RoleActivityView;
  /** 是否已在调用内确认停止（无执行在跑时立即确认）。 */
  confirmed: boolean;
}

/** DL-148 停止边界：由对话服务在图的模型／工具节点入口调用。 */
export interface RoleActivityGate {
  isStopRequested(roleId: string): boolean;
  confirmStop(roleId: string, executionId: string | null): void;
  /** 活动是否允许启动；已停止或正在停止时拒绝新的对话与自主唤醒。 */
  canStart(roleId: string): boolean;
}

/** 对话服务提供的实时执行状态与恢复后的重新调度入口。 */
export interface ActivityRuntime {
  isRunning(roleId: string): boolean;
  /**
   * 恢复成功后把因停止而暂停的原任务链与到期待办接回调度。
   * 不清理任何待办、不重置自主额度；失败不回滚已恢复的活动状态。
   */
  resumeWork?(roleId: string): void;
}
