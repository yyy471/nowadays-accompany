import type { RoleListItem } from '../types';

export type ExtensionTool = { name: string } & (
  { scope: 'admin_only' | 'all_roles' } | { scope: 'selected_roles'; roleIds: string[] }
);

export function toolScopeLabel(tool: ExtensionTool, roles: Pick<RoleListItem, 'roleId' | 'displayName' | 'isBuiltin'>[]) {
  if (tool.scope !== 'selected_roles') return tool.scope === 'all_roles' ? '全员' : '仅主角色';
  const names = tool.roleIds.flatMap(id => {
    const role = roles.find(item => item.roleId === id);
    return role?.isBuiltin ? [] : [role?.displayName || id];
  });
  return names.length ? ['主角色', ...names].join('、') : '仅主角色';
}
