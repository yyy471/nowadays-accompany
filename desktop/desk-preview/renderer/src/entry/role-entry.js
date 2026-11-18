/**
 * 冷启动选角页的纯逻辑（DL-147）。
 * 页面只负责渲染，排序、标识与选中解析放在这里，便于离线单测。
 */

/** 内置默认助手优先，其余保持后端返回顺序（创建顺序）。 */
export function entryRoles(roles) {
  return (roles || [])
    .map((role, index) => ({ role, index }))
    .sort((left, right) => {
      const builtin = Number(!!right.role.isBuiltin) - Number(!!left.role.isBuiltin);
      return builtin !== 0 ? builtin : left.index - right.index;
    })
    .map(item => item.role);
}

/** 内置角色在入口页与配置页使用的固定标识文案。 */
export function entryBadge(role) {
  return role && role.isBuiltin ? '内置助手' : null;
}

/** 卡片副标题：优先只读介绍，其次初始化状态。 */
export function entrySubtitle(role) {
  if (!role) return '';
  const bio = typeof role.bio === 'string' ? role.bio.trim() : '';
  if (bio) return bio;
  if (role.status && role.status !== 'ready') return '尚未就绪';
  return '还没有写下介绍';
}

/**
 * 冷启动是否需要先停在选角页。
 * 出错且没有任何角色时仍停在入口页，由页面呈现错误与重试，不闪进空工作区。
 */
export function needsEntryPick({ loading, roles, entered, error }) {
  if (entered) return false;
  if (loading) return true;
  // 无角色且读取失败时停在入口页，让 RoleEntry 的错误分支与「重试」可达。
  if (error && (roles || []).length === 0) return true;
  return (roles || []).length > 0;
}

/** 选定角色进入工作区；编号失效时回退到排序后的第一位。 */
export function resolveEntryChoice(roles, roleId) {
  const ordered = entryRoles(roles);
  if (roleId && ordered.some(role => role.roleId === roleId)) return roleId;
  return ordered[0] ? ordered[0].roleId : '';
}

/** 默认焦点：内置默认助手，其次第一位。 */
export function defaultEntryChoice(roles) {
  const ordered = entryRoles(roles);
  const builtin = ordered.find(role => role.isBuiltin);
  return builtin ? builtin.roleId : ordered[0] ? ordered[0].roleId : '';
}
