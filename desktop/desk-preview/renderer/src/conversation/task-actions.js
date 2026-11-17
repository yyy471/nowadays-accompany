/**
 * 对话内「取消任务」入口的纯逻辑（310 §4.3 / DL-154）。
 * 只挑用户委托、仍可取消的任务；自主与记忆任务留给后台自行收敛。
 */

/** @param {Array<{taskId:string,status:string,continuable?:boolean,waitReason?:string|null,origin?:string,goal?:string,updatedAt?:string}>} tasks */
export function pickCancelableTask(tasks) {
  const candidates = (tasks || []).filter(task =>
    task && (task.status === 'active' || task.status === 'paused')
    && (task.origin ?? 'user') === 'user'
    && (task.status === 'active' || task.continuable !== false));
  if (candidates.length === 0) return null;
  const rank = task => (task.status === 'active' ? 0 : 1);
  return candidates.slice().sort((left, right) => {
    const byStatus = rank(left) - rank(right);
    if (byStatus !== 0) return byStatus;
    return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
  })[0];
}

/** 按钮文案：进行中与等待答复分开说，避免用户以为取消的是另一件事。 */
export function taskCancelLabel(task) {
  if (!task) return '';
  return task.status === 'active' ? '取消任务' : '取消等待中的任务';
}

/** 悬停提示：带上目标摘要，便于确认取消哪一条。 */
export function taskCancelTitle(task) {
  if (!task) return '';
  const goal = typeof task.goal === 'string' ? task.goal.trim() : '';
  const summary = goal.length > 60 ? `${goal.slice(0, 60)}…` : goal;
  const state = task.status === 'active' ? '正在办理' : '等待你答复';
  return summary ? `${state}：${summary}` : state;
}

/** 取消成功后的说明，区分「立即中止」与「结束等待中的任务链」。 */
export function taskCancelNotice(task) {
  return task && task.status === 'paused'
    ? '这条任务已取消，之后在这个窗口发消息不会自动接回。'
    : '任务已取消，已保存的进度仍留在本机。';
}
