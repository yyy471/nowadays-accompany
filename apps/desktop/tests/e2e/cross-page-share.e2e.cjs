'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { xiachengPortraitFixture, testResultsDir } = require('../helpers/paths.cjs');
const { check } = require('./settings-media-sheet.e2e.cjs');
const { configControls, element, setValue } = require('../helpers/config-page-controls.cjs');

const roles = ['a', 'b'].map((roleId, i) => ({
  roleId, displayName: i ? '乙角色' : '甲角色', status: 'ready', isBuiltin: !!i,
  defaultWindowId: roleId + '-main',
}));
let engineeringStream;
const notices = new Set();
const chats = new Map();
const shares = [];
const reconnects = [];
const writes = [];
const date = new Date().toISOString();
const rolesReady = Promise.withResolvers();

function route(path, req, res) {
  const json = data => {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify(data));
    return true;
  };
  const stream = () => {
    res.writeHead(200, {'content-type': 'text/event-stream', 'access-control-allow-origin': '*'});
    res.write('retry: 100\n: connected\n\n');
  };
  if (req.method === 'POST') writes.push(path);
  if (path === '/v1/roles') {
    void rolesReady.promise.then(() => json({items: roles}));
    return true;
  }
  if (path === '/v1/engineering/events') {
    engineeringStream = res;
    stream();
    res.write('event: snapshot\ndata: ' + JSON.stringify([{jobId:'a1',extId:'index',title:'整理索引',startedAt:date}]) + '\n\n');
    return true;
  }
  if (path === '/v1/extension-events') {
    stream();
    const share = (id, summary) => res.write(`id: ${JSON.stringify({a: id})}\nevent: coplay-share\ndata: ${JSON.stringify({
      source: 'autonomy_share', roleId: 'a', windowId: 'a-main', messageId: 'coplay-' + id, summary,
    })}\n\n`);
    if (!req.headers['last-event-id']) {
      share(1, '角色列表之前的共玩');
      res.end();
    } else {
      assert.equal(req.headers['last-event-id'], '{"a":1}');
      share(2, '断流期间的共玩');
      share(2, '断流期间的共玩');
      res.write('event: notice\ndata: ' + JSON.stringify({extId:'labels',version:'1',message:'工具已打开'}) + '\n\n');
      rolesReady.resolve();
    }
    return true;
  }
  if (path === '/v1/roles/b/appearance/assets/home') {
    res.writeHead(200, {'content-type': 'image/png'});
    res.end(fs.readFileSync(xiachengPortraitFixture));
    return true;
  }
  if (path === '/v1/roles/b/share-events') {
    stream();
    notices.add(res);
    reconnects.push(req.headers['last-event-id']);
    res.on('close', () => notices.delete(res));
    return true;
  }
  const roleId = path.split('/')[3];
  const windowId = roleId + '-main';
  if (path.endsWith('/windows')) return json({items: [{windowId, roleId, source: 'nowadays', kind: 'main', createdAt: date, updatedAt: date}]});
  if (path.endsWith('/events')) {
    stream();
    chats.set(roleId, res);
    res.on('close', () => { if (chats.get(roleId) === res) chats.delete(roleId); });
    return true;
  }
  if (path.endsWith('/messages')) {
    const ids = roleId === 'b' ? shares : ['ongoing'];
    return json({items: ids.map((messageId, i) => ({messageId, windowId, sender: 'assistant', sequence: i + 1,
      content: messageId, status: roleId === 'b' ? 'completed' : 'generating', sourcePlatform: 'nowadays', createdAt: date, updatedAt: date})),
      segments: [], sceneImages: [], nextAfter: null, nextBefore: null, cursor: 0,
      activeReply: roleId === 'a' ? {executionId: 'running', messageId: 'ongoing'} : null});
  }
  return false;
}

function publish(id, source = 'autonomy_share', summary = id) {
  if (source === 'autonomy_share' && !shares.includes(id)) shares.push(id);
  const payload = {source, roleId: 'b', windowId: 'b-main', messageId: id, summary, homeAssetId: 'home'};
  for (const res of notices) res.write(`id: ${shares.length}\nevent: share\ndata: ${JSON.stringify(payload)}\n\n`);
}

check(async ({cmd, ev, until, errors}) => {
  const {tab, openRoleRow, click} = configControls(ev, until);
  const card = '.share-slip';
  const open = ".share-slip aside > button:last-child";
  const has = selector => ev(`!!document.querySelector(${JSON.stringify(selector)})`);
  const waitCard = id => until(() => ev(`document.querySelector('.share-slip p')?.textContent===${JSON.stringify(id)}`), '收到 ' + id);
  const locate = id => until(() => has(`[data-located][data-message-id="${id}"]`), '定位 ' + id);
  await until(() => notices.size === 1, '独立 SSE');
  await waitCard('角色列表之前的共玩');
  assert.equal(await ev("document.querySelector('.share-slip strong').textContent"), '甲角色');
  await click(element('[aria-label="关闭分享提示"]'));
  await waitCard('断流期间的共玩');
  await click(element('[aria-label="关闭分享提示"]'));
  await until(async () => !await has(card), '共玩重放按消息号去重');

  // 真正编辑配置纸笺，取消离开后可继续原编辑。
  await cmd('Emulation.setDeviceMetricsOverride', {width:720,height:540,deviceScaleFactor:1,mobile:false});
  await until(() => ev("innerWidth===720 && innerHeight===540 && !!document.querySelector('.extension-overlays')"), '窄屏统一浮层');
  await tab('模型');
  await openRoleRow('model:chat');
  await ev(setValue(element('.config-sheet input'), '草稿模型'));
  await ev("document.querySelector('.config-sheet input').focus(); window.prompts=[]; window.confirm=msg=>{prompts.push(msg);return false}");
  const summary = '窗外的梧桐开始落叶了，我把今天的见闻写在这里。'.repeat(12);
  publish('草稿中的分享', 'autonomy_share', summary);
  await waitCard(summary);
  assert.equal(await ev("document.activeElement===document.querySelector('.config-sheet input')"), true);
  await ev("Promise.allSettled(document.querySelector('.config-sheet').getAnimations().map(a=>a.finished))");
  const clearance = await ev(`(() => {
    const rect = s => document.querySelector(s).getBoundingClientRect();
    const hit = s => {
      const el = document.querySelector(s), r = rect(s);
      const top = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return el.contains(top) || [r.toJSON(), top?.className];
    };
    const left = rect('.studio-floating-column'), right = rect('.share-slip');
    const text = document.querySelector('.share-slip p');
    text.scrollTop = text.scrollHeight;
    return {height:left.height, gap:right.left-left.right, share:hit('${open}'), closeShare:hit('[aria-label="关闭分享提示"]'),
      scroll:text.scrollTop, shareWidth:right.width, shareHeight:right.height,
      save:hit('.config-sheet .config-save-btn'), close:hit('.config-sheet-x'), dock:hit('.ui-menu-trigger')};
  })()`);
  assert.ok(clearance.height<=192 && clearance.gap>=32, JSON.stringify(clearance));
  assert.ok(clearance.shareHeight <= 144 && clearance.shareWidth === 320 && clearance.gap === 32 && clearance.scroll > 0, JSON.stringify(clearance));
  console.log('窄屏浮层', JSON.stringify(clearance));
  await ev("document.querySelector('.share-slip p').scrollTop=0");
  const stageDir = path.join(testResultsDir, 'frontend-refinement-stage2');
  fs.mkdirSync(stageDir, {recursive:true});
  fs.writeFileSync(path.join(stageDir, 'share-720x540-draft.png'), Buffer.from((await cmd('Page.captureScreenshot', {format:'png'})).data, 'base64'));
  assert.ok([clearance.share,clearance.closeShare,clearance.save,clearance.close,clearance.dock].every(value => value === true), JSON.stringify(clearance));
  await click(element('.ui-menu-trigger'));
  await until(() => ev(`(() => {
    const items=[...document.querySelectorAll('.ui-menu-panel .ui-menu-item')];
    return items.length && items.every(item => {
      const r=item.getBoundingClientRect();
      return item.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    });
  })()`), '纸笺与左右浮层同时显示时更多菜单可命中');
  await ev("Promise.all(document.querySelector('.ui-menu-panel').getAnimations().map(a=>a.finished))");
  const menuGap = await ev("document.querySelector('.ui-menu-trigger').getBoundingClientRect().top - document.querySelector('.ui-menu-panel').getBoundingClientRect().bottom");
  assert.ok(Math.abs(menuGap - 8) < 1, '更多菜单向上展开，距触发器 8px');
  const key = async (key, code) => {
    for (const type of ['keyDown','keyUp']) await cmd('Input.dispatchKeyEvent', {type,key,windowsVirtualKeyCode:code});
  };
  await key('Escape', 27);
  await until(() => ev("document.activeElement.matches('.ui-menu-trigger') && !document.querySelector('.ui-menu-panel')"), '关闭菜单归还焦点');
  await key('ArrowUp', 38);
  await until(() => ev("document.activeElement===document.querySelector('.ui-menu-item:last-child')"), '向上进入末项');
  await key('ArrowDown', 40);
  assert.equal(await ev("document.activeElement===document.querySelector('.ui-menu-item:first-child')"), true);
  await key('End', 35);
  assert.equal(await ev("document.activeElement===document.querySelector('.ui-menu-item:last-child')"), true);
  await key('Escape', 27);
  await click("[...document.querySelectorAll('.extension-overlays button')].find(b=>b.textContent.includes('关闭提示'))");
  engineeringStream.write('event: snapshot\ndata: []\n\n');
  await until(() => ev("!document.querySelector('.studio-floating-column > *')"), '两项左下反馈都结束');
  assert.equal(await ev(`['.config-sheet-x','.config-save-btn','.ui-menu-trigger','${open}'].every(selector => {
    const button = document.querySelector(selector), box = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })`), true, '仅右下分享在场时纸笺和底栏仍可点');
  const point = await ev(`(() => {
    const target = document.querySelector('${open}');
    const r = target.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    return {x, y, reachable: target.contains(document.elementFromPoint(x, y))};
  })()`);
  assert.ok(point.reachable, '配置草稿打开时分享按钮仍可点击');
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cmd('Input.dispatchMouseEvent', {type, x: point.x, y: point.y, button: 'left', clickCount: 1});
  }
  assert.match(await ev('prompts.at(-1)'), /放弃修改/);
  assert.equal(await ev("document.querySelector('.config-sheet input').value"), '草稿模型');
  await ev('window.confirm=()=>true');
  await click(element(open));
  await locate('草稿中的分享');
  await cmd('Emulation.setDeviceMetricsOverride', {width:1280,height:800,deviceScaleFactor:1,mobile:false});
  assert.equal(await has(card), false);
  publish('主窗口中的分享');
  await ev("document.querySelector('.dialogue-role-switch button').click()");
  await click("[...document.querySelectorAll('.dialogue-role-switch [role=menuitemradio]')].find(b=>b.textContent.includes('甲角色'))");
  await until(() => chats.has('a'), '普通角色窗口');
  assert.equal(await has(card), false);
  const ongoing = chats.get('a');
  await until(() => has('.dialogue-advance-bar'), '普通角色正在生成');
  await click(element('[aria-label="演出设置"]'));
  await until(() => has('[role="dialog"]'), '打开全局弹窗');
  publish('生成期间的分享');
  await waitCard('生成期间的分享');
  assert.equal(await ev("!!document.querySelector('.share-slip').closest('[inert][aria-hidden=true]')"), true);
  await click(element('[role="dialog"] [aria-label="关闭弹窗"]'));
  await until(async () => !await has('[role="dialog"]'), '恢复背景交互');
  await waitCard('生成期间的分享');
  assert.equal(chats.get('a'), ongoing);
  await click(element('[aria-label="关闭分享提示"]'));
  const completed = {streamEventId: 1, executionId: 'running', type: 'message_completed', replyMessageId: 'ongoing'};
  ongoing.write(`id: 1\nevent: execution\ndata: ${JSON.stringify(completed)}\n\n`);
  await until(() => has('#dialogue-draft'), '原回复正常完成');
  await ev("document.querySelector('#dialogue-draft').focus()");
  await ev(setValue(element('#dialogue-draft'), '还在输入'));
  publish('系统通知', 'task_circuit_breaker');
  publish('同页跳转');
  await waitCard('同页跳转');
  assert.equal(await ev("document.activeElement.id==='dialogue-draft' && document.activeElement.value==='还在输入'"), true);
  assert.equal(chats.get('a'), ongoing);
  assert.equal(writes.some(p => p.endsWith('/cancel') || p.endsWith('/messages')), false);
  await click(element(open));
  try { await locate('同页跳转'); }
  catch (error) {
    console.error('分享定位现场', {messages:shares, windows:[...chats.keys()], view:await ev('document.body.innerText.slice(-1200)')});
    throw error;
  }

  await click(element('.ui-studio-brand'));
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='home'"), '主页');
  await cmd('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await ev("document.documentElement.dataset.motion='full'");
  publish('主页分享');
  await waitCard('主页分享');
  await until(() => ev("document.querySelector('.share-slip img')?.naturalWidth > 0 && document.querySelector('.share-slip strong').textContent==='乙角色'"), '角色名与立绘');
  await until(() => ev(`(() => {
    const style = getComputedStyle(document.querySelector('.share-slip aside'));
    return style.opacity === '1' && parseFloat(style.transitionDuration) > 0;
  })()`), '显式完整动效覆盖系统偏好，等待纸笺进入完成');
  const exitStarted = await ev(`new Promise(resolve => {
    const slip = document.querySelector('.share-slip aside');
    slip.style.setProperty('--nd-semantic-motion-micro-exit', '1s');
    const finish = value => { clearTimeout(timeout); slip.removeEventListener('transitionrun', onRun); resolve(value); };
    const onRun = event => {
      if (event.target !== slip || event.propertyName !== 'opacity' || !slip.hasAttribute('data-closing')) return;
      const fade = slip.getAnimations().find(animation => animation.transitionProperty === 'opacity');
      fade?.pause();
      finish(!!fade);
    };
    const timeout = setTimeout(() => finish(false), 3000);
    slip.addEventListener('transitionrun', onRun);
    slip.querySelector('[aria-label="关闭分享提示"]').click();
  })`);
  assert.equal(exitStarted, true, '收到纸笺透明度退场事件');
  publish('退场期间的新分享');
  await ev("document.documentElement.dataset.motion='reduced'");
  await waitCard('退场期间的新分享');
  assert.equal(await ev("document.querySelector('.share-slip aside').getAnimations().length"), 0);
  await click(element('[aria-label="关闭分享提示"]'));
  await until(() => ev("!document.querySelector('.share-slip')"), '减少动效下立即撤下纸笺');
  await ev("delete document.documentElement.dataset.motion");
  await cmd('Emulation.setEmulatedMedia', {features: []});
  for (const res of notices) res.end();
  await until(() => reconnects.length > 1 && notices.size === 1, 'SSE 重连');
  assert.ok(reconnects.at(-1), '保留 Last-Event-ID');
  publish('主页分享');
  publish('重连后的新分享');
  await waitCard('重连后的新分享');
  assert.deepEqual(errors, []);
}, route);
