'use strict';
/**
 * 包 3 · 冷启动选角页真实桌面核验（DL-147）：
 * 1. 冷启动先停在选角页，不直接进入工作区；
 * 2. 列表展示已建角色，主角色显示席位标识和当前人物介绍；
 * 3. 选定后进入共享工作区（主页），页面不残留「陪伴」概念。
 * 运行：node tests/e2e/pack3-entry.e2e.cjs（在 apps/desktop 下）
 */
const { button, configControls, editor, element, setValue, sheet } = require('../helpers/config-page-controls.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { resolveElectronExecutableInfo } = require('../helpers/electron-executable.cjs');

const { repoRoot: root, desktopDir, backendDir, xiachengPortraitFixture } = require('../helpers/paths.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-p3-entry-'));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label = 'condition', timeoutMs = 30000) {
  let last;
  for (const start = Date.now(); Date.now() - start < timeoutMs;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw Error(`等待超时(${label}): ${last || ''}`);
}

let backend, electron, ws, backendLog = '', electronLog = '', nextId = 0, base = '';
const waiting = new Map(), errors = [];

function cmd(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function run() {
  backend = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--app-root', path.join(temp, 'app'), '--port', '0'], {
    cwd: backendDir,
    windowsHide: true,
  });
  backend.stdout.on('data', data => backendLog += data);
  backend.stderr.on('data', data => backendLog += data);
  const port = await until(() => /"event":"listening","host":"[^"]+","port":(\d+)/.exec(backendLog)?.[1], 'backend-listen');
  base = `http://127.0.0.1:${port}`;

  // 冷启动：不设置 NOWADAYS_SKIP_ROLE_PICKER，验证入口页真实出现。
  const env = { ...process.env, NOWADAYS_BACKEND_URL: base, NOWADAYS_APP_ROOT: path.join(temp, 'desktop') };
  delete env.NOWADAYS_SKIP_ROLE_PICKER;
  delete env.ELECTRON_RUN_AS_NODE;
  const electronInfo = resolveElectronExecutableInfo({ repoRoot: root });
  electron = spawn(electronInfo.executable, [
    '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`,
    desktopDir,
  ], { env, windowsHide: true });
  electron.stdout.on('data', data => electronLog += data);
  electron.stderr.on('data', data => electronLog += data);

  const debugPort = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(electronLog)?.[1], 'devtools');
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(i => i.url.startsWith('desk://bundle/')), 'target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const job = waiting.get(message.id);
      waiting.delete(message.id);
      message.error ? job?.reject(message.error) : job?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.text);
    }
  };
  await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // 1. 冷启动停在选角页，未进入工作区。
  await until(() => ev("!!document.querySelector('.role-entry')"), 'role-entry-visible');
  assert.equal(await ev("!!document.querySelector('.studio-shell')"), false, '选角页出现前不应渲染工作区外壳');

  // 2. 角色卡片：主角色带标识与初始介绍。
  await until(() => ev("document.querySelectorAll('.role-entry-card:not(.role-entry-new)').length >= 1"), 'role-cards');
  const cards = await ev(`[...document.querySelectorAll('.role-entry-card:not(.role-entry-new)')].map(card => ({
    name: card.querySelector('.role-entry-name')?.childNodes[0]?.textContent?.trim() || '',
    builtin: card.hasAttribute('data-builtin'),
    badge: card.querySelector('.role-entry-name em')?.textContent || '',
    bio: card.querySelector('.role-entry-bio')?.textContent || '',
  }))`);
  assert.ok(cards.length >= 1, '至少展示一位角色');
  const builtin = cards.find(card => card.builtin);
  assert.ok(builtin, '内置夏澄应带内置标识');
  assert.equal(builtin.badge, '主角色 / 内置管理员 · 不可删除');
  assert.ok(builtin.bio.trim().length > 10, '入口页应显示首次播种的人物介绍');

  // 3. 进入工作区，主页显示当前角色。
  await ev("[...document.querySelectorAll('.role-entry-actions button')].find(b => b.textContent === '进入书房')?.click()");
  await until(() => ev("!!document.querySelector('.studio-shell[data-page=\"home\"]')"), 'workspace-home');
  assert.equal(await ev("!!document.querySelector('.role-entry')"), false, '进入后不再显示选角页');
  assert.equal(await ev("document.body.innerText.includes('陪伴')"), false, '全站不应残留「陪伴」文案');

  const { click, tab, openSheet } = configControls(ev, until);
  await click(element('.ui-menu-trigger'));
  await click(button('角色配置', '.ui-menu-panel:not([inert])'));
  await tab('设定');
  const nameField = element(`${editor} input[aria-label="显示名"]`);
  const bioField = element(`${editor} textarea[aria-label="人物介绍"]`);
  await until(() => ev(`${nameField}?.value === '夏澄' && !!${bioField}?.value`), 'profile-loaded');
  assert.equal(await ev(`${element(editor + ' .config-role-delete-button')}.disabled`), true);
  const save = element('.config-profile-actions button:last-child');
  await ev(setValue(nameField, '岚'));
  await ev(setValue(bioField, '一名档案管理员'));
  await click(save);
  await until(() => ev(`!${save}`), 'profile-saved');
  await ev(setValue(bioField, ''));
  await click(save);
  await until(() => ev(`!${save}`), 'bio-cleared');
  await tab('外观');
  await openSheet(element(editor + ' .config-outfit-card'), '编辑服饰');
  for (const target of [
    element(sheet + ' [data-sheet-focus]'), button('上传差分', sheet),
    button('替换主页立绘', sheet), element(sheet + ' [data-delete-trigger="outfit"]'),
    element(sheet + ' .config-sprite-list [data-delete-trigger]'),
  ]) assert.equal(await ev(`${target}?.disabled`), false);

  const assetName = element(sheet + ' input[aria-label="素材显示名"]');
  await ev(setValue(assetName, '雨后立绘'));
  const saveOutfit = element(sheet + ' .config-save-btn');
  await click(saveOutfit);
  await until(() => ev(`!${element(sheet)}`), 'outfit-saved');
  await openSheet(element(editor + ' .config-outfit-card'), '编辑服饰');
  await until(() => ev(`${assetName}?.value === '雨后立绘'`), 'asset-name-persisted');
  const roleId = (await (await fetch(`${base}/v1/roles`)).json()).items.find(role => role.builtinKey === 'xiacheng').roleId;
  const outfits = async () => (await (await fetch(`${base}/v1/roles/${roleId}/appearance/outfits`)).json()).items;
  const outfit = (await outfits()).find(item => item.home?.displayName === '雨后立绘');
  assert.ok(outfit?.sprites.length);
  const readOutfit = async () => (await outfits()).find(item => item.outfitId === outfit.outfitId);
  await click(button('删除主页立绘', sheet));
  await click(button('删除', sheet + ' .config-sheet-actions'));
  await until(async () => (await readOutfit()).home === null, 'home-removed');

  const sprite = outfit.sprites[0];
  const assetSelect = element(sheet + ' select[aria-label="编辑素材"]');
  await until(() => ev(`${assetSelect}?.value === ${JSON.stringify(sprite.assetId)}`), 'sprite-selected');
  await cmd('Page.setInterceptFileChooserDialog', { enabled: true });
  await click(button('替换此差分', sheet));
  const { root: documentRoot } = await cmd('DOM.getDocument');
  const { nodeId } = await cmd('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: sheet + ' .config-sheet-row input[type=file]' });
  await cmd('DOM.setFileInputFiles', { nodeId, files: [xiachengPortraitFixture] });
  await cmd('Page.setInterceptFileChooserDialog', { enabled: false });
  await until(async () => {
    const current = await readOutfit();
    return current.sprites.length === outfit.sprites.length && !current.sprites.some(item => item.assetId === sprite.assetId);
  }, 'sprite-replaced');
  await click(button('删除服饰…', sheet));
  await click(button('删除', sheet + ' .config-sheet-actions'));
  await until(async () => !(await readOutfit()), 'preset-outfit-removed');
  await cmd('Page.reload');
  await until(() => ev("document.querySelector('.role-entry-card[data-builtin] .role-entry-name')?.firstChild?.textContent === '岚'"), 'entry-renamed');
  assert.equal(await ev("document.querySelector('.role-entry-card[data-builtin] .role-entry-bio').textContent"), '还没有写下介绍');
  await click(button('进入书房', '.role-entry-actions'));

  // 关系页也读取用户保存的名字。
  await until(() => ev("[...document.querySelectorAll('.ui-dock-item')].some(x=>x.textContent.includes('关系'))"), 'dock-relations');
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('关系')).click()");
  await until(() => ev("!!document.querySelector('.exlibris') && !!document.querySelector('[data-testid=\"plate-name\"]')"), 'relations-loaded');
  const plateName = await ev("document.querySelector('[data-testid=\"plate-name\"]').textContent.trim()");
  assert.equal(plateName, '岚', '关系页应停在选角页选定的角色上');

  console.log(JSON.stringify({ entryVisible: true, builtinBadge: builtin.badge, plateName, errors }, null, 2));
  assert.deepEqual(errors, []);
}

run().catch(error => {
  console.error(error, '\n--- backend ---\n', backendLog.slice(-1500), '\n--- electron ---\n', electronLog.slice(-1500));
  process.exitCode = 1;
}).finally(async () => {
  try { ws?.close(); } catch { /* ignore */ }
  for (const child of [electron, backend]) {
    if (child) child.kill('SIGKILL');
  }
  for (let i = 0; i < 6; i += 1) {
    try { fs.rmSync(temp, { recursive: true, force: true }); break; } catch { await delay(250); }
  }
});
