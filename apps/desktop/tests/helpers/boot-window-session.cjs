'use strict';
// 仅测试入口拦获真实托盘菜单引用。生产 preload 和 Electron 主进程无自动化入口。
const { app, BrowserWindow, Tray, dialog, nativeTheme } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testResultsDir } = require('./paths.cjs');
const { until } = require('./live-desktop.cjs');
process.on('uncaughtException', error => { console.error(error.stack); app.exit(1); });
const mode = process.env.STAGE4_MODE;
const out = path.join(testResultsDir, 'frontend-refinement-stage4');
fs.mkdirSync(out, { recursive: true });
let menu, nativeCalls = 0, beforeUnload = 0, expectingExit = false;
const start = Date.now();
const attach = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (value) { menu = value; return attach.call(this, value); };
const show = dialog.showMessageBox;
dialog.showMessageBox = function (owner, options) {
  nativeCalls++;
  assert.equal(mode, 'unresponsive', '正常路径不得弹原生确认');
  assert.equal(options.buttons[1], '放弃修改并退出');
  // 按进程号与按钮文案找到真实 Windows 对话框，由 Win32 点击。
  const click = spawn('powershell.exe', ['-NoProfile', '-Command',
    '& {\n' + fs.readFileSync(path.join(__dirname, 'confirm-native-exit.ps1'), 'utf8') + '\n} ' + process.pid],
    { windowsHide: true, stdio: 'inherit' });
  click.on('exit', code => { if (code) app.exit(1); });
  return show.call(this, owner, options);
};
app.on('quit', () => console.log('STAGE4_QUIT'));
app.on('will-quit', () => {
  if (expectingExit && nativeCalls === Number(mode === 'unresponsive') && beforeUnload === 0) console.log('STAGE4_EXIT_VERIFIED');
});

// 健康响应返回前开始逐帧采样，覆盖首次冷启动及随后翻页。
function observeFastBoot() {
  localStorage.setItem('nowadays.motion-preference.v1', 'full');
  document.documentElement.dataset.motion = 'full';
  const cover = document.querySelector('.boot-gate');
  const details = cover.querySelector('.boot-details');
  const root = document.getElementById('root');
  const record = {
    phase: cover.dataset.phase, start: performance.getEntriesByType('navigation')[0].domContentLoadedEventStart,
    frames: 0, turnFrames: 0, maxOpacity: 0
  };
  window.fastBoot = record;
  const observer = new MutationObserver(() => {
    if (root.firstElementChild) record.mount ??= performance.now();
    if (!cover.isConnected) { record.removed = true; observer.disconnect(); }
  });
  observer.observe(root, { childList:true });
  observer.observe(document.body, { childList:true });
  function sample() {
    if (!cover.isConnected) return;
    record.frames++;
    if (cover.dataset.cover === 'opening') record.turnFrames++;
    record.maxOpacity = Math.max(record.maxOpacity, Number(getComputedStyle(details).opacity));
    requestAnimationFrame(sample);
  }
  sample();
}
// 在既有减少动效会话内覆盖发行渠道，复用真实主进程和 preload。
if (mode === 'clean') Object.defineProperty(app, 'isPackaged', { value: true });
require('../../electron/main.cjs');

async function run() {
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0], '主窗口');
  const ev = expr => win.webContents.executeJavaScript(expr);
  const wait = (expr, label) => until(() => ev(expr), label);
  const trayClick = label => menu.items.find(item => item.label === label).click();
  win.webContents.on('will-prevent-unload', () => beforeUnload++);
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  try { await until(() => win.isVisible(), '可见封面'); }
  catch (error) {
    console.error(await ev(`({url:location.href, content:document.body.innerText, bridge:!!window.nowadaysDesk,
      color:getComputedStyle(document.querySelector('.boot-gate')).backgroundColor})`));
    throw error;
  }
  const elapsed = Date.now() - start;
  console.log('STAGE4_COVER_MS', elapsed);
  assert.ok(elapsed < 3000, '窗口应在健康检查仍在途时秒开');
  if (mode === 'fast') {
    await ev('(' + observeFastBoot.toString() + ')()');
    assert.deepEqual(await (await fetch(process.env.NOWADAYS_BACKEND_URL + '/test/ready')).json(), []);
    await wait('window.fastBoot?.removed', '冷启动翻页结束').catch(async error => {
      console.error(await ev("({sample:window.fastBoot, phase:document.querySelector('.boot-gate')?.dataset.phase, mounted:!!document.querySelector('#root > *')})"));
      throw error;
    });
    const record = await ev('window.fastBoot');
    assert.equal(record.phase, 'service');
    assert.ok(record.mount > record.start && record.mount - record.start < 300, JSON.stringify(record));
    assert.ok(record.frames > record.turnFrames && record.turnFrames > 0);
    assert.equal(record.maxOpacity, 0, '快启动正文在等待与翻页的每个可绘制帧都应不可见');
    console.log('STAGE4_FAST_BOOT', JSON.stringify(record));
    await until(async () => (await (await fetch(process.env.NOWADAYS_BACKEND_URL+'/test/streams')).json()).length >= 2, '业务订阅');
    expectingExit = true;
    trayClick('退出 Nowadays');
    return;
  }
  const preset = mode === 'daylight' ? mode : 'nightwave';
  assert.equal(await ev("document.querySelector('.boot-gate')?.dataset.uiPreset"), preset);
  assert.equal(nativeTheme.themeSource, preset === 'daylight' ? 'light' : 'dark');
  assert.equal(win.getBackgroundColor().slice(-6).toUpperCase(), preset === 'daylight' ? 'F5F0E8' : '171D29');
  assert.equal(await ev("!!document.querySelector('.studio-shell,.role-entry')"), false);
  const loading = await ev(`(async () => {
    const cover = document.querySelector('.boot-gate'), mark = cover.querySelector('.boot-mark');
    await mark.decode();
    return { sibling: cover.parentElement === document.getElementById('root').parentElement,
      phase: cover.dataset.phase, steps: [...cover.querySelectorAll('.boot-steps li')].map(x => [x.textContent, x.dataset.state]),
      mark: [mark.alt, mark.width, mark.height], status: cover.querySelector('[role=status]').textContent,
      activeAnimations: cover.getAnimations({subtree:true}).length };
  })()`);
  assert.ok(loading.sibling);
  assert.equal(loading.phase, 'service');
  assert.deepEqual(loading.steps, [['点灯','done'], ['研墨','now'], ['翻开','waiting']]);
  assert.deepEqual(loading.mark, ['',44,48]);
  assert.equal(loading.status, '正在启动本机服务');
  if (mode === 'clean') assert.equal(loading.activeAnimations, 0, '保存的减少动效偏好从启动首帧生效');
  assert.equal(await ev("fetch('/api-config.json').then(r=>r.json()).then(x=>x.backendBaseUrl)"), '');
  async function shots(state) {
    if (!['daylight', 'nightwave'].includes(mode)) return;
    for (const [w,h] of [[720,540],[1280,800]]) {
      win.setContentSize(w,h);
      await wait('innerWidth===' + w + ' && innerHeight===' + h, '截图视口');
      await delay(300);
      const image = await win.webContents.capturePage();
      assert.ok(!image.isEmpty());
      fs.writeFileSync(path.join(out, [mode,state,w+'x'+h].join('-')+'.png'), image.toPNG());
    }
  }
  await ev("window.addEventListener('error', e => console.error(e.error?.stack || e.message))");
  await shots('boot');
  if (mode === 'daylight') await wait("/[1-9]\\d* 秒/.test(document.querySelector('.boot-elapsed').textContent)", '慢启动显示等待秒数');
  await delay(150);
  assert.deepEqual(await (await fetch(process.env.NOWADAYS_BACKEND_URL+'/test/fail')).json(), []);
  await wait("!document.querySelector('.boot-gate button').hidden", '失败纸页');
  assert.match(await ev("document.querySelector('.boot-gate [role=status]').textContent"), /健康检查/);
  assert.equal(await ev("document.querySelector('.boot-gate').dataset.phase"), 'failed');
  assert.equal(await ev("getComputedStyle(document.querySelector('.boot-lamp')).opacity"), '0.35');
  await shots('failed');
  const opening = await ev(`new Promise(resolve => {
    const cover = document.querySelector('.boot-gate'), leaf = cover.querySelector('.boot-leaf');
    const record = { workspace: false };
    const observer = new MutationObserver(() => {
      if (cover.dataset.phase === 'workspace') {
        record.workspace = cover.querySelector('.boot-steps li:last-child').dataset.state === 'now'
          && cover.querySelector('[role=status]').textContent === '本机服务已就绪，正在翻开资料';
      }
      if (cover.dataset.cover === 'opening' && record.mounted === undefined) {
        record.mounted = !!document.querySelector('#root .studio-shell, #root .role-entry');
        record.turn = leaf.getAnimations().find(a => a.animationName === 'boot-turn')?.effect.getTiming().duration ?? 0;
        record.fade = cover.getAnimations().find(a => a.animationName === 'boot-fade')?.effect.getTiming().duration ?? 0;
        record.instant = !cover.isConnected;
      }
      if (!cover.isConnected) { observer.disconnect(); resolve(record); }
    });
    observer.observe(cover, {attributes:true, attributeFilter:['data-phase','data-cover']});
    observer.observe(document.body, {childList:true});
    cover.querySelector('button').click();
  })`);
  assert.ok(opening.workspace && opening.mounted, '翻开从工作区首帧开始');
  if (mode === 'nightwave') assert.deepEqual([opening.turn, opening.fade, opening.instant], [360, 360, false]);
  if (mode === 'clean') assert.deepEqual([opening.turn, opening.fade, opening.instant], [0, 0, true]);
  console.log('STAGE4_BOOT_OPEN', JSON.stringify(opening));
  await wait("!!document.querySelector('.ui-menu-trigger')", '重试入壳');
  assert.equal(await ev('window.nowadaysDesk.isPackaged'), mode === 'clean');
  assert.equal(await ev("!!document.querySelector('.studio-edition')"), mode !== 'clean');
  if (mode === 'daylight') {
    for (const [choice, source, color] of [['nightwave', 'dark', '171D29'], ['daylight', 'light', 'F5F0E8']]) {
      await ev(`document.querySelector('[data-theme-choice="${choice}"]').click()`);
      await until(() => nativeTheme.themeSource === source && win.getBackgroundColor().toUpperCase().endsWith(color), '原生窗口随昼夜切换');
      if (process.platform === 'win32') assert.equal(win.getAccentColor().replace('#', '').toUpperCase(), color);
    }
  }
  await until(async () => (await (await fetch(process.env.NOWADAYS_BACKEND_URL + '/test/streams', { headers: { connection: 'close' } })).json()).length >= 2, '业务订阅');
  win.close();
  await until(() => !win.isVisible(), '干净窗口直接隐藏');
  trayClick('打开光影书房');
  if (mode === 'clean') {
    await ev("document.querySelector('.ui-menu-trigger').click()");
    await ev("[...document.querySelectorAll('.ui-menu-item')].find(item=>item.textContent.includes('设置')).click()");
    await wait("!!document.querySelector('.config-tabs button[aria-label=本机]')", '设置分区');
    await ev("document.querySelector('.config-tabs button[aria-label=本机]').click()");
    await wait("!!document.querySelector('#config-local-connection')", '本机配置');
    assert.equal(await ev("document.querySelector('#config-local-connection').innerText.includes('开发版')"), false);
    expectingExit = true;
    trayClick('退出 Nowadays');
    return;
  }
  if (mode === 'unresponsive') {
    expectingExit = true;
    // 渲染线程暂停，计时与托盘菜单仍由主进程执行。
    await ev("setTimeout(() => { const until = performance.now() + 25000; while (performance.now() < until) {} }, 0)");
    await delay(250);
    trayClick('退出 Nowadays');
    return;
  }
  await ev("document.querySelector('.ui-menu-trigger').click()");
  const clickText = async (selector, label) => {
    const expression = '[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(x=>x.textContent.includes(' + JSON.stringify(label) + '))';
    await wait('!!('+expression+')', label);
    await ev(expression+'.click()');
  };
  await clickText('.ui-menu-item', '角色配置');
  await clickText('.config-tabs button', '模型');
  const row = '.config-role-editor:not([hidden]) [data-edit="model:chat"] .config-sum-edit';
  await wait('document.querySelector('+JSON.stringify(row)+')?.getBoundingClientRect().height > 0', '模型分区切换后配置行可见');
  await ev('document.querySelector('+JSON.stringify(row)+').click()');
  await wait("!!document.querySelector('.config-sheet input')", '配置纸笺');
  await ev(`(() => {const input=document.querySelector('.config-sheet input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'尚未保存的书稿');
    input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const draft = () => ev("document.querySelector('.config-sheet input').value");
  await wait("!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))", '草稿守卫');
  // 在真窗口的请求仍在途时投递子帧与错号回执，均应保留原纸笺。
  require('electron').ipcMain.once('desk:intent-waiting', (event, id) => {
    const ipc = require('electron').ipcMain;
    ipc.emit('desk:intent-reply', { sender: event.sender, senderFrame: { url: 'about:blank' } }, id, true);
    ipc.emit('desk:intent-reply', event, id + 1, true);
  });
  win.close();
  win.close();
  trayClick('退出 Nowadays');
  await wait("document.querySelector('.desk-intent')?.textContent.includes('保留草稿并隐藏')", '关窗纸笺');
  assert.equal(await ev("document.querySelectorAll('.desk-intent').length"), 1);
  assert.ok(win.isVisible());
  await shots('hide');
  await clickText('.desk-intent button','继续编辑');
  await wait("!document.querySelector('.desk-intent')", '取消隐藏');
  assert.ok(win.isVisible());
  win.close();
  await clickText('.desk-intent button','保留草稿并隐藏');
  await until(() => !win.isVisible(), '保稿隐藏');
  // 托盘重开应回到原编辑器，随后再次隐藏并从托盘发起退出。
  trayClick('打开光影书房');
  assert.equal(await draft(), '尚未保存的书稿');
  await wait("!document.querySelector('.desk-intent')", '原纸笺已退出');
  win.close();
  await clickText('.desk-intent button','保留草稿并隐藏');
  await until(() => !win.isVisible(), '从托盘发起退出前已隐藏');
  trayClick('退出 Nowadays');
  await until(() => win.isVisible(), '退出纸笺回到前台');
  await wait("document.querySelector('.desk-intent')?.textContent.includes('放弃修改并退出')", '退出纸笺');
  await shots('quit');
  await clickText('.desk-intent button','继续编辑');
  await wait("!document.querySelector('.desk-intent')", '取消退出');
  assert.ok(win.isVisible());
  assert.equal(await draft(), '尚未保存的书稿');
  if (mode === 'daylight') await ev("localStorage.setItem('nowadays.theme-preset.v1','nightwave');localStorage.setItem('nowadays.motion-preference.v1','full')");
  if (mode === 'nightwave') await ev("localStorage.setItem('nowadays.motion-preference.v1','reduced')");
  trayClick('退出 Nowadays');
  expectingExit = true;
  await clickText('.desk-intent button','放弃修改并退出');
}
run().catch(error => { console.error(error); app.exit(1); });
