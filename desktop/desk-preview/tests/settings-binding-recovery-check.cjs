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
  const model = await request('/v1/resources', json({ kind: 'model', name: '复核模型', config: { protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1/v1' } }));
  const mcp = await request('/v1/resources', json({ kind: 'mcp', name: '复核扩展', config: { command: 'node', args: [], env: {} } }));
  const bindingPath = `/v1/roles/${a.roleId}/bindings`;
  const put = (body) => ({ ...json(body), method: 'PUT' });
  await request(bindingPath, put({ bindings: [{ capability: 'chat_model', resourceId: model.resourceId, modelName: 'saved-model', enabled: true }] }));
  const otherBindingPath = `/v1/roles/${b.roleId}/bindings`;
  await request(otherBindingPath, put({ bindings: [{ capability: 'chat_model', resourceId: model.resourceId, modelName: 'second-model', enabled: true }] }));
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
  const editor = '.config-role-editor:not([hidden])';
  const button = (label, root = editor) => `[...document.querySelectorAll(${JSON.stringify(root + ' button')})].find(x=>x.textContent===${JSON.stringify(label)})`;
  const tab = async (label) => ev(`[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes(${JSON.stringify(label)})).click()`);
  const enter = async () => {
    const params = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
    await cmd('Input.dispatchKeyEvent', { ...params, type: 'keyDown' });
    await cmd('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
  };
  const visible = editor + ' .config-prose:not([hidden])';
  const modelInput = editor + ' .config-model-details:not([hidden]) input[type=text]';
  const snapshot = () => ev(`({
    model:document.querySelector(${JSON.stringify(modelInput)})?.value ?? null,
    error:document.querySelector(${JSON.stringify(visible + ' [role=alert]')})?.textContent ?? null,
    retry:!!${button('重试读取绑定', visible)},
    saveDisabled:${button('保存模型选择', visible)}?.disabled ?? null
  })`);
  const choose = async (name) => {
    await ev("document.querySelector('.config-switch-role').click()");
    const expression = `[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes(${JSON.stringify(name)}))`;
    await until(() => ev(`!!${expression}`));
    await ev(`${expression}.click()`);
  };
  await tab('模型');
  await until(async () => (await snapshot()).model === 'saved-model');
  await ev(`(()=>{const input=document.querySelector(${JSON.stringify(modelInput)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'discard-this');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const old = await request(bindingPath);
  await request(bindingPath, put({ expectedRevision: old.revision, bindings: [
    { capability: 'chat_model', resourceId: model.resourceId, modelName: 'external-chat', enabled: true },
  ] }));
  await ev(`${button('保存模型选择', visible)}.click()`);
  await until(async () => (await snapshot()).retry);
  const conflict = await snapshot();

  await ev(`(() => {
    const original = window.fetch;
    window.reviewInitialBindingFailed=false;
    window.fetch=function(input, options) {
      if (String(input)===${JSON.stringify(otherBindingPath)} && (!options?.method || options.method==='GET') && !window.reviewInitialBindingFailed) {
        window.reviewInitialBindingFailed=true;
        return Promise.resolve(new Response(JSON.stringify({error:{message:'复核注入：首次读取绑定暂不可用'}}), {status:503,headers:{'content-type':'application/json'}}));
      }
      return original.call(this,input,options);
    };
  })()`);
  await choose('联调乙');
  await until(() => ev("!!document.querySelector('.config-dirty-prompt')"));
  await ev("[...document.querySelectorAll('.config-dirty-prompt button')].find(x=>x.textContent==='放弃改动，切换').click()");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='联调乙'"));
  await tab('模型');
  await until(async () => { const state=await snapshot(); return state.error?.includes('首次读取') || state.model==='second-model'; });
  const initialFailure = await snapshot();
  assert.equal(initialFailure.retry, true, '首次读取失败必须有恢复入口');
  await tab('扩展');
  assert.equal(await ev(`!!${button('重试读取绑定', visible)}`), true, '扩展分区也应能恢复绑定');
  assert.equal(await ev(`document.querySelector(${JSON.stringify(visible + ' input[type=checkbox]')})?.disabled`), true, '首次读取完成前不应允许修改未知的扩展绑定');
  await tab('模型');
  let initialRecovered = initialFailure.model === 'second-model';
  if (initialFailure.retry) {
    // 第二次读取也失败，入口必须保留，直到读取成功。
    await ev('window.reviewInitialBindingFailed=false');
    await ev(`${button('重试读取绑定', visible)}.click()`);
    await until(async () => { const state = await snapshot(); return state.error?.includes('重新读取绑定失败') && state.retry; });
    assert.equal((await snapshot()).saveDisabled, true);
    await ev(`${button('重试读取绑定', visible)}.click()`);
    await until(async () => (await snapshot()).model === 'second-model');
    initialRecovered = true;
  }
  console.log('INITIAL_BINDING_READ_FAILURE', JSON.stringify({ ...initialFailure, recovered: initialRecovered }));

  await choose('联调甲');
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='联调甲'"));
  await tab('模型');
  await delay(120);
  const back = await snapshot();
  const serverBinding = (await request(bindingPath)).items.find(item=>item.capability==='chat_model');
  console.log('DISCARD_BINDING_CONFLICT', JSON.stringify({
    priorConflict: conflict, returned: back, serverModel: serverBinding?.modelName,
  }));
  assert.equal(back.retry, true);
  assert.equal(back.saveDisabled, true);
  await ev(`${button('重试读取绑定', visible)}.click()`);
  await until(async () => { const state = await snapshot(); return state.model === 'external-chat' && !state.saveDisabled; });
  assert.equal((await snapshot()).model, serverBinding.modelName, '放弃草稿后应读取最新服务端值');
  await ev(`(()=>{const input=document.querySelector(${JSON.stringify(modelInput)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'recovered-model');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await ev(`${button('保存模型选择', visible)}.click()`);
  await until(async () => (await request(bindingPath)).items.find(item=>item.capability==='chat_model')?.modelName === 'recovered-model');
  assert.deepEqual(errors, []);
  assert.deepEqual({
    initialReadCanRecover: initialRecovered,
    discardedConflictCanRecover: back.retry || (!back.saveDisabled && back.model==='external-chat'),
  }, { initialReadCanRecover: true, discardedConflictCanRecover: true });
}
run().catch(error => { console.error(error, backendLog.slice(-1500), electronLog.slice(-1000)); process.exitCode = 1; }).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(300); if (electron && electron.exitCode === null) electron.kill(); if (backend && backend.exitCode === null) backend.kill();
  await delay(500); try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('nowadays-ui-real-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
