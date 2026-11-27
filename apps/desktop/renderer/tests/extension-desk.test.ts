import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogForRole, catalogStatus, resolveDesk, type DeskPosition } from '../src/extensions/desk';
import type { Extension } from '../src/extensions/ExtensionSlotFrame';

const tile: Extension = { extId: 'game', version: '1', status: 'enabled', ui: [{ slot: 'page', file: 'a' }, { slot: 'widget', file: 'b' }],
  tools: [{ name: 'tool', scope: 'selected_roles', roleIds: ['a'] }], lastError: null };
const a = { roleId: 'a', displayName: '阿澄', status: 'ready', initError: null };

test('只有权威空快照给出邀请笺，正在读取与断线重连均不显示', () => {
  assert.equal(catalogStatus('loading', 0), 'loading');
  assert.equal(catalogStatus('reconnecting', 0), 'reconnecting');
  assert.equal(catalogStatus('ready', 0), 'empty');
  assert.equal(catalogStatus('ready', 1), 'installed');
});

test('角色范围和启用态过滤，全部、故障和无工具入口始终可查', () => {
  const items = [tile, { ...tile, extId: 'off', status: 'disabled' }, { ...tile, extId: 'bad', status: 'failed' },
    { ...tile, extId: 'none', tools: [] }, { ...tile, extId: 'public', tools: [{name:'p', scope:'all_roles' as const}] }];
  assert.equal(catalogForRole(items), items);
  const mixed: Extension = { ...tile, tools: [...tile.tools, { name:'review', scope:'admin_only' }] };
  assert.deepEqual(catalogForRole([mixed], a)[0]?.tools, tile.tools);
  assert.deepEqual(catalogForRole(items, a).map(i => i.extId), ['game', 'bad', 'none', 'public']);
  assert.deepEqual(catalogForRole(items, { ...a, roleId:'b' }).map(i => i.extId), ['bad', 'none', 'public']);
  assert.equal(catalogForRole(items, { ...a, roleId:'seat', isBuiltin:true }).length, 4);
});

test('台面书签保留视图和文件，按最新快照定位，停用、删除回到目录', () => {
  const mark: DeskPosition = { view:'desk', extId:'game', file:'b' };
  assert.equal(resolveDesk([tile]).view, 'desk');
  assert.equal(resolveDesk([{ ...tile, version:'2' }], mark).target?.extension.version, '2');
  assert.equal(resolveDesk([tile], mark).target?.entry.file, 'b');
  assert.equal(resolveDesk([tile], { ...mark, view:'catalog' }).view, 'catalog');
  assert.equal(resolveDesk([{ ...tile, extId:'other' }], mark).view, 'desk');
  for (const items of [[], [{ ...tile, status:'disabled' }], [{ ...tile, extId:'other' }]]) {
    assert.equal(resolveDesk(items, mark, true).view, 'catalog');
  }
});
