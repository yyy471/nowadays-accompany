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
const root = path.resolve(__dirname, '../../../../');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-ui-real-'));
const emptyPresets = path.join(temp, 'presets');
fs.mkdirSync(emptyPresets, { recursive: true });
const layout = resolveBackendLayout({ isPackaged: false, dirname: path.resolve(__dirname, '../..', 'electron'), env: process.env });
const node = resolveNodeExecutable({ layout, env: process.env, exists: fs.existsSync });
const imagePath = path.join(root, 'apps/desktop/renderer/src/assets/themes/xiacheng/character.png');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { let last; for (const start = Date.now(); Date.now() - start < 25000;) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(100); } throw Error(`等待超时: ${last || ''}`); }
let backend, electron, ws, backendLog = '', electronLog = '', nextId = 0, base = '';
const waiting = new Map(), errors = [];
function cmd(method, params = {}) { return new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function ev(expression) { const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
const { click, pickRole, tab, openRoleRow } = configControls(ev, until);
async function request(route, options = {}) { const response = await fetch(base + route, options); const body = await response.json(); if (!response.ok) throw Error(`${response.status}: ${JSON.stringify(body)}`); return body; }
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function run() {
  backend = spawn(node, ['--import', 'tsx', 'src/main.ts', '--app-root', path.join(temp, 'app'), '--port', '0', '--preset-assets-dir', emptyPresets], { cwd: path.join(root, 'apps', 'backend'), windowsHide: true });
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
  const remoteModel = await request('/v1/resources', json({ kind: 'model', name: '另一模型服务', config: { protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:2/v1' } }));
  const bindingPath = `/v1/roles/${a.roleId}/bindings`;
  const put = (body) => ({ ...json(body), method: 'PUT' });
  await request(bindingPath, put({ bindings: [{ capability: 'chat_model', resourceId: model.resourceId, modelName: 'saved-model', enabled: true }, { capability: 'memory_model', resourceId: model.resourceId, modelName: 'initial-memory', enabled: true }] }));
  const bytes = fs.readFileSync(imagePath);
  for (const name of ['春装', '秋装']) {
    const form = new FormData(); form.append('name', name); form.append('home', new Blob([bytes], { type: 'image/png' }), 'home.png');
    if (name === '春装') form.append('sprites', new Blob([bytes], { type: 'image/png' }), '微笑.png');
    await request(`/v1/roles/${a.roleId}/appearance/outfits`, { method: 'POST', body: form });
  }
  const env = { ...process.env, NOWADAYS_BACKEND_URL: base, NOWADAYS_APP_ROOT: path.join(temp, 'desktop'), NOWADAYS_SKIP_ROLE_PICKER: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(resolveElectronExecutable({ repoRoot: root }), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, path.join(root, 'apps/desktop')], { env, windowsHide: true });
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
  const modelInput = element(sheet + ' input[role=combobox]');
  const sheetSave = `[...document.querySelectorAll('${sheet} .config-sheet-actions button')].find(button=>/^保存(?: *[0-9]+)?$/.test(button.textContent.trim()))`;
  const openSettings = async () => {
    await click(element('.ui-menu-trigger'));
    await click(button('设置'));
    await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"));
  };
  const switchRow = name => element(`${sheet} [role=switch][aria-label="为角色开启${name}"]`);
  const isChecked = target => ev(`(${target}?.checked ?? (${target}?.getAttribute('aria-checked') === 'true'))`);
  await tab('模型');
  await until(() => ev(`${element(`${editor} [data-edit="model:chat"]`)}?.innerText.includes('saved-model')`));
  await openSettings();
  await tab('MCP');
  await click(element(`.config-index-item[data-resource-id="${mcp.resourceId}"]`));
  const original = await request(bindingPath);
  const external = await request(bindingPath, put({
    expectedRevision: original.revision,
    bindings: [
      { capability: 'chat_model', resourceId: model.resourceId, modelName: 'saved-model', enabled: true },
      { capability: 'memory_model', resourceId: remoteModel.resourceId, modelName: 'external-memory', enabled: true },
    ],
  }));
  assert.notEqual(original.revision, external.revision);
  await ev(`(() => {
    const original=window.fetch;
    window.reviewAuto=[];
    window.reviewWrites=[];
    window.holdReviewBinding=true;
    window.fetch=async function(input, options) {
      const response=await original.call(this,input,options);
      if (String(input)===${JSON.stringify(bindingPath)}) {
        if (options?.method==='PUT') window.reviewWrites.push({status:response.status,revision:JSON.parse(options.body).expectedRevision});
        else if (response.ok) {
          const revision=(await response.clone().json()).revision;
          if (window.holdReviewBinding) {
            window.holdReviewBinding=false;
            return new Promise(resolve=>{window.releaseReviewBinding=()=>{window.reviewAuto.push(revision);resolve(response);};});
          }
          window.reviewAuto.push(revision);
        }
      }
      return response;
    };
  })()`);
  await click(button('删除 MCP…'));
  await click(button('删除', sheet));
  await until(() => ev("typeof window.releaseReviewBinding==='function'"));
  assert.equal((await fetch(base + '/v1/resources/' + mcp.resourceId)).status, 404);

  // v6 的脏纸笺离开会要求放弃。保留真实删除与刷新链路，控制刷新返回时机，
  // 在返回角色页后仍可编辑已读到的模型字段，并观察重读是否只更新未改字段。
  await click(element('.config-return-link'));
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  await tab('扩展');
  assert.equal(await ev(`${element(`${editor} [data-edit="ext:mcp"] .config-sum-edit`)}?.disabled`), true, '自动重读期间不可编辑未知版本的扩展');
  await tab('模型');
  await openRoleRow('model:chat');
  await until(() => ev(`${modelInput}?.value==='saved-model'`));
  await ev(setValue(modelInput, 'local-chat'));
  await ev('window.releaseReviewBinding()');
  await until(() => ev(`${element(`${editor} [data-edit="model:memory"]`)}?.innerText.includes('external-memory')`));
  assert.equal(await ev(`${modelInput}.value`), 'local-chat', '重读不得覆盖纸笺里的本地对话模型草稿');
  await click(sheetSave);
  await until(() => ev('window.reviewWrites.length===1'));
  const writes = await ev('window.reviewWrites');
  assert.deepEqual(writes, [{status:200,revision:external.revision}]);
  const saved = await request(bindingPath);
  assert.equal(saved.items.find(item => item.capability === 'chat_model')?.modelName, 'local-chat');
  assert.equal(saved.items.find(item => item.capability === 'memory_model')?.resourceId, remoteModel.resourceId);
  assert.equal(saved.items.find(item => item.capability === 'memory_model')?.modelName, 'external-memory');
  console.log('AUTO_RELOAD_BINDING', JSON.stringify({ localChatPreserved:true, externalMemoryPreserved:true, writes }));

  // 一张纸笺完成一个范围的保存。先让扩展纸笺在真实 409 中合并另一扩展和对话模型，
  // 再让记忆模型纸笺在真实 409 中保留新出现的扩展状态。
  const localMcp = await request('/v1/resources', json({ kind: 'mcp', name: '本地草稿扩展', config: { command: 'node', args: [], env: {} } }));
  const externalMcp = await request('/v1/resources', json({ kind: 'mcp', name: '外部更新扩展', config: { command: 'node', args: [], env: {} } }));
  await until(() => ev(`!${element(sheet)}`));
  await openSettings();
  await tab('MCP');
  await until(() => ev(`!!${element(`.config-index-item[data-resource-id="${localMcp.resourceId}"]`)}`));
  await click(element('.config-return-link'));
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  await tab('扩展');
  await openRoleRow('ext:mcp');
  await click(switchRow('本地草稿扩展'));
  const beforeExternal = await request(bindingPath);
  await request(bindingPath, put({ expectedRevision: beforeExternal.revision, bindings: [
    { capability: 'chat_model', resourceId: model.resourceId, modelName: 'external-chat', enabled: true },
    { capability: 'memory_model', resourceId: remoteModel.resourceId, modelName: 'external-memory', enabled: true },
    { capability: 'mcp', resourceId: externalMcp.resourceId, enabled: true },
  ] }));
  await click(sheetSave);
  await until(() => ev(`window.reviewWrites.length===3 && !${element(sheet)}`));
  const extensions = await request(bindingPath);
  assert.equal(extensions.items.find(item => item.resourceId === localMcp.resourceId)?.enabled, true);
  assert.equal(extensions.items.find(item => item.resourceId === externalMcp.resourceId)?.enabled, true);
  assert.equal(extensions.items.find(item => item.capability === 'chat_model')?.modelName, 'external-chat');
  await openRoleRow('ext:mcp');
  assert.equal(await isChecked(switchRow('本地草稿扩展')), true);
  assert.equal(await isChecked(switchRow('外部更新扩展')), true);
  await tab('模型');
  await openRoleRow('model:memory');
  await until(() => ev(`${modelInput}?.value==='external-memory'`));
  await ev(setValue(modelInput, 'local-memory'));
  await request(bindingPath, put({ expectedRevision: extensions.revision, bindings: [
    { capability: 'chat_model', resourceId: model.resourceId, modelName: 'external-chat', enabled: true },
    { capability: 'memory_model', resourceId: remoteModel.resourceId, modelName: 'external-memory', enabled: true },
    { capability: 'mcp', resourceId: localMcp.resourceId, enabled: true },
    { capability: 'mcp', resourceId: externalMcp.resourceId, enabled: false },
  ] }));
  await click(sheetSave);
  await until(() => ev(`window.reviewWrites.length===5 && !${element(sheet)}`));
  const models = await request(bindingPath);
  assert.equal(models.items.find(item => item.capability === 'memory_model')?.modelName, 'local-memory');
  assert.equal(models.items.find(item => item.capability === 'chat_model')?.modelName, 'external-chat');
  assert.equal(models.items.find(item => item.resourceId === localMcp.resourceId)?.enabled, true);
  assert.equal(models.items.find(item => item.resourceId === externalMcp.resourceId)?.enabled, false);
  assert.deepEqual(await ev('window.reviewWrites.map(item=>item.status)'), [200, 409, 200, 409, 200]);
  assert.deepEqual(errors, []);
  console.log('AUTO_RELOAD_BOTH_SCOPES', JSON.stringify({ localMemoryPreserved:true, localExtensionPreserved:true, externalChatPreserved:true, externalExtensionPreserved:true }));

}
run().catch(error => { console.error(error, backendLog.slice(-1500), electronLog.slice(-1000)); process.exitCode = 1; }).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(300); if (electron && electron.exitCode === null) electron.kill(); if (backend && backend.exitCode === null) backend.kill();
  await delay(500); try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('nowadays-ui-real-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
