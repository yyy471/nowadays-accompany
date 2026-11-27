"use strict";

// Electron 换光验收：在真实渲染进程内观测点击、羽化、折页与图层清理。
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { resolveElectronExecutable } = require('../helpers/electron-executable.cjs');

const { repoRoot: root, desktopDir, xiachengPortraitFixture, testResultsDir } = require('../helpers/paths.cjs');
const results = path.join(testResultsDir, 'frontend-refinement-stage2');
fs.mkdirSync(results, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-transition-'));
const now = '2026-11-09T10:00:00.000Z';
const roles = [
  { roleId: 'role-one', displayName: '甲角色', status: 'ready', defaultWindowId: 'w0' },
  { roleId: 'role-two', displayName: '乙角色', status: 'ready', defaultWindowId: 'w0' }
];
const messages = [
  ['m1', 'user', '今天想听你说说窗外的事。'],
  ['m2', 'assistant', '窗外的梧桐开始落叶了，风把叶子推到石阶边上。'],
  ['m3', 'user', '那你把窗开一条缝吧。'],
  ['m4', 'assistant', '开了一条缝。风进来的时候带着一点凉，桌上的纸被吹起一角。'],
  ['m5', 'user', '听起来很安静。'],
  ['m6', 'assistant', '嗯，安静得能听见楼下有人在收摊。']
].map(([messageId, sender, content], index) => ({
  messageId, windowId: 'w0', sender, content, sequence: index + 1,
  sourcePlatform: 'nowadays', status: 'completed', submissionId: null, createdAt: now, updatedAt: now
}));

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(value));
}

let healthy = true, microPageLoads = 0;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const role = roles.find(item => p.includes(`/roles/${item.roleId}`)) ?? roles[0];
    if (p === '/v1/health') return json(res, { status: healthy ? 'ok' : 'unavailable', version: 'test' }, healthy ? 200 : 503);
    if (p === '/v1/extension-events') {
      res.writeHead(200, { 'content-type':'text/event-stream', 'access-control-allow-origin':'*' });
      res.write('event: snapshot\ndata: ' + JSON.stringify([{extId:'theme-sample',status:'enabled',version:'v1',ui:[{slot:'page',file:'ui/index.html'}]}]) + '\n\n');
      return;
    }
    if (p === '/v1/extensions/theme-sample/ui/index.html') {
      microPageLoads++;
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
      return res.end('<!doctype html><title>书签</title><p>今日书签</p>');
    }
    if (p === '/v1/roles') return json(res, { items: roles });
    if (p === `/v1/roles/${role.roleId}`) return json(res, { ...role, definition: { text: `${role.displayName}的介绍`, payload: {} }, definitionRevision: 1 });
    if (p.endsWith('/appearance/outfits')) return json(res, { items: [{ outfitId: 'o', roleId: role.roleId, name: '服饰', home: { assetId: 'portrait', outfitId: 'o', usage: 'home' }, sprites: [] }] });
    if (p.endsWith('/appearance/assets/portrait')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(fs.readFileSync(xiachengPortraitFixture));
    }
    if (p.endsWith('/state')) return json(res, { state: { outfitId: 'o', mood: `${role.displayName}的近况` }, stateVersion: 1, updatedAt: now });
    if (p.endsWith('/voice')) return json(res, { voice: null });
    if (p.endsWith('/windows')) return json(res, { items: [{ windowId: 'w0', roleId: role.roleId, kind: 'main', source: 'nowadays', createdAt: now, updatedAt: now }] });
    if (p.endsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*', connection: 'keep-alive' });
      res.write(': ready\n\n');
      return;
    }
    if (/\/windows\/[^/]+\/messages$/.test(p)) {
      return json(res, { items: messages, nextAfter: null, nextBefore: null, segments: [], activeReply: null, cursor: messages.length });
    }
    if (p.endsWith('/memory/search')) return json(res, { items: [{ type: 'event', id: 'event-1', title: `${role.displayName}的经历`, snippet: '一起散步' }] });
    if (p.endsWith('/memory/events/event-1')) return json(res, { title: `${role.displayName}的经历`, summary: '一起散步', subjectiveExperience: '很开心', experienceDate: '2026-11-09', sources: [{ evidenceId: 'e1' }] });
    if (p.endsWith('/memory/evidence/e1')) return json(res, { content: '保存的原始记录', occurredAt: now });
    if (p.endsWith('/diaries')) return json(res, { items: [{ diaryId: 'd1', experienceDate: '2026-11-09' }, { diaryId: 'd2', experienceDate: '2026-11-08' }] });
    if (/\/diaries\/d\d$/.test(p)) return json(res, { experienceDate: '2026-11-09', content: '# 日记\n\n这一天的记录。\n\n还有一段。' });
    return json(res, { error: { message: `unhandled ${p}` } }, 404);
  });
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, timeout = 20000) {
  let error;
  for (const start = Date.now(); Date.now() - start < timeout;) {
    try { const value = await test(); if (value) return value; } catch (e) { error = e; }
    await delay(80);
  }
  throw Error(`timeout ${error || ''}`);
}

let proc, ws, nextId = 0, logs = '';
const waiting = new Map();
const errors = [];
const timeline = [];
function cmd(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const result = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function shot(name) {
  const png = await cmd('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(results, name), Buffer.from(png.data, 'base64'));
}
const themeButton = label => `[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('${label}'))`;

// 以下探针在渲染进程内运行。点击、提交和节点移除共用 performance.now()。
function observeSwitch(to, fold) {
  const root = document.documentElement;
  const history = document.querySelector('.dialogue-history[data-open]');
  const selector = fold ? '.fold-morph i' : '.theme-snapshot';
  const present = () => !!document.querySelector(selector);
  const result = { to, dpr: devicePixelRatio, visibility: document.visibilityState, frames: [], ripple: false };
  return new Promise((resolve, reject) => {
    let start, raf;
    const timeout = setTimeout(() => { cleanup(); reject(Error('THEME_CLEANUP_TIMEOUT')); }, 2400);
    const observer = new MutationObserver(() => {
      if (!present()) {
        result.elapsed = performance.now() - start;
        result.final = root.dataset.uiPreset;
        result.clean = !document.querySelector('.theme-snapshot,.fold-morph i,.exlibris-ripple,.collection.illuminating')
          && !root.hasAttribute('data-switching') && !root.hasAttribute('data-theme-transition');
        result.history = !history || history === document.querySelector('.dialogue-history[data-open]');
        cleanup();
        resolve(result);
      }
    });
    function cleanup() { clearTimeout(timeout); cancelAnimationFrame(raf); observer.disconnect(); }
    function sample() {
      if (!present()) return;
      result.firstFrameMs ??= performance.now() - start;
      result.ripple ||= !!document.querySelector('.exlibris-ripple');
      if (fold) {
        const bars = [...document.querySelectorAll(selector)];
        const strip = document.querySelector('.edition-strip');
        const day = getComputedStyle(strip.querySelector('.letter-strip'));
        const night = getComputedStyle(strip.querySelector('.glass'));
        if (!result.bars) {
          const ticks = [...strip.querySelectorAll('.scale-ticks i')].map(i => i.getBoundingClientRect()).filter(r => r.width);
          const rect = strip.getBoundingClientRect(), parent = strip.parentElement;
          result.stripVisible = rect.height > 0 && rect.width > 0 && parent.querySelector('.breadcrumb').getBoundingClientRect().right <= rect.left && rect.right <= parent.querySelector('.folio').getBoundingClientRect().left;
          result.bars = bars.length;
          result.aligned = bars.length === ticks.length && bars.every((bar, i) => Math.abs(parseFloat(bar.style.getPropertyValue('--tick-x')) - ticks[i].left) < 1);
          result.lastTick = bars.at(-1).getAnimations()[0]?.effect.getComputedTiming().endTime;
          result.fade = [parseFloat(day.transitionDuration), parseFloat(night.transitionDuration)];
        }
        result.crossfade ||= Number(day.opacity) > .01 && Number(day.opacity) < .99 && Number(night.opacity) > .01 && Number(night.opacity) < .99;
        if (!result.commit && root.dataset.uiPreset === to) result.commit = performance.now() - start;
      } else {
        const feather = document.querySelector('.theme-feather'), style = getComputedStyle(feather);
        const edge = parseFloat(style.getPropertyValue('--theme-edge'));
        if (edge > 0 && edge < 100) {
          result.frames.push(edge);
          result.direction = style.getPropertyValue('--theme-direction').trim();
          result.mask = style.maskImage;
          result.warm = getComputedStyle(feather, '::after').backgroundImage;
          result.historyDuring = !history || (history.isConnected && !!feather.querySelector('.dialogue-history[data-open]'));
          result.iframes = feather.querySelectorAll('iframe').length;
        }
      }
      raf = requestAnimationFrame(sample);
    }
    const button = document.querySelector('.ui-theme-switcher [data-theme-choice="' + to + '"]');
    button.addEventListener('click', () => { start = performance.now(); }, { once: true, capture: true });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    button.click();
    result.clickMs = performance.now() - start;
    if (!present()) { cleanup(); reject(Error('THEME_LAYER_MISSING ' + JSON.stringify(result))); return; }
    raf = requestAnimationFrame(sample);
  });
}

async function measure(page, to, count) {
  const v = await ev('(' + observeSwitch.toString() + ')(' + JSON.stringify(to) + ',' + Boolean(count) + ')');
  timeline.push(page + ' ' + JSON.stringify(v));
  assert.equal(v.final, to);
  assert.ok(v.clean && v.history && !v.ripple, JSON.stringify(v));
  if (count) {
    assert.ok(v.elapsed >= 800 && v.elapsed <= 900, JSON.stringify(v));
    assert.equal(v.bars, count);
    assert.ok(v.stripVisible && v.aligned && v.crossfade && v.fade.every(n => n > 0), JSON.stringify(v));
    assert.ok(v.commit > 0 && v.commit < v.lastTick && v.lastTick >= 800 && v.lastTick <= v.elapsed, JSON.stringify(v));
  } else {
    assert.ok(v.elapsed <= 550 && v.frames.length > 1 && v.frames.at(-1) > v.frames[0], JSON.stringify(v));
    assert.equal(v.direction, to === 'daylight' ? 'to bottom' : 'to top');
    assert.match(v.mask, /linear-gradient/);
    assert.match(v.warm, /linear-gradient/);
    assert.ok(v.historyDuring && v.iframes === 0, JSON.stringify(v));
  }
}

// 截图单独走一次切换，截图编码和 CDP 往返均不进入时限断言。
async function pictureSwitch(to, name) {
  await ev("document.querySelector('[data-theme-choice=" + to + "]').click()");
  await ev("new Promise(resolve=>{const tick=()=>{const el=document.querySelector('.theme-feather');if(!el || parseFloat(getComputedStyle(el).getPropertyValue('--theme-edge'))>28)resolve();else requestAnimationFrame(tick)};tick()})");
  await shot(name);
  await until(() => ev("!document.querySelector('.theme-snapshot')"));
}

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    NOWADAYS_BACKEND_URL: `http://127.0.0.1:${server.address().port}`,
    NOWADAYS_APP_ROOT: path.join(temp, 'data'),
    NOWADAYS_SKIP_ROLE_PICKER: '1'
  };
  delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(resolveElectronExecutable({ repoRoot: root }), [
    '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'chrome')}`,
    desktopDir
  ], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', chunk => { logs += chunk; });
  proc.stderr.on('data', chunk => { logs += chunk; });
  const port = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(logs)?.[1]);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.startsWith('desk://bundle/')));
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const job = waiting.get(message.id);
      waiting.delete(message.id);
      message.error ? job?.reject(message.error) : job?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  };
  await cmd('Runtime.enable');
  // 并发 Electron 窗口可能互相遮挡，持续按用户正查看此页的状态测量可见帧。
  await cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(() => ev("!!document.querySelector('.ui-page-dock') && !!document.querySelector('.ui-theme-switcher')"));
  const resize = (width, height, deviceScaleFactor = 1) => cmd('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor, mobile:false});
  const direct = label => ev("[...document.querySelectorAll('.ui-dock-item')].find(b=>b.textContent.includes(" + JSON.stringify(label) + ")).click()");
  await cmd('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await until(() => ev("document.querySelector('.studio-connection')?.dataset.state==='online' && document.fonts.status==='loaded'"));
  // 原生窗口的首个样本从首页立绘就绪并绘制后开始，与后续页面使用同一点击计时口径。
  await until(() => ev("document.querySelector('.home-scene-character')?.naturalWidth > 0"));
  await ev('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const nativeWindow = await ev("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})");
  timeline.push('Windows 原生窗口 ' + JSON.stringify(nativeWindow));
  await measure('Windows 原生窗口', 'nightwave');
  await pictureSwitch('daylight', 'native-dpi-dawn.png');
  await resize(1280, 800);
  await cmd('Emulation.setEmulatedMedia', {features: [{name:'prefers-reduced-motion', value:'no-preference'}]});
  await until(() => ev("document.querySelector('.studio-connection')?.dataset.state === 'online'"));
  healthy = false;
  await ev("window.dispatchEvent(new Event('focus'))");
  await until(() => ev("document.querySelector('.studio-connection')?.dataset.state === 'offline' && document.querySelector('.studio-runtime').textContent.includes('2 位角色')"));
  healthy = true;
  await ev("window.dispatchEvent(new Event('focus'))");
  await until(() => ev("document.querySelector('.studio-connection')?.dataset.state === 'online'"));
  await shot('home-1280x800-daylight.png');
  await measure('桌面', 'nightwave');
  await shot('home-1280x800-nightwave.png');
  await measure('桌面', 'daylight');

  await ev("document.querySelector('.ui-menu-trigger').click()");
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(b=>b.textContent==='角色配置').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page === 'role-config' && !!document.querySelector('.config-book')"));
  await delay(600);
  await measure('设置壳', 'nightwave');
  await measure('设置壳', 'daylight');

  await ev("document.querySelector('.ui-menu-trigger').click()");
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(b=>b.textContent==='扩展').click()");
  await until(() => microPageLoads === 1 && ev("!!document.querySelector('iframe[data-extension-slot=page]')"));
  await measure('扩展微页', 'nightwave');
  await measure('扩展微页', 'daylight');
  assert.equal(microPageLoads, 1, '两次切屏只加载一次活动微页');
  await direct('关系');
  await until(() => ev("document.querySelector('.exlibris .collection')?.getBoundingClientRect().width > 1100"));
  await delay(900);
  await measure('关系宽屏', 'nightwave', 41);
  await shot('relations-1280x800-nightwave.png');
  await resize(720, 540);
  await measure('关系窄屏', 'daylight', 25);
  await shot('relations-720x540-daylight.png');
  await ev(`${themeButton('晚风电台')}.click()`);
  await delay(400);
  await shot('relations-720x540-fold.png');
  await until(() => ev("!document.querySelector('.fold-morph i')"));

  await direct('对话');
  await until(() => ev("document.querySelectorAll('.dialogue-message').length >= 4"));
  await delay(500);
  await measure('对话窄屏', 'daylight');
  await shot('dialogue-720x540-daylight.png');
  await pictureSwitch('nightwave', 'dialogue-720x540-dusk.png');
  await shot('dialogue-720x540-nightwave.png');
  await resize(1280, 800);
  await pictureSwitch('daylight', 'dialogue-1280x800-dawn.png');
  await measure('对话宽屏', 'nightwave');
  await ev("document.querySelector('.dialogue-history-button').click()");
  await until(() => ev("!!document.querySelector('.dialogue-history[data-open]')"));
  await delay(400);
  await measure('对话历史', 'daylight');
  await resize(1280, 800, 1.25);
  await ev('new Promise(resolve => requestAnimationFrame(resolve))');
  await measure('对话历史 125% DPI', 'nightwave');
  await pictureSwitch('daylight', 'history-125pct-dawn.png');
  await ev("document.querySelector('.dialogue-history-button').click()");
  await ev(`${themeButton('晚风电台')}.click();document.documentElement.dataset.motion='reduced'`);
  await until(() => ev("!document.querySelector('.theme-snapshot') && document.documentElement.dataset.uiPreset==='nightwave'"));
  await ev(`${themeButton('白昼来信')}.click();delete document.documentElement.dataset.motion`);
  await resize(1280, 800);

  // ---------- 减少动效 ----------
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await delay(120);
  await ev(`${themeButton('晚风电台')}.click()`);
  const reducedState = await ev("({theme:document.querySelector('.dialogue-page').dataset.theme, layers:document.querySelectorAll('.theme-snapshot,.config-theme-veil,.fold-morph i,.exlibris-ripple').length})");
  timeline.push('对话系统减少动效 ' + JSON.stringify(reducedState));
  assert.deepEqual(reducedState, {theme:'night',layers:0});
  await shot('dialogue-reduced-night.png');

  // 显式开启完整动效时允许折页，恢复系统减少动效则立即收束在最新主题。
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('关系')).click()");
  await until(() => ev("document.querySelector('.exlibris')?.dataset.motion === 'reduced'"));
  await ev("document.documentElement.dataset.motion = 'full'");
  await until(() => ev("document.querySelector('.exlibris')?.dataset.motion === 'full'"));
  await ev(`${themeButton('白昼来信')}.click()`);
  await until(() => ev("document.querySelector('.fold-morph i')?.getAnimations().length"));
  await ev("delete document.documentElement.dataset.motion");
  await until(() => ev("document.querySelector('.exlibris')?.dataset.theme === 'day' && !document.querySelector('.fold-morph i') && !document.documentElement.dataset.themeTransition"));

  fs.writeFileSync(path.join(results, 'timeline.txt'), `${timeline.join('\n')}\n`);
  assert.deepEqual(errors, [], `页面异常: ${errors.join(' | ')}`);
  console.log(timeline.join('\n'));
  console.log(`截图目录: ${path.relative(root, results)}`);
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 忽略 */ }
  try { proc?.kill(); } catch { /* 忽略 */ }
  server.close();
  await delay(400);
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 忽略 */ }
});
