'use strict';
// 仓库根目录运行：临时后端数据目录 + Electron；不访问模型或外部服务。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { resolveElectronExecutable } = require('../helpers/electron-executable.cjs');
const { button, configControls, editor, element, setValue, sheet } = require('../helpers/config-page-controls.cjs');
const { repoRoot: root, desktopDir, backendDir, xiachengPortraitFixture } = require('../helpers/paths.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-ui-real-'));
const emptyPresets = path.join(temp, 'presets');
fs.mkdirSync(emptyPresets, { recursive: true });
const node = process.execPath;
const imagePath = xiachengPortraitFixture;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { let last; for (const start = Date.now(); Date.now() - start < 25000;) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(100); } throw Error(`等待超时: ${last || ''}`); }
let backend, electron, ws, backendLog = '', electronLog = '', nextId = 0, base = '';
const waiting = new Map(), errors = [];
function cmd(method, params = {}) { return new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function ev(expression) { const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
const { click, pickRole, tab, openRoleRow, openSheet } = configControls(ev, until);
async function request(route, options = {}) { const response = await fetch(base + route, options); const body = await response.json(); if (!response.ok) throw Error(`${response.status}: ${JSON.stringify(body)}`); return body; }
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function run() {
  backend = spawn(node, ['--import', 'tsx', 'src/main.ts', '--app-root', path.join(temp, 'app'), '--port', '0', '--preset-assets-dir', emptyPresets], { cwd: backendDir, windowsHide: true });
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
  const bytes = fs.readFileSync(imagePath);
  for (const name of ['春装', '秋装']) {
    const form = new FormData(); form.append('name', name); form.append('home', new Blob([bytes], { type: 'image/png' }), 'home.png');
    if (name === '春装') form.append('sprites', new Blob([bytes], { type: 'image/png' }), '微笑.png');
    await request(`/v1/roles/${a.roleId}/appearance/outfits`, { method: 'POST', body: form });
  }
  const env = { ...process.env, NOWADAYS_BACKEND_URL: base, NOWADAYS_APP_ROOT: path.join(temp, 'desktop'), NOWADAYS_SKIP_ROLE_PICKER: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(resolveElectronExecutable({ repoRoot: root }), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, desktopDir], { env, windowsHide: true });
  electron.stdout.on('data', data => electronLog += data); electron.stderr.on('data', data => electronLog += data);
  const debugPort = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(electronLog)?.[1]);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.url.startsWith('desk://bundle/')));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id) { const job = waiting.get(message.id); waiting.delete(message.id); message.error ? job?.reject(message.error) : job?.resolve(message.result); } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text); };
  await cmd('Runtime.enable'); await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => ev("!!document.querySelector('.ui-menu-trigger')")); await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev("[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes('角色配置'))")); await ev("[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes('角色配置')).click()");
  // 启动即存在内置助手夏澄，默认编辑对象可能不是联调甲；显式切到联调甲再继续。
  const profileInput = element(`${editor} textarea[aria-label="角色设定"]`);
  await until(() => ev(`!!${profileInput}?.value`));
  await pickRole(a.roleId);
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='联调甲'"));

  const sheetActions = sheet + ' .config-sheet-actions';
  async function cancelFocus(trigger, confirmation) {
    await until(() => ev(`!!${trigger} && !${trigger}.disabled`));
    await ev(`${trigger}.focus();${trigger}.click()`);
    const cancel = button('取消', sheetActions);
    await until(() => ev(`${element(sheet)}?.innerText.includes(${JSON.stringify(confirmation)})`));
    await until(() => ev(`document.activeElement === ${cancel}`));
    await click(cancel);
    await until(() => ev(`document.activeElement === ${trigger}`));
    return ev(`({ activeTag: document.activeElement?.tagName, triggerFocused: document.activeElement === ${trigger} })`);
  }
  const roleFocus = await cancelFocus(button('删除角色', editor), '保留本机数据');
  await tab('外观');
  await click(element(`${editor} .config-outfit-card[aria-label="编辑服饰：春装"]`));
  await until(() => ev(`${element(sheet + ' input[data-sheet-focus]')}?.value==='春装'`));
  const outfitFocus = await cancelFocus(button('删除服饰…', sheet), '衣柜里不再显示');
  const spriteFocus = await cancelFocus(button('删除', sheet + ' .config-sprite-list'), '删除差分');
  console.log('DELETE_CANCEL_FOCUS', JSON.stringify({ roleFocus, outfitFocus, spriteFocus }));
  const modelInput = sheet + ' input[role=combobox]';
  const sheetSave = `[...document.querySelectorAll('${sheetActions} button')].find(button=>/^(?:重试)?保存(?: *[0-9]+)?$/.test(button.textContent.trim()))`;
  const retry = button('重试读取绑定', sheet);
  await tab('模型');
  await openRoleRow('model:chat');
  await until(() => ev(`${element(modelInput)}?.value==='saved-model'`));
  await ev(`(() => {
    window.reviewBindingWrites=[];
    const original=window.fetch;
    window.fetch=async function(input, options) {
      const response=await original.call(this,input,options);
      if(String(input).endsWith('/bindings') && options?.method==='PUT') {
        window.reviewBindingWrites.push({status:response.status,revision:JSON.parse(options.body).expectedRevision});
      }
      return response;
    };
  })()`);

  // 1) 非重叠冲突：页面修改模型为 unsaved-model，同时服务端仅新增 mcp；应自动字段级合并并一次重提保存（[409, 200]）。
  await ev(`(()=>{const input=document.querySelector(${JSON.stringify(modelInput)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'unsaved-model');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const bindingBefore = await request(bindingPath);
  await request(bindingPath, put({
    expectedRevision: bindingBefore.revision,
    bindings: [
      { capability: 'chat_model', resourceId: model.resourceId, modelName: 'saved-model', enabled: true },
      { capability: 'mcp', resourceId: mcp.resourceId, enabled: true },
    ],
  }));
  await click(sheetSave);
  await until(() => ev("window.reviewBindingWrites.length===2"));
  const afterAutoModel = await request(bindingPath);
  assert.deepEqual(await ev('window.reviewBindingWrites.slice(0,2).map(item=>item.status)'), [409, 200]);
  assert.equal(afterAutoModel.items.find(item => item.capability === 'chat_model')?.modelName, 'unsaved-model');
  assert.equal(afterAutoModel.items.find(item => item.capability === 'mcp')?.enabled, true);

  await until(() => ev(`!${element(sheet)}`));
  await openRoleRow('model:chat');
  await until(() => ev(`${element(modelInput)}?.value==='unsaved-model'`));

  // 2) 同用途重叠冲突：页面修改模型为 local-conflict-model，同时服务端也把 chat_model 改成 server-conflict-model；
  // 应阻断自动重提并要求点击「重试读取绑定」（先注入一次 503，再二次读取成功且保留用户草稿），随后保存成功。
  await ev(`(()=>{const input=document.querySelector(${JSON.stringify(modelInput)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'local-conflict-model');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await request(bindingPath, put({
    expectedRevision: afterAutoModel.revision,
    bindings: [
      { capability: 'chat_model', resourceId: model.resourceId, modelName: 'server-conflict-model', enabled: true },
      { capability: 'mcp', resourceId: mcp.resourceId, enabled: true },
    ],
  }));
  await click(sheetSave);
  await until(() => ev(`window.reviewBindingWrites.length===3 && !!${retry}`));
  assert.equal(await ev(`${sheetSave}.disabled`), true, '同用途冲突后不能重复提交旧版本');
  assert.equal(await ev(`document.querySelector(${JSON.stringify(modelInput)}).value`), 'local-conflict-model');
  await ev(`(() => {
    const original=window.fetch; window.reviewBindingReadFailed=false;
    window.fetch=function(input, options) {
      if(String(input).endsWith('/bindings') && (!options?.method || options.method==='GET') && !window.reviewBindingReadFailed) {
        window.reviewBindingReadFailed=true;
        return Promise.resolve(new Response(JSON.stringify({error:{message:'绑定读取暂时失败'}}), {status:503,headers:{'content-type':'application/json'}}));
      }
      return original.call(this,input,options);
    };
  })()`);
  await ev(`${retry}.click()`);
  await until(() => ev(`window.reviewBindingReadFailed && !!${retry} && !${retry}.disabled`));
  assert.equal(await ev(`${sheetSave}.disabled`), true, '重读失败后仍不能提交');
  await ev(`${retry}.click()`);
  await until(() => ev(`!!${sheetSave} && !${sheetSave}.disabled`));
  assert.equal(await ev(`document.querySelector(${JSON.stringify(modelInput)}).value`), 'local-conflict-model');
  await click(sheetSave);
  await until(() => ev('window.reviewBindingWrites.length===4'));
  const writes = await ev('window.reviewBindingWrites');
  const bindingAfter = await request(bindingPath);
  assert.deepEqual(writes.slice(2, 4).map(item => item.status), [409, 200]);
  assert.notEqual(writes[2].revision, writes[3].revision);
  assert.equal(bindingAfter.items.find(item => item.capability === 'chat_model')?.modelName, 'local-conflict-model');
  assert.equal(bindingAfter.items.find(item => item.capability === 'mcp')?.resourceId, mcp.resourceId);
  console.log('BINDING_CONFLICT', JSON.stringify({ writes: writes.map(item => item.status), autoMergedModel: true, overlapConflictRecovered: true, latestMcpPreserved: true, readRetry: true }));

  // 3) 扩展非重叠冲突：扩展取消勾选 mcp，同时服务端把 chat_model 改成 external-model；应自动合并保留 external-model 并关闭 mcp（[409, 200]）。
  await until(() => ev(`!${element(sheet)}`));
  await tab('扩展');
  await openRoleRow('ext:mcp');
  const extensionSwitch = element(`${sheet} [role=switch][aria-label="为角色开启复核扩展"]`);
  await until(() => ev(`${extensionSwitch}?.getAttribute('aria-checked')==='true' || ${extensionSwitch}?.checked`));
  await click(extensionSwitch);
  const beforeExt = await request(bindingPath);
  await request(bindingPath, put({ expectedRevision: beforeExt.revision, bindings: [
    { capability: 'chat_model', resourceId: model.resourceId, modelName: 'external-model', enabled: true },
    { capability: 'mcp', resourceId: mcp.resourceId, enabled: true },
  ] }));
  await click(sheetSave);
  await until(() => ev("window.reviewBindingWrites.length===6"));
  const finalBinding = await request(bindingPath);
  assert.deepEqual(await ev('window.reviewBindingWrites.slice(4,6).map(item=>item.status)'), [409, 200]);
  assert.equal(finalBinding.items.find(item => item.capability === 'chat_model')?.modelName, 'external-model');
  assert.equal(finalBinding.items.find(item => item.capability === 'mcp')?.enabled, false);
  await until(() => ev(`!${element(sheet)}`));
  await tab('模型');
  await openRoleRow('model:chat');
  assert.equal(await ev(`${element(modelInput)}.value`), 'external-model');

  await tab('设定');
  await ev(setValue(profileInput, '更新后的联调角色甲'));
  const profileSave = `[...document.querySelectorAll('.config-leaf-foot button')].find(button=>/^保存(?: *[0-9]+)?$/.test(button.textContent.trim()))`;
  await click(profileSave);
  await until(async () => (await request(`/v1/roles/${a.roleId}`)).definitionRevision > 1);
  await until(() => ev(`!${profileSave}`));

  // v6 写入期间禁止再提交删除。从服饰保存触发独立的列表刷新，让旧响应跨过角色删除。
  await tab('外观');
  await openSheet(element(`${editor} .config-outfit-card[aria-label="编辑服饰：春装"]`), '编辑服饰');
  await ev(`(() => {
    const original=window.fetch;
    window.reviewRoleRefreshFailed=false;
    window.reviewHoldRoleRefresh=true;
    window.fetch=function(input, options) {
      if(String(input)==='/v1/roles' && (!options?.method || options.method==='GET') && window.reviewHoldRoleRefresh) {
        window.reviewHoldRoleRefresh=false;
        return original.call(this,input,options).then(response => new Promise(resolve => { window.reviewReleaseOldRoles = () => resolve(response); }));
      }
      if(String(input)==='/v1/roles' && (!options?.method || options.method==='GET') && !window.reviewRoleRefreshFailed) {
        window.reviewRoleRefreshFailed=true;
        return Promise.resolve(new Response(JSON.stringify({error:{message:'复核注入：角色列表暂不可读'}}), {status:503,headers:{'content-type':'application/json'}}));
      }
      return original.call(this,input,options);
    };
  })()`);
  await ev(setValue(element(sheet + ' input[data-sheet-focus]'), '春装复核'));
  await click(sheetSave);
  await until(() => ev("typeof window.reviewReleaseOldRoles === 'function'"));
  await until(() => ev(`!${element(sheet)}`));
  await tab('设定');
  const rolesBeforeDelete = (await request('/v1/roles')).items.length;
  await openSheet(button('删除角色', editor), '删除角色');
  await click(element(`${sheet} input[name=role-delete]:checked`));
  await click(button('删除', sheetActions));
  // 启动即存在内置助手夏澄；按删除前后相对数量判断，不写死绝对数。
  const rolesAfter = await until(async () => { const result = await request('/v1/roles'); return result.items.length === rolesBeforeDelete - 1 ? result.items : null; });
  await until(() => ev('window.reviewRoleRefreshFailed && !!document.querySelector(".config-delete-notice")'));
  await ev('window.reviewReleaseOldRoles()');
  await delay(300);
  const stale = await ev(`({ edit:document.querySelector('.config-footer-ident strong')?.textContent, companion:document.querySelector('#config-footer-right')?.textContent, notice:document.querySelector('.config-delete-notice')?.textContent, retry:[...document.querySelectorAll('button')].some(x=>x.getClientRects().length && /重试读取角色|刷新角色列表/.test(x.textContent)), visibleErrors:[...document.querySelectorAll('[role=alert]')].filter(x=>x.getClientRects().length).map(x=>x.textContent) })`);
  console.log('DELETE_REFRESH_FAILURE', JSON.stringify({ ...stale, actualRoles: rolesAfter.map(role => role.displayName) }));

  assert.equal(roleFocus.triggerFocused, true);
  assert.equal(outfitFocus.triggerFocused, true);
  assert.equal(spriteFocus.triggerFocused, true);
  assert.notEqual(stale.edit, '联调甲');
  assert.ok(!stale.companion.includes('联调甲'));
  assert.equal(stale.retry, true);
  assert.ok(stale.visibleErrors.some(item => item.includes('角色列表同步失败')));
  await ev("[...document.querySelectorAll('[role=alert] button')].find(x=>x.textContent.includes('重试读取角色列表')).click()");
  await until(() => ev("![...document.querySelectorAll('[role=alert]')].some(x=>x.textContent.includes('角色列表同步失败'))"));
  assert.deepEqual(errors, []);
  console.log('RESULT', JSON.stringify({ conflictRecovery:true, roleRefreshRetry:true, roleFocus:true, outfitFocus:true, spriteFocus:true, errors }));

}
run().catch(error => { console.error(error, backendLog.slice(-1500), electronLog.slice(-1000)); process.exitCode = 1; }).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(300); if (electron && electron.exitCode === null) electron.kill(); if (backend && backend.exitCode === null) backend.kill();
  await delay(500); try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('nowadays-ui-real-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
