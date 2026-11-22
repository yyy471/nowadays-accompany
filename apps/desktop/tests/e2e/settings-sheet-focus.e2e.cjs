'use strict';
// 在仓库根目录运行：Electron + 本地 HTTP 替身，不访问真实模型或外部服务。
// 覆盖纸笺与分区的交接语义（R12-1 / R12-3 的等价断言）：
// 1) 纸笺开着点页签（有改动走 T9「放弃修改」/ 无改动直接关）后，焦点回到目标分区标题，不落 body；
// 2) 纸笺开着切角色（无改动）后，焦点交回底栏角色选择器；
// 3) 脏状态由页签脏点与 aria-label「有未保存的改动」表达（替代旧藏书票墙的 .config-poster-dirty），
//    放弃改动后脏点清除、草稿回滚到已保存值；
// 4) 全程同一张纸笺只渲染一份（R11-1 回归）。
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { resolveElectronExecutable } = require('../helpers/electron-executable.cjs');
const root = path.resolve(__dirname, '../../../../');
const out = path.join(root, 'test-results/settings-sheet-focus');
fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-sheet-focus-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label = 'cond', timeoutMs = 20000) {
  let last;
  for (const start = Date.now(); Date.now() - start < timeoutMs;) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(60);
  }
  throw Error(`等待超时(${label})${last ? ': ' + last.message : ''}`);
}
const date = '2026-11-19T10:00:00.000Z';
const roles = [{ roleId: 'a', displayName: '甲角色', isBuiltin: false }, { roleId: 'b', displayName: '乙角色', isBuiltin: false }];
const resources = [{ resourceId: 'm1', kind: 'model', name: 'DeepSeek', enabled: true, config: { protocol: 'openai' }, createdAt: date, updatedAt: date }];
const bindings = {
  a: [{ capability: 'chat_model', resourceId: 'm1', modelName: 'deepseek-chat', enabled: true }],
  b: [{ capability: 'chat_model', resourceId: 'm1', modelName: 'deepseek-chat', enabled: true }],
};
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://127.0.0.1').pathname;
  const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (p === '/v1/health') return json({ status: 'ok' });
  // 新建角色纸笺：创建后要能读到新角色，才能验证「纸笺关闭且不残留」。
  if (p === '/v1/roles' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    return req.on('end', () => {
      const data = JSON.parse(body || '{}');
      const role = { roleId: 'c', displayName: data.displayName, isBuiltin: false };
      roles.push(role);
      bindings.c = [];
      json({ ...role, definition: { text: data.definition?.text || '', payload: {} }, definitionRevision: 1, bio: '' });
    });
  }
  if (p === '/v1/roles') return json({ items: roles });
  if (p === '/v1/resources') return json({ items: resources });
  if (p === '/v1/activities') return json({ items: roles.map(role => ({ roleId: role.roleId, state: 'active', initStatus: 'ready' })) });
  if (p === '/v1/voice-services' || p === '/v1/image-services') return json({ items: [] });
  const detail = /^\/v1\/roles\/([^/]+)$/.exec(p);
  if (detail) { const role = roles.find(item => item.roleId === detail[1]); return json({ ...role, definition: { text: '正文', payload: {} }, definitionRevision: 1, bio: '' }); }
  const bind = /^\/v1\/roles\/([^/]+)\/bindings$/.exec(p);
  if (bind) {
    if (req.method === 'PUT') { let body = ''; req.on('data', chunk => body += chunk); return req.on('end', () => { bindings[bind[1]] = JSON.parse(body || '{}').bindings || []; return json({ items: bindings[bind[1]], revision: 'r2' }); }); }
    return json({ items: bindings[bind[1]] || [], revision: 'r1' });
  }
  if (p.includes('/autonomy/budget')) return json({ localDate: '2026-11-19', usedPoints: 12, dailyLimit: 200, unlimited: false });
  if (p.endsWith('/activity')) return json({ activity: { state: 'active', initStatus: 'ready' } });
  if (p.endsWith('/state')) return json({ state: {}, stateVersion: 1, updatedAt: date });
  if (p.endsWith('/voice')) return json({ voice: null });
  if (p.endsWith('/windows')) return json({ items: [] });
  if (p.endsWith('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.write(': ok\n\n'); return; }
  if (p.endsWith('/messages')) return json({ items: [], segments: [], sceneImages: [], nextAfter: null, nextBefore: null, activeReply: null, cursor: 0 });
  return json({ items: [] });
});
let proc, ws, seq = 0, logs = '';
const waiting = new Map(), errors = [];
function cmd(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function ev(expression) { const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error('EVAL: ' + JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text)); return result.result.value; }
async function touch(selector) {
  const box = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();if(!r.width)return null;return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  if (!box) throw Error('no box ' + selector);
  await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
const clickTab = async (label) => {
  const ok = await ev(`(()=>{const b=[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes(${JSON.stringify(label)}));if(!b)return false;b.click();return true;})()`);
  if (!ok) throw Error('no tab ' + label);
};
async function nav(label) {
  await clickTab(label);
  await until(() => ev(`document.querySelector('.config-tabs button[aria-current=page]')?.textContent.includes(${JSON.stringify(label)})`), 'tab ' + label);
}
async function pickRole(value) {
  // 真机里用户先聚焦选择器再选值；补上 focus 后，纸笺记录的触发元素才是这个选择器。
  await ev(`(()=>{const s=document.querySelector('.config-role-switch');s.focus();Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
}
const roleName = () => ev("document.querySelector('.config-footer-ident strong')?.textContent.trim()");
const focusInfo = () => ev(`(()=>{const a=document.activeElement;return {
  tag:a?.tagName, text:(a?.textContent||'').trim().slice(0,8),
  inSheet:!!a?.closest('.config-sheet'), inLeaf:!!a?.closest('.config-leaf-body'),
  tab:document.querySelector('.config-tabs button[aria-current=page]')?.textContent.trim(),
  sheets:document.querySelectorAll('.config-sheet').length,
  scrims:document.querySelectorAll('.config-scrim').length,
  books:document.querySelectorAll('.config-book-scrim').length
};})()`);
// 页签脏点：当前分区有未保存改动时出现，并带读屏可读的 aria-label。
const tabDirty = (label) => ev(`(()=>{const b=[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes(${JSON.stringify(label)}));return b?{dot:!!b.querySelector('.tab-dot'),aria:b.getAttribute('aria-label')||''}:null;})()`);
async function setDraftModel(value) {
  await ev(`(()=>{const i=[...document.querySelectorAll('.config-sheet input')].find(x=>x.type!=='checkbox');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await until(() => ev(`document.querySelector('.config-sheet input')?.value===${JSON.stringify(value)}`), 'draft value');
  await delay(160);
}
async function clickSheetButton(label) {
  const ok = await ev(`(()=>{const b=[...document.querySelectorAll('.config-sheet button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true;})()`);
  if (!ok) throw Error('no sheet button ' + label);
}
async function key(key, code, virtualKey, modifiers = 0) {
  const event = { key, code, windowsVirtualKeyCode: virtualKey, modifiers };
  await cmd('Input.dispatchKeyEvent', { ...event, type: 'keyDown' });
  await cmd('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
}
async function openChatSheet(tag) {
  // 常驻的非激活角色编辑器也在 DOM 里（[hidden]），选择器必须限定到当前可见的编辑器。
  const row = '.config-role-editor:not([hidden]) .config-sum[data-edit="model:chat"]';
  await nav('模型');
  await until(() => ev(`!!document.querySelector(${JSON.stringify(row)})`), 'chat row ' + tag);
  // 「编辑」按钮只在行悬停时显形，先把指针移到行上再点，避免零尺寸命中失败。
  const box = await ev(`(()=>{const r=document.querySelector(${JSON.stringify(row)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await delay(80);
  await touch(`${row} .config-sum-edit`);
  await until(() => ev("!!document.querySelector('.config-sheet')"), 'sheet ' + tag);
  await delay(320);
}
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, NOWADAYS_BACKEND_URL: `http://127.0.0.1:${server.address().port}`, NOWADAYS_APP_ROOT: path.join(temp, 'app'), NOWADAYS_SKIP_ROLE_PICKER: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(resolveElectronExecutable({ repoRoot: root }), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, path.join(root, 'apps/desktop')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', chunk => logs += chunk); proc.stderr.on('data', chunk => logs += chunk);
  const port = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(logs)?.[1], 'devtools');
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.startsWith('desk://bundle/')), 'target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id) { const job = waiting.get(message.id); waiting.delete(message.id); message.error ? job?.reject(new Error(JSON.stringify(message.error))) : job?.resolve(message.result); } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text); };
  await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => ev("!!document.querySelector('.ui-menu-trigger')"), 'menu');
  await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev("[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes('角色配置'))"), 'menu-config');
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes('角色配置')).click()");
  await until(() => ev("!!document.querySelector('.config-role-switch')"), 'role ready');
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"), 'role a');

  // 1) 有改动 → 点页签 → T9 → 放弃修改：切到目标分区，焦点落在目标分区标题上。
  await openChatSheet('dirty');
  assert.equal(await ev("document.querySelectorAll('.config-sheet').length"), 1, '纸笺只应渲染一份');
  await setDraftModel('将丢弃的文字');
  const dirtyTab = await tabDirty('模型');
  assert.equal(dirtyTab?.dot, true, `脏草稿应给当前分区页签加脏点：${JSON.stringify(dirtyTab)}`);
  assert.ok(dirtyTab?.aria.includes('有未保存的改动'), `页签 aria-label 应读出未保存：${JSON.stringify(dirtyTab)}`);
  await clickTab('外观');
  await until(() => ev("!!document.querySelector('.config-sheet-confirm')"), 'T9');
  await clickSheetButton('放弃修改');
  await until(() => ev("!document.querySelector('.config-sheet')"), 'sheet closed');
  await delay(120);
  const afterDiscard = await focusInfo();
  assert.equal(afterDiscard.tab, '02外观', `放弃修改后应切到目标分区：${JSON.stringify(afterDiscard)}`);
  assert.equal(afterDiscard.tag, 'H2', `页签关纸笺后焦点应回到分区标题，而不是 body：${JSON.stringify(afterDiscard)}`);
  assert.equal(afterDiscard.text, '衣柜', `焦点应落在目标分区标题「衣柜」：${JSON.stringify(afterDiscard)}`);
  assert.equal(afterDiscard.inLeaf, true, '焦点应仍在右页正文内');
  assert.equal(afterDiscard.inSheet, false, '纸笺已关闭，焦点不应留在纸笺内');
  assert.equal(afterDiscard.sheets + afterDiscard.scrims + afterDiscard.books, 0, '纸笺与双层压暗应全部卸载');

  // 2) 放弃后草稿回滚：重开为已保存值，模型页签脏点清除（替代旧「未保存」标记清除的断言）。
  await openChatSheet('rollback');
  assert.equal(await ev("document.querySelector('.config-sheet input')?.value"), 'deepseek-chat', '放弃改动后重开应显示已保存值');
  await ev("document.querySelector('.config-sheet-x')?.click()");
  await until(() => ev("!document.querySelector('.config-sheet')"), 'sheet closed clean');
  const cleanTab = await tabDirty('模型');
  assert.equal(cleanTab?.dot, false, `草稿回滚后页签不应再有脏点：${JSON.stringify(cleanTab)}`);
  assert.ok(!cleanTab?.aria.includes('有未保存的改动'), `页签 aria-label 不应再报未保存：${JSON.stringify(cleanTab)}`);

  // 3) 无改动 → 点页签直接关：同样把焦点交给目标分区标题。
  await openChatSheet('clean');
  await nav('完成');
  await until(() => ev("!document.querySelector('.config-sheet')"), 'sheet closed clean tab');
  await delay(120);
  const cleanSwitch = await focusInfo();
  assert.equal(cleanSwitch.tab, '06完成', `无改动点页签应直接切段：${JSON.stringify(cleanSwitch)}`);
  assert.equal(cleanSwitch.tag, 'H2', `无改动关纸笺后焦点也应回到分区标题：${JSON.stringify(cleanSwitch)}`);
  assert.equal(cleanSwitch.text, '完成度', `焦点应落在「完成度」标题：${JSON.stringify(cleanSwitch)}`);

  // 4) 纸笺开着切角色（无改动）：先收纸笺再切，焦点交给新内容标题（§7.3）。
  await openChatSheet('switch');
  await pickRole('b');
  await until(async () => (await roleName()) === '乙角色', 'role b');
  await until(() => ev("!document.querySelector('.config-sheet')"), 'sheet closed on switch');
  try { await until(async () => (await focusInfo()).tag === 'H2', 'role switch focuses heading', 2000); }
  catch (error) { console.error('ROLE_SWITCH_FOCUS', { electronPid:proc.pid, state:await focusInfo(), role:await roleName() }); throw error; }
  const roleSwitch = await focusInfo();
  assert.equal(roleSwitch.tag, 'H2', `切角色关纸笺后焦点应交给新内容标题：${JSON.stringify(roleSwitch)}`);
  assert.equal(roleSwitch.text, '模型', `焦点应落在保留的模型分区：${JSON.stringify(roleSwitch)}`);
  assert.equal(roleSwitch.sheets + roleSwitch.scrims + roleSwitch.books, 0, '切角色后纸笺与压暗应全部卸载');

  // 5) 纸笺草稿先走 T9；只有设定有草稿才继续出 T37。
  await nav('设定');
  await ev(`(()=>{const area=document.querySelector('.config-role-editor:not([hidden]) textarea[aria-label="角色设定"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'乙未保存的设定');area.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(async () => (await tabDirty('设定'))?.dot, 'profile draft');
  await openChatSheet('role-b');
  await setDraftModel('乙的草稿');
  assert.equal((await tabDirty('模型'))?.dot, true, '乙角色的脏草稿应给页签加脏点');
  await pickRole('a');
  await until(() => ev("!!document.querySelector('.config-sheet-confirm')"), 'sheet discard T9 before role discard');
  assert.equal(await roleName(), '乙角色');
  await clickSheetButton('放弃修改');
  await until(() => ev("document.querySelector('.config-sheet h3')?.textContent==='切换角色'"), 'profile discard T37 follows T9');
  assert.equal(await roleName(), '乙角色');
  await clickSheetButton('放弃并切换');
  await until(async () => (await roleName()) === '甲角色', 'role a back');
  await until(() => ev("!document.querySelector('.config-sheet')"), 'sheet closed after switch');
  await delay(200);
  assert.equal((await tabDirty('模型'))?.dot, false, '切回甲后不应继承乙的脏点');
  await openChatSheet('role-a');
  assert.equal(await ev("document.querySelector('.config-sheet input')?.value"), 'deepseek-chat', '甲应显示自己的已保存值，没有被乙的宿主接管');
  assert.equal(await ev("document.querySelectorAll('.config-sheet').length"), 1, '多角色实例下纸笺仍只渲染一份');
  await setDraftModel('甲的纸笺草稿');
  await pickRole('b');
  await until(() => ev("!!document.querySelector('.config-sheet-confirm')"), 'only sheet T9');
  await clickSheetButton('放弃修改');
  await until(async () => (await roleName()) === '乙角色', 'without profile draft no T37');
  await until(() => ev("!document.querySelector('.config-sheet')"), 'no sheet after second role switch');
  await openChatSheet('role-b-discarded');
  assert.notEqual(await ev("document.querySelector('.config-sheet input')?.value"), '乙的草稿', '已放弃的乙角色草稿不得恢复');

  // 6) 「＋ 新建角色…」纸笺创建成功后不残留（R13-1）：纸笺与压暗卸载，焦点回到触发它的选择器。
  await ev("document.querySelector('.config-sheet-x')?.click()");
  await until(() => ev("!document.querySelector('.config-sheet')"), 'sheet closed before create');
  await delay(160);
  await pickRole('__new');
  await until(() => ev("!!document.querySelector('.config-sheet')"), 'create sheet');
  await delay(320);
  assert.equal(await ev("document.querySelector('.config-sheet h3')?.textContent.trim()"), '新建角色', '底栏选「＋ 新建角色…」应打开新建角色纸笺');
  await ev(`(()=>{const d=document.querySelector('.config-sheet');const input=d.querySelector('input');const area=d.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'丙角色');input.dispatchEvent(new Event('input',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'丙角色设定');area.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await until(() => ev("[...document.querySelectorAll('.config-sheet button')].some(b=>b.textContent.trim()==='创建角色'&&!b.disabled)"), 'create enabled');
  await clickSheetButton('创建角色');
  await until(async () => (await roleName()) === '丙角色', 'role c created');
  await until(() => ev("!document.querySelector('.config-sheet')"), 'create sheet closed');
  await delay(200);
  const afterCreate = await focusInfo();
  assert.equal(afterCreate.sheets, 0, `创建成功后纸笺不应残留：${JSON.stringify(afterCreate)}`);
  assert.equal(afterCreate.scrims + afterCreate.books, 0, '创建成功后压暗层不应残留');
  assert.equal(afterCreate.tab, '01设定', `创建后应切到新角色的设定分区：${JSON.stringify(afterCreate)}`);
  assert.equal(afterCreate.tag, 'SELECT', `创建后焦点应回到触发纸笺的底栏选择器：${JSON.stringify(afterCreate)}`);
  assert.equal(await ev("[...document.querySelectorAll('.config-role-switch option')].some(o=>o.textContent.includes('丙角色'))"), true, '新角色应出现在底栏选择器里');

  // 7) 跨页跳转（角色配置 → 设置）同样要把焦点交给设置分区的标题（§21.3 未覆盖的设置分区落点）。
  await nav('完成');
  await until(() => ev("[...document.querySelectorAll('.config-check-row')].some(row=>row.textContent.includes('角色状态'))"), 'done rows');
  await ev("[...document.querySelectorAll('.config-check-row')].find(row=>row.textContent.includes('角色状态')).querySelector('button').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"), 'settings page');
  await until(async () => (await focusInfo()).tag === 'H2', 'settings heading after page transition');
  const crossPage = await focusInfo();
  assert.equal(crossPage.tag, 'H2', `跨页跳转后焦点应落在设置分区标题，而不是 body：${JSON.stringify(crossPage)}`);
  assert.equal(crossPage.text, '角色状态', `焦点应落在「角色状态」标题：${JSON.stringify(crossPage)}`);
  assert.equal(crossPage.inLeaf, true, '设置页焦点也应落在右页正文内');

  // 无障碍与关闭窗口：系统减少动效时纸笺及压暗没有动画，Esc 从确认回到输入框，脏草稿触发 beforeunload。
  await cmd('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:'reduce' }] });
  await until(() => ev("matchMedia('(prefers-reduced-motion: reduce)').matches && !!document.querySelector('.config-motion-toggle[aria-pressed=true]')"), 'system reduced policy applied');
  await ev("document.querySelector('.config-return-link').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"), 'return before reduced motion');
  await nav('模型');
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) [data-edit=\"model:chat\"] .config-sum-edit')"), 'chat row reduced');
  const openAnimations = await ev(`new Promise(resolve => {
    document.querySelector('.config-role-editor:not([hidden]) [data-edit="model:chat"] .config-sum-edit').click();
    requestAnimationFrame(() => resolve([...document.querySelectorAll('.config-sheet,.config-scrim,.config-book-scrim')].map(node=>node.getAnimations().length)));
  })`);
  assert.ok(openAnimations.every(count => count === 0), '减少动效下首帧出现的节点无过渡');
  await until(() => ev("document.querySelectorAll('.config-sheet,.config-scrim,.config-book-scrim').length===3"), 'mounted reduced-motion layers');
  const animationDetails = await ev(`({ os:matchMedia('(prefers-reduced-motion: reduce)').matches, mode:document.documentElement.dataset.motion,
    layers:[...document.querySelectorAll('.config-sheet,.config-scrim,.config-book-scrim')].map(node=>({ layer:node.className,
      duration:getComputedStyle(node).getPropertyValue('--nd-semantic-motion-page'), animations:node.getAnimations().map(animation=>({ name:animation.animationName,
        pseudo:animation.effect.pseudoElement, timing:animation.effect.getTiming(), properties:animation.effect.getKeyframes().map(frame=>Object.keys(frame)) })) })) })`);
  assert.ok(animationDetails.layers.every(layer=>layer.animations.length===0), `系统减少动效下两层压暗和纸笺均无过渡：${JSON.stringify(animationDetails)}`);
  await until(() => ev("document.activeElement?.matches('.config-sheet select')"), 'focus field in reduced-motion sheet');
  const modal = await ev(`(() => {
    const sheet=document.querySelector('.config-sheet');
    return { modal:sheet.getAttribute('aria-modal'), backdropInert:!!document.querySelector('.config-leaf-body[inert]') && !!document.querySelector('.config-leaf-foot[inert]'),
      focus:document.activeElement?.tagName, inside:sheet.contains(document.activeElement) };
  })()`);
  assert.deepEqual(modal, { modal:'true', backdropInert:true, focus:'SELECT', inside:true });
  await key('Tab', 'Tab', 9, 8);
  assert.equal(await ev("document.querySelector('.config-sheet').contains(document.activeElement)"), true, '反向 Tab 必须留在纸笺内');
  await ev(`(()=>{const select=document.querySelector('.config-sheet select');const next=[...select.options].find(option=>option.value && !option.disabled);Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,next.value);select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await setDraftModel('待离开确认的草稿');
  const windowIsGuarded = () => ev(`(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})()`);
  assert.equal(await windowIsGuarded(), true, '有草稿离开窗口必须触发确认');
  await key('Escape', 'Escape', 27);
  await until(() => ev("!!document.querySelector('.config-sheet-confirm')"), 'escape opens T9');
  await key('Escape', 'Escape', 27);
  await until(() => ev("!document.querySelector('.config-sheet-confirm') && document.activeElement?.matches('.config-sheet select')"), 'escape cancels T9 and refocuses field');
  await key('Escape', 'Escape', 27);
  await clickSheetButton('放弃修改');
  await until(() => ev("!document.querySelector('.config-sheet')"), 'discard before reduced case ends');
  assert.equal(await windowIsGuarded(), false, '草稿清除后窗口允许离开');

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ afterDiscard, cleanSwitch, roleSwitch, dirtyTab, cleanTab, afterCreate, crossPage }, null, 2));
  console.log(JSON.stringify({ sheetFocus: true, discardRollback: true, dirtyIndicator: true, roleSwitchFocus: true, singleSheet: true, createLeavesNothing: true, crossPageFocus: true, windowGuard: true, reducedMotion: true, afterDiscard, cleanSwitch, roleSwitch, afterCreate, crossPage }, null, 2));
}
run().catch(error => { console.error(error, logs.slice(-1200)); process.exitCode = 1; }).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(400); if (proc && proc.exitCode === null) proc.kill(); server.close();
  try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('settings-sheet-focus-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
