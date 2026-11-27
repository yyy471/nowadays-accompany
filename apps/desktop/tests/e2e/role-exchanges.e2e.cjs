'use strict';
const assert = require('node:assert/strict');
const { check } = require('./settings-media-sheet.e2e.cjs');

const sessions = ['旧书', '观星'].map((topic, index) => ({
  sessionId: 'exchange-' + index, topic, initiatorRoleId: 'a', targetRoleId: 'b', initiatorName: '甲角色', targetName: '乙角色',
  turnCount: 2, status: 'completed', reason: null, startedAt: new Date(Date.now() - (2 - index) * 60000).toISOString(),
}));
const roles = [
  {roleId: 'a', displayName: '甲角色', status: 'ready', defaultWindowId: 'wa'},
  {roleId: 'b', displayName: '乙角色', status: 'ready', defaultWindowId: 'wb'},
  ...Array.from({length: 7}, (_, i) => ({
    roleId: 'extra-' + i, displayName: '记录很多的角色 ' + i, status: 'ready', defaultWindowId: 'w' + i,
  })),
];
const firstIntent = '你第一次开始活动。只有确实想主动分享时才用 autonomy_share。';
const wakes = Array.from({length: 4}, (_, i) => ({
  wakeId: i === 1 ? 'first-activation:b' : 'pending-' + i, roleId: i === 0 ? 'a' : 'b', kind: 'scheduled', status: 'pending',
  scheduledAt: new Date(Date.now() + (i === 3 ? 24 : i + 1) * 3600000).toISOString(),
  createdAt: new Date(Math.floor(Date.parse(sessions[0].startedAt) / 60000) * 60000 + i * 1000).toISOString(),
  intent: i === 1 ? firstIntent : '下一项安排 ' + i,
}));
const sharedMessage = {
  messageId: 'old-share', windowId: 'wa', content: '整理书桌时发现的一张旧纸签',
  createdAt: new Date(Date.now() - 3600000).toISOString(),
};
let exchangeReads = 0;
let exchangeStatus = 200;
let holdExchange = false;
let releaseExchange;
function route(path, req, res) {
  let body;
  if (path === '/v1/roles') body = {items: roles};
  else if (path === '/v1/roles/a/autonomy/wakes') body = {items: [...wakes.filter(wake => wake.roleId === 'a'), {
    wakeId: 'ordinary', roleId: 'a', kind: 'scheduled', status: 'completed', scheduledAt: sessions[0].startedAt,
    createdAt: sessions[0].startedAt, intent: '整理笔记',
  }, {
    wakeId: 'first-activation:a', roleId: 'a', kind: 'scheduled', status: 'completed',
    scheduledAt: sharedMessage.createdAt, createdAt: sharedMessage.createdAt, intent: firstIntent,
  }]};
  else if (path === '/v1/roles/b/autonomy/wakes') body = {items: wakes.filter(wake => wake.roleId === 'b')};
  else if (path === '/v1/roles/a/autonomy/activities') body = {items: [{
    activityId: 'share', roleId: 'a', wakeId: 'first-activation:a', taskId: 'task', windowId: 'wa', status: 'completed',
    startedAt: sharedMessage.createdAt, finishedAt: sharedMessage.createdAt, sharedMessageId: sharedMessage.messageId, sharedMessage,
  }]};
  else if (path === '/v1/roles/a/tasks') body = {items: [{ taskId: 'task', roleId: 'a', goal: firstIntent }]};
  else if (path === '/v1/roles/a/windows') body = {items: [{
    windowId: 'wa', roleId: 'a', source: 'nowadays', kind: 'main', createdAt: sharedMessage.createdAt, updatedAt: sharedMessage.createdAt,
  }]};
  else if (path.endsWith('/windows/wa/messages')) body = {
    items: [{...sharedMessage, sender: 'assistant', sequence: 1, status: 'completed', sourcePlatform: 'nowadays', updatedAt: sharedMessage.createdAt}],
    segments: [], sceneImages: [], nextAfter: null, nextBefore: null, activeReply: null, cursor: 0,
  };
  else if (path === '/v1/role-exchanges') {
    exchangeReads++;
    const status = exchangeStatus;
    const respond = () => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(JSON.stringify(status === 200 ? {items: sessions} : {message: '动态读取暂时不可用'}));
    };
    if (holdExchange) releaseExchange = respond;
    else respond();
    return true;
  }
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

check(async ({cmd, ev, until, errors}) => {
  await cmd('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'no-preference'}]});
  await ev("document.querySelector('.ui-menu-trigger').click()");
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(b=>b.textContent.includes('动态')).click()");
  const slips = "[...document.querySelectorAll('.feed-slip')]";
  await until(() => ev("document.querySelectorAll('.feed-exchange').length===2"), '全部时间线显示两张合笺');
  const cards = await ev("[...document.querySelectorAll('.feed-slip.feed-exchange')].map(card => ({names:[...card.querySelectorAll('.feed-event-title strong')].map(el=>el.textContent), topic:card.querySelector('.feed-exchange-topic').textContent, count:card.querySelector('.feed-turn-count').textContent}))");
  assert.deepEqual(cards, [...sessions].reverse().map(s => ({names:[s.initiatorName, s.targetName], topic:s.topic, count:s.turnCount + ' 轮'})));
  assert.ok(await ev(slips + ".some(b=>b.textContent.includes('整理笔记'))"));
  assert.equal(await ev("document.querySelector('.feed-scope').textContent.includes('autonomy_share')"), false);
  await ev(slips + ".find(b=>b.classList.contains('feed-letter')).click()");
  await until(() => ev("document.querySelector('.feed-dialog')?.innerText.includes('首次活动')"), '首次活动来源');
  assert.equal(await ev("document.querySelector('.feed-dialog').textContent.includes('autonomy_share')"), false, '任务目标与来源均隐藏首次意图');
  await ev("document.querySelector('.feed-dialog button[aria-label=关闭弹窗]').click()");
  await until(() => ev("!document.querySelector('.feed-dialog')"), '关闭活动详情');
  await ev("[...document.querySelectorAll('[aria-label=类型筛选] button')].find(b=>b.textContent==='安排').click()");
  await until(() => ev(slips + ".length===6 && " + slips + ".filter(b=>b.querySelector('.feed-event-title').textContent.includes('首次活动')).length===2"), '安排筛选保留两位角色的首次活动');
  const minuteRows = await ev(`[...document.querySelectorAll('.feed-event > time')].map(time => ({
    at: time.dateTime, text: time.textContent, opacity: getComputedStyle(time).opacity, repeat: time.hasAttribute('data-repeat')
  }))`);
  assert.ok(minuteRows.some(row => row.repeat), '同分钟连续安排应收起重复时刻');
  minuteRows.forEach((row, index) => {
    const repeat = index > 0 && Math.floor(Date.parse(row.at) / 60000) === Math.floor(Date.parse(minuteRows[index - 1].at) / 60000);
    assert.equal(row.repeat, repeat);
    assert.equal(row.opacity, repeat ? '0' : '1');
    assert.match(row.text, /^\d{2}:\d{2}$/);
  });
  assert.match(await ev(slips + ".find(b=>b.textContent.includes('整理笔记')).querySelector('.feed-number').textContent"), /^\d{2}:\d{2}$/, '同日安排只显示时刻');
  assert.match(await ev(slips + ".find(b=>b.textContent.includes('下一项安排 3')).querySelector('.feed-number').textContent"), /月.*日/, '跨日安排保留日期');
  await ev("[...document.querySelectorAll('[aria-label=类型筛选] button')].find(b=>b.textContent==='往来').click()");
  await until(() => ev(slips + ".length===2 && " + slips + ".every(b=>b.textContent.includes('2 轮'))"), '往来筛选');
  for (const s of sessions) {
    await ev(slips + ".find(b=>b.textContent.includes(" + JSON.stringify(s.topic) + ")).click()");
    await until(() => ev("document.querySelectorAll('[aria-label=完整聊天记录] li').length===2"), '完整记录');
    const transcript = await ev("[...document.querySelectorAll('[aria-label=完整聊天记录] li')].map(li=>[li.querySelector('strong').textContent, li.querySelector('p').textContent, li.querySelector('time').dateTime])");
    assert.deepEqual(transcript, [['甲角色', s.topic + '的开场', s.startedAt], ['乙角色', s.topic + '的回复', s.startedAt]]);
    await ev("document.querySelector('.feed-dialog button[aria-label=关闭弹窗]').click()");
    await until(() => ev("!document.querySelector('.feed-dialog')"), '纸笺关闭');
    assert.equal(await ev("document.activeElement.closest('.feed-exchange')?.querySelector('.feed-exchange-topic').textContent"), s.topic, '焦点回到本张合笺');
  }

  await cmd('Emulation.setDeviceMetricsOverride', {width: 720, height: 540, deviceScaleFactor: 1, mobile: false});
  const bookmark = "document.querySelector('.feed-bookmark .ui-disclosure-trigger')";
  await until(() => ev("innerWidth===720 && " + bookmark + "?.getAttribute('aria-expanded')==='false'"), '窄屏书签默认收起');
  assert.equal(await ev("document.querySelectorAll('.feed-bookmark .ui-disclosure-trigger').length"), 1);
  assert.equal(await ev("document.querySelectorAll('.feed-next-list').length"), 1);
  const panel = "document.getElementById(" + bookmark + ".getAttribute('aria-controls'))";
  assert.equal(await ev(panel + ".getBoundingClientRect().height"), 0);
  await ev(bookmark + ".click()");
  await until(() => ev(bookmark + ".getAttribute('aria-expanded')==='true' && " + panel + ".offsetHeight>0"), '展开接下来');
  for (const [i, wake] of wakes.entries()) {
    const button = panel + ".querySelectorAll('.feed-next-open')[" + i + "]";
    await ev(button + ".scrollIntoView({block:'center',behavior:'instant'})");
    const point = await ev("(() => {const b=" + button + ", r=b.getBoundingClientRect(), x=r.left+r.width/2,y=r.top+r.height/2; return b.contains(document.elementFromPoint(x,y)) ? {x,y} : null;})()");
    assert.ok(point, wake.intent + ' 可在书页内滚动触达');
    await cmd('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
    await cmd('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
    const expected = wake.wakeId.startsWith('first-activation:') ? '首次活动' : wake.intent;
    await until(() => ev("document.querySelector('.feed-dialog')?.innerText.includes(" + JSON.stringify(expected) + ")"), expected);
    if (expected === '首次活动') {
      assert.equal(await ev("document.querySelector('.feed-dialog').textContent.includes('autonomy_share')"), false);
      assert.equal(await ev(button + ".closest('li').textContent.includes('首次活动')"), true);
    }
    await ev("document.querySelector('.feed-dialog button[aria-label=关闭弹窗]').click()");
    await until(() => ev("!document.querySelector('.feed-dialog')"), '返回安排');
  }
  await ev(bookmark + ".scrollIntoView({block:'start'}); " + bookmark + ".click()");
  assert.equal(await ev(bookmark + ".getAttribute('aria-expanded')"), 'false');
  assert.equal(await ev(panel + ".getBoundingClientRect().height"), 0);
  const layout = await ev(`(() => {
    const roles = document.querySelector('.feed-roles'), types = document.querySelector('[aria-label=类型筛选]');
    const page = document.querySelector('.feed-leaf');
    return {rolesScroll: roles.scrollWidth > roles.clientWidth,
      spacing: types.getBoundingClientRect().left - roles.getBoundingClientRect().right,
      viewportFits: document.documentElement.scrollWidth === innerWidth && types.getBoundingClientRect().right <= page.getBoundingClientRect().right};
  })()`);
  assert.equal(layout.rolesScroll, true, JSON.stringify(layout));
  assert.ok(layout.spacing >= 8);
  assert.equal(layout.viewportFits, true);

  const refresh = "document.querySelector('[aria-label=刷新动态]')";
  const receipt = "document.querySelector('.feed-scope .ui-live[role=status]')";
  const startRefresh = async () => {
    holdExchange = true;
    releaseExchange = undefined;
    await ev(refresh + '.focus(); ' + refresh + '.click()');
    await until(() => releaseExchange && ev(refresh + ".getAttribute('aria-busy')==='true'"), '刷新等待在途响应');
    assert.equal(await ev(receipt + ".textContent.trim()"), '');
    assert.equal(await ev("document.activeElement===" + refresh), true);
    holdExchange = false;
    releaseExchange();
  };
  await startRefresh();
  await until(() => ev(receipt + ".textContent==='动态与安排已刷新'"), '手动刷新成功回执');
  assert.equal(await ev("document.querySelector('.feed-scope .config-result-notice').dataset.tone"), 'success');

  exchangeStatus = 503;
  await startRefresh();
  await until(() => ev(receipt + ".textContent==='安排已刷新，动态暂时无法刷新'"), '手动刷新部分失败回执');
  assert.equal(await ev("document.querySelector('.feed-scope .config-result-notice').dataset.tone"), 'warning');
  assert.notEqual(await ev(refresh + ".getAttribute('aria-busy')"), 'true');
  assert.equal(await ev(slips + '.length'), 2);
  await ev("document.querySelector('.feed-scope .config-result-notice').click()");
  exchangeStatus = 200;
  const previousReads = exchangeReads;
  await ev("document.dispatchEvent(new Event('visibilitychange'))");
  await until(() => exchangeReads > previousReads && ev("!document.querySelector('.feed-error')"), '后台恢复读取');
  assert.equal(await ev(receipt + ".textContent.trim()"), '');
  assert.equal(await ev("!!document.querySelector('.feed-scope .config-result-notice')"), false);

  const shares = "[...document.querySelectorAll('[aria-label=类型筛选] button')].find(b=>b.textContent==='分享')";
  const activity = "document.querySelector('[data-feed-chat]')";
  await ev(shares + '.click()');
  await until(() => ev("!!" + activity), '筛出分享');
  const openShare = async () => {
    await ev(activity + '.click()');
    await until(() => ev("!!document.querySelector('.dialogue-message[data-message-id=old-share][data-located]')"), '进入对话并定位原文');
    await ev("[...document.querySelectorAll('.dialogue-role-button')].find(b=>b.textContent.includes('返回动态')).click()");
  };
  await openShare();
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='feed' && !document.documentElement.hasAttribute('data-feed-transition') && !!document.querySelector('.feed-return-ink')"), '返回动态并开始原卡定格');
  assert.ok(await ev("document.querySelector('.feed-return-ink').getAnimations().some(a=>a.animationName==='feed-locate' && a.playState==='running')"));
  const checkLocation = async () => {
    assert.equal(await ev("document.activeElement===" + activity), true);
    assert.equal(await ev(`(() => {
      const target = ${activity}.getBoundingClientRect(), area = document.querySelector('.feed-scroll').getBoundingClientRect();
      return target.top >= area.top && target.bottom <= area.bottom;
    })()`), true);
    assert.equal(await ev(shares + ".getAttribute('aria-pressed')"), 'true');
  };
  await checkLocation();
  await cmd('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await openShare();
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='feed' && !!document.querySelector('.feed-return-ink')"), '减少动效下恢复原卡');
  assert.equal(await ev("document.querySelector('.feed-return-ink').getAnimations().length"), 0);
  await checkLocation();
  await cmd('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'no-preference'}]});
  await ev(`(() => {
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = update => start(() => new Promise(resolve => {
      window.releaseFeedNavigation = () => { update(); resolve(); };
    }));
  })()`);
  await ev(activity + '.click()');
  await until(() => ev("typeof window.releaseFeedNavigation==='function'"), '动态离开等待快照回调');
  await ev("document.querySelector('.ui-studio-brand').click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='home'"), '更新的导航完成');
  await ev("window.releaseFeedNavigation()");
  await ev("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))");
  assert.equal(await ev("document.querySelector('.studio-shell').dataset.page"), 'home', '被取消的动态跳转不能覆盖新页面');
  assert.equal(await ev("document.documentElement.hasAttribute('data-feed-transition')"), false);
  assert.deepEqual(errors, []);
}, route);
