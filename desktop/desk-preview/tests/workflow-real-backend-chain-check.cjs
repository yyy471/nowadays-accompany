'use strict';
/**
 * 真实后端 + 本地假 OpenAI/TTS/ComfyUI HTTP 服务 + Electron 全链路交互核验：
 * 覆盖模型主链与在用暂停支链、扩展绑定与回收、生图配置与删除异常支链、
 * 语音暂存/试听/原子保存/启停、跨角色草稿切换与真实对话（聊天+朗读+过场图），
 * 并采集关键页面截图到 test-results/full-chain-review/（不入库）。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { resolveElectronExecutableInfo } = require('./electron-executable.cjs');

const root = path.resolve(__dirname, '../../..');
const screenshotDir = path.join(root, 'test-results', 'full-chain-review');
fs.mkdirSync(screenshotDir, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-chain-'));
const imagePath = path.join(root, 'desktop/desk-preview/renderer/src/assets/themes/xiacheng/character.png');
const pngBytes = fs.readFileSync(imagePath);

function createWavBuffer(durationMs = 120, sampleRate = 16000) {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}
const wavBytes = createWavBuffer();
const wavPath = path.join(temp, 'sample.wav');
fs.writeFileSync(wavPath, wavBytes);

function startFakeOpenAi(name, modelIds) {
  const state = {
    name,
    listCalls: 0,
    chatCalls: [],
    baseUrl: '',
    server: null,
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/models') {
      state.listCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: modelIds.map(id => ({ id, object: 'model' })) }));
      return;
    }
    if (req.method === 'POST' && url === '/chat/completions') {
      const body = raw ? JSON.parse(raw) : {};
      const userContent = body.messages?.[1]?.content;
      state.chatCalls.push({
        model: body.model,
        auth: req.headers.authorization || null,
        system: body.messages?.[0]?.content || '',
        hasImage: Array.isArray(userContent) && userContent.some(part => part?.type === 'image_url'),
      });
      const sys = String(body.messages?.[0]?.content || '');
      const userText = Array.isArray(userContent)
        ? userContent.filter(part => part?.type === 'text').map(part => part.text || '').join('\n')
        : String(userContent || '');
      let reply = '你好！\n（她轻轻放下茶杯，抬眼看过来）\n今天的风很轻呢。';
      if (sys.includes('pong')) {
        reply = 'pong';
      } else if (sys.includes('角色一致性提示词助手')) {
        assert.equal(
          Array.isArray(userContent) && userContent.some(part => part?.type === 'image_url'),
          true,
          '生成基础锚点提示词时应向对话模型传入角色锚点图片',
        );
        reply = userText.includes('上一版提示词：')
          ? '黑长直，琥珀瞳，柔和神情，日系厚涂'
          : '黑长直，深棕瞳，日系厚涂质感';
      } else if (sys.includes('服饰一致性提示词助手')) {
        assert.equal(
          Array.isArray(userContent) && userContent.some(part => part?.type === 'image_url'),
          true,
          '生成服饰锚点提示词时应向对话模型传入服饰立绘图片',
        );
        reply = '浅米针织开衫，深蓝百褶裙，白色棉袜';
      } else if (sys.includes('过场图规划器')) {
        const userJson = JSON.parse(String(body.messages?.[1]?.content || '{}'));
        const firstSeg = userJson.segments?.[0]?.segmentId;
        const lastSeg = userJson.segments?.at(-1)?.segmentId;
        reply = JSON.stringify({
          description: '午后书房窗边，柔和阳光洒在茶杯与人物肩头',
          layerMode: userJson.requestedLayerMode || 'full_scene',
          ...(firstSeg ? { startSegmentId: firstSeg } : {}),
          ...(lastSeg ? { endSegmentId: lastSeg } : {}),
        });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 16, completion_tokens: 12 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
  });
  state.server = server;
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    state.baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve(state);
  }));
}

function startFakeTts() {
  const state = { baseUrl: '', healthCalls: 0, synthCalls: [], server: null };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      state.healthCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        protocol: 'nowadays-tts-v1',
        service: 'local-fake-tts',
        model: 'mock-tts-v1',
        ready: true,
        capabilities: {
          referenceModes: [
            { id: 'cross_language', label: '跨语种克隆', requiresReferenceText: false },
            { id: 'zero_shot', label: '同语种精确克隆', requiresReferenceText: true },
          ],
          presetVoices: true,
          languages: ['zh', 'en'],
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
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      state.synthCalls.push({
        size: chunks.reduce((sum, c) => sum + c.length, 0),
        hasZeroShot: bodyStr.includes('zero_shot'),
        hasCrossLang: bodyStr.includes('cross_language'),
        hasSampleWav: bodyStr.includes('sample.wav'),
      });
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(wavBytes);
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

const DEFAULT_WAIT_MS = Number(process.env.NOWADAYS_E2E_WAIT_MS) > 0
  ? Number(process.env.NOWADAYS_E2E_WAIT_MS)
  : 25000;
const releaseAllHolds = new Set();

function createComfyHold(state, slotKey, notifyKey, kind, label = kind, timeoutMs = DEFAULT_WAIT_MS) {
  let releaseGate;
  let settleArrived;
  let timer = null;
  let settled = false;
  let released = false;

  const gate = new Promise(resolve => { releaseGate = resolve; });
  const release = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (released) return;
    released = true;
    releaseAllHolds.delete(release);
    if (state[slotKey] === gate) state[slotKey] = null;
    if (state[notifyKey]) state[notifyKey] = null;
    releaseGate?.();
  };
  releaseAllHolds.add(release);

  const arrived = new Promise((resolve, reject) => {
    settleArrived = (err) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (err) reject(err);
      else resolve();
    };
    state[notifyKey] = () => settleArrived(null);
    timer = setTimeout(() => {
      release();
      settleArrived(new Error(`等待超时(${label}): 模拟 ComfyUI ${timeoutMs}ms 内未收到 ${kind} 请求`));
    }, timeoutMs);
  });

  state[slotKey] = gate;
  return { arrived, release };
}

function startFakeComfy(name, models) {
  const state = {
    name,
    baseUrl: '',
    prompts: [],
    authHeaders: [],
    objectInfoHits: 0,
    server: null,
    gateObjectInfo: null,
    onObjectInfoArrived: null,
    holdNextObjectInfo(label = 'object_info', timeoutMs = DEFAULT_WAIT_MS) {
      return createComfyHold(state, 'gateObjectInfo', 'onObjectInfoArrived', '/object_info', label, timeoutMs);
    },
    gatePrompt: null,
    onPromptArrived: null,
    holdNextPrompt(label = 'prompt', timeoutMs = DEFAULT_WAIT_MS) {
      return createComfyHold(state, 'gatePrompt', 'onPromptArrived', '/prompt', label, timeoutMs);
    },
  };
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = req.url || '/';
    if (req.headers.authorization) state.authHeaders.push(req.headers.authorization);
    if (req.method === 'GET' && url === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ system: { comfyui_version: '0.3.60' }, devices: [{ name: `cuda:0 ${name}` }] }));
      return;
    }
    if (req.method === 'GET' && url === '/object_info') {
      state.objectInfoHits += 1;
      if (state.gateObjectInfo) {
        const notify = state.onObjectInfoArrived;
        state.onObjectInfoArrived = null;
        notify?.();
        await state.gateObjectInfo;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        UNETLoader: { input: { required: { unet_name: [models] } } },
        CLIPLoader: { input: { required: { clip_name: [['qwen3.5_9b_w4a8_gptq.safetensors']], type: [['moss_image']] } } },
        VAELoader: { input: { required: { vae_name: [['flux2-vae_small.safetensors']] } } },
        CLIPTextEncode: { input: { required: { text: ['STRING'] } } },
        EmptyFlux2LatentImage: { input: { required: {} } },
        SpectrumMOSSImageManual: { input: { required: {} } },
        SkipLayerGuidanceDiTSimple: { input: { required: {} } },
        KSampler: { input: { required: {} } },
        VAEDecode: { input: { required: {} } },
        SaveImage: { input: { required: {} } },
        MOSSImageHFLoader: { input: { required: {} } },
        ModelSamplingSD3: { input: { required: {} } },
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [[models[0]]] } } },
        MOSSImageUNETLoader: { input: { required: { unet_name: [models] } } },
      }));
      return;
    }
    if (req.method === 'POST' && url === '/prompt') {
      if (state.gatePrompt) {
        const notify = state.onPromptArrived;
        state.onPromptArrived = null;
        notify?.();
        await state.gatePrompt;
      }
      const body = raw ? JSON.parse(raw) : {};
      state.prompts.push({ workflow: body.prompt || null, auth: req.headers.authorization || null });
      const promptId = `p-${++seq}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: promptId, number: seq, node_errors: {} }));
      return;
    }
    if (req.method === 'GET' && url.startsWith('/history/')) {
      const promptId = decodeURIComponent(url.slice('/history/'.length).split('?')[0]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        [promptId]: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { '11': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
        },
      }));
      return;
    }
    if (req.method === 'GET' && url.startsWith('/view?')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(pngBytes);
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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label = '', timeoutMs = DEFAULT_WAIT_MS) {
  let last;
  for (const start = Date.now(); Date.now() - start < timeoutMs;) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw Error(`等待超时${label ? `(${label})` : ''}: ${last || ''}`);
}

let backend, electron, ws, backendLog = '', electronLog = '', nextId = 0, base = '';
const waiting = new Map(), errors = [];
const closeServers = [];

function cmd(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) {
      reject(new Error(`CDP 连接未就绪(${method})`));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      reject(new Error(`等待超时(cdp:${method}): ${DEFAULT_WAIT_MS}ms 内未收到响应`));
    }, DEFAULT_WAIT_MS);
    waiting.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function shot(name) {
  const result = await cmd('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(screenshotDir, name), Buffer.from(result.data, 'base64'));
}
async function request(route, options = {}) {
  const response = await fetch(base + route, options);
  const body = await response.json();
  if (!response.ok) throw Error(`${response.status} ${route}: ${JSON.stringify(body)}`);
  return body;
}
const jsonReq = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function setInput(selectorExpr, value) {
  await ev(`(()=>{const el=${selectorExpr};if(!el)throw Error('missing input');const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function setSelect(selectorExpr, value) {
  await ev(`(()=>{const el=${selectorExpr};if(!el)throw Error('missing select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

async function run() {
  const llmA = await startFakeOpenAi('llm-a', ['fake-chat-a', 'fake-mem-a']);
  const llmB = await startFakeOpenAi('llm-b', ['fake-chat-b', 'fake-mem-b']);
  const tts = await startFakeTts();
  const comfyA = await startFakeComfy('comfy-a', ['moss-image-base.safetensors', 'sd_xl_base_1.0.safetensors']);
  const comfyB = await startFakeComfy('comfy-b', ['backup-image-model.safetensors']);
  closeServers.push(llmA.server, llmB.server, tts.server, comfyA.server, comfyB.server);

  backend = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--app-root', path.join(temp, 'app'), '--port', '0'], {
    cwd: path.join(root, 'backend'),
    windowsHide: true,
  });
  backend.stdout.on('data', d => backendLog += d);
  backend.stderr.on('data', d => backendLog += d);
  const port = await until(() => /"event":"listening","host":"[^"]+","port":(\d+)/.exec(backendLog)?.[1], 'backend-port');
  base = `http://127.0.0.1:${port}`;

  // 初始化两个角色（新建默认处于 stopped 态，允许初始整理服饰与首轮配置）。
  const roleA = await request('/v1/roles', jsonReq({ displayName: '甲角色', definition: { text: '温柔体贴的甲角色' } }));
  const roleB = await request('/v1/roles', jsonReq({ displayName: '乙角色', definition: { text: '冷静理性的乙角色' } }));
  const actBefore = await request('/v1/activities');
  assert.equal(actBefore.items.every(i => i.state === 'stopped'), true, '新建角色默认应处于 stopped 态');
  const outfitForm = new FormData();
  outfitForm.append('name', '春装');
  outfitForm.append('home', new Blob([pngBytes], { type: 'image/png' }), 'home.png');
  await request(`/v1/roles/${roleA.roleId}/appearance/outfits`, { method: 'POST', body: outfitForm });

  const outfitFormB = new FormData();
  outfitFormB.append('name', '冬装');
  outfitFormB.append('home', new Blob([pngBytes], { type: 'image/png' }), 'home.png');
  const outfitB = await request(`/v1/roles/${roleB.roleId}/appearance/outfits`, { method: 'POST', body: outfitFormB });

  const env = { ...process.env, NOWADAYS_BACKEND_URL: base, NOWADAYS_APP_ROOT: path.join(temp, 'desktop') };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronInfo = resolveElectronExecutableInfo({ repoRoot: root });
  electron = spawn(electronInfo.executable, [
    '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`,
    path.join(root, 'desktop/desk-preview'),
  ], { env, windowsHide: true });
  electron.stdout.on('data', d => electronLog += d);
  electron.stderr.on('data', d => electronLog += d);

  const debugPort = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(electronLog)?.[1], 'devtools-port');
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(i => i.url.startsWith('desk://bundle/')), 'electron-target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待超时(cdp-open): ${DEFAULT_WAIT_MS}ms 内未连通`)), DEFAULT_WAIT_MS);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = (err) => { clearTimeout(timer); reject(err); };
  });
  ws.onclose = () => {
    for (const [id, job] of waiting) {
      waiting.delete(id);
      job.reject(new Error('CDP 连接已关闭'));
    }
  };
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) {
      const job = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? job?.reject(msg.error) : job?.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.text);
    }
  };
  await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // === 链路 1：设置导航、两栏收敛、跨页回跳不串 Tab（Bug 1 & Bug 2） ===
  await until(() => ev("!!document.querySelector('.ui-menu-trigger')"), 'menu-trigger');
  await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev("[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes('设置'))"), 'menu-settings');
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes('设置')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"), 'page-settings');
  assert.deepEqual(await ev("[...document.querySelectorAll('.config-kind-tabs button')].map(x=>x.textContent)"), ['模型', '生图']);

  // 先切到「生图」，再回到角色「模型 -> 对话 -> 在设置中查看模型」，验证必须回到「模型」而非停在「生图」。
  await ev("[...document.querySelectorAll('.config-kind-tabs button')].find(x=>x.textContent==='生图').click()");
  await until(() => ev("document.querySelector('.config-kind-tabs button[aria-pressed=\"true\"]')?.textContent==='生图'"));
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"), 'return-role');
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].some(x=>x.textContent.includes('在设置中查看模型'))"), 'open-model-link');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent.includes('在设置中查看模型')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"), 'back-to-settings');
  assert.equal(await ev("document.querySelector('.config-kind-tabs button[aria-pressed=\"true\"]')?.textContent"), '模型', 'Bug1修复：查看模型应切回模型分类而非留在生图');

  // 验证 Bug 2：先点「添加 MCP」停在添加页，再切回角色扩展点「在设置中管理」不得滞留添加表单。
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('MCP')).click()");
  await until(() => ev("!!document.querySelector('.config-index button.config-index-new')"));
  await ev("document.querySelector('.config-index button.config-index-new').click()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) h2')].some(x=>x.textContent==='添加 MCP')"));
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('扩展')).click()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].some(x=>x.textContent.includes('在设置中管理'))"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent.includes('在设置中管理')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"));
  assert.equal(await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) h2')].some(x=>x.textContent==='添加 MCP')"), false, 'Bug2修复：进入扩展管理不得滞留未关闭的添加表单');

  // === 链路 2：创建模型 m1/m2 + 列表与测通 + 绑定到激活中角色甲/乙 ===
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  await until(() => ev("!!document.querySelector('.config-index button.config-index-new')"));
  await ev("document.querySelector('.config-index button.config-index-new').click()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) h2')].some(x=>x.textContent==='添加模型服务')"));
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[0]", '主对话模型');
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[1]", llmA.baseUrl);
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[2]", 'key-a');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='读取模型列表').click()");
  await until(() => llmA.listCalls === 1, 'm1-list');
  await setInput("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[role=combobox]')", 'fake-chat-a');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('测试通过')"), 'm1-test');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存模型服务').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='主对话模型'"), 'm1-saved-ui');

  // 创建第二个模型 m2 给乙角色，用于验证修改 m1 连接参数时只暂停依赖 m1 的甲角色而不碰乙角色。
  await ev("document.querySelector('.config-index button.config-index-new').click()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) h2')].some(x=>x.textContent==='添加模型服务')"));
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[0]", '次模型');
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[1]", llmB.baseUrl);
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[2]", 'key-b');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存模型服务').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='次模型'"), 'm2-saved-ui');
  const resourcesInit = await request('/v1/resources');
  const m1 = resourcesInit.items.find(i => i.name === '主对话模型');
  const m2 = resourcesInit.items.find(i => i.name === '次模型');

  // 回到角色配置：stopped 甲直接绑 m1（「保存模型选择」），再去角色状态恢复甲/乙为启用中，随后在启用中的乙绑 m2（「暂停并保存」+「继续活动」）。
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .config-model-details select')"));
  await setSelect("document.querySelector('.config-role-editor:not([hidden]) .config-model-details select')", m1.resourceId);
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .config-model-details input[role=combobox]')", 'fake-chat-a');
  assert.equal(await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-details button')].some(x=>x.textContent==='保存模型选择')"), true, '停止态角色应直接显示保存模型选择');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-details button')].find(x=>x.textContent==='保存模型选择').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden])')?.innerText.includes('模型选择已保存')"), 'bind-a-stopped');

  // 通过设置 -> 角色状态页恢复甲和乙，并从乙状态卡直跳乙角色配置页
  await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev("[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes('设置'))"));
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes('设置')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"));
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('角色')).click()");
  await until(() => ev("[...document.querySelectorAll('.config-status-poster')].filter(p=>p.textContent.includes('恢复活动')).length===2"), 'status-wall-two');
  await ev("[...document.querySelectorAll('.config-status-poster')].find(p=>p.textContent.includes('甲角色')).querySelector('button').click()");
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active', 'resume-a-wall');
  await ev("[...document.querySelectorAll('.config-status-poster')].find(p=>p.textContent.includes('乙角色')).querySelector('button').click()");
  await until(async () => (await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state === 'active', 'resume-b-wall');
  await ev("[...document.querySelectorAll('.config-status-poster')].find(p=>p.textContent.includes('乙角色')).querySelectorAll('button')[1].click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config' && document.querySelector('.config-footer-ident strong')?.textContent==='乙角色'"), 'jump-b-from-wall');
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .config-model-details select')"));
  await setSelect("document.querySelector('.config-role-editor:not([hidden]) .config-model-details select')", m2.resourceId);
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .config-model-details input[role=combobox]')", 'fake-chat-b');
  assert.equal(await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-details button')].some(x=>x.textContent==='暂停并保存')"), true, '启用中角色应显示暂停并保存');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-details button')].find(x=>x.textContent==='暂停并保存').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden])')?.innerText.includes('模型选择已保存') && document.querySelector('.config-role-editor:not([hidden])')?.innerText.includes('继续活动')"), 'bind-b');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='继续活动').click()");
  await until(async () => (await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state === 'active', 'resume-b-after-bind');

  // 切回甲角色后再从甲角色「在设置中查看模型」，验证定位到 m1
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("[...document.querySelectorAll('.config-poster-hit')].some(x=>x.textContent.includes('甲角色'))"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('甲角色')).click()");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"), 'switch-to-a-for-model');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent.includes('在设置中查看模型')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings' && document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='主对话模型'"), 'jump-to-m1');

  // === 链路 3：模型主链修改（改名不暂停）+ 正被使用的支链（改连接只暂停依赖角色甲，不动乙） ===
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('甲角色 · 对话 / 记忆整理 · 启用中')"), 'impact-a-only');
  assert.equal(await ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('乙角色')"), false, '影响范围不应误包含无关角色乙');
  await shot('settings-model-1280.png');
  await setInput("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[aria-label=\"模型服务名称\"]')", '主对话模型·改');
  assert.equal(await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='保存模型服务')"), true, '仅改名称不得要求暂停相关角色');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存模型服务').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('模型服务已保存')"), 'm1-renamed');
  const actsAfterRename = await request('/v1/activities');
  assert.equal(actsAfterRename.items.every(i => i.state === 'active'), true, '仅改模型名后甲乙两角色都应保持启用中');

  // 现在修改 m1 的地址（切到 llmB）和密钥：必须出现「暂停相关角色并保存」，且仅暂停甲，乙继续保持 active！
  await setInput("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .config-connection input')", llmB.baseUrl);
  await setInput("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[aria-label=\"模型密钥\"]')", 'key-b2');
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='暂停相关角色并保存')"), 'pause-related-btn');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='暂停相关角色并保存').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('已暂停 甲角色')"), 'paused-only-a');
  assert.equal((await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state, 'stopped', '关联角色甲应已被暂停');
  assert.equal((await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state, 'active', '未关联角色乙应保持启用中');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='继续本次活动暂停的角色').click()");
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active', 'resume-a-from-model-detail');

  // === 链路 4：扩展（MCP/Skill）创建、角色开启绑定、占用检查、关闭绑定、停用删除 ===
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('MCP')).click()");
  await until(() => ev("!!document.querySelector('.config-index button.config-index-new')"));
  await ev("document.querySelector('.config-index button.config-index-new').click()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) h2')].some(x=>x.textContent==='添加 MCP')"));
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[0]", '文件工具');
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[1]", 'node');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存资源').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='文件工具'"), 'mcp-saved-ui');

  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('扩展')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) > .config-prose:not([hidden])')?.innerText.includes('文件工具')"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) > .config-prose:not([hidden]) .config-row')].find(x=>x.textContent.includes('文件工具')).querySelector('input[type=checkbox]').click()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) > .config-prose:not([hidden]) button')].some(x=>x.textContent==='暂停并保存'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) > .config-prose:not([hidden]) button')].find(x=>x.textContent==='暂停并保存').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) > .config-prose:not([hidden])')?.innerText.includes('扩展选择已保存') && document.querySelector('.config-role-editor:not([hidden]) > .config-prose:not([hidden])')?.innerText.includes('继续活动')"), 'ext-saved-real');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) > .config-prose:not([hidden]) button')].find(x=>x.textContent==='继续活动').click()");
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active', 'resume-a-after-ext');

  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) > .config-prose:not([hidden]) button')].find(x=>x.textContent.includes('在设置中管理')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings' && document.querySelector('.config-leaf')?.innerText.includes('文件工具')"));
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('甲角色') && document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('角色已开启')"), 'ext-ref-shown');
  assert.equal(await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='删除')?.disabled"), true, '被启用角色绑定的扩展禁止删除');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='关闭全部启用绑定').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('甲角色 · 角色已关闭')"), 'ext-unbound');
  assert.equal((await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state, 'active', '关闭绑定后甲角色应自动恢复活动');
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='全局停用'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='全局停用').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('已停用')"), 'ext-disabled');
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='删除'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='删除').click()");
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='确认删除').click()");
  await until(async () => !(await request('/v1/resources')).items.some(i => i.name === '文件工具'), 'mcp-deleted');

  // === 链路 5：生图全局管理（收敛后无角色内建、跨站点留密预拦截、暂停与恢复） + 角色生图 + 删除服务后失效服务支链 ===
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.textContent.includes('生图')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-image')"));
  assert.equal(await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].some(x=>x.textContent.includes('新建服务'))"), false, '收敛检查：角色生图面板不得保留重复的内联新建服务按钮');
  assert.equal(await ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-image-new-service')"), false);

  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent.includes('在设置中管理')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings' && document.querySelector('.config-leaf')?.innerText.includes('添加生图服务')"), 'auto-open-new-image-service');

  // 创建主生图 comfyA 与备用生图 comfyB
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[0]", '主生图');
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[1]", comfyA.baseUrl);
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[2]", 'img-secret-a');
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[3]", '15000');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='读取模型列表').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('已读取 2 个模型')"), 'probe-comfy-a-list');
  await ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[role=combobox]').focus()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) .nd-model-options [role=option]')].length === 2"), 'comfy-a-two-options');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) .nd-model-options [role=option] button')].find(x=>x.textContent==='moss-image-base.safetensors').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[role=combobox]')?.value==='moss-image-base.safetensors'"), 'comfy-a-picked-default');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('moss-image-base.safetensors')"), 'probe-comfy-a');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存生图服务').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='主生图'"), 'img-1-created-ui');

  await ev("document.querySelector('.config-index button.config-index-new').click()");
  await until(() => ev("document.querySelector('.config-leaf')?.innerText.includes('添加生图服务')"));
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[0]", '备用生图');
  await setInput("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) input')[1]", comfyB.baseUrl);
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存生图服务').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='备用生图'"), 'img-2-created-ui');

  // 选中主生图测试「保留原密钥改站点」客户端前置拦截：绝不能先暂停活跃角色甲乙再报错！
  await ev("[...document.querySelectorAll('.config-index button')].find(x=>x.textContent.includes('主生图')).click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='主生图'"));
  await setInput("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .config-connection input')", comfyB.baseUrl);
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='暂停活跃角色并保存').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) [role=alert]')?.textContent.includes('换了服务地址，需要重新填写密钥')"), 'site-change-blocked-before-pause');
  assert.equal((await request('/v1/activities')).items.every(i => i.state === 'active'), true, '跨站点留密前置校验拦截后不得无故暂停活跃角色');

  // 改回 comfyA，修改名称与密钥并正式保存（应先停活跃角色并允许一键继续）。
  await setInput("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[aria-label=\"生图服务名称\"]')", '主生图·可用');
  await setInput("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .config-connection input')", comfyA.baseUrl);
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='暂停活跃角色并保存').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('已暂停') && document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('继续本次暂停的角色')"), 'img1-paused-save');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='继续本次暂停的角色').click()");
  await until(async () => (await request('/v1/activities')).items.every(i => i.state === 'active'), 'img1-resumed');

  // 回到甲角色配置生图（探测、选模型芯片、填锚点、展开生成参数与服饰锚点、草稿试生图不落库、再正式保存）
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  const svcs = (await request('/v1/image-services')).items;
  const img1 = svcs.find(s => s.name === '主生图·可用');
  const img2 = svcs.find(s => s.name === '备用生图');
  await until(() => ev(`(() => { const s = document.querySelector('.config-role-editor:not([hidden]) .nd-image-service-row select'); return !!s && s.value !== '' && [...s.options].some(o => o.value === '${img1.serviceId}'); })()`), 'auto-select-after-settings');
  await setSelect("document.querySelector('.config-role-editor:not([hidden]) .nd-image-service-row select')", img1.serviceId);
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]')?.value==='moss-image-base.safetensors'"), 'prefill-default-image-model');
  await ev("(()=>{const el=document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]');el.focus();el.click();})()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image .nd-model-options [role=option]')].some(x=>x.textContent==='moss-image-base.safetensors')"), 'shared-image-options');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image .nd-model-options [role=option] button')].find(x=>x.textContent==='sd_xl_base_1.0.safetensors').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]')?.value==='sd_xl_base_1.0.safetensors'"), 'pick-second-image-model');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('已确认模型「sd_xl_base_1.0.safetensors」')"), 'confirm-second-image-model');
  await ev("(()=>{const el=document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]');el.focus();el.click();})()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image .nd-model-options [role=option]')].some(x=>x.textContent==='moss-image-base.safetensors')"), 'reopen-image-options');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image .nd-model-options [role=option] button')].find(x=>x.textContent==='moss-image-base.safetensors').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]')?.value==='moss-image-base.safetensors'"), 'pick-first-image-model');
  const llmBCallsBeforeAnchor = llmB.chatCalls.length;
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image button[aria-label=\"用对话模型生成基础锚点提示词\"]').click()");
  await until(() => llmB.chatCalls.length > llmBCallsBeforeAnchor && ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image textarea[aria-label=\"基础锚点提示词\"]')?.value==='黑长直，深棕瞳，日系厚涂质感'"), 'chat-model-base-anchor-1');
  assert.equal(llmB.chatCalls.at(-1).hasImage, true);
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image button[aria-label=\"用对话模型生成基础锚点提示词\"]').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image textarea[aria-label=\"基础锚点提示词\"]')?.value==='黑长直，琥珀瞳，柔和神情，日系厚涂'"), 'chat-model-base-anchor-2');
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image button[aria-label=\"用对话模型生成「春装」服饰提示词\"]').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image-outfits input[placeholder=\"例如：米色风衣，深色长裤\"]')?.value==='浅米针织开衫，深蓝百褶裙，白色棉袜'"), 'chat-model-outfit-anchor');
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .nd-image textarea')", '黑长直，深棕瞳，柔和神情');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent.includes('生成参数')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-image input[placeholder=\"例如：米色风衣，深色长裤\"]')"));
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .nd-image input[placeholder=\"例如：米色风衣，深色长裤\"]')", '米色风衣');
  await shot('role-image-1280.png');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='测试生图').click()");
  await until(() => ev("(() => { const img = document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure img'); return !!(img && img.complete && img.naturalWidth > 0); })()"), 'draft-image-preview');
  assert.equal(comfyA.prompts.some(p => p.auth === 'Bearer img-secret-a'), true, '生图测试应使用已保存凭据访问真实本地 ComfyUI');
  const beforeSceneSave = await request(`/v1/roles/${roleA.roleId}/scene-image`);
  assert.equal(beforeSceneSave.configured, false, '测试生图不得修改已保存角色生图配置');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='暂停并保存配置').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image')?.innerText.includes('已保存生图配置') && document.querySelector('.config-role-editor:not([hidden])')?.innerText.includes('继续活动')"), 'save-roleA-scene-image');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='继续活动').click()");
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active', 'resume-a-after-scene');

  // 给乙角色绑定备用生图后去设置删除备用生图，验证 Bug 3 修复（乙角色生图面板必须显式显示「原服务已删除」，不得视觉错显为主生图、也不得误停用角色乙）。
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("[...document.querySelectorAll('.config-poster-hit')].some(x=>x.textContent.includes('乙角色'))"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='乙角色'"));
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-image-service-row select')"));
  await setSelect("document.querySelector('.config-role-editor:not([hidden]) .nd-image-service-row select')", img2.serviceId);
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .nd-image input[placeholder=\"moss_image_sft_int8_convrot.safetensors\"]')", 'backup-image-model.safetensors');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='暂停并保存配置').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image')?.innerText.includes('已保存生图配置') && document.querySelector('.config-role-editor:not([hidden])')?.innerText.includes('继续活动')"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='继续活动').click()");
  await until(async () => (await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state === 'active');

  // 292-R05 / 292-R06 跨页生图与在途编辑恢复回归验证：
  // 0) 出图期间修改测试画面描述、测试服饰或基础草稿参数：旧响应不得写回样图，同时「测试生图」按钮立即/可用最新草稿重测（283 §28）。
  const inFlightEdit1 = comfyB.holdNextPrompt('r06-inflight-edit-1-prompt');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image-preview button')].find(x=>x.textContent==='测试生图').click()");
  await inFlightEdit1.arrived;
  await until(() => ev("(() => { const btn = document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview button'); return !!btn && btn.disabled && btn.textContent.includes('正在出图'); })()"), 'r06-inflight-busy-1');
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview input')", '雨夜霓虹街景');
  await until(() => ev("(() => { const btn = document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview button'); return !!btn && !btn.disabled && btn.textContent === '测试生图'; })()"), 'r06-button-restored-after-prompt-edit');
  inFlightEdit1.release();
  await delay(250);
  assert.equal(await ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure')"), false, '出图期间改画面描述后，旧响应不得渲染样图');

  const inFlightEdit2 = comfyB.holdNextPrompt('r06-inflight-edit-2-prompt');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image-preview button')].find(x=>x.textContent==='测试生图').click()");
  await inFlightEdit2.arrived;
  await until(() => ev("(() => { const btn = document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview button'); return !!btn && btn.disabled && btn.textContent.includes('正在出图'); })()"), 'r06-inflight-busy-2');
  await setSelect("document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview select')", outfitB.outfitId);
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .nd-image textarea')", '银灰挑染，冷静眼神');
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview input')", '窗边微光特写');
  await until(() => ev("(() => { const btn = document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview button'); return !!btn && !btn.disabled && btn.textContent === '测试生图'; })()"), 'r06-button-restored-after-draft-edit');
  inFlightEdit2.release();
  await delay(250);
  assert.equal(await ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure')"), false, '出图期间改服饰与草稿后，旧响应不得渲染样图');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image-preview button')].find(x=>x.textContent==='测试生图').click()");
  await until(() => ev("(() => { const img = document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure img'); const cap = document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure figcaption')?.textContent || ''; return !!(img && img.complete && img.naturalWidth > 0 && cap.includes('银灰挑染，冷静眼神') && cap.includes('窗边微光特写')); })()"), 'r06-repreview-with-latest-draft');

  // 验证已有样图时再次出图并在途中改写画面描述：旧在途响应不得覆盖现有样图，随后仍可用最新草稿重测。
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview input')", '将被放弃的旧出图描述');
  const inFlightEdit3 = comfyB.holdNextPrompt('r06-inflight-edit-3-prompt');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image-preview button')].find(x=>x.textContent==='测试生图').click()");
  await inFlightEdit3.arrived;
  await until(() => ev("(() => { const btn = document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview button'); return !!btn && btn.disabled && btn.textContent.includes('正在出图'); })()"), 'r06-inflight-busy-3');
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview input')", '最终稳定新描述');
  await until(() => ev("(() => { const btn = document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview button'); return !!btn && !btn.disabled && btn.textContent === '测试生图'; })()"), 'r06-button-restored-with-existing-preview');
  inFlightEdit3.release();
  await delay(250);
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure figcaption')?.textContent.includes('将被放弃的旧出图描述')"), false, '已有样图时在途编辑，旧响应不得覆盖样图');

  // 1) 在乙角色探测备用生图（得到 backup-image-model.safetensors 候选）并以最新草稿测试生图，验证草稿字段保留。
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('已确认模型「backup-image-model.safetensors」')"), 'r06-probe-before-disable');
  const beforeStep1Prompts = comfyB.prompts.length;
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image-preview button')].find(x=>x.textContent==='测试生图').click()");
  await until(() => comfyB.prompts.length > beforeStep1Prompts && ev("(() => { const img = document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure img'); const cap = document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure figcaption')?.textContent || ''; const btn = document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview button'); return !!(img && img.complete && img.naturalWidth > 0 && cap.includes('最终稳定新描述') && btn && !btn.disabled && btn.textContent === '测试生图'); })()"), 'r06-preview-before-disable');

  // 2) 去设置停用备用生图再返回：旧探测候选与预览图必须清除、草稿字段保留，且直接保存被拦下（不得暂停活跃角色乙）。
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent.includes('在设置中管理')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings' && document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='备用生图'"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='暂停并停用').click()");
  await until(async () => (await request('/v1/image-services')).items.find(s => s.serviceId === img2.serviceId)?.enabled === false, 'img2-disabled');
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='继续本次暂停的角色')"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='继续本次暂停的角色').click()");
  await until(async () => (await request('/v1/activities')).items.every(i => i.state === 'active'), 'roles-resumed-after-disable');
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image')?.innerText.includes('当前所选生图服务已停用')"), 'r05-disabled-alert');
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]').focus()");
  assert.equal(await ev("document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image .nd-model-options [role=option]').length"), 0, '停用后旧候选模型必须清除');
  assert.equal(await ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure')"), false, '停用后旧测试样图必须清除');
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image textarea')?.value"), '银灰挑染，冷静眼神', '停用后返回不得丢失未保存生图草稿');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='暂停并保存配置').click()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image [role=alert]')].some(x=>x.textContent.includes('生图服务已停用，启用后再试'))"), 'r05-disabled-save-rejected');
  assert.equal((await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state, 'active', '292-R05：停用生图服务保存失败前不得暂停角色乙');

  // 3) 重新启用备用生图，再完成一次探测并发起一条在途慢预览，然后去设置修改连接配置（timeoutMs）后释放：
  // 已返回的探测候选与在途晚到的测试样图都不得渲染或写回，草稿保留。
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent.includes('在设置中管理')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings' && document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='备用生图'"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='暂停并启用').click()");
  await until(async () => (await request('/v1/image-services')).items.find(s => s.serviceId === img2.serviceId)?.enabled === true, 'img2-reenabled');
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='继续本次暂停的角色')"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='继续本次暂停的角色').click()");
  await until(async () => (await request('/v1/activities')).items.every(i => i.state === 'active'));
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));

  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='读取模型列表').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('已读取 1 个模型')"), 'r06-probe-before-edit');
  const slowPreview = comfyB.holdNextPrompt('r06-slow-preview-prompt');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='测试生图').click()");
  await slowPreview.arrived;

  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent.includes('在设置中管理')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings' && document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='备用生图'"));
  await setInput("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .config-connection input[type=number]')", '45000');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='暂停活跃角色并保存').click()");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden])')?.innerText.includes('生图服务已保存')"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='继续本次暂停的角色').click()");
  await until(async () => (await request('/v1/activities')).items.every(i => i.state === 'active'));
  slowPreview.release();
  await delay(150);
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]').focus()");
  await until(() => ev("document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image .nd-model-options [role=option]').length === 0 && !document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure')"), 'r06-cleared-after-edit');
  await delay(200);
  assert.equal(await ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure')"), false, '连接修改后在途晚到测试样图不得写回渲染');
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image textarea')?.value"), '银灰挑染，冷静眼神', '修改连接配置返回后应保留生图草稿');

  // 4) 验证：一次已完成的探测 + 生图，以及一个尚未返回的在途慢探测，在设置删除备用生图后都不得残留或晚到写回。
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('已确认模型「backup-image-model.safetensors」')"), 'r06-probe-before-delete');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='测试生图').click()");
  await until(() => ev("(() => { const img = document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure img'); return !!(img && img.complete && img.naturalWidth > 0); })()"), 'r06-preview-before-delete');
  const slowProbe = comfyB.holdNextObjectInfo('r06-slow-probe-object-info');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='读取模型列表').click()");
  await slowProbe.arrived;

  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent.includes('在设置中管理')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings' && document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='备用生图'"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='删除生图服务').click()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='暂停并删除')"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='暂停并删除').click()");
  await until(async () => (await request('/v1/image-services')).items.length === 1, 'img2-deleted');
  await until(async () => (await request('/v1/activities')).items.every(i => i.state === 'active'), 'roles-resumed-after-delete');
  slowProbe.release();
  await delay(150);
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image')?.innerText.includes('当前所选生图服务已不存在')"), 'bug3-missing-service-alert');
  await delay(250);
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]').focus()");
  assert.equal(await ev("document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image .nd-model-options [role=option]').length"), 0, '删除后旧候选及在途晚到响应均不得存在');
  assert.equal(await ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure')"), false, '删除后旧样图必须清除');
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image textarea')?.value"), '银灰挑染，冷静眼神', '删除后应保留未保存生图草稿');
  assert.equal(await ev(`document.querySelector('.config-role-editor:not([hidden]) .nd-image-service-row select')?.value==='${img2.serviceId}'`), true, 'Bug3修复：不得静默改写已失效 serviceId');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='暂停并保存配置').click()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image [role=alert]')].filter(x=>x.textContent.includes('已不存在')).length === 2"), 'bug3-save-blocked-before-pause');
  assert.equal((await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state, 'active', '保存失效生图服务前校验拦截不得无故暂停角色乙');
  await setSelect("document.querySelector('.config-role-editor:not([hidden]) .nd-image-service-row select')", img1.serviceId);
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='暂停并保存配置').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image')?.innerText.includes('已保存生图配置') && document.querySelector('.config-role-editor:not([hidden])')?.innerText.includes('继续活动')"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='继续活动').click()");
  await until(async () => (await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state === 'active');

  // === 链路 6：切回甲角色测试语音暂存、试听、原子 multipart 保存、使用中不可删、停用/启用切换 ===
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("[...document.querySelectorAll('.config-poster-hit')].some(x=>x.textContent.includes('甲角色'))"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('甲角色')).click()");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"), 'switch-to-a-for-voice');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.textContent.includes('语音')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-voice input[placeholder=\"http://127.0.0.1:8000\"]')"));
  await setInput("document.querySelector('.config-role-editor:not([hidden]) .nd-voice input[placeholder=\"http://127.0.0.1:8000\"]')", tts.baseUrl);
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-voice-probe')?.textContent.includes('local-fake-tts')"), 'tts-probe');

  await setSelect(" [...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice select')].find(x=>[...x.options].some(o=>o.value==='cross_language'))", 'cross_language');
  const docVoice = await cmd('DOM.getDocument');
  const voiceInput = await cmd('DOM.querySelector', { nodeId: docVoice.root.nodeId, selector: '.config-role-editor:not([hidden]) .nd-voice input[type=file]' });
  await cmd('DOM.setFileInputFiles', { nodeId: voiceInput.nodeId, files: [wavPath] });
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-voice')?.innerText.includes('待上传：sample.wav')"), 'voice-staged');
  assert.equal((await request(`/v1/roles/${roleA.roleId}/voice/references`)).items.length, 0, '选文件暂存期不得写入后端参考音频');

  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].find(x=>x.textContent==='生成试听').click()");
  await until(() => tts.synthCalls.length === 1 && tts.synthCalls[0].hasCrossLang, 'voice-preview-real');
  assert.equal((await request(`/v1/roles/${roleA.roleId}/voice/references`)).items.length, 0, '试听不得写入后端参考音频');

  // 切到需要参考文本的 zero_shot 且不填文本：点击保存应在暂停前就被客户端拦截，甲仍为 active！
  await setSelect(" [...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice select')].find(x=>[...x.options].some(o=>o.value==='zero_shot'))", 'zero_shot');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].find(x=>x.textContent==='暂停并保存声音配置').click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-voice .nd-appearance-error')"), 'voice-missing-ref-text');
  assert.equal((await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state, 'active', '缺少参考文本拦截时不得暂停甲角色');

  await setInput("document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice textarea')[0]", '你好，今天风很轻。');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].find(x=>x.textContent==='暂停并保存声音配置').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-voice-references')?.innerText.includes('sample.wav') && document.querySelector('.config-role-editor:not([hidden])')?.innerText.includes('继续活动')"), 'voice-atomic-saved');
  const refsAfterSave = (await request(`/v1/roles/${roleA.roleId}/voice/references`)).items;
  assert.equal(refsAfterSave.length, 1);
  assert.equal(refsAfterSave[0].inUse, true);
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-voice-references button')?.disabled"), true, '使用中的参考音频不得删除');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='继续活动').click()");
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active');

  // 停用语音开关 -> 确认已保留配置且可再启用
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-voice-toggle input').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-voice')?.innerText.includes('已停用角色语音')"));
  assert.equal((await request(`/v1/roles/${roleA.roleId}/voice`)).voice.enabled, false);
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-voice-toggle input').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-voice')?.innerText.includes('已启用角色语音')"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='继续活动').click()");
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active');

  // 小屏 + 夜间主题抽查
  await cmd('Emulation.setDeviceMetricsOverride', { width: 720, height: 540, deviceScaleFactor: 1, mobile: false });
  await ev("[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('晚风电台')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.uiPreset==='nightwave'"));
  await delay(450);
  await shot('role-voice-night-720.png');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await ev("document.querySelectorAll('.ui-theme-switcher button')[0].click()");
  await delay(300);

  // === 链路 7：跨角色未保存草稿切换（.config-poster-dirty）+ 进入真实对话（发送消息验证 llmB -> 点播语音 -> 手动生成过场图并查看） ===
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('设定')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) input[aria-label=\"显示名\"]')"));
  await setInput("document.querySelector('.config-role-editor:not([hidden]) input[aria-label=\"显示名\"]')", '甲角色未保存草稿');
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("[...document.querySelectorAll('.config-poster-hit')].some(x=>x.textContent.includes('乙角色'))"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("!!document.querySelector('.config-dirty-prompt')"), 'dirty-prompt-visible');
  await ev("[...document.querySelectorAll('.config-dirty-prompt button')].find(x=>x.textContent==='保留草稿，切换').click()");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='乙角色'"));
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("[...document.querySelectorAll('.config-poster')].find(x=>x.textContent.includes('甲角色'))?.querySelector('.config-poster-dirty')?.textContent==='未保存'"), 'poster-dirty-badge');
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('甲角色')).click()");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"), 'switch-to-a-for-chat');
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.textContent.includes('对话')).click()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-details button')].some(x=>x.textContent==='开始对话')"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-details button')].find(x=>x.textContent==='开始对话').click()");

  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='conversation' && document.querySelector('.dialogue-connection')?.dataset.state==='open'"), 'dialogue-open');
  await shot('dialogue-ready.png');

  const llmBCallsBeforeChat = llmB.chatCalls.length;
  const ttsCallsBeforeChat = tts.synthCalls.length;
  await setInput("document.querySelector('.dialogue-composer textarea')", '看看窗外，风怎么样？');
  await ev("document.querySelector('.dialogue-send').click()");
  await until(() => llmB.chatCalls.length > llmBCallsBeforeChat, 'llmB-called-after-repoint');
  assert.equal(llmB.chatCalls.at(-1).auth, 'Bearer key-b2', '修改模型连接并恢复活动后，对话应使用最新地址与新密钥');

  // 推进或等待助理文字气泡出现并完成本轮演出（出现输入栏与生成过场图入口）
  await until(async () => {
    const canAdv = await ev("document.querySelector('.dialogue-messages')?.dataset.canAdvance==='true'");
    if (canAdv) await ev("document.querySelector('.dialogue-messages').click()");
    return ev("[...document.querySelectorAll('.dialogue-message.assistant .dialogue-bubble')].some(x=>x.textContent.includes('你好')) && !document.querySelector('.dialogue-waiting') && !document.querySelector('.dialogue-advance-hint') && !!document.querySelector('.dialogue-composer')");
  }, 'assistant-reply-visible');

  // 触发语音合成按钮 -> 验证真实后端 /speech 调本地假 TTS（兼容预取已触发或点击按需触发）
  await ev("document.querySelector('.dialogue-message.assistant .dialogue-speaker').click()");
  await until(() => tts.synthCalls.length > ttsCallsBeforeChat, 'dialogue-segment-tts').catch(async e => {
    console.error('DIAG tts calls:', JSON.stringify(tts.synthCalls), 'toast:', await ev("document.querySelector('.dialogue-toast')?.innerText || document.body.innerText.slice(-400)"));
    throw e;
  });

  // 触发手动过场图 -> 选「人物与背景」-> 验证真实后端 /scene-images 先用模型规划再调本地假 ComfyUI 并在对话中渲染查看
  const comfyPromptsBeforeDialogue = comfyA.prompts.length;
  await until(() => ev("[...document.querySelectorAll('.dialogue-round-tools button')].some(x=>x.textContent.includes('生成过场图'))"), 'draw-scene-btn');
  await ev("[...document.querySelectorAll('.dialogue-round-tools button')].find(x=>x.textContent.includes('生成过场图')).click()");
  await until(() => ev("[...document.querySelectorAll('.dialogue-scene-options button')].some(x=>x.textContent==='人物与背景')"), 'scene-mode-modal');
  await ev("[...document.querySelectorAll('.dialogue-scene-options button')].find(x=>x.textContent==='人物与背景').click()");
  await until(() => comfyA.prompts.length > comfyPromptsBeforeDialogue, 'dialogue-comfy-called');
  await until(() => ev("[...document.querySelectorAll('.dialogue-round-tools .dialogue-scene-chip')].some(x=>x.textContent.startsWith('查看'))"), 'scene-chip-ready');
  await ev("[...document.querySelectorAll('.dialogue-round-tools .dialogue-scene-chip')].find(x=>x.textContent.startsWith('查看')).click()");
  await until(() => ev("(() => { const full = document.querySelector('.dialogue-scene-full img'); return (full && full.complete && full.naturalWidth > 0) || !!document.querySelector('.dialogue-stage')?.dataset.scene; })()"), 'scene-displayed');
  await shot('dialogue-scene.png');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    realBackend: true,
    navigationBug1Fixed: true,
    navigationBug2Fixed: true,
    modelMainAndSelectivePauseBranch: true,
    modelUpdatedUsedInChat: true,
    extensionBindAndCleanup: true,
    imageServiceConvergedNoInlineCreate: true,
    imageSiteChangeGuardedBeforePause: true,
    imageDeletedServiceGuardedAndDisplayed: true,
    imageDisabledSaveGuardedBeforePause: true,
    imageCrossPageProbeAndPreviewInvalidated: true,
    imageInFlightDraftEditRecoversPreviewButton: true,
    electronExecutableSource: electronInfo.source,
    electronExecutableResolvedFromDesktop:
      electronInfo.source === 'desktop-local' || electronInfo.source === 'desktop-node-resolve',
    voiceStagedZeroWritePreviewAtomicSave: true,
    dialogueChatVoiceSceneE2E: true,
    errors,
  }, null, 2));
}

run().catch(error => {
  console.error(error, '\n--- BACKEND LOG ---\n', backendLog.slice(-1500), '\n--- ELECTRON LOG ---\n', electronLog.slice(-1000));
  process.exitCode = 1;
}).finally(async () => {
  for (const release of [...releaseAllHolds]) { try { release(); } catch {} }
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(300);
  if (electron && electron.exitCode === null) electron.kill();
  if (backend && backend.exitCode === null) backend.kill();
  for (const s of closeServers) { try { s.closeAllConnections?.(); s.close(); } catch {} }
  await delay(500);
  try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('nowadays-chain-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
