'use strict';

// 仓库根目录运行：临时后端数据目录 + Electron；不访问模型或外部服务。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
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
const { click, pickRole, tab, openSheet } = configControls(ev, until);
async function request(route, options = {}) { const response = await fetch(base + route, options); const body = await response.json(); if (!response.ok) throw Error(`${response.status}: ${JSON.stringify(body)}`); return body; }
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function verifyWorldbooks(roleId, otherRoleId) {
  const route = `/v1/roles/${roleId}/worldbooks`;
  const openBooks = () => openSheet(element(`${editor} button[aria-label="编辑世界书"]`), '编辑世界书');
  const field = label => `[...document.querySelectorAll('.config-sheet .field-label')].find(node=>node.textContent===${JSON.stringify(label)})?.control`;
  const fill = async (label, value) => {
    const control = field(label);
    await until(() => ev(`!!(${control})`));
    await ev(setValue(control, value));
  };
  const save = () => click(element(`${sheet} .config-save-btn`));
  const closed = () => until(() => ev(`!${element(sheet)}`));
  await tab('扩展');
  await openBooks();
  await click(button('添加世界书', sheet));
  await fill('书名', '海岸记录');
  await click(button('添加条目', sheet));
  await fill('条目标题', '海港');
  await fill('关键词', '海港\n灯塔');
  await fill('设定正文', '潮汐表贴在门边');
  await click(button('添加条目', sheet));
  assert.equal(await ev(`${element(`${sheet} .config-save-btn`)}.disabled`), true);
  await fill('条目标题', '暗号');
  await fill('关键词', '灯塔');
  await fill('设定正文', '作者笔记');
  await fill('角色知情范围', 'author_only');
  await click(element(`${sheet} [aria-label="启用此条目"]`));
  await save();
  await closed();
  const first = await request(route);
  assert.equal(first.books[0].name, '海岸记录');
  const [known, secret] = first.books[0].entries;
  assert.deepEqual(known.keywords, ['海港', '灯塔']);
  assert.deepEqual([known.visibility, secret.visibility, secret.enabled], ['known', 'author_only', false]);
  assert.deepEqual((await request(`/v1/roles/${otherRoleId}/worldbooks`)).books, []);
  await openBooks();
  await click(element(`${sheet} [aria-label="启用整本世界书"]`));
  await fill('选择条目', secret.id);
  await click(button('移除条目', sheet));
  await save();
  await closed();
  const second = await request(route);
  assert.equal(second.books[0].enabled, false);
  assert.deepEqual(second.books[0].entries, [known]);
  await openBooks();
  await fill('书名', '未保存的书名');
  await request(route, { ...json({ expectedRevision: second.revision, books: [{ ...second.books[0], name: '另一窗口的书名' }] }), method: 'PUT' });
  await save();
  await until(() => ev(`!!${button('读取最新版本', sheet)}`));
  assert.equal(await ev(`(${field('书名')}).value`), '未保存的书名');
  await click(button('读取最新版本', sheet));
  await click(element('.config-sheet-confirm .danger'));
  await closed();
  await openBooks();
  await until(() => ev(`(${field('书名')})?.value==='另一窗口的书名'`));
  await click(button('移除这本书', sheet));
  await save();
  await closed();
  assert.deepEqual((await request(route)).books, []);
}
async function verifyModelProviders(roleId) {
  let reads = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url !== '/v1/models' || req.headers['api-key'] !== 'offline-test') {
      res.writeHead(403).end();
      return;
    }
    reads++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mimo-offline-chat' }, { id: 'mimo-offline-tts' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await click(element('.ui-menu-trigger'));
    await click(button('设置', '.ui-menu-panel:not([inert])'));
    await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"));
    await tab('模型');
    await until(() => ev("!!document.querySelector('.config-index-new')"));
    assert.equal(await ev("[...document.querySelectorAll('.config-workspace button')].filter(b => b.getClientRects().length && b.textContent.includes('添加模型服务')).length"), 1, '目录只有一个添加入口');
    await openSheet(element('.config-index-new'));
    const select = element(`${sheet} select`);
    const address = element(`${sheet} .config-connection input`);
    const name = element(`${sheet} .config-service-field-one input`);
    const model = element(`${sheet} .nd-model-picker input`);
    const option = element(`${sheet} [role=option] button`);
    const openCandidates = expected => until(() => ev(`(() => {
      const field=${model}, item=${option};
      if (item?.getClientRects().length && item.textContent.trim()===${JSON.stringify(expected)}) return true;
      if (field && !field.disabled && !field.closest('[inert]') && field.getClientRects().length) {
        field.focus(); field.click();
      }
      return false;
    })()`));
    for (const provider of ['opencode-go','deepseek','openrouter','xai','zai','mimo']) {
      await ev(setValue(select, provider));
      await until(() => ev(`${select}.value===${JSON.stringify(provider)} && ${address}.value.startsWith('https://')`));
      assert.ok(await ev(`!!${button('读取列表', sheet)}`), provider);
    }
    await ev(setValue(select, 'google-gemini'));
    await until(() => ev(`${model}.placeholder.includes('预置')`));
    assert.equal(await ev(`!!${button('读取列表', sheet)}`), false);
    await openCandidates('gemini-3.8-flash');
    await ev(setValue(select, 'google-ai-studio'));
    await until(() => ev(`${address}.value.includes('generativelanguage.googleapis.com') && !!${button('读取列表', sheet)}`));
    await ev(setValue(select, 'mimo'));
    await ev(setValue(name, 'MiMo 联调'));
    await ev(setValue(address, `http://127.0.0.1:${upstream.address().port}/v1`));
    await ev(setValue(element(`${sheet} input[aria-label="模型密钥"]`), 'offline-test'));
    assert.equal(reads, 0);
    await click(button('读取列表', sheet));
    await until(() => reads === 1);
    await openCandidates('mimo-offline-chat');
    await ev(`${option}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`);
    await click(element(`${sheet} .config-save-btn`));
    const saved = await until(async () => (await request('/v1/resources')).items.find(item => item.name === 'MiMo 联调'));
    assert.deepEqual([saved.config.provider, saved.config.protocol, saved.config.modelName], ['mimo','openai-chat','mimo-offline-chat']);
    await until(() => ev(`!${element(sheet)}`));
    await openSheet(element('.config-prose:not([hidden]) [data-service-group="连接"] .config-sum-edit'));
    await until(() => ev(`${select}?.value==='mimo'`));
    await click(element(`${sheet} button[aria-label="关闭"]`));
    await until(() => ev(`!${element(sheet)}`));
    await click(element('.ui-menu-trigger'));
    await click(button('角色配置', '.ui-menu-panel:not([inert])'));
    await pickRole(roleId);
    await tab('模型');
    for (const kind of ['chat', 'memory']) {
      await openSheet(element(`${editor} [data-edit="model:${kind}"] .config-sum-edit`));
      await until(() => ev(`[...${select}.options].some(option=>option.value===${JSON.stringify(saved.resourceId)})`));
      await ev(setValue(select, saved.resourceId));
      const previousReads = reads;
      await click(button('读取列表', sheet));
      await until(() => reads === previousReads + 1);
      await openCandidates('mimo-offline-chat');
      await ev(`${option}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`);
      await click(element(`${sheet} .config-save-btn`));
      await until(async () => (await request(`/v1/roles/${roleId}/bindings`)).items
        .some(item => item.capability === `${kind}_model` && item.resourceId === saved.resourceId && item.modelName === 'mimo-offline-chat'));
      await until(() => ev(`!${element(sheet)}`));
    }
  } finally {
    await new Promise(resolve => upstream.close(resolve));
  }
}
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
  await until(() => ev(`!!${element(`${editor} textarea[aria-label="角色设定"]`)}?.value`));
  await pickRole(a.roleId);
  await until(() => ev("document.querySelector('.config-role-switch')?.selectedOptions[0]?.textContent.includes('联调甲')"));
  await verifyWorldbooks(a.roleId, b.roleId);
  await tab('外观');
  const outfitCard = (name) => element(`${editor} .config-outfit-card[aria-label="编辑服饰：${name}"]`);
  await openSheet(outfitCard('春装'), '编辑服饰');
  const nameInput = element(`${sheet} input[data-sheet-focus]`);
  await until(() => ev(`${nameInput}?.value==='春装'`));
  await ev(setValue(nameInput, '春日'));
  await click(element(`${sheet} .config-save-btn`));
  await until(async () => (await request(`/v1/roles/${a.roleId}/appearance/outfits`)).items.some(item => item.name === '春日'));
  await until(() => ev(`!${element(sheet)}`));
  await openSheet(outfitCard('春日'), '编辑服饰');
  await until(() => ev(`!!${button('替换主页立绘', sheet)} && !${button('替换主页立绘', sheet)}.disabled`));
  const doc = await cmd('DOM.getDocument'); const input = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `${sheet} input[type=file]:nth-of-type(2)` });
  assert.ok(input.nodeId, '替换立绘所用的本机文件控件');
  await cmd('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [imagePath] });
  await until(() => ev("document.querySelector('.config-sheet')?.innerText.includes('主页立绘已更新') || document.querySelector('.config-role-editor:not([hidden])')?.innerText.includes('主页立绘已更新')"));
  await click(button('删除', `${sheet} .config-sprite-list`));
  await click(button('删除', `${sheet} .config-sheet-actions`));
  await until(async () => (await request(`/v1/roles/${a.roleId}/appearance/outfits`)).items.find(item => item.name === '春日')?.sprites.length === 0);
  await click(button('删除服饰…', sheet));
  await click(button('删除', `${sheet} .config-sheet-actions`));
  await until(async () => (await request(`/v1/roles/${a.roleId}/appearance/outfits`)).items.length === 1);
  await until(() => ev(`!${element(sheet)}`));
  await tab('设定');
  const rolesBeforeDelete = (await request('/v1/roles')).items.length;
  await openSheet(button('删除角色', editor), '删除角色');
  await click(element(`${sheet} input[name=role-delete]:checked`));
  await click(button('删除', sheet));
  await until(async () => (await request('/v1/roles')).items.length === rolesBeforeDelete - 1);
  // 删除甲后编辑对象可能回退到内置助手夏澄；显式切到联调乙，继续验证「清理数据」删除路径。
  await until(() => ev(`!${element(sheet)}`));
  await pickRole(b.roleId);
  await until(() => ev("document.querySelector('.config-role-switch')?.selectedOptions[0]?.textContent.includes('联调乙')"));
  assert.ok(fs.existsSync(path.join(temp, 'app', 'data', 'roles', a.roleId)), '保留历史路径应保留角色目录');
  await openSheet(button('删除角色', editor), '删除角色');
  await click(`document.querySelectorAll('${sheet} input[name=role-delete]')[1]`);
  await click(button('删除', sheet));
  await until(async () => (await request('/v1/roles')).items.length === rolesBeforeDelete - 2);
  await until(() => ev(`!${element(sheet)}`));
  await pickRole(c.roleId);
  await until(() => ev("document.querySelector('.config-role-switch')?.selectedOptions[0]?.textContent.includes('联调丙')"));
  assert.equal(fs.existsSync(path.join(temp, 'app', 'data', 'roles', b.roleId)), false, '清理路径应删除角色目录');
  await verifyModelProviders(c.roleId);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ realBackend: true, worldbooks: true, worldbookConflict: true, roleIsolation: true, modelProviders: true, rename: true, replaceHome: true, deleteSprite: true, deleteOutfit: true, deleteRoleKeepHistory: true, deleteRoleAndData: true, companionFallback: true, errors }, null, 2));
}
run().catch(async error => {
  console.error(error, backendLog.slice(-1500), electronLog.slice(-1000));
  if (ws?.readyState === 1) {
    console.error(await ev(`({ page:document.querySelector('.studio-shell')?.dataset.page,
      role:document.querySelector('.config-role-switch')?.value,
      roles:[...document.querySelectorAll('.config-role-switch option')].map(option=>[option.value,option.textContent]),
      sheet:document.querySelector('.config-sheet h3')?.textContent,
      text:document.body.innerText.slice(-1600) })`).catch(() => null));
  }
  process.exitCode = 1;
}).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(300); if (electron && electron.exitCode === null) electron.kill(); if (backend && backend.exitCode === null) backend.kill();
  await delay(500); try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('nowadays-ui-real-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
