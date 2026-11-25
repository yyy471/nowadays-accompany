'use strict';
const assert = require('node:assert/strict');
const { check } = require('./settings-media-sheet.e2e.cjs');

const sessions = ['旧书', '观星'].map((topic, index) => ({
  sessionId: 'exchange-' + index, topic, initiatorRoleId: 'a', targetRoleId: 'b', initiatorName: '甲角色', targetName: '乙角色',
  turnCount: 2, status: 'completed', reason: null, startedAt: new Date(Date.now() - (2 - index) * 60000).toISOString(),
}));
function route(path, req, res) {
  let body;
  if (path === '/v1/roles') body = {items: [
    {roleId: 'a', displayName: '甲角色', status: 'ready', defaultWindowId: 'wa'},
    {roleId: 'b', displayName: '乙角色', status: 'ready', defaultWindowId: 'wb'},
  ]};
  else if (path === '/v1/roles/a/autonomy/wakes') body = {items: [{
    wakeId: 'ordinary', roleId: 'a', kind: 'scheduled', status: 'completed', scheduledAt: sessions[0].startedAt,
    createdAt: sessions[0].startedAt, intent: '整理笔记',
  }]};
  else if (path === '/v1/role-exchanges') body = {items: sessions};
  else if (path.startsWith('/v1/role-exchanges/')) {
    const s = sessions.find(item => path.endsWith('/' + item.sessionId));
    body = {...s, turns: [s.initiatorName, s.targetName].map((speakerName, i) => ({
      exchangeId: s.sessionId + i, turnIndex: i + 1, speakerName, createdAt: s.startedAt, content: s.topic + (i ? '的回复' : '的开场'),
    }))};
  } else return false;
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
  return true;
}

check(async ({ev, until, errors}) => {
  await ev("document.querySelector('.ui-menu-trigger').click()");
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(b=>b.textContent.includes('动态')).click()");
  const slips = "[...document.querySelectorAll('.feed-slip')]";
  await until(() => ev(slips + ".filter(b=>b.textContent.includes('甲角色 与 乙角色 进行了对话')).length===2"), '全部时间线显示两次往来');
  assert.ok(await ev(slips + ".some(b=>b.textContent.includes('整理笔记'))"));
  await ev("[...document.querySelectorAll('[aria-label=类型筛选] button')].find(b=>b.textContent==='往来').click()");
  await until(() => ev(slips + ".length===2 && " + slips + ".every(b=>b.textContent.includes('2 轮'))"), '往来筛选');
  for (const s of sessions) {
    await ev(slips + ".find(b=>b.textContent.includes(" + JSON.stringify(s.topic) + ")).click()");
    await until(() => ev("document.querySelectorAll('[aria-label=完整聊天记录] li').length===2"), '完整记录');
    const transcript = await ev("[...document.querySelectorAll('[aria-label=完整聊天记录] li')].map(li=>[li.querySelector('strong').textContent, li.querySelector('p').textContent, li.querySelector('time').dateTime])");
    assert.deepEqual(transcript, [['甲角色', s.topic + '的开场', s.startedAt], ['乙角色', s.topic + '的回复', s.startedAt]]);
    await ev("document.querySelector('.feed-dialog button[aria-label=关闭弹窗]').click()");
    await until(() => ev("!document.querySelector('.feed-dialog')"), '纸笺关闭');
  }
  assert.deepEqual(errors, []);
}, route);
