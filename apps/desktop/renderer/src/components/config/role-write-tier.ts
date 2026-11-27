/**
 * 角色配置写入的停机分级（DL-148 方案 A / UX-01）。
 *
 * 新增、保存与上传等热生效写入不再暂停角色；只有首次绑定对话模型时，
 * 才在停机状态下默认勾选「保存并立即启用角色」，保存后直接恢复活动。
 */
export function shouldDefaultEnableOnChatBind({ activityState, hasSavedChat }: {
  activityState?: string;
  hasSavedChat: boolean;
}): boolean {
  return activityState === 'stopped' && !hasSavedChat;
}
