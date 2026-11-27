import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedExchangeTurns, upcomingForRole } from '../src/feed/data';
import { roleFaceImage } from '../src/components/role-face-image';

test('书签数量与展开清单共用选中角色的待办，按预定时间排序', () => {
  const wake = (roleId, status, hour) => ({ roleId, status, scheduledAt: new Date(hour * 3600000).toISOString() });
  const source = [wake('a', 'pending', 3), wake('a', 'completed', 1), wake('b', 'pending', 2), wake('a', 'pending', 1)];
  assert.deepEqual(upcomingForRole(source, 'all'), [source[3], source[2], source[0]]);
  assert.deepEqual(upcomingForRole(source, 'a'), [source[3], source[0]]);
  assert.deepEqual(upcomingForRole(source, 'missing'), []);
});

test('往来合笺按发言轮序排布，同一时间戳也保留发起人与收口人', () => {
  const turns = ['乙', '甲'].map((speakerName, i) => ({ turnIndex: 2 - i, speakerName, content: speakerName, createdAt: '2026-11-27T00:00:00Z' }));
  assert.deepEqual(orderedExchangeTurns(turns), [turns[1], turns[0]]);
  assert.equal(turns[0].turnIndex, 2);
});

test('同一角色更换素材后只裁切标明预设的图片，未标记旧图按自定义图处理', () => {
  const image = (home) => roleFaceImage('主角色', home);
  assert.equal(image({ assetId: 'preset', isPreset: true }).preset, true);
  assert.equal(image({ assetId: 'custom', isPreset: false }).preset, false);
  assert.equal(image({ assetId: 'old' }).preset, false);
  assert.match(image({ assetId: 'old' }).url, /appearance\/assets\/old$/);
  assert.equal(image(null), undefined);
});
