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
  await tab('模型');
  const detail = editor + ' .config-model-details:not([hidden])';
  const input = detail + ' input[type=text]';
  const select = detail + ' select';
  const modelPart = (text) => ev(`[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.querySelector('strong').textContent===${JSON.stringify(text)}).click()`);
  await until(() => ev(`document.querySelector(${JSON.stringify(input)})?.value==='saved-model'`));
  await ev(`(()=>{const e=document.querySelector(${JSON.stringify(input)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'local-chat');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.equal(await ev(`document.querySelector(${JSON.stringify(input)}).value`), 'local-chat');

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
    window.fetch=async function(input, options) {
      const response=await original.call(this,input,options);
      if (String(input)===${JSON.stringify(bindingPath)}) {
        if (options?.method==='PUT') window.reviewWrites.push({status:response.status,revision:JSON.parse(options.body).expectedRevision});
        else if (response.ok) window.reviewAuto.push((await response.clone().json()).revision);
      }
      return response;
    };
  })()`);
  await ev(`[...document.querySelectorAll(${JSON.stringify(detail + ' button')})].find(x=>x.textContent.includes('在设置中查看模型')).click()`);
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='settings'"));
  await tab('MCP');
  const visibleSettings = '.config-leaf-body > .config-prose:not([hidden])';
  await until(() => ev(`!!${button('删除', visibleSettings)} && !${button('删除', visibleSettings)}.disabled`));
  await ev(`${button('删除', visibleSettings)}.click()`);
  await ev(`${button('确认删除', visibleSettings)}.click()`);
  await until(() => ev(`window.reviewAuto.includes(${JSON.stringify(external.revision)})`));
  assert.equal((await fetch(base + '/v1/resources/' + mcp.resourceId)).status, 404);
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='role-config'"));
  await modelPart('记忆整理');
  const memoryDraft = await ev(`({ resource:document.querySelector(${JSON.stringify(select)})?.value, model:document.querySelector(${JSON.stringify(input)})?.value })`);
  await modelPart('对话');
  const chatDraft = await ev(`document.querySelector(${JSON.stringify(input)})?.value`);
  await until(() => ev(`!!${button('保存模型选择')} && !${button('保存模型选择')}.disabled`));
  await ev(`${button('保存模型选择')}.click()`);
  await until(() => ev('window.reviewWrites.length===1'));
  const writes = await ev('window.reviewWrites');
  const saved = await request(bindingPath);
  const savedChat = saved.items.find(item => item.capability === 'chat_model');
  const savedMemory = saved.items.find(item => item.capability === 'memory_model');
  console.log('AUTO_RELOAD_BINDING', JSON.stringify({
    chatDraft, memoryDraft: memoryDraft.model, memoryDraftUsesExternalService: memoryDraft.resource === remoteModel.resourceId,
    serverMemoryBefore: 'external-memory', saveStatus: writes[0].status,
    usedLatestRevision: writes[0].revision === external.revision,
    savedChat: savedChat?.modelName, savedMemory: savedMemory?.modelName,
    savedMemoryUsesExternalService: savedMemory?.resourceId === remoteModel.resourceId,
  }));
  assert.deepEqual(errors, []);
  assert.equal(savedChat?.modelName, 'local-chat');
  assert.equal(savedMemory?.resourceId, remoteModel.resourceId, 'saving the edited chat model must preserve the other client’s memory model service');
  assert.equal(savedMemory?.modelName, 'external-memory');

  // 反向场景：本地改记忆模型和一个扩展开关，其他客户端改对话模型和另一个扩展。
  const unused = await request('/v1/resources', json({ kind: 'mcp', name: '第二个待删除扩展', config: { command: 'node', args: [], env: {} } }));
  const localMcp = await request('/v1/resources', json({ kind: 'mcp', name: '本地草稿扩展', config: { command: 'node', args: [], env: {} } }));
  const externalMcp = await request('/v1/resources', json({ kind: 'mcp', name: '外部更新扩展', config: { command: 'node', args: [], env: {} } }));
  await ev(`[...document.querySelectorAll(${JSON.stringify(detail + ' button')})].find(x=>x.textContent.includes('在设置中查看模型')).click()`);
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='settings'"));
  await tab('MCP');
  await until(() => ev("[...document.querySelectorAll('.config-index-item')].some(x=>x.textContent.includes('本地草稿扩展'))"));
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='role-config'"));
  await modelPart('记忆整理');
  await ev(`(()=>{const e=document.querySelector(${JSON.stringify(input)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'local-memory');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await tab('扩展');
  const localCheckbox = `[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-prose:not([hidden]) label.config-row')].find(x=>x.textContent.includes('本地草稿扩展'))?.querySelector('input')`;
  await until(() => ev(`!!${localCheckbox}`));
  await ev(`${localCheckbox}.click()`);
  const beforeSecond = await request(bindingPath);
  const externalSecond = await request(bindingPath, put({ expectedRevision: beforeSecond.revision, bindings: [
    { capability: 'chat_model', resourceId: model.resourceId, modelName: 'external-chat', enabled: true },
    { capability: 'memory_model', resourceId: remoteModel.resourceId, modelName: 'external-new-memory', enabled: true },
    { capability: 'mcp', resourceId: externalMcp.resourceId, enabled: true },
  ] }));
  await tab('模型');
  await ev(`[...document.querySelectorAll(${JSON.stringify(detail + ' button')})].find(x=>x.textContent.includes('在设置中查看模型')).click()`);
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='settings'"));
  await tab('MCP');
  await until(() => ev("[...document.querySelectorAll('.config-index-item')].some(x=>x.textContent.includes('第二个待删除扩展'))"));
  await ev("[...document.querySelectorAll('.config-index-item')].find(x=>x.textContent.includes('第二个待删除扩展')).click()");
  await until(() => ev(`!!${button('删除', visibleSettings)} && !${button('删除', visibleSettings)}.disabled`));
  await ev(`${button('删除', visibleSettings)}.click()`);
  await ev(`${button('确认删除', visibleSettings)}.click()`);
  await until(() => ev(`window.reviewAuto.includes(${JSON.stringify(externalSecond.revision)})`));
  assert.equal((await fetch(base + '/v1/resources/' + unused.resourceId)).status, 404);
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='role-config'"));
  await modelPart('记忆整理');
  await until(() => ev(`document.querySelector(${JSON.stringify(input)})?.value==='local-memory'`));
  await modelPart('对话');
  assert.equal(await ev(`document.querySelector(${JSON.stringify(input)})?.value`), 'external-chat');
  await tab('扩展');
  const externalCheckbox = `[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-prose:not([hidden]) label.config-row')].find(x=>x.textContent.includes('外部更新扩展'))?.querySelector('input')`;
  assert.equal(await ev(`${localCheckbox}.checked`), true, '未保存的本地扩展开关应保留');
  assert.equal(await ev(`${externalCheckbox}.checked`), true, '未修改的扩展开关应同步外部更新');
  await tab('模型'); await modelPart('记忆整理');
  await until(() => ev(`!!${button('保存模型选择')} && !${button('保存模型选择')}.disabled`));
  await ev(`${button('保存模型选择')}.click()`);
  await until(() => ev('window.reviewWrites.length===2'));
  const afterModels = await request(bindingPath);
  assert.equal(afterModels.items.find(item => item.capability === 'chat_model')?.modelName, 'external-chat');
  assert.equal(afterModels.items.find(item => item.capability === 'memory_model')?.modelName, 'local-memory');
  assert.equal(afterModels.items.find(item => item.resourceId === externalMcp.resourceId)?.enabled, true);
  assert.equal(afterModels.items.some(item => item.resourceId === localMcp.resourceId), false, '保存模型不得隐式保存扩展草稿');
  await tab('扩展');
  await until(() => ev(`!!${button('保存扩展')} && !${button('保存扩展')}.disabled`));
  await ev(`${button('保存扩展')}.click()`);
  await until(() => ev('window.reviewWrites.length===3'));
  const afterExtensions = await request(bindingPath);
  assert.equal(afterExtensions.items.find(item => item.resourceId === localMcp.resourceId)?.enabled, true);
  assert.equal(afterExtensions.items.find(item => item.resourceId === externalMcp.resourceId)?.enabled, true);
  assert.equal(afterExtensions.items.find(item => item.capability === 'chat_model')?.modelName, 'external-chat');
  console.log('AUTO_RELOAD_BOTH_SCOPES', JSON.stringify({ localMemoryPreserved:true, localExtensionPreserved:true, externalChatPreserved:true, externalExtensionPreserved:true }));
  assert.deepEqual(errors, []);
}
run().catch(error => { console.error(error, backendLog.slice(-1500), electronLog.slice(-1000)); process.exitCode = 1; }).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(300); if (electron && electron.exitCode === null) electron.kill(); if (backend && backend.exitCode === null) backend.kill();
  await delay(500); try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('nowadays-ui-real-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
