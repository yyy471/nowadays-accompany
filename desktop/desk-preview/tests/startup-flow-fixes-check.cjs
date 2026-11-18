'use strict';
/**
 * 308 首次启动/连接/对话体验修复（#1-#6 + 用户裁决 1-2）真实桌面端到端核验：
 * 1. 创建角色弹窗不反复重开；创建后状态及时同步（不卡在「状态未获取」）；
 * 2. 衣柜去除「当前穿着」与默认选中，点开可收起；生图试跑标签语义隔离；
 * 3. 模型 /models 404 时给出手填指引，新建草稿测试通过后保存立刻保留「测试通过」；
 * 4. 语音/生图预览支持主动取消并显示已耗时；
 * 5. 对话首次进入且角色未选首套服饰时不闪现主题图/「未选择服饰」，展示背景与「即将赶来」提示；
 * 6. 多句按句推进在底部提供「继续下一句 / 全部展开」，两轮实时对话严格按正序排列。
 */
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { resolveElectronExecutableInfo } = require('./electron-executable.cjs');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-308-fixes-'));
const imagePath = path.join(root, 'desktop/desk-preview/renderer/src/assets/themes/xiacheng/character.png');
const pngBytes = fs.readFileSync(imagePath);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label = 'condition', timeoutMs = 25000) {
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

function startFakeOpenAi(getTargetOutfitId) {
  const state = { baseUrl: '', list404Count: 0, chatTurn: 0, server: null };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/models') {
      state.list404Count += 1;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'models endpoint disabled' } }));
      return;
    }
    if (req.method === 'POST' && url === '/chat/completions') {
      const body = raw ? JSON.parse(raw) : {};
      const sys = String(body.messages?.[0]?.content || '');
      const hasToolResult = Array.isArray(body.messages) && body.messages.some(m => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (sys.includes('pong')) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'pong' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (!hasToolResult) state.chatTurn += 1;
      // 第 1 轮先返回多段台词（验证推进控制条 + 全部展开 + 不误插第 2 轮前面）；
      // 第 2 轮先调用 state_update 选穿角色服饰，再返回台词。
      if (state.chatTurn >= 2 && !hasToolResult && getTargetOutfitId()) {
        res.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_outfit_1',
                type: 'function',
                function: {
                  name: 'state_update',
                  arguments: JSON.stringify({ patch: { outfitId: getTargetOutfitId() } }),
                },
              }],
            },
          }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const reply = state.chatTurn === 1
        ? '第一句说完啦。\n（她抬手拢了拢袖口）\n第二句轻轻落下。\n第三句才正式开口。'
        : '换好春衫来见你了。';
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  state.server = server;
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    state.baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve(state);
  }));
}

function startSlowFakeTts() {
  const state = { baseUrl: '', inFlight: 0, abortedByClient: 0, server: null };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        protocol: 'nowadays-tts-v1',
        service: 'slow-fake-tts',
        model: 'mock-tts-v1',
        ready: true,
        capabilities: {
          referenceModes: [],
          presetVoices: true,
          languages: ['zh'],
          speed: { min: 0.5, max: 2.0 },
        },
      }));
      return;
    }
    if (req.method === 'GET' && url === '/voices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ voices: [{ id: 'v-warm', label: '温和女声' }] }));
      return;
    }
    if (req.method === 'POST' && url === '/tts') {
      state.inFlight += 1;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 15000);
        req.on('close', () => {
          if (!res.writableEnded) state.abortedByClient += 1;
          clearTimeout(timer);
          resolve();
        });
      });
      state.inFlight -= 1;
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(Buffer.alloc(64));
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  state.server = server;
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    state.baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve(state);
  }));
}

let backend, electron, ws, fakeAi, fakeTts;
let backendLog = '', electronLog = '', nextId = 0, base = '';
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
async function setInput(selectorExpr, value) {
  await ev(`(()=>{const e=${selectorExpr};const d=Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value');d.set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function setSelect(selectorExpr, value) {
  await ev(`(()=>{const e=${selectorExpr};Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function request(route, options = {}) {
  const response = await fetch(base + route, options);
  const body = await response.json();
  if (!response.ok) throw Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}
const json = (body, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function openMenuPage(label) {
  await until(() => ev("!!document.querySelector('.ui-menu-trigger')"), `menu-trigger-${label}`);
  await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev(`[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes(${JSON.stringify(label)}))`), `menu-item-${label}`);
  await ev(`[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes(${JSON.stringify(label)})).click()`);
}

async function run() {
  let springOutfitId = '';
  fakeAi = await startFakeOpenAi(() => springOutfitId);
  fakeTts = await startSlowFakeTts();

  backend = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--app-root', path.join(temp, 'app'), '--port', '0'], {
    cwd: path.join(root, 'backend'),
    windowsHide: true,
  });
  backend.stdout.on('data', data => backendLog += data);
  backend.stderr.on('data', data => backendLog += data);
  const port = await until(() => /"event":"listening","host":"[^"]+","port":(\d+)/.exec(backendLog)?.[1], 'backend-listen');
  base = `http://127.0.0.1:${port}`;

  // 启动 Electron（初始 0 角色）
  // 这些脚本直接验证工作区页面，跳过冷启动选角页；选角页本身由 pack3-entry 单测覆盖。
  const env = { ...process.env, NOWADAYS_BACKEND_URL: base, NOWADAYS_APP_ROOT: path.join(temp, 'desktop'), NOWADAYS_SKIP_ROLE_PICKER: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronInfo = resolveElectronExecutableInfo({ repoRoot: root });
  electron = spawn(electronInfo.executable, [
    '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`,
    path.join(root, 'desktop/desk-preview'),
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

  // === #1 & #6：以已有内置助手为起点，从角色配置页新建角色，创建后弹窗不重开且活动状态立即可用 ===
  // 包 1 起启动即创建内置助手夏澄，主页不再出现「创建角色」入口；
  // 这里走「角色配置 → 切换角色 → 新建角色」，仍完整覆盖创建弹窗与活动状态同步。
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='home'"), 'home-ready');
  await openMenuPage('角色配置');
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"), 'page-role-config-entry');
  await until(() => ev("!!document.querySelector('.config-switch-role')"), 'switch-role-btn');
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-create-role')"), 'role-wall-open');
  await ev("document.querySelector('.config-create-role').click()");
  await until(() => ev("!!document.querySelector('.config-create-form')"), 'create-modal-open');
  await setInput("document.querySelector('.config-create-form input')", '林雾');
  await setInput("document.querySelector('.config-create-form textarea')", '喜欢看海的少女');
  await ev("[...document.querySelectorAll('.config-create-form button')].find(x=>x.textContent==='创建角色').click()");

  await until(() => ev("!document.querySelector('.config-create-form') && document.querySelector('.config-footer-ident strong')?.textContent==='林雾'"), 'created-role-active');
  // #6：新创建角色（默认 stopped）应立刻同步到真实活动记录：不出现「状态未获取」提示，保存按钮直接显示「保存设定」
  await until(() => ev("!document.querySelector('.config-role-editor:not([hidden]) .config-active-note') && [...document.querySelectorAll('.config-leaf-foot button')].some(b=>b.textContent==='保存设定')"), 'new-role-activity-synced');

  // 来回切换页面后再回「角色配置」，创建弹窗不得再自动弹出
  await openMenuPage('设置');
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"), 'page-settings-1');
  await openMenuPage('角色配置');
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"), 'page-role-back');
  assert.equal(await ev("!!document.querySelector('.config-create-form')"), false, '#1：创建完或切回角色配置后不得重开新建角色弹窗');

  // 导入一套服饰（新角色默认已处于 stopped，可直接导入）并验证外观设置页与生图标签。
  // 启动即存在内置助手夏澄，items[0] 不再保证是刚建的「林雾」，按显示名定位新建角色。
  const rolesRes = await request('/v1/roles');
  const createdRole = rolesRes.items.find(item => item.displayName === '林雾');
  assert.ok(createdRole, `应能按显示名找到刚创建的角色，实际：${rolesRes.items.map(i => i.displayName).join('、')}`);
  const roleId = createdRole.roleId;
  await until(async () => (await request(`/v1/roles/${roleId}/activity`)).activity.state === 'stopped');
  const outfitForm = new FormData();
  outfitForm.append('name', '春衫');
  outfitForm.append('home', new Blob([pngBytes], { type: 'image/png' }), 'home.png');
  const imported = await request(`/v1/roles/${roleId}/appearance/outfits`, { method: 'POST', body: outfitForm });
  springOutfitId = imported.outfitId;

  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('外观')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-outfit-card')"), 'outfit-list-loaded');
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-appearance button')?.disabled"), false, '#6：创建后切到外观时选择素材按钮应立即启用，不被缺失活动状态禁用');
  assert.equal(await ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-appearance-current')"), false, '不得残留当前穿着徽章');
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden])').innerText.includes('当前穿着')"), false, '不得残留当前穿着文案');
  assert.equal(await ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-outfit.selected')"), false, '外观卡片初始不应高亮为默认选中');
  assert.equal(await ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-outfit-manage')"), false, '外观页初始不应直接展开服饰管理');
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-outfit-card').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-outfit-manage h3')?.textContent?.includes('春衫')"), 'outfit-manage-opened');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].find(x=>x.textContent==='收起').click()");
  await until(() => ev("!document.querySelector('.config-role-editor:not([hidden]) .nd-outfit-manage')"), 'outfit-manage-collapsed');

  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.textContent.includes('生图')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview')?.innerText.includes('试生图参考服饰')"), 'image-ref-label');
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview')?.innerText.includes('带哪套服饰')"), false);

  // === #5：新建模型读取 /models 404 时给出手填指引 + 草稿测试通过保存后立即保留「测试通过」 ===
  await openMenuPage('设置');
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"), 'page-settings-model');
  await until(() => ev("!!document.querySelector('.config-index button.config-index-new')"), 'new-model-btn');
  await ev("document.querySelector('.config-index button.config-index-new').click()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) h2')].some(x=>x.textContent==='添加模型服务')"), 'new-model-form');
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[0]", '兼容直连服务');
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[1]", fakeAi.baseUrl);
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[2]", 'sk-test');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='读取模型列表').click()");
  await until(() => fakeAi.list404Count >= 1 && ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('部分兼容接口不开放模型列表属正常现象')"), 'list-404-guidance');

  await setInput("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[role=combobox]')", 'custom-chat');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('测试通过')"), 'draft-model-tested');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存模型服务').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='兼容直连服务'"), 'saved-model-detail');
  const savedCardText = await ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])').innerText");
  assert.equal(savedCardText.includes('最近测试：成功 · custom-chat'), true, `#5：保存前已测通，保存后详情必须立刻显示最近测试成功，实际：\n${savedCardText}`);
  assert.equal(savedCardText.includes('尚未测试'), false, '#5：不得在测通保存后仍显示尚未测试');

  // === #6：慢语音试听中主动取消 ===
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"), 'back-role-for-voice');
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.textContent.includes('语音')).click()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].some(x=>x.textContent.includes('去设置添加'))"), 'role-voice-open-settings');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].find(x=>x.textContent.includes('去设置添加')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings' && document.querySelector('.config-leaf')?.innerText.includes('添加语音服务')"), 'add-voice-form');
  await setInput("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[aria-label=\"语音服务名称\"]')", '慢速试听服务');
  await setInput("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[aria-label=\"语音服务地址\"]')", fakeTts.baseUrl);
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .nd-voice-probe')?.textContent.includes('slow-fake-tts')"), 'voice-probe-ok');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存语音服务').click()");
  await until(async () => (await request('/v1/voice-services')).items.length === 1, 'voice-saved');
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config' && document.querySelector('.config-role-editor:not([hidden]) .nd-voice-probe')?.textContent?.includes('slow-fake-tts')"), 'voice-tab-ready');
  await setSelect("document.querySelector('.config-role-editor:not([hidden]) .nd-voice select[aria-label=\"音色来源\"]')", 'preset');
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice select')].some(s=>[...s.options].some(o=>o.value==='v-warm'))"), 'voice-preset-loaded');
  await setSelect("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice select')].find(s=>[...s.options].some(o=>o.value==='v-warm'))", 'v-warm');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].find(x=>x.textContent==='生成试听').click()");
  await until(() => fakeTts.inFlight >= 1 && ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].some(x=>x.textContent==='取消') && document.querySelector('.config-role-editor:not([hidden]) .nd-voice').innerText.includes('正在合成（')"), 'voice-busy-cancel-visible');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].find(x=>x.textContent==='取消').click()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].some(x=>x.textContent==='生成试听') && document.querySelector('.config-role-editor:not([hidden]) .nd-voice').innerText.includes('已取消本次试听合成')"), 'voice-cancelled');

  // 绑定对话模型并进入对话
  const modelList = await request('/v1/resources');
  const savedModelId = modelList.items.find(item => item.name === '兼容直连服务').resourceId;
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.textContent.includes('对话')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .config-model-details select')"));
  await setSelect("document.querySelector('.config-role-editor:not([hidden]) .config-model-details select')", savedModelId);
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .config-model-details input[role=combobox]')", 'custom-chat');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-details button')].find(x=>x.textContent==='保存模型选择').click()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-details button')].some(x=>x.textContent.includes('开始对话'))"), 'start-chat-visible');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-details button')].find(x=>x.textContent.includes('开始对话')).click()");

  // === #3 & 用户裁决 2(B)：已有导入服饰且未选首套时，仅展示背景 + 「即将赶来」，不闪现主题图和「当前未选择服饰」 ===
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='conversation' && document.querySelector('.dialogue-connection')?.dataset.state==='open'"), 'conversation-ready');
  const initialStage = await ev(`({
    arriving: document.querySelector('.dialogue-stage-arriving')?.innerText || '',
    charImgs: [...document.querySelectorAll('.dialogue-character img')].map(i=>i.getAttribute('src')||''),
    bodyText: document.body.innerText
  })`);
  assert.equal(initialStage.arriving.includes('即将赶来'), true, `应展示角色即将赶来过渡提示，实际: ${initialStage.arriving}`);
  assert.equal(initialStage.charImgs.some(src => src.includes('character')), false, '不得闪现夏澄主题角色立绘');
  assert.equal(initialStage.bodyText.includes('当前未选择服饰'), false, '不得提示当前未选择服饰');

  // === #4：发送多句消息，检查底部推进条（继续下一句 + 全部展开） ===
  await setInput("document.querySelector('.dialogue-composer textarea')", '你好呀');
  await ev("document.querySelector('.dialogue-send').click()");
  await until(() => ev("!!document.querySelector('.dialogue-advance-bar') && document.querySelector('.dialogue-advance-bar').innerText.includes('还有 3 句')"), 'advance-bar-three-left');
  assert.equal(await ev("[...document.querySelectorAll('.dialogue-advance-bar button')].some(b=>b.textContent==='继续下一句')"), true);
  assert.equal(await ev("[...document.querySelectorAll('.dialogue-advance-bar button')].some(b=>b.textContent==='全部展开')"), true);

  await ev("[...document.querySelectorAll('.dialogue-advance-bar button')].find(b=>b.textContent==='继续下一句').click()");
  await until(() => ev("document.querySelector('.dialogue-advance-bar')?.innerText.includes('还有 2 句')"), 'advance-bar-two-left');
  await ev("[...document.querySelectorAll('.dialogue-advance-bar button')].find(b=>b.textContent==='全部展开').click()");
  await until(() => ev("!!document.querySelector('.dialogue-composer textarea') && document.querySelector('.dialogue-messages').innerText.includes('第三句才正式开口')"), 'expanded-all-restored-composer');

  // === #2 & #3 闭环：发送第二轮消息（触发 state_update 穿搭），验证两轮实时消息严格按时间正序且立绘登场 ===
  await setInput("document.querySelector('.dialogue-composer textarea')", '第二轮问候');
  await ev("document.querySelector('.dialogue-send').click()");
  await until(() => ev("!!document.querySelector('.dialogue-composer textarea') && document.querySelector('.dialogue-messages').innerText.includes('换好春衫来见你了')"), 'round-two-completed');

  const orderedTexts = await ev("[...document.querySelectorAll('.dialogue-messages .dialogue-message')].map(el=>el.innerText)");
  const idx = fragment => orderedTexts.findIndex(t => t.includes(fragment));
  const positions = [
    idx('你好呀'),
    idx('第一句说完啦'),
    idx('第三句才正式开口'),
    idx('第二轮问候'),
    idx('换好春衫来见你了'),
  ];
  assert.equal(positions.every(i => i >= 0), true, `所有消息必须存在 DOM 中: ${JSON.stringify(orderedTexts)}`);
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `#2：实时消息顺序不得倒错，positions=${JSON.stringify(positions)} texts=${JSON.stringify(orderedTexts)}`);
  }

  await until(() => ev("!document.querySelector('.dialogue-stage-arriving') && [...document.querySelectorAll('.dialogue-character img')].some(img=>(img.getAttribute('src')||'').includes('/appearance/assets/'))"), 'role-outfit-arrived-on-stage');

  // === 观察项4：取消任务最短 E2E（按钮出现 → 确认 → 实际取消 → 任务终态）===
  // 对话内取消入口只对「用户委托、仍可取消」的任务出现（active／paused）。这里向角色业务库
  // 预置一条 paused+continuable 的用户任务，覆盖「轮询发现 → 按钮出现 → 弹窗确认 → 真正取消 →
  // 任务终态 failed/USER_CANCELLED」的完整 UI→后端链路；创建任务本身不在本用例范围。
  const seededTaskId = randomUUID();
  const seededAt = new Date().toISOString();
  const Database = require(path.join(root, 'backend', 'node_modules', 'better-sqlite3'));
  const businessDb = new Database(path.join(temp, 'app', 'data', 'roles', roleId, 'business.sqlite'));
  try {
    businessDb.prepare(
      "INSERT INTO tasks (task_id, role_id, goal, status, end_reason, created_at, updated_at, origin, continuable, wait_reason) VALUES (?, ?, ?, 'paused', NULL, ?, ?, 'user', 1, 'AWAITING_USER_INPUT')",
    ).run(seededTaskId, roleId, '等你确认后继续办理的测试任务', seededAt, seededAt);
  } finally {
    businessDb.close();
  }
  // 对话页每 5s 轮询任务列表；等取消入口出现（暂停态文案为「取消等待中的任务」）。
  await until(() => ev("!!document.querySelector('.dialogue-task-cancel')"), 'cancel-task-btn-visible', 15000);
  assert.equal(
    await ev("document.querySelector('.dialogue-task-cancel')?.textContent?.includes('取消等待中的任务')"),
    true, '暂停中的任务，取消入口文案应为「取消等待中的任务」',
  );
  await ev("document.querySelector('.dialogue-task-cancel').click()");
  await until(() => ev("!!document.querySelector('.dialogue-cancel-task')"), 'cancel-task-modal-open');
  await ev("[...document.querySelectorAll('.dialogue-cancel-task button')].find(b=>b.textContent==='确认取消任务').click()");
  const cancelled = await until(async () => {
    const task = await request(`/v1/roles/${roleId}/tasks/${seededTaskId}`);
    return task.status === 'failed' && task.endReason === 'USER_CANCELLED' ? task : null;
  }, 'cancel-task-terminal', 15000);
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.endReason, 'USER_CANCELLED');
  await until(() => ev("!document.querySelector('.dialogue-task-cancel')"), 'cancel-task-btn-gone', 15000);

  console.log(JSON.stringify({
    issue1CreateModalNoReopen: true,
    issue2LiveTwoRoundOrder: positions,
    issue3ArrivingThenRoleOutfit: true,
    issue4AdvanceBarAndExpandAll: true,
    issue5Models404AndDraftTestCarried: true,
    issue6ActivitySyncAndCancelVoicePreview: true,
    issue7CancelTaskE2E: { taskId: seededTaskId, status: cancelled.status, endReason: cancelled.endReason },
    errors,
  }, null, 2));
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
  fakeAi?.server?.close();
  fakeTts?.server?.close();
  for (let i = 0; i < 6; i += 1) {
    try { fs.rmSync(temp, { recursive: true, force: true }); break; } catch { await delay(250); }
  }
});
