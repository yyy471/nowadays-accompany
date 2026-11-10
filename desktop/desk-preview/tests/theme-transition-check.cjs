"use strict";

// 换光验收：真实 Electron + 隔离假服务，实拍对话页日夜切换的中间帧，
// 并确认关系页仍是原来的折页刻度（快照推进方案已回滚）。
// 仓库根目录运行：node desktop/desk-preview/tests/theme-transition-check.cjs
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const root = process.cwd();
const results = path.join(root, 'backend', 'test-results', 'theme-transition');
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

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const role = roles.find(item => p.includes(`/roles/${item.roleId}`)) ?? roles[0];
    if (p === '/v1/health') return json(res, { status: 'ok', version: 'test' });
    if (p === '/v1/roles') return json(res, { items: roles });
    if (p === `/v1/roles/${role.roleId}`) return json(res, { ...role, definition: { text: `${role.displayName}的介绍`, payload: {} }, definitionRevision: 1 });
    if (p.endsWith('/appearance/outfits')) return json(res, { items: [{ outfitId: 'o', roleId: role.roleId, name: '服饰', home: { assetId: 'portrait', outfitId: 'o', usage: 'home' }, sprites: [] }] });
    if (p.endsWith('/appearance/assets/portrait')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(fs.readFileSync(path.join(root, 'desktop/desk-preview/renderer/src/assets/themes/xiacheng/character.png')));
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

async function burst(prefix, count, gap) {
  for (let index = 0; index < count; index += 1) {
    const at = Date.now();
    await shot(`${prefix}-${String(index + 1).padStart(2, '0')}.png`);
    timeline.push(`${prefix}-${index + 1} ${Date.now() - at}ms 截图`);
    await delay(gap);
  }
}

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    NOWADAYS_BACKEND_URL: `http://127.0.0.1:${server.address().port}`,
    NOWADAYS_APP_ROOT: path.join(temp, 'data')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [
    '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'chrome')}`,
    path.join(root, 'desktop/desk-preview')
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
  await until(() => ev("!!document.querySelector('.ui-page-dock') && !!document.querySelector('.ui-theme-switcher')"));
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });

  // ---------- 关系页：保持原有折页刻度（快照推进方案已按用户意见回滚） ----------
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('关系')).click()");
  await until(() => ev("document.querySelector('.exlibris .collection')?.getBoundingClientRect().width > 1100"));
  await delay(1200);
  await shot('relations-day.png');
  await ev(`${themeButton('晚风电台')}.click()`);
  await delay(160);
  const fold = await ev("JSON.stringify({mode:document.documentElement.dataset.themeTransition||'',bars:document.querySelectorAll('.fold-morph i').length,ripple:document.querySelectorAll('.exlibris-ripple').length,theme:document.querySelector('.exlibris')?.dataset.theme})");
  timeline.push(`关系 夜切: ${fold}`);
  assert.match(fold, /"mode":"relationship-journal"/);
  assert.match(fold, /"bars":41/);
  assert.match(fold, /"ripple":0/);
  const stripAlignment = await ev("(()=>{const r=document.querySelector('.edition-strip').getBoundingClientRect(),bars=[...document.querySelectorAll('.fold-morph i')],x=e=>parseFloat(e.style.getPropertyValue('--tick-x'));return {left:r.left,right:r.right,first:x(bars[0]),last:x(bars[bars.length-1]),dayFade:getComputedStyle(document.querySelector('.edition-strip .letter-strip')).transitionDuration,nightFade:getComputedStyle(document.querySelector('.edition-strip .glass')).transitionDuration}})()");
  assert.ok(stripAlignment.first >= stripAlignment.left && stripAlignment.last <= stripAlignment.right, `折页终点未对齐装饰条: ${JSON.stringify(stripAlignment)}`);
  assert.ok(parseFloat(stripAlignment.dayFade) > 0 && parseFloat(stripAlignment.nightFade) > 0, `装饰条缺少淡入淡出: ${JSON.stringify(stripAlignment)}`);
  await until(() => ev("(()=>{const day=Number(getComputedStyle(document.querySelector('.edition-strip .letter-strip')).opacity),night=Number(getComputedStyle(document.querySelector('.edition-strip .glass')).opacity);return day>.01&&day<.99&&night>.01&&night<.99})()"));
  await shot('relations-fold.png');
  await delay(1900);
  await shot('relations-night.png');
  const nightState = await ev("JSON.stringify({theme:document.querySelector('.exlibris')?.dataset.theme,transition:document.documentElement.dataset.themeTransition||'',ripple:document.querySelectorAll('.exlibris-ripple').length,illuminating:document.querySelector('.collection')?.classList.contains('illuminating')})");
  timeline.push(`关系 夜: ${nightState}`);
  assert.match(nightState, /"theme":"night"/);
  assert.match(nightState, /"transition":""/);
  assert.match(nightState, /"ripple":0/);
  assert.match(nightState, /"illuminating":false/);

  await ev(`${themeButton('白昼来信')}.click()`);
  await delay(420);
  await shot('relations-dawn.png');
  await delay(1600);
  await shot('relations-day-again.png');
  const dayState = await ev("JSON.stringify({theme:document.querySelector('.exlibris')?.dataset.theme,transition:document.documentElement.dataset.themeTransition||'',ripple:document.querySelectorAll('.exlibris-ripple').length})");
  timeline.push(`关系 昼: ${dayState}`);
  assert.match(dayState, /"theme":"day"/);
  assert.match(dayState, /"transition":""/);
  assert.match(dayState, /"ripple":0/);

  // ---------- 对话页 ----------
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('对话')).click()");
  await until(() => ev("document.querySelectorAll('.dialogue-pane .dialogue-message').length >= 4"));
  await delay(900);
  await shot('dialogue-day.png');
  await ev(`${themeButton('晚风电台')}.click()`);
  await delay(50);
  const lighting = await ev("JSON.stringify({lighting:document.querySelector('.dialogue-page')?.dataset.lighting||'',dir:document.querySelector('.dialogue-page')?.dataset.lightDir||'',beam:!!document.querySelector('.dialogue-sun-beam')})");
  timeline.push(`对话 50ms: ${lighting}`);
  assert.match(lighting, /"dir":"dusk"/);
  assert.match(lighting, /"beam":true/);
  const beam = await ev("(()=>{const b=document.querySelector('.dialogue-sun-beam');const s=getComputedStyle(b);const r=b.getBoundingClientRect();return JSON.stringify({top:s.top,op:s.opacity,name:s.animationName,anim:b.getAnimations().length,h:Math.round(r.height),w:Math.round(r.width),y:Math.round(r.top)})})()");
  timeline.push(`对话 光线: ${beam}`);
  await burst('dialogue-dusk', 5, 0);
  const sweep = await ev("JSON.stringify({sweeping:document.querySelector('.dialogue-pane')?.classList.contains('sweeping'),band:document.querySelector('.dialogue-pane')?.style.getPropertyValue('--band')||'',pinned:document.querySelectorAll('.dialogue-pane .dlg-pal').length,flipped:document.querySelectorAll('.dialogue-pane .flipped').length,paper:document.querySelector('.dialogue-pane')?.style.getPropertyValue('--sweep-paper')||''})");
  timeline.push(`对话 换光中: ${sweep}`);
  await delay(1200);
  await shot('dialogue-night.png');
  const dialogueNight = await ev("JSON.stringify({theme:document.querySelector('.dialogue-page')?.dataset.theme,lighting:document.querySelector('.dialogue-page')?.dataset.lighting||'',sweeping:document.querySelector('.dialogue-pane')?.classList.contains('sweeping'),pinned:document.querySelectorAll('.dialogue-pane .dlg-pal').length,paper:getComputedStyle(document.querySelector('.dialogue-pane')).backgroundColor})");
  timeline.push(`对话 夜: ${dialogueNight}`);
  assert.match(dialogueNight, /"theme":"night"/);
  assert.match(dialogueNight, /"lighting":""/);
  assert.match(dialogueNight, /"sweeping":false/);
  assert.match(dialogueNight, /"pinned":0/);

  await ev(`${themeButton('白昼来信')}.click()`);
  await delay(420);
  await shot('dialogue-dawn.png');
  await delay(1300);
  await shot('dialogue-day-again.png');
  const dialogueDay = await ev("JSON.stringify({theme:document.querySelector('.dialogue-page')?.dataset.theme,pinned:document.querySelectorAll('.dialogue-pane .dlg-pal').length,paper:getComputedStyle(document.querySelector('.dialogue-pane')).backgroundColor})");
  timeline.push(`对话 昼: ${dialogueDay}`);
  assert.match(dialogueDay, /"theme":"day"/);

  // ---------- 历史层打开时换光 ----------
  await ev("document.querySelector('.dialogue-history-button').click()");
  await until(() => ev("!!document.querySelector('.dialogue-history')"));
  await delay(500);
  await ev(`${themeButton('晚风电台')}.click()`);
  await delay(520);
  const historySweep = await ev("JSON.stringify({sweeping:document.querySelector('.dialogue-pane')?.classList.contains('sweeping'),band:document.querySelector('.dialogue-pane')?.style.getPropertyValue('--band')||'',pinned:document.querySelectorAll('.dialogue-pane .dlg-pal').length})");
  timeline.push(`对话 历史层换光: ${historySweep}`);
  await shot('dialogue-history-dusk.png');
  await delay(1400);
  const historyEnd = await ev("JSON.stringify({theme:document.querySelector('.dialogue-page')?.dataset.theme,pinned:document.querySelectorAll('.dialogue-pane .dlg-pal').length,transition:document.documentElement.dataset.themeTransition||''})");
  timeline.push(`对话 历史层收尾: ${historyEnd}`);
  assert.match(historyEnd, /"theme":"night"/);
  assert.match(historyEnd, /"pinned":0/);
  await ev("document.querySelector('.dialogue-history-button').click()");
  await delay(320);
  await ev(`${themeButton('白昼来信')}.click()`);
  await delay(1500);

  // ---------- 减少动效 ----------
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await delay(120);
  await ev(`${themeButton('晚风电台')}.click()`);
  await delay(80);
  const reducedState = await ev("JSON.stringify({theme:document.querySelector('.dialogue-page')?.dataset.theme,lighting:document.querySelector('.dialogue-page')?.dataset.lighting||'',pinned:document.querySelectorAll('.dialogue-pane .dlg-pal').length,transition:document.documentElement.dataset.themeTransition||''})");
  timeline.push(`对话 减少动效: ${reducedState}`);
  assert.match(reducedState, /"theme":"night"/);
  assert.match(reducedState, /"lighting":""/);
  assert.match(reducedState, /"pinned":0/);
  await shot('dialogue-reduced-night.png');

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
