'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { xiachengPortraitFixture } = require('../helpers/paths.cjs');
const { check } = require('./settings-media-sheet.e2e.cjs');
const { configControls, element, setValue } = require('../helpers/config-page-controls.cjs');

const roles = ['a', 'b'].map((roleId, i) => ({
  roleId, displayName: i ? '乙角色' : '甲角色', status: 'ready', isBuiltin: !!i,
  defaultWindowId: roleId + '-main',
}));
const notices = new Set();
const chats = new Map();
const shares = [];
const reconnects = [];
const writes = [];
const date = new Date().toISOString();

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
  if (path === '/v1/roles') return json({items: roles});
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

function publish(id, source = 'autonomy_share') {
  if (source === 'autonomy_share' && !shares.includes(id)) shares.push(id);
  const payload = {source, roleId: 'b', windowId: 'b-main', messageId: id, summary: id, homeAssetId: 'home'};
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

  // 真正编辑配置纸笺，取消离开后可继续原编辑。
  await tab('模型');
  await openRoleRow('model:chat');
  await ev(setValue(element('.config-sheet input'), '草稿模型'));
  await ev("document.querySelector('.config-sheet input').focus(); window.prompts=[]; window.confirm=msg=>{prompts.push(msg);return false}");
  publish('草稿中的分享');
  await waitCard('草稿中的分享');
  assert.equal(await ev("document.activeElement===document.querySelector('.config-sheet input')"), true);
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
  assert.equal(await has(card), false);
  publish('主窗口中的分享');
  await ev("document.querySelector('.dialogue-role-switch button').click()");
  await click("[...document.querySelectorAll('.dialogue-role-switch [role=menuitem]')].find(b=>b.textContent.includes('甲角色'))");
  await until(() => chats.has('a'), '普通角色窗口');
  assert.equal(await has(card), false);
  const ongoing = chats.get('a');
  await until(() => has('.dialogue-advance-bar'), '普通角色正在生成');
  publish('生成期间的分享');
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
  await locate('同页跳转');

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
