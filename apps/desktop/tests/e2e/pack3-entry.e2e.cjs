'use strict';
/**
 * 包 3 · 冷启动选角页真实桌面核验（DL-147）：
 * 1. 冷启动先停在选角页，不直接进入工作区；
 * 2. 列表展示已建角色，内置夏澄带「内置助手」标识与只读介绍；
 * 3. 选定后进入共享工作区（主页），页面不残留「陪伴」概念。
 * 运行：node tests/pack3-entry-check.cjs（在 apps/desktop 下）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { resolveElectronExecutableInfo } = require('../helpers/electron-executable.cjs');

const { repoRoot: root, desktopDir, backendDir } = require('../helpers/paths.cjs');
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

  // 2. 角色卡片：内置夏澄带标识与只读介绍。
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
  assert.equal(builtin.badge, '内置助手');
  assert.ok(builtin.bio.trim().length > 10, '入口页应显示只读人物介绍');

  // 3. 进入工作区，主页显示当前角色。
  await ev("[...document.querySelectorAll('.role-entry-actions button')].find(b => b.textContent === '进入书房')?.click()");
  await until(() => ev("!!document.querySelector('.studio-shell[data-page=\"home\"]')"), 'workspace-home');
  assert.equal(await ev("!!document.querySelector('.role-entry')"), false, '进入后不再显示选角页');
  assert.equal(await ev("document.body.innerText.includes('陪伴')"), false, '全站不应残留「陪伴」文案');

  // 4. 关系页与对话页共享同一角色。
  const roleId = await ev(`(async () => (await (await fetch('/v1/roles')).json()).items[0].roleId)()`);
  assert.ok(roleId, '后端应返回角色编号');
  await until(() => ev("[...document.querySelectorAll('.ui-dock-item')].some(x=>x.textContent.includes('关系'))"), 'dock-relations');
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('关系')).click()");
  await until(() => ev("!!document.querySelector('.exlibris') && !!document.querySelector('[data-testid=\"plate-name\"]')"), 'relations-loaded');
  const plateName = await ev("document.querySelector('[data-testid=\"plate-name\"]').textContent.trim()");
  assert.equal(plateName, builtin.name, '关系页应停在选角页选定的角色上');

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
