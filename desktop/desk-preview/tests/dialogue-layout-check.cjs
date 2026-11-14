"use strict";
// 从仓库根目录运行；桌面运行时与本地 HTTP 替身，不调用真实模型。
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { resolveElectronExecutable } = require('./electron-executable.cjs');
const root = path.resolve(__dirname, '../../..'), output = path.join(root, 'backend/test-results/dialogue-layout');
fs.mkdirSync(output, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-layout-'));
const date = '2026-11-09T10:00:00.000Z';
const roles = [{ roleId: 'a', displayName: '甲角色', status: 'ready', defaultWindowId: 'w1' }, { roleId: 'b', displayName: '乙角色', status: 'ready', defaultWindowId: 'w1' }];
const streams = new Set(), requests = [];
function json(res, data, status = 200) { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(data)); }
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://127.0.0.1').pathname;
  requests.push(p);
  const role = roles.find(item => p.includes(`/roles/${item.roleId}`)) ?? roles[0];
  if (p === '/v1/health') return json(res, { status: 'ok' });
  if (p === '/v1/roles') return json(res, { items: roles });
  if (p === `/v1/roles/${role.roleId}`) return json(res, { ...role, definition: { text: '', payload: {} }, definitionRevision: 1 });
  if (p.endsWith('/appearance/outfits')) return json(res, { items: [] });
  if (p.endsWith('/state')) return json(res, { state: {}, stateVersion: 1, updatedAt: date });
  if (p.endsWith('/voice')) return json(res, { voice: null });
  if (p.endsWith('/windows')) return json(res, { items: ['w1', 'w2'].map((windowId, i) => ({ windowId, roleId: role.roleId, kind: i ? 'custom' : 'main', source: 'nowadays', createdAt: date, updatedAt: date })) });
  if (p.endsWith('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' }); res.write(': connected\n\n'); streams.add(res); res.on('close', () => streams.delete(res)); return; }
  if (p.endsWith('/messages')) return json(res, { items: [{ messageId: 'm1', windowId: p.includes('/w2/') ? 'w2' : 'w1', sender: 'user', content: '一条历史消息', sequence: 1, status: 'completed', sourcePlatform: 'nowadays', submissionId: null, createdAt: date, updatedAt: date }], segments: [], sceneImages: [], nextAfter: null, nextBefore: null, activeReply: null, cursor: 0 });
  return json(res, { error: { message: '测试接口未配置' } }, 404);
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { let error; for (const start = Date.now(); Date.now() - start < 16000;) { try { const value = await fn(); if (value) return value; } catch (e) { error = e; } await delay(80); } throw Error(`等待超时 ${error || ''}`); }
let proc, ws, id = 0, logs = '';
const waiting = new Map(), errors = [];
function cmd(method, params = {}) { return new Promise((resolve, reject) => { const n = ++id; waiting.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); }); }
async function ev(expression) { const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function shot(name) { const result = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name), Buffer.from(result.data, 'base64')); }
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, NOWADAYS_BACKEND_URL: `http://127.0.0.1:${server.address().port}`, NOWADAYS_APP_ROOT: path.join(temp, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(resolveElectronExecutable({ repoRoot: root }), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, path.join(root, 'desktop/desk-preview')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', chunk => logs += chunk); proc.stderr.on('data', chunk => logs += chunk);
  const port = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(logs)?.[1]);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.startsWith('desk://bundle/')));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if (msg.id) { const job = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? job?.reject(msg.error) : job?.resolve(msg.result); } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text); };
  await cmd('Runtime.enable'); await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => ev("!!document.querySelector('.ui-page-dock')"));
  assert.equal(await ev("!!document.querySelector('.ui-settings-launcher')"), false);
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('对话')).click()");
  await until(() => ev("document.querySelector('.dialogue-connection')?.dataset.state==='open'")); await delay(500);
  const boxes = await ev("(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}};return {stage:rect('.dialogue-stage'),pane:rect('.dialogue-pane'),page:rect('.dialogue-page'),actions:rect('.dialogue-pane-actions'),message:rect('.dialogue-messages')}})()");
  assert.ok(Math.abs(boxes.stage.top - boxes.pane.top) < 1 && boxes.stage.top - boxes.page.top < 12, JSON.stringify(boxes));
  assert.ok(boxes.actions.right <= boxes.pane.right && boxes.actions.top >= boxes.pane.top && boxes.message.top >= boxes.actions.bottom, JSON.stringify(boxes));
  assert.equal(await ev("!!document.querySelector('.dialogue-topbar')"), false);
  await shot('desktop.png');
  await ev("document.querySelector('[aria-label=演出设置]').click()");
  await until(() => ev("[...document.querySelectorAll('[role=dialog]')].some(x=>x.textContent.includes('演出设置'))"));
  await ev("[...document.querySelectorAll('.dialogue-option')].find(x=>x.textContent.includes('隐藏底部导航栏')).querySelector('input').click()");
  await until(() => ev("!document.querySelector('.ui-page-dock')"));
  assert.ok(await ev(`document.querySelector('.dialogue-pane').getBoundingClientRect().bottom > ${boxes.pane.bottom} + 70`), '隐藏导航后没有释放对话空间');
  await ev("document.querySelector('[role=dialog] [aria-label=关闭弹窗]').click()"); await delay(300);
  await ev("document.querySelector('.ui-studio-brand').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='home' && !!document.querySelector('.ui-page-dock')"));
  await cmd('Page.reload');
  await until(() => ev("!!document.querySelector('.ui-page-dock')"));
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('对话')).click()");
  await until(() => ev("document.querySelector('.dialogue-connection')?.dataset.state==='open' && !document.querySelector('.ui-page-dock')"));
  await ev("document.querySelector('[aria-label=演出设置]').click()");
  await until(() => ev("!!document.querySelector('.dialogue-option input')"));
  assert.equal(await ev("[...document.querySelectorAll('.dialogue-option')].find(x=>x.textContent.includes('隐藏底部导航栏')).querySelector('input').checked"), true, '重启后未保留对话页导航偏好');
  await ev("[...document.querySelectorAll('.dialogue-option')].find(x=>x.textContent.includes('隐藏底部导航栏')).querySelector('input').click()");
  await until(() => ev("!!document.querySelector('.ui-page-dock')"));
  await ev("document.querySelector('[role=dialog] [aria-label=关闭弹窗]').click()"); await delay(300);
  await ev("document.querySelector('.dialogue-history-button').focus();document.querySelector('.dialogue-history-button').click()");
  await until(() => ev("!!document.querySelector('.dialogue-history[data-open]')"));
  await ev("document.querySelector('.dialogue-history-close').click()");
  await until(() => ev("!document.querySelector('.dialogue-history')"));
  assert.equal(await ev("document.activeElement===document.querySelector('.dialogue-history-button')"), true, '关闭历史后焦点未恢复');
  await ev("document.querySelector('.dialogue-role-switch button').click()");
  await ev("[...document.querySelectorAll('.dialogue-role-switch [role=menuitem]')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("document.querySelector('.dialogue-role-switch button')?.getAttribute('aria-label')?.includes('乙角色')"));
  await until(() => ev("document.querySelector('.dialogue-connection')?.dataset.state==='open'"));
  await ev("document.querySelector('.dialogue-window-switch button').click()");
  await ev("[...document.querySelectorAll('.dialogue-window-switch [role=menuitem]')].find(x=>x.textContent.includes('页面窗口')).click()");
  await until(() => requests.some(p => p.includes('/roles/b/windows/w2/messages')));
  await until(() => ev("document.querySelector('.dialogue-connection')?.dataset.state==='open'"));
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await delay(350);
  assert.equal(await ev("document.documentElement.scrollWidth<=innerWidth+1"), true);
  const inside = await ev("(()=>{const p=document.querySelector('.dialogue-pane').getBoundingClientRect();return [...document.querySelectorAll('.dialogue-pane-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=p.left&&r.right<=p.right})})()");
  assert.equal(inside, true, '窄屏工具超出对话框'); await shot('mobile.png');
  await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev("[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes('设置'))"));
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes('设置')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"));
  assert.deepEqual(errors, []); console.log(JSON.stringify({ boxes, dockPreference: true, otherPagesKeepDock: true, historyFocus: true, roleSwitch: true, windowSwitch: true, mobile: true, settingsMenu: true, errors }, null, 2));
}
run().catch(error => { console.error(error, logs.slice(-1000)); process.exitCode = 1; }).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 99999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(500); if (proc && proc.exitCode === null) proc.kill(); for (const stream of streams) stream.end(); server.close();
  try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('dialogue-layout-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
