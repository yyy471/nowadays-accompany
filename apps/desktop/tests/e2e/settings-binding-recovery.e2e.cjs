'use strict';
// 仓库根目录运行：临时后端数据目录 + Electron；不访问模型或外部服务。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { resolveElectronExecutable } = require('../helpers/electron-executable.cjs');
const { resolveBackendLayout, resolveNodeExecutable } = require('../../electron/backend-paths.cjs');
const { button, configControls, editor, element, setValue, sheet } = require('../helpers/config-page-controls.cjs');
const { repoRoot: root, desktopDir, backendDir, electronDir, xiachengPortraitFixture, testResultsDir, backendTestResultsDir } = require('../helpers/paths.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-ui-real-'));
const hostToken = require('node:crypto').randomBytes(32).toString('hex');
const hostHeaders = { 'X-Nowadays-Host-Token': hostToken };
const emptyPresets = path.join(temp, 'presets');
fs.mkdirSync(emptyPresets, { recursive: true });
const layout = resolveBackendLayout({ isPackaged: false, dirname: electronDir, env: process.env });
const node = resolveNodeExecutable({ layout, env: process.env, exists: fs.existsSync });
const imagePath = xiachengPortraitFixture;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { let last; for (const start = Date.now(); Date.now() - start < 25000;) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(100); } throw Error(`等待超时: ${last || ''}`); }
let backend, electron, ws, backendLog = '', electronLog = '', nextId = 0, base = '';
const waiting = new Map(), errors = [];
function cmd(method, params = {}) { return new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function ev(expression) { const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
const { click, pickRole, tab, openRoleRow } = configControls(ev, until);
async function request(route, options = {}) { const response = await fetch(base + route, { ...options, headers: { ...hostHeaders, ...options.headers } }); const body = await response.json(); if (!response.ok) throw Error(`${response.status}: ${JSON.stringify(body)}`); return body; }
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function run() {
  backend = spawn(node, ['--import', 'tsx', 'src/main.ts', '--app-root', path.join(temp, 'app'), '--port', '0', '--preset-assets-dir', emptyPresets], { cwd: backendDir, env: { ...process.env, NOWADAYS_HOST_TOKEN: hostToken }, windowsHide: true });
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
  const env = { ...process.env, NOWADAYS_BACKEND_URL: base, NOWADAYS_APP_ROOT: path.join(temp, 'desktop'), NOWADAYS_HOST_TOKEN: hostToken, NOWADAYS_SKIP_ROLE_PICKER: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(resolveElectronExecutable({ repoRoot: root }), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, desktopDir], { env, windowsHide: true });
  electron.stdout.on('data', data => electronLog += data); electron.stderr.on('data', data => electronLog += data);
  const debugPort = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(electronLog)?.[1]);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.url.startsWith('desk://bundle/')));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id) { const job = waiting.get(message.id); waiting.delete(message.id); message.error ? job?.reject(message.error) : job?.resolve(message.result); } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text); };
  await cmd('Runtime.enable'); await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => ev("!!document.querySelector('.ui-menu-trigger')")); await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev("[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes('角色配置'))")); await ev("[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes('角色配置')).click()");
  const profile = element(`${editor} textarea[aria-label="角色设定"]`);
  await until(() => ev(`!!${profile}?.value`));
  await pickRole(a.roleId);
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='联调甲'"));
  const visible = editor + ' .config-prose:not([hidden])';
  const modelInput = element(sheet + ' input[role=combobox]');
  const initialRetry = button('重试', visible + ' .config-load-err');
  const retry = button('重试读取绑定', visible);
  const sheetRetry = button('重试读取绑定', sheet);
  const sheetSave = `[...document.querySelectorAll('${sheet} .config-sheet-actions button')].find(button=>/^(?:重试保存|保存(?: *[0-9]+)?)$/.test(button.textContent.trim()))`;
  const snapshot = () => ev(`({
    model:${modelInput}?.value ?? null,
    error:${element(sheet + ' [role=alert]')}?.textContent ?? ${element(visible + ' [role=alert]')}?.textContent ?? null,
    retry:!!(${sheetRetry} || ${retry} || ${initialRetry}),
    saveDisabled:${sheetSave}?.disabled ?? true
  })`);
  await tab('模型');
  await openRoleRow('model:chat');
  await until(async () => (await snapshot()).model === 'saved-model');
  await ev(setValue(modelInput, 'discard-this'));
  const old = await request(bindingPath);
  await request(bindingPath, put({ expectedRevision: old.revision, bindings: [
    { capability: 'chat_model', resourceId: model.resourceId, modelName: 'external-chat', enabled: true },
  ] }));
  await click(sheetSave);
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
  await pickRole(b.roleId);
  await click(button('放弃修改', sheet + ' .config-sheet-confirm'));
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='联调乙'"))
    .catch(async error => {
      const state = await ev(`(() => {
        const sheet=document.querySelector('.config-sheet');
        return {
          visibility:document.visibilityState, focused:document.hasFocus(),
          role:document.querySelector('.config-footer-ident strong')?.textContent,
          sheet:sheet?.querySelector('h3')?.textContent, exiting:sheet?.hasAttribute('data-exiting'),
          confirmation:!!sheet?.querySelector('.config-sheet-confirm'),
          animations:[...document.querySelectorAll('.config-sheet,.config-scrim,.config-book-scrim')].flatMap(node=>
            node.getAnimations().map(animation=>({ state:animation.playState, at:animation.currentTime, end:animation.effect.getComputedTiming().endTime }))
          ),
          initialReadInjected:window.reviewInitialBindingFailed,
        };
      })()`);
      throw Error(`T9 放弃后等待切到联调乙失败：${JSON.stringify(state)}`, { cause: error });
    });
  await tab('模型');
  const initialFailure = await until(async () => {
    const state = await snapshot();
    return state.error?.includes('首次读取') && state.retry && state;
  }).catch(async error => {
    throw Error(`等待联调乙的 T35 失败：${JSON.stringify({ ...await snapshot(), injected: await ev('window.reviewInitialBindingFailed') })}`,
      { cause: error });
  });
  assert.equal(initialFailure.retry, true, '首次读取失败必须有恢复入口');
  await tab('扩展');
  assert.equal(await ev(`!!${initialRetry}`), true, '扩展分区也应能恢复绑定');
  assert.equal(await ev(`!!${element(visible + ' [data-edit="ext:mcp"] .config-sum-edit:not(:disabled)')}`), false, '读取前不能修改未知的扩展绑定');
  await tab('模型');

  // 第二次读取仍失败；第三次读取到真实版本后才能继续编辑。
  await ev('window.reviewInitialBindingFailed=false');
  await click(initialRetry);
  await until(async () => {
    const state = await snapshot();
    return state.error?.includes('重新读取绑定失败') && state.retry;
  });
  assert.equal((await snapshot()).saveDisabled, true);
  await click(initialRetry);
  await until(() => ev(`!${initialRetry}`));
  await openRoleRow('model:chat');
  await until(async () => (await snapshot()).model === 'second-model');
  const initialRecovered = true;
  console.log('INITIAL_BINDING_READ_FAILURE', JSON.stringify({ ...initialFailure, recovered: initialRecovered }));

  await pickRole(a.roleId);
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='联调甲'"));
  await tab('模型');
  await until(() => ev(`!!${retry}`));
  const back = await snapshot();
  const serverBinding = (await request(bindingPath)).items.find(item=>item.capability==='chat_model');
  console.log('DISCARD_BINDING_CONFLICT', JSON.stringify({
    priorConflict: conflict, returned: back, serverModel: serverBinding?.modelName,
  }));
  assert.equal(back.retry, true);
  assert.equal(back.saveDisabled, true);
  await click(retry);
  await until(() => ev(`!${retry}`));
  await openRoleRow('model:chat');
  await until(async () => (await snapshot()).model === 'external-chat');
  assert.equal((await snapshot()).model, serverBinding.modelName, '放弃草稿后应读取最新服务端值');
  await ev(setValue(modelInput, 'recovered-model'));
  await click(sheetSave);
  await until(async () => (await request(bindingPath)).items.find(item=>item.capability==='chat_model')?.modelName === 'recovered-model');
  assert.deepEqual(errors, []);
  assert.equal(initialRecovered, true);
  assert.equal(back.retry, true);
}
run().catch(error => { console.error(error, backendLog.slice(-1500), electronLog.slice(-1000)); process.exitCode = 1; }).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(300); if (electron && electron.exitCode === null) electron.kill(); if (backend && backend.exitCode === null) backend.kill();
  await delay(500); try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('nowadays-ui-real-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
