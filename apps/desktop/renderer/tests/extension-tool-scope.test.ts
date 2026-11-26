import assert from 'node:assert/strict';
import test from 'node:test';
import { toolScopeLabel } from '../src/extensions/tool-scope';

test('扩展工具分发范围显示角色名，缺失的角色保留 ID，主角色只显示一次', () => {
  const roles = [{ roleId: 'b', displayName: '阿澄' }, { roleId: 'seat', displayName: '管理员', isBuiltin: true }];
  const label = (roleIds: string[]) => toolScopeLabel({ name: 'stamp', scope: 'selected_roles', roleIds }, roles);
  assert.equal(label(['seat', 'b', 'removed']), '主角色、阿澄、removed');
  assert.equal(label([]), '仅主角色');
  assert.equal(toolScopeLabel({ name: 'stamp', scope: 'admin_only' }, roles), '仅主角色');
  assert.equal(toolScopeLabel({ name: 'stamp', scope: 'all_roles' }, roles), '全员');
});
