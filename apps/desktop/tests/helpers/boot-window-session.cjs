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
  const preset = mode === 'daylight' ? mode : 'nightwave';
  assert.equal(await ev("document.querySelector('.boot-gate')?.dataset.uiPreset"), preset);
  assert.equal(nativeTheme.themeSource, preset === 'daylight' ? 'light' : 'dark');
  assert.equal(win.getBackgroundColor().slice(-6).toUpperCase(), preset === 'daylight' ? 'F5F0E8' : '171D29');
  assert.equal(await ev("!!document.querySelector('.studio-shell,.role-entry')"), false);
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
  await delay(150);
  assert.deepEqual(await (await fetch(process.env.NOWADAYS_BACKEND_URL+'/test/fail')).json(), []);
  await wait("!document.querySelector('.boot-gate button').hidden", '失败纸页');
  assert.match(await ev("document.querySelector('.boot-gate [role=status]').textContent"), /健康检查/);
  await shots('failed');
  await ev("document.querySelector('.boot-gate button').click()");
  await wait("!!document.querySelector('.ui-menu-trigger')", '重试入壳');
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
    await wait("!!document.querySelector('.engineering-summary,.studio-footer-info')", '业务壳可见');
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
  await wait('!!document.querySelector('+JSON.stringify(row)+')', '配置行');
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
  if (mode === 'daylight') await ev("localStorage.setItem('nowadays.theme-preset.v1','nightwave')");
  trayClick('退出 Nowadays');
  expectingExit = true;
  await clickText('.desk-intent button','放弃修改并退出');
}
run().catch(error => { console.error(error); app.exit(1); });
