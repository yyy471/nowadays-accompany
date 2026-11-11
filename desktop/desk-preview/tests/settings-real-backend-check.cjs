'use strict';
// 仓库根目录运行：临时后端数据目录 + Electron；不访问模型或外部服务。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-ui-real-'));
const node = path.join(root, 'prototypes/p0/.runtime/node-v24.22.2-win-x64/node.exe');
const imagePath = path.join(root, 'desktop/desk-preview/renderer/src/assets/themes/xiacheng/character.png');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { let last; for (const start = Date.now(); Date.now() - start < 25000;) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(100); } throw Error(`等待超时: ${last || ''}`); }
let backend, electron, ws, backendLog = '', electronLog = '', nextId = 0, base = '';
const waiting = new Map(), errors = [];
function cmd(method, params = {}) { return new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function ev(expression) { const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function request(route, options = {}) { const response = await fetch(base + route, options); const body = await response.json(); if (!response.ok) throw Error(`${response.status}: ${JSON.stringify(body)}`); return body; }
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function run() {
  backend = spawn(node, ['--import', 'tsx', 'src/main.ts', '--app-root', path.join(temp, 'app'), '--port', '0'], { cwd: path.join(root, 'backend'), windowsHide: true });
  backend.stdout.on('data', data => backendLog += data); backend.stderr.on('data', data => backendLog += data);
  const port = await until(() => { const match = /"event":"listening","host":"[^"]+","port":(\d+)/.exec(backendLog); return match?.[1]; });
  base = `http://127.0.0.1:${port}`;
  const a = await request('/v1/roles', json({ displayName: '联调甲', definition: { text: '联调角色甲' } }));
  const b = await request('/v1/roles', json({ displayName: '联调乙', definition: { text: '联调角色乙' } }));
  const c = await request('/v1/roles', json({ displayName: '联调丙', definition: { text: '联调角色丙' } }));
  await request(`/v1/roles/${a.roleId}/activity/stop`, { method: 'POST' });
  await request(`/v1/roles/${b.roleId}/activity/stop`, { method: 'POST' });
  await request(`/v1/roles/${c.roleId}/activity/stop`, { method: 'POST' });
  await until(async () => (await request('/v1/activities')).items.every(item => item.state === 'stopped'));
  const bytes = fs.readFileSync(imagePath);
  for (const name of ['春装', '秋装']) {
    const form = new FormData(); form.append('name', name); form.append('home', new Blob([bytes], { type: 'image/png' }), 'home.png');
    if (name === '春装') form.append('sprites', new Blob([bytes], { type: 'image/png' }), '微笑.png');
    await request(`/v1/roles/${a.roleId}/appearance/outfits`, { method: 'POST', body: form });
  }
  const env = { ...process.env, NOWADAYS_BACKEND_URL: base, NOWADAYS_APP_ROOT: path.join(temp, 'desktop') }; delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, path.join(root, 'desktop/desk-preview')], { env, windowsHide: true });
  electron.stdout.on('data', data => electronLog += data); electron.stderr.on('data', data => electronLog += data);
  const debugPort = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(electronLog)?.[1]);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.url.startsWith('desk://bundle/')));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id) { const job = waiting.get(message.id); waiting.delete(message.id); message.error ? job?.reject(message.error) : job?.resolve(message.result); } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text); };
  await cmd('Runtime.enable'); await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => ev("!!document.querySelector('.ui-menu-trigger')")); await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev("[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes('角色配置'))")); await ev("[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes('角色配置')).click()");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='联调甲'"));
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('外观')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-outfit-manage h3')?.textContent==='春装'"));
  await ev("(()=>{const e=document.querySelector('.config-role-editor:not([hidden]) .nd-outfit-manage input:not([type=file])');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'春日');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].find(x=>x.textContent==='保存名称').click()");
  await until(async () => (await request(`/v1/roles/${a.roleId}/appearance/outfits`)).items.some(item => item.name === '春日'));
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].some(x=>x.textContent==='替换主页立绘'&&!x.disabled)"));
  const doc = await cmd('DOM.getDocument'); const input = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.config-role-editor:not([hidden]) .nd-outfit-manage input[type=file]' });
  await cmd('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [imagePath] });
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden])').innerText.includes('主页立绘已更新')"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].find(x=>x.textContent==='删除差分').click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-confirm button')].find(x=>x.textContent==='确认删除').click()");
  await until(async () => (await request(`/v1/roles/${a.roleId}/appearance/outfits`)).items.find(item => item.name === '春日')?.sprites.length === 0);
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].some(x=>x.textContent==='删除服饰'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].find(x=>x.textContent==='删除服饰').click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-confirm button')].find(x=>x.textContent==='确认删除').click()");
  await until(async () => (await request(`/v1/roles/${a.roleId}/appearance/outfits`)).items.length === 1);
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('设定')).click()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].some(x=>x.textContent==='删除角色'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='删除角色').click()");
  await ev("document.querySelector('.config-role-editor:not([hidden]) .config-delete-options input[type=radio]').click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-delete-options button')].find(x=>x.textContent==='确认删除').click()");
  await until(async () => (await request('/v1/roles')).items.length === 2);
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='联调乙' && document.querySelector('#config-footer-right').textContent.includes('联调乙')"));
  assert.ok(fs.existsSync(path.join(temp, 'app', 'data', 'roles', a.roleId)), '保留历史路径应保留角色目录');
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].some(x=>x.textContent==='删除角色'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='删除角色').click()");
  await ev("document.querySelectorAll('.config-role-editor:not([hidden]) .config-delete-options input[type=radio]')[1].click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-delete-options button')].find(x=>x.textContent==='确认删除').click()");
  await until(async () => (await request('/v1/roles')).items.length === 1);
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='联调丙' && document.querySelector('#config-footer-right').textContent.includes('联调丙')"));
  assert.equal(fs.existsSync(path.join(temp, 'app', 'data', 'roles', b.roleId)), false, '清理路径应删除角色目录');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ realBackend: true, rename: true, replaceHome: true, deleteSprite: true, deleteOutfit: true, deleteRoleKeepHistory: true, deleteRoleAndData: true, companionFallback: true, errors }, null, 2));
}
run().catch(error => { console.error(error, backendLog.slice(-1500), electronLog.slice(-1000)); process.exitCode = 1; }).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(300); if (electron && electron.exitCode === null) electron.kill(); if (backend && backend.exitCode === null) backend.kill();
  await delay(500); try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('nowadays-ui-real-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
