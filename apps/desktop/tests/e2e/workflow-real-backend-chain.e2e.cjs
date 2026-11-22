'use strict';
/** 底栏角色切换（3a4ac9a 起改为原生 select）：按显示名选中并派发 change。 */
async function pickRole(name) {
  const ok = await ev(`(()=>{const s=document.querySelector('.config-role-switch');if(!s)return false;const o=[...s.options].find(o=>o.textContent.includes(${JSON.stringify(name)}));if(!o)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,o.value);s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  if (!ok) throw Error('no role option: ' + name);
}

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
const { resolveElectronExecutableInfo } = require('../helpers/electron-executable.cjs');
const { button, configControls, editor, element, sheet } = require('../helpers/config-page-controls.cjs');

const { repoRoot: root, desktopDir, backendDir, xiachengPortraitFixture, testResultsDir } = require('../helpers/paths.cjs');
const screenshotDir = path.join(testResultsDir, 'full-chain-review');
fs.mkdirSync(screenshotDir, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-chain-'));
const imagePath = xiachengPortraitFixture;
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
    const url = (req.url || '/').replace(/^\/alternate(?=\/)/, '');
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

/**
 * 在同一求值内「找到即点」并返回布尔：找不到就交回 until 重试。
 * 原先的「until 判存在 → 另一次 ev 里 find().click()」在两次求值之间可能被重渲染清掉，
 * 表现为 TypeError: Cannot read properties of undefined (reading 'click')。
 */
async function clickWhen(expression, label = '') {
  await until(() => ev(`(()=>{const el=${expression};if(!el || el.disabled || el.closest('[inert]') || el.getAttribute('aria-disabled')==='true' || !el.getClientRects().length)return false;el.click();return true;})()`), label || expression);
}

/**
 * 等待下拉候选就绪。ImageModelPicker 的 onBlur 会在 120ms 后收起列表，
 * 因此不能只 focus 一次干等：每次探测都在同一次求值内「未展开则唤出」，再数候选。
 */
async function untilModelOptions(scope, count, label = '') {
  const input = `${scope} input[role=combobox]`;
  const options = `${scope} .nd-model-options [role=option]`;
  await until(() => ev(`(()=>{
    const input=document.querySelector(${JSON.stringify(input)});
    if(!input) return false;
    if(input.getAttribute('aria-expanded')!=='true'){ input.focus(); input.click(); return false; }
    return document.querySelectorAll(${JSON.stringify(options)}).length === ${count};
  })()`), label);
}

/**
 * 选中下拉候选：同一次求值内「缺则唤出 → 出现即按下」。
 * 候选按钮只用 onMouseDown（preventDefault 保留焦点），所以必须派发 mousedown 而不是 click()。
 */
async function pickModelOption(scope, text, label = '') {
  const input = `${scope} input[role=combobox]`;
  const option = `${scope} .nd-model-options [role=option] button`;
  await until(() => ev(`(()=>{
    const input=document.querySelector(${JSON.stringify(input)});
    if(!input) return false;
    const option=[...document.querySelectorAll(${JSON.stringify(option)})].find(x=>x.textContent.trim()===${JSON.stringify(text)});
    if(!option){ input.focus(); input.click(); return false; }
    option.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
    return true;
  })()`), label);
}

async function run() {
  const llmA = await startFakeOpenAi('llm-a', ['fake-chat-a', 'fake-mem-a']);
  const llmB = await startFakeOpenAi('llm-b', ['fake-chat-b', 'fake-mem-b']);
  const tts = await startFakeTts();
  const comfyA = await startFakeComfy('comfy-a', ['moss-image-base.safetensors', 'sd_xl_base_1.0.safetensors']);
  const comfyB = await startFakeComfy('comfy-b', ['backup-image-model.safetensors']);
  closeServers.push(llmA.server, llmB.server, tts.server, comfyA.server, comfyB.server);

  backend = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--app-root', path.join(temp, 'app'), '--port', '0'], {
    cwd: backendDir,
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
  // 启动即存在内置助手夏澄（保持 stopped），凡「全员 active」断言都改为只看脚本自建的甲、乙。
  const bothActive = async () => {
    const items = (await request('/v1/activities')).items;
    const stateOf = (roleId) => items.find(i => i.roleId === roleId)?.state;
    return stateOf(roleA.roleId) === 'active' && stateOf(roleB.roleId) === 'active';
  };
  const outfitForm = new FormData();
  outfitForm.append('name', '春装');
  outfitForm.append('home', new Blob([pngBytes], { type: 'image/png' }), 'home.png');
  await request(`/v1/roles/${roleA.roleId}/appearance/outfits`, { method: 'POST', body: outfitForm });

  const outfitFormB = new FormData();
  outfitFormB.append('name', '冬装');
  outfitFormB.append('home', new Blob([pngBytes], { type: 'image/png' }), 'home.png');
  const outfitB = await request(`/v1/roles/${roleB.roleId}/appearance/outfits`, { method: 'POST', body: outfitFormB });

  // 这些脚本直接验证工作区页面，跳过冷启动选角页；选角页本身由 pack3-entry 单测覆盖。
  const env = { ...process.env, NOWADAYS_BACKEND_URL: base, NOWADAYS_APP_ROOT: path.join(temp, 'desktop'), NOWADAYS_SKIP_ROLE_PICKER: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronInfo = resolveElectronExecutableInfo({ repoRoot: root });
  electron = spawn(electronInfo.executable, [
    '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`,
    desktopDir,
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
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      const { type, message } = msg.params;
      errors.push(`未预期的本机确认：${type} ${message}`);
      void cmd('Page.handleJavaScriptDialog', { accept: false }).catch(error => errors.push(String(error)));
    }
  };
  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:'reduce' }] });

  const { openRoleRow, tab, openSheet } = configControls(ev, until);
  const actions = sheet + ' .config-sheet-actions';
  const sheetButton = (label) => button(label, sheet);
  const saveButton = (pause = false) => `[...document.querySelectorAll('${actions} button')].find(button=>new RegExp(${JSON.stringify(pause ? '^暂停并保存(?: *[0-9]+)?$' : '^保存(?: *[0-9]+)?$')}).test(button.textContent.trim()))`;
  const field = selector => element(`${sheet} ${selector}`);
  const selectService = async name => {
    await clickWhen(`[...document.querySelectorAll('.config-index-item')].find(item=>item.querySelector('strong')?.textContent===${JSON.stringify(name)})`);
    await waitService(name);
  };
  const waitService = name => until(() => ev(`!document.querySelector('.config-sheet') && document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent===${JSON.stringify(name)}`), 'service ' + name);
  const openSettings = async () => {
    await clickWhen(element('.ui-menu-trigger'));
    await clickWhen("[...document.querySelectorAll('.ui-menu-item')].find(item=>item.textContent.includes('设置'))");
    await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"), 'page-settings');
  };
  const returnRole = async (closeCleanSheet = false) => {
    if (!closeCleanSheet) await until(() => ev("!document.querySelector('.config-sheet,.config-leaf-body[inert]')"), 'current write and sheet exit complete');
    await until(() => ev(`(() => {
      if(document.querySelector('.studio-shell')?.dataset.page==='role-config')return true;
      const link=document.querySelector('.config-return-link');
      if(link && !link.disabled && !document.querySelector('.config-sheet-confirm'))link.click();
      return false;
    })()`), 'return-role');
  };
  const addService = title => openSheet(element('.config-index button.config-index-new'), title);
  const navigateModel = () => clickWhen(sheetButton('在设置中查看模型 →'));
  const resumePaused = () => clickWhen(button('继续活动', '.config-leaf-foot'));
  const editService = () => openSheet(element('.config-prose:not([hidden]) .config-service-edit'));
  const poster = name => `[...document.querySelectorAll('.config-status-poster')].find(item=>item.querySelector('.config-status-name')?.textContent===${JSON.stringify(name)})`;
  const addField = index => `document.querySelectorAll('.config-sheet input')[${index}]`;
  const setModel = model => setInput(field('input[role=combobox]'), model);
  const bindModel = async (role, resource, model, pause) => {
    await openRoleRow('model:chat');
    await until(() => ev(`!!${field('select')}`), 'chat service field');
    await setSelect(field('select'), resource);
    await until(() => ev(`!!${field('input[role=combobox]')}`), 'chat name field');
    await setModel(model);
    await clickWhen(saveButton(pause), pause ? '暂停并保存绑定' : '保存绑定');
    await until(async () => (await request(`/v1/roles/${role}/bindings`)).items.some(item => item.capability === 'chat_model' && item.resourceId === resource && item.modelName === model), 'saved chat binding');
    await until(() => ev("!document.querySelector('.config-sheet')"), 'binding sheet closes');
  };

  // === 链路 1：设置导航、两栏收敛、跨页回跳不串 Tab（Bug 1 & Bug 2） ===
  await openSettings();
  assert.deepEqual(await ev("[...document.querySelectorAll('.config-kind-tabs button')].map(x=>x.textContent)"), ['模型', '语音', '生图']);
  await clickWhen(button('生图', '.config-kind-tabs'));
  await until(() => ev("document.querySelector('.config-kind-tabs button[aria-pressed=true]')?.textContent==='生图'"));
  await returnRole();
  await tab('模型');
  await openRoleRow('model:chat');
  await clickWhen(sheetButton('去设置添加 →'), 'unbound model link');
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"), 'back-to-settings');
  assert.equal(await ev("document.querySelector('.config-kind-tabs button[aria-pressed=true]')?.textContent"), '模型', '查看对话模型应回到模型分类');

  await tab('MCP');
  await addService('添加 MCP');
  await returnRole(true);
  await tab('扩展');
  await openRoleRow('ext:mcp');
  await clickWhen(sheetButton('去设置添加 →'));
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"));
  assert.equal(await ev("!!document.querySelector('.config-sheet')"), false, '进入扩展管理不得滞留未关闭的添加表单');

  // === 链路 2：创建模型 m1/m2 + 列表与测通 + 绑定激活中角色甲/乙 ===
  await tab('模型');
  await addService('添加模型服务');
  await setInput(addField(0), '主对话模型');
  await setInput(field('.config-connection input'), llmA.baseUrl);
  await setInput(field('input[type=password]'), 'key-a');
  await clickWhen(sheetButton('读取列表'));
  await until(() => llmA.listCalls === 1, 'm1-list');
  await setModel('fake-chat-a');
  await clickWhen(button('测试连接', sheet + ' .config-grp:has(input[role=combobox])'));
  await until(() => ev("document.querySelector('.config-sheet')?.innerText.includes('测试通过')"), 'm1-test');
  await clickWhen(sheetButton('添加'));
  await waitService('主对话模型');

  await addService('添加模型服务');
  await setInput(addField(0), '次模型');
  await setInput(field('.config-connection input'), llmB.baseUrl);
  await setInput(field('input[type=password]'), 'key-b');
  await clickWhen(sheetButton('添加'));
  await waitService('次模型');
  const resourcesInit = await request('/v1/resources');
  const m1 = resourcesInit.items.find(i => i.name === '主对话模型');
  const m2 = resourcesInit.items.find(i => i.name === '次模型');

  await returnRole();
  await tab('设定');
  await until(() => ev(`!!${element(`${editor} textarea[aria-label="角色设定"]`)}?.value`));
  await pickRole("甲角色");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"), 'select-a-before-bind');
  await tab('模型');
  await bindModel(roleA.roleId, m1.resourceId, 'fake-chat-a', false);

  await openSettings();
  await tab('角色');
  await until(() => ev(`${poster('甲角色')}?.innerText.includes('恢复活动') && ${poster('乙角色')}?.innerText.includes('恢复活动')`), 'status-wall-two');
  await clickWhen(`${poster('甲角色')}.querySelector('button')`);
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active', 'resume-a-wall');
  await clickWhen(`${poster('乙角色')}.querySelector('button')`);
  await until(async () => (await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state === 'active', 'resume-b-wall');
  await clickWhen(element('button[aria-label="乙角色的角色配置"]'));
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config' && document.querySelector('.config-footer-ident strong')?.textContent==='乙角色'"), 'jump-b-from-wall');
  await tab('模型');
  await bindModel(roleB.roleId, m2.resourceId, 'fake-chat-b', true);
  assert.equal((await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state, 'stopped');
  await resumePaused();
  await until(async () => (await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state === 'active', 'resume-b-after-bind');

  await pickRole("甲角色");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"), 'switch-to-a-for-model');
  await openRoleRow('model:chat');
  await navigateModel();
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"), 'jump-to-m1');
  await waitService('主对话模型');

  // === 链路 3：改名不暂停；改连接只暂停依赖角色甲 ===
  const occupancy = element('.config-prose:not([hidden]) .config-use-row');
  await until(() => ev(`${occupancy}?.innerText.includes('甲角色')`), 'impact-a-only');
  assert.equal(await ev(`${occupancy}?.innerText.includes('乙角色')`), false, '影响范围不应误包含无关角色乙');
  await shot('settings-model-1280.png');
  await editService();
  await setInput(field('input[aria-label="模型服务名称"]'), '主对话模型·改');
  await clickWhen(saveButton(false), 'rename without pause');
  await waitService('主对话模型·改');
  assert.equal(await bothActive(), true, '仅改模型名保持甲乙活动');

  await editService();
  await setInput(field('.config-connection input'), llmB.baseUrl);
  await setInput(field('input[aria-label="模型密钥"]'), 'key-b2');
  await clickWhen(saveButton(true), 'pause-related-btn');
  await until(() => ev("document.querySelector('.config-leaf-foot')?.innerText.includes('已为保存暂停甲角色')"), 'paused-only-a');
  assert.equal((await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state, 'stopped', '关联角色甲应已被暂停');
  assert.equal((await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state, 'active', '未关联角色乙应保持启用中');
  await resumePaused();
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active', 'resume-a-from-model-detail');

  // === 链路 4：MCP 创建、角色开启绑定、占用检查、关闭绑定、停用删除 ===
  await tab('MCP');
  await addService('添加 MCP');
  await setInput(addField(0), '文件工具');
  await setInput(addField(1), 'node');
  await clickWhen(sheetButton('添加'));
  await waitService('文件工具');
  const extension = (await request('/v1/resources')).items.find(item => item.name === '文件工具');
  await returnRole();
  await tab('扩展');
  await openRoleRow('ext:mcp');
  await clickWhen(field('[role=switch][aria-label="为角色开启文件工具"]'));
  await clickWhen(saveButton(true), 'pause for extension binding');
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/bindings`)).items.some(item => item.resourceId === extension.resourceId && item.enabled), 'ext-saved-real');
  await resumePaused();
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active', 'resume-a-after-ext');

  await openRoleRow('ext:mcp');
  await clickWhen(sheetButton('在设置中管理 →'));
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"));
  await selectService('文件工具');
  await until(() => ev(`${occupancy}?.innerText.includes('甲角色')`), 'ext-ref-shown');
  const deleteMcp = button('删除 MCP…');
  assert.equal(await ev(`${deleteMcp}?.disabled`), true, '被启用角色绑定的扩展禁止删除');
  await clickWhen(element('.config-prose:not([hidden]) .config-occupancy-details summary'));
  await clickWhen(button('关闭全部启用绑定'));
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/bindings`)).items.some(item => item.resourceId === extension.resourceId && !item.enabled), 'ext-unbound');
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active', '关闭绑定后甲角色应自动恢复活动');
  await clickWhen(element('[role=switch][aria-label="全局启用文件工具"]'));
  await until(async () => (await request('/v1/resources')).items.some(item => item.resourceId === extension.resourceId && !item.enabled), 'ext-disabled');
  await clickWhen(deleteMcp);
  await clickWhen(sheetButton('删除'));
  await until(async () => !(await request('/v1/resources')).items.some(i => i.name === '文件工具'), 'mcp-deleted');

  // === 链路 5：全局生图、角色图片草稿与服务维护 ===
  const image = sheet + ' .nd-image';
  const voice = sheet + ' .nd-voice';
  const openImage = () => openRoleRow('media:image');
  const openVoice = () => openRoleRow('media:voice');
  const imageSettings = label => clickWhen(button(label, image));
  const imageButton = label => button(label, image);
  const mediaSave = `[...document.querySelectorAll('${actions} button')].find(button=>/^(?:暂停并|重试)?保存(?: *[0-9]+)?$/.test(button.textContent.trim()))`;
  const clickImageSave = () => clickWhen(mediaSave, 'image save');
  const clickVoiceSave = () => clickWhen(mediaSave, 'voice save');
  const imageNotice = text => until(() => ev(`document.querySelector('.config-sheet')?.innerText.includes(${JSON.stringify(text)})`), text);
  const imageSaved = (roleId, serviceId) => until(async () => (await request(`/v1/roles/${roleId}/scene-image`)).settings?.serviceId === serviceId, 'role image saved');

  await returnRole();
  await tab('模型');
  await openImage();
  assert.equal(await ev(`!!${button('新建服务', image)} || !!${element(image + ' .nd-image-new-service')}`), false, '角色生图纸笺不得有重复的新建入口');
  await imageSettings('去设置添加 →');
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings' && document.querySelector('.config-sheet h3')?.textContent==='添加生图服务'"), 'auto-open-new-image-service');

  await setInput(addField(0), '主生图');
  await setInput(addField(1), comfyA.baseUrl);
  await setInput(field('input[type=password]'), 'img-secret-a');
  await clickWhen(sheetButton('读取模型列表'));
  await imageNotice('已读取 2 个模型');
  await untilModelOptions(sheet, 2, 'comfy-a-two-options');
  await pickModelOption(sheet, 'moss-image-base.safetensors', 'comfy-a-pick-default');
  await until(() => ev(`${field('input[role=combobox]')}?.value==='moss-image-base.safetensors'`), 'comfy-a-picked-default');
  await clickWhen(sheetButton('测试连接'));
  await imageNotice('moss-image-base.safetensors');
  await clickWhen(sheetButton('添加'));
  await waitService('主生图');

  await addService('添加生图服务');
  await setInput(addField(0), '备用生图');
  await setInput(addField(1), comfyB.baseUrl);
  await clickWhen(sheetButton('添加'));
  await waitService('备用生图');

  // 更换 origin 却留用原密钥时，客户端拦截，不发 PATCH 或暂停。
  await selectService('主生图');
  await editService();
  const groupInput = name => `[...document.querySelectorAll('.config-sheet .config-grp')].find(group=>group.querySelector('.config-grp-label b')?.textContent===${JSON.stringify(name)})?.querySelector('input')`;
  await setInput(groupInput('连接'), comfyB.baseUrl);
  await imageNotice('换了站点，请重新填写密钥。');
  assert.equal(await ev(`${field('.config-save-btn')}?.disabled`), true, '保留密钥换站点时不可提交');
  assert.equal(await bothActive(), true, '跨站点保留密钥时不得暂停角色');
  await setInput(groupInput('连接'), comfyA.baseUrl);
  await setInput(field('input[aria-label="生图服务名称"]'), '主生图·可用');
  await clickWhen(saveButton(false));
  await waitService('主生图·可用');
  assert.equal(await bothActive(), true, '仅改名称不得暂停角色');

  // 回到甲角色配置生图（探测、选模型芯片、填锚点、展开生成参数与服饰锚点、草稿试生图不落库、再正式保存）
  await clickWhen("document.querySelector('.config-return-link')");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  await tab('模型');
  await openImage();
  const svcs = (await request('/v1/image-services')).items;
  const img1 = svcs.find(s => s.name === '主生图·可用');
  const img2 = svcs.find(s => s.name === '备用生图');
  await until(() => ev(`(() => { const s = document.querySelector('.config-sheet .nd-image-service-row select'); return !!s && s.value !== '' && [...s.options].some(o => o.value === '${img1.serviceId}'); })()`), 'auto-select-after-settings');
  await setSelect("document.querySelector('.config-sheet .nd-image-service-row select')", img1.serviceId);
  await until(() => ev("document.querySelector('.config-sheet .nd-image input[role=combobox]')?.value==='moss-image-base.safetensors'"), 'prefill-default-image-model');
  await pickModelOption('.config-sheet .nd-image', 'sd_xl_base_1.0.safetensors', 'shared-image-options');
  await until(() => ev("document.querySelector('.config-sheet .nd-image input[role=combobox]')?.value==='sd_xl_base_1.0.safetensors'"), 'pick-second-image-model');
  await clickWhen("[...document.querySelectorAll('.config-sheet .nd-image button')].find(x=>x.textContent==='测试连接')");
  await imageNotice('已确认模型「sd_xl_base_1.0.safetensors」');
  await pickModelOption('.config-sheet .nd-image', 'moss-image-base.safetensors', 'reopen-image-options');
  await until(() => ev("document.querySelector('.config-sheet .nd-image input[role=combobox]')?.value==='moss-image-base.safetensors'"), 'pick-first-image-model');
  const llmBCallsBeforeAnchor = llmB.chatCalls.length;
  await clickWhen("document.querySelector('.config-sheet .nd-image button[aria-label=\"用对话模型生成基础锚点提示词\"]')");
  await until(() => llmB.chatCalls.length > llmBCallsBeforeAnchor && ev("document.querySelector('.config-sheet .nd-image textarea[aria-label=\"基础锚点提示词\"]')?.value==='黑长直，深棕瞳，日系厚涂质感'"), 'chat-model-base-anchor-1');
  assert.equal(llmB.chatCalls.at(-1).hasImage, true);
  await clickWhen("document.querySelector('.config-sheet .nd-image button[aria-label=\"用对话模型生成基础锚点提示词\"]')");
  await until(() => ev("document.querySelector('.config-sheet .nd-image textarea[aria-label=\"基础锚点提示词\"]')?.value==='黑长直，琥珀瞳，柔和神情，日系厚涂'"), 'chat-model-base-anchor-2');
  await clickWhen("document.querySelector('.config-sheet .nd-image button[aria-label=\"用对话模型生成「春装」服饰提示词\"]')");
  await until(() => ev("document.querySelector('.config-sheet .nd-image-outfits input[placeholder=\"例如：米色风衣，深色长裤\"]')?.value==='浅米针织开衫，深蓝百褶裙，白色棉袜'"), 'chat-model-outfit-anchor');
  await setInput("document.querySelector('.config-sheet .nd-image textarea')", '黑长直，深棕瞳，柔和神情');
  await until(() => ev("!!document.querySelector('.config-sheet .nd-image input[placeholder=\"例如：米色风衣，深色长裤\"]')"));
  await setInput("document.querySelector('.config-sheet .nd-image input[placeholder=\"例如：米色风衣，深色长裤\"]')", '米色风衣');
  await shot('role-image-1280.png');
  await clickWhen("[...document.querySelectorAll('.config-sheet .nd-image button')].find(x=>x.textContent==='测试生图')");
  await until(() => ev("(() => { const img = document.querySelector('.config-sheet .nd-image-figure img'); return !!(img && img.complete && img.naturalWidth > 0); })()"), 'draft-image-preview');
  assert.equal(comfyA.prompts.some(p => p.auth === 'Bearer img-secret-a'), true, '生图测试应使用已保存凭据访问真实本地 ComfyUI');
  const beforeSceneSave = await request(`/v1/roles/${roleA.roleId}/scene-image`);
  assert.equal(beforeSceneSave.configured, false, '测试生图不得修改已保存角色生图配置');
  await clickImageSave();
  await imageSaved(roleA.roleId, img1.serviceId);
  await resumePaused();
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active', 'resume-a-after-scene');

  // 给乙角色绑定备用生图后去设置删除备用生图，验证 Bug 3 修复（乙角色生图面板必须显式显示「原服务已删除」，不得视觉错显为主生图、也不得误停用角色乙）。
  await pickRole("乙角色");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='乙角色'"));
  await openImage();
  await until(() => ev("!!document.querySelector('.config-sheet .nd-image-service-row select')"));
  await setSelect("document.querySelector('.config-sheet .nd-image-service-row select')", img2.serviceId);
  await setInput("document.querySelector('.config-sheet .nd-image input[placeholder=\"moss_image_sft_int8_convrot.safetensors\"]')", 'backup-image-model.safetensors');
  await clickImageSave();
  await imageSaved(roleB.roleId, img2.serviceId);
  await resumePaused();
  await until(async () => (await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state === 'active');

  await openImage();

  // 292-R05 / 292-R06 跨页生图与在途编辑恢复回归验证：
  // 0) 出图期间修改测试画面描述、测试服饰或基础草稿参数：旧响应不得写回样图，同时「测试生图」按钮立即/可用最新草稿重测（283 §28）。
  const inFlightEdit1 = comfyB.holdNextPrompt('r06-inflight-edit-1-prompt');
  await clickWhen("[...document.querySelectorAll('.config-sheet .nd-image-preview button')].find(x=>x.textContent==='测试生图')");
  await inFlightEdit1.arrived;
  await until(() => ev("(() => { const btn = document.querySelector('.config-sheet .nd-image-preview button'); return !!btn && btn.disabled && btn.textContent.includes('正在出图'); })()"), 'r06-inflight-busy-1');
  await setInput("document.querySelector('.config-sheet .nd-image-preview input')", '雨夜霓虹街景');
  await until(() => ev("(() => { const btn = document.querySelector('.config-sheet .nd-image-preview button'); return !!btn && !btn.disabled && btn.textContent === '测试生图'; })()"), 'r06-button-restored-after-prompt-edit');
  inFlightEdit1.release();
  await delay(250);
  assert.equal(await ev("!!document.querySelector('.config-sheet .nd-image-figure')"), false, '出图期间改画面描述后，旧响应不得渲染样图');

  const inFlightEdit2 = comfyB.holdNextPrompt('r06-inflight-edit-2-prompt');
  await clickWhen("[...document.querySelectorAll('.config-sheet .nd-image-preview button')].find(x=>x.textContent==='测试生图')");
  await inFlightEdit2.arrived;
  await until(() => ev("(() => { const btn = document.querySelector('.config-sheet .nd-image-preview button'); return !!btn && btn.disabled && btn.textContent.includes('正在出图'); })()"), 'r06-inflight-busy-2');
  await setSelect("document.querySelector('.config-sheet .nd-image-preview select')", outfitB.outfitId);
  await setInput("document.querySelector('.config-sheet .nd-image textarea')", '银灰挑染，冷静眼神');
  await setInput("document.querySelector('.config-sheet .nd-image-preview input')", '窗边微光特写');
  await until(() => ev("(() => { const btn = document.querySelector('.config-sheet .nd-image-preview button'); return !!btn && !btn.disabled && btn.textContent === '测试生图'; })()"), 'r06-button-restored-after-draft-edit');
  inFlightEdit2.release();
  await delay(250);
  assert.equal(await ev("!!document.querySelector('.config-sheet .nd-image-figure')"), false, '出图期间改服饰与草稿后，旧响应不得渲染样图');
  await clickWhen("[...document.querySelectorAll('.config-sheet .nd-image-preview button')].find(x=>x.textContent==='测试生图')");
  await until(() => ev("(() => { const img = document.querySelector('.config-sheet .nd-image-figure img'); const cap = document.querySelector('.config-sheet .nd-image-figure figcaption')?.textContent || ''; return !!(img && img.complete && img.naturalWidth > 0 && cap.includes('银灰挑染，冷静眼神') && cap.includes('窗边微光特写')); })()"), 'r06-repreview-with-latest-draft');

  // 验证已有样图时再次出图并在途中改写画面描述：旧在途响应不得覆盖现有样图，随后仍可用最新草稿重测。
  await setInput("document.querySelector('.config-sheet .nd-image-preview input')", '将被放弃的旧出图描述');
  const inFlightEdit3 = comfyB.holdNextPrompt('r06-inflight-edit-3-prompt');
  await clickWhen("[...document.querySelectorAll('.config-sheet .nd-image-preview button')].find(x=>x.textContent==='测试生图')");
  await inFlightEdit3.arrived;
  await until(() => ev("(() => { const btn = document.querySelector('.config-sheet .nd-image-preview button'); return !!btn && btn.disabled && btn.textContent.includes('正在出图'); })()"), 'r06-inflight-busy-3');
  await setInput("document.querySelector('.config-sheet .nd-image-preview input')", '最终稳定新描述');
  await until(() => ev("(() => { const btn = document.querySelector('.config-sheet .nd-image-preview button'); return !!btn && !btn.disabled && btn.textContent === '测试生图'; })()"), 'r06-button-restored-with-existing-preview');
  inFlightEdit3.release();
  await delay(250);
  assert.equal(await ev("document.querySelector('.config-sheet .nd-image-figure figcaption')?.textContent.includes('将被放弃的旧出图描述')"), false, '已有样图时在途编辑，旧响应不得覆盖样图');

  // 1) 在乙角色探测备用生图（得到 backup-image-model.safetensors 候选）并以最新草稿测试生图，验证草稿字段保留。
  await clickWhen("[...document.querySelectorAll('.config-sheet .nd-image button')].find(x=>x.textContent==='测试连接')");
  await imageNotice('已确认模型「backup-image-model.safetensors」');
  const beforeStep1Prompts = comfyB.prompts.length;
  await clickWhen("[...document.querySelectorAll('.config-sheet .nd-image-preview button')].find(x=>x.textContent==='测试生图')");
  await until(() => comfyB.prompts.length > beforeStep1Prompts && ev("(() => { const img = document.querySelector('.config-sheet .nd-image-figure img'); const cap = document.querySelector('.config-sheet .nd-image-figure figcaption')?.textContent || ''; const btn = document.querySelector('.config-sheet .nd-image-preview button'); return !!(img && img.complete && img.naturalWidth > 0 && cap.includes('最终稳定新描述') && btn && !btn.disabled && btn.textContent === '测试生图'); })()"), 'r06-preview-before-disable');

  // 2) 先保存角色纸笺中的基础草稿，再走公开设置入口。全局停用只暂停乙，
  // 返回后不能沿用旧探测和试生图结果；已保存的停用绑定仍可随其他字段保存。
  await clickImageSave();
  await imageSaved(roleB.roleId, img2.serviceId);
  await resumePaused();
  await until(bothActive);
  await openImage();
  await imageSettings('在设置中管理 →');
  await waitService('备用生图');
  const image2Switch = element('[role=switch][aria-label="全局启用备用生图"]');
  await clickWhen(image2Switch, 'img2-disable-btn');
  await until(async () => (await request('/v1/image-services')).items.find(service => service.serviceId === img2.serviceId)?.enabled === false, 'img2-disabled');
  assert.equal((await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state, 'active', '全局停用不能暂停无关角色甲');
  assert.equal((await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state, 'stopped', '全局停用需暂停依赖角色乙');
  await resumePaused();
  await until(bothActive);
  await returnRole();
  await openImage();
  await imageNotice('所选服务已全局停用');
  assert.equal(await ev(`document.querySelectorAll('${image} .nd-model-options [role=option]').length`), 0);
  assert.equal(await ev(`!!${field('.nd-image-figure')}`), false);
  assert.equal(await ev(`${field('textarea[aria-label="基础锚点提示词"]')}?.value`), '银灰挑染，冷静眼神');
  const option = field(`option[value="${img2.serviceId}"]`);
  assert.equal(await ev(`${option}?.disabled`), true, '全局停用的服务不能新选用');
  assert.match(await ev(`${option}?.textContent`), /已全局停用，不能选用/);
  await setInput(field('.nd-image-grid input[type=number]'), '896');
  await clickImageSave();
  await until(async () => {
    const { settings } = await request(`/v1/roles/${roleB.roleId}/scene-image`);
    return settings?.serviceId === img2.serviceId && settings.width === 896;
  }, 'retained disabled binding is saved with other fields');
  await resumePaused();
  await until(bothActive);

  // 3) 恢复服务，再发起在途出图并离开纸笺。关闭后的晚到结果和改连接前的候选都不能显示。
  await openImage();
  await imageSettings('在设置中管理 →');
  await waitService('备用生图');
  await clickWhen(image2Switch, 'img2-enable-btn');
  await until(async () => (await request('/v1/image-services')).items.find(service => service.serviceId === img2.serviceId)?.enabled === true, 'img2-reenabled');
  await until(() => ev(`${image2Switch}?.checked && !${image2Switch}?.disabled`), 'image enable request finished in renderer');
  assert.equal(await bothActive(), true, '重新启用无需暂停');
  await returnRole();
  await openImage();
  await clickWhen(imageButton('读取模型列表'));
  await imageNotice('已读取 1 个模型');
  const slowPreview = comfyB.holdNextPrompt('r06-slow-preview-prompt');
  await clickWhen(imageButton('测试生图'));
  await slowPreview.arrived;
  await imageSettings('在设置中管理 →');
  await waitService('备用生图');
  await editService();
  await setInput(groupInput('连接'), `${comfyB.baseUrl}/alternate`);
  await clickWhen(saveButton(true), 'pause for connection maintenance');
  slowPreview.release();
  await waitService('备用生图');
  await resumePaused();
  await until(bothActive);
  await returnRole();
  await openImage();
  assert.equal(await ev(`document.querySelectorAll('${image} .nd-model-options [role=option]').length`), 0);
  assert.equal(await ev(`!!${field('.nd-image-figure')}`), false, '修改连接后，旧试生图不得写回');
  assert.equal(await ev(`${field('textarea[aria-label="基础锚点提示词"]')}?.value`), '银灰挑染，冷静眼神');

  // 4) 服务有活动依赖时禁止删除。先经角色状态停止乙，再删除，返回验证保留失效绑定。
  await clickWhen(imageButton('测试连接'));
  await imageNotice('已确认模型「backup-image-model.safetensors」');
  await clickWhen(imageButton('测试生图'));
  await until(() => ev(`${field('.nd-image-figure img')}?.naturalWidth > 0`), 'r06-preview-before-delete');
  const slowProbe = comfyB.holdNextObjectInfo('r06-slow-probe-object-info');
  await clickWhen(imageButton('读取模型列表'));
  await slowProbe.arrived;
  await imageSettings('在设置中管理 →');
  await waitService('备用生图');
  const deleteImage2 = button('删除生图服务…');
  await until(() => ev(`${deleteImage2}?.disabled`), 'active dependency blocks image deletion');
  await tab('角色');
  await clickWhen(`${poster('乙角色')}.querySelector('button')`);
  await until(async () => (await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state === 'stopped', 'stop dependent role');
  slowProbe.release();
  await tab('模型');
  await clickWhen(button('生图', '.config-kind-tabs'));
  await selectService('备用生图');
  await clickWhen(deleteImage2);
  await clickWhen(sheetButton('删除'));
  await until(async () => (await request('/v1/image-services')).items.length === 1, 'img2-deleted');
  assert.equal((await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state, 'active');
  assert.equal((await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state, 'stopped');
  await returnRole();
  await openImage();
  await imageNotice('当前所选生图服务已不存在');
  assert.equal(await ev(`document.querySelectorAll('${image} .nd-model-options [role=option]').length`), 0);
  assert.equal(await ev(`!!${field('.nd-image-figure')}`), false);
  assert.equal(await ev(`${field('textarea[aria-label="基础锚点提示词"]')}?.value`), '银灰挑染，冷静眼神');
  assert.equal(await ev(`${field('.nd-image-service-row select')}?.value`), img2.serviceId, '保留失效服务标识');
  await setInput(field('textarea[aria-label="基础锚点提示词"]'), '验证失效服务不能保存');
  await clickImageSave();
  await imageNotice('服务已不存在');
  assert.equal((await request(`/v1/roles/${roleB.roleId}/activity`)).activity.state, 'stopped');
  await setSelect(field('.nd-image-service-row select'), img1.serviceId);
  await clickImageSave();
  await imageSaved(roleB.roleId, img1.serviceId);
  await openSettings();
  await tab('角色');
  await clickWhen(`${poster('乙角色')}.querySelector('button')`);
  await until(bothActive, 'resume rebound role B');
  await returnRole();
  await tab('模型');

  // === 链路 6：全局语音添加、角色参考音频暂存、试听、原子保存及启停 ===
  await pickRole("甲角色");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"), 'switch-to-a-for-voice');
  await openVoice();
  await clickWhen(button('去设置添加 →', voice));
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings' && document.querySelector('.config-kind-tabs button[aria-pressed=true]')?.textContent==='语音' && document.querySelector('.config-sheet h3')?.textContent==='添加语音服务'"), 'open-add-voice-service');
  await setInput(field('input[aria-label="语音服务名称"]'), '主本地语音');
  await setInput(field('input[aria-label="语音服务地址"]'), tts.baseUrl);
  await clickWhen(sheetButton('探测服务'));
  await until(() => ev("document.querySelector('.config-sheet')?.innerText.includes('探测到')"), 'global-tts-probe');
  await clickWhen(sheetButton('添加'));
  await waitService('主本地语音');
  const voiceSvc = (await request('/v1/voice-services')).items[0];
  assert.ok(voiceSvc?.serviceId, '全局语音服务已写入后端');
  await returnRole();
  await openVoice();
  await until(() => ev(`${field('select[aria-label="语音服务"]')}?.value===${JSON.stringify(voiceSvc.serviceId)}`), 'role-picked-voice-svc');
  await until(() => ev("document.querySelector('.config-sheet .nd-voice-probe')?.textContent.includes('local-fake-tts')"), 'tts-probe-carried');

  const refMode = `[...document.querySelectorAll('${voice} select')].find(select=>[...select.options].some(option=>option.value==='cross_language'))`;
  await setSelect(refMode, 'cross_language');
  const docVoice = await cmd('DOM.getDocument');
  const voiceInput = await cmd('DOM.querySelector', { nodeId: docVoice.root.nodeId, selector: `${voice} input[type=file]` });
  await cmd('DOM.setFileInputFiles', { nodeId: voiceInput.nodeId, files: [wavPath] });
  await until(() => ev("document.querySelector('.config-sheet .nd-voice')?.innerText.includes('待上传：sample.wav')"), 'voice-staged');
  assert.equal((await request(`/v1/roles/${roleA.roleId}/voice/references`)).items.length, 0, '暂存期不得上传参考音频');

  await clickWhen(button('生成试听', voice));
  await until(() => tts.synthCalls.length === 1 && tts.synthCalls[0].hasCrossLang, 'voice-preview-real');
  assert.equal((await request(`/v1/roles/${roleA.roleId}/voice/references`)).items.length, 0, '试听不得上传参考音频');

  // 需要参考文本的 zero_shot 必须在暂停前拦截。
  await setSelect(refMode, 'zero_shot');
  await clickVoiceSave();
  await until(() => ev("!!document.querySelector('.config-sheet [role=alert]')"), 'voice-missing-ref-text');
  assert.equal((await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state, 'active');

  await setInput(element(voice + ' textarea'), '你好，今天风很轻。');
  await clickVoiceSave();
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/voice/references`)).items.some(item => item.fileName === 'sample.wav' && item.inUse), 'voice-atomic-saved');
  const refsAfterSave = (await request(`/v1/roles/${roleA.roleId}/voice/references`)).items;
  assert.equal(refsAfterSave.length, 1);
  assert.equal(refsAfterSave[0].inUse, true);
  await resumePaused();
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active');
  await openVoice();
  assert.equal(await ev("document.querySelector('.config-sheet .nd-voice-references button')?.disabled"), true, '使用中的参考音频不得删除');

  // 停用再启用角色语音，保留已保存的参考音频及配置。
  await clickWhen(field('.nd-voice-toggle input'));
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/voice`)).voice.enabled === false, 'role voice disabled');
  await clickWhen(field('.nd-voice-toggle input'));
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/voice`)).voice.enabled === true, 'role voice re-enabled');
  await clickWhen(element('.config-sheet-x'));
  await until(() => ev("!document.querySelector('.config-sheet')"));
  await resumePaused();
  await until(async () => (await request(`/v1/roles/${roleA.roleId}/activity`)).activity.state === 'active');
  const voiceAfterToggle = await request(`/v1/roles/${roleA.roleId}/voice`);
  assert.equal(voiceAfterToggle.voice.voiceSource.referenceAssetId, refsAfterSave[0].assetId, '启停保留参考音频');

  // 小屏 + 夜间主题抽查
  await cmd('Emulation.setDeviceMetricsOverride', { width: 720, height: 540, deviceScaleFactor: 1, mobile: false });
  await clickWhen("[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('晚风电台'))");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.uiPreset==='nightwave'"));
  await delay(450);
  await shot('role-voice-night-720.png');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await clickWhen("document.querySelectorAll('.ui-theme-switcher button')[0]");
  await delay(300);

  // === 链路 7：跨角色设定草稿确认（T37）+ 进入真实对话（发送消息验证 llmB -> 点播语音 -> 手动生成过场图并查看） ===
  await clickWhen("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('设定'))");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) input[aria-label=\"显示名\"]')"));
  await setInput("document.querySelector('.config-role-editor:not([hidden]) input[aria-label=\"显示名\"]')", '甲角色未保存草稿');
  await until(() => ev("!!document.querySelector('.config-tabs [aria-current=page] .tab-dot')"), 'profile draft visible');
  await pickRole("乙角色");
  // 3a4ac9a 起跨角色脏草稿走 T37 纸笺（原角色墙的三选一提示已移除）。
  await until(() => ev("!!document.querySelector('.config-sheet') && document.querySelector('.config-sheet').textContent.includes('还没保存')"), 'dirty-prompt-visible');
  await clickWhen("[...document.querySelectorAll('.config-sheet button')].find(x=>x.textContent==='放弃并切换')");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='乙角色'"));
  await pickRole("甲角色");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"), 'switch-to-a-for-chat');
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) input[aria-label=\"显示名\"]')?.value"), '甲角色', 'T37 放弃后保留已保存的角色名');
  assert.equal(await ev(`(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })()`), false, 'T37 放弃最后一份用户草稿后无需拦截离开');
  await clickWhen("[...document.querySelectorAll('.ui-dock-item')].find(button=>button.textContent.includes('对话'))");
  assert.deepEqual(errors, [], '离开配置页进入对话时没有本机确认或渲染异常');
  await clickWhen(element('.dialogue-role-switch button'));
  await clickWhen("[...document.querySelectorAll('.dialogue-role-menu button')].find(button=>button.textContent.includes('甲角色'))");
  await until(() => ev("document.querySelector('.dialogue-role-switch button')?.getAttribute('aria-label')?.includes('甲角色')"), 'dialogue uses A');

  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='conversation' && document.querySelector('.dialogue-connection')?.dataset.state==='open'"), 'dialogue-open');
  await shot('dialogue-ready.png');

  const llmBCallsBeforeChat = llmB.chatCalls.length;
  const ttsCallsBeforeChat = tts.synthCalls.length;
  await setInput("document.querySelector('.dialogue-composer textarea')", '看看窗外，风怎么样？');
  await clickWhen("document.querySelector('.dialogue-send')");
  await until(() => llmB.chatCalls.length > llmBCallsBeforeChat, 'llmB-called-after-repoint');
  assert.equal(llmB.chatCalls.at(-1).auth, 'Bearer key-b2', '修改模型连接并恢复活动后，对话应使用最新地址与新密钥');

  // 推进或等待助理文字气泡出现并完成本轮演出（出现输入栏与生成过场图入口）
  await until(async () => {
    const canAdv = await ev("document.querySelector('.dialogue-messages')?.dataset.canAdvance==='true'");
    if (canAdv) await ev("document.querySelector('.dialogue-messages')?.click()");
    return ev("[...document.querySelectorAll('.dialogue-message.assistant .dialogue-bubble')].some(x=>x.textContent.includes('你好')) && !document.querySelector('.dialogue-waiting') && !document.querySelector('.dialogue-advance-hint') && !!document.querySelector('.dialogue-composer')");
  }, 'assistant-reply-visible');

  // 触发语音合成按钮 -> 验证真实后端 /speech 调本地假 TTS（兼容预取已触发或点击按需触发）
  await clickWhen("document.querySelector('.dialogue-message.assistant .dialogue-speaker')");
  await until(() => tts.synthCalls.length > ttsCallsBeforeChat, 'dialogue-segment-tts').catch(async e => {
    console.error('DIAG tts calls:', JSON.stringify(tts.synthCalls), 'toast:', await ev("document.querySelector('.dialogue-toast')?.innerText || document.body.innerText.slice(-400)"));
    throw e;
  });

  // 触发手动过场图 -> 选「人物与背景」-> 验证真实后端 /scene-images 先用模型规划再调本地假 ComfyUI 并在对话中渲染查看
  const comfyPromptsBeforeDialogue = comfyA.prompts.length;
  await until(() => ev("[...document.querySelectorAll('.dialogue-round-tools button')].some(x=>x.textContent.includes('生成过场图'))"), 'draw-scene-btn');
  await clickWhen("[...document.querySelectorAll('.dialogue-round-tools button')].find(x=>x.textContent.includes('生成过场图'))");
  await until(() => ev("[...document.querySelectorAll('.dialogue-scene-options button')].some(x=>x.textContent==='人物与背景')"), 'scene-mode-modal');
  await clickWhen("[...document.querySelectorAll('.dialogue-scene-options button')].find(x=>x.textContent==='人物与背景')");
  await until(() => comfyA.prompts.length > comfyPromptsBeforeDialogue, 'dialogue-comfy-called');
  await until(() => ev("[...document.querySelectorAll('.dialogue-round-tools .dialogue-scene-chip')].some(x=>x.textContent.startsWith('查看'))"), 'scene-chip-ready');
  await clickWhen("[...document.querySelectorAll('.dialogue-round-tools .dialogue-scene-chip')].find(x=>x.textContent.startsWith('查看'))");
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
    disabledImageOptionGuardedAndExistingBindingRetained: true,
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

run().catch(async error => {
  console.error(error, errors, '\n--- BACKEND LOG ---\n', backendLog.slice(-1500), '\n--- ELECTRON LOG ---\n', electronLog.slice(-1000));
  if (ws?.readyState === 1) console.error(await ev(`({ page:document.querySelector('.studio-shell')?.dataset.page,
    sheet:document.querySelector('.config-sheet h3')?.textContent, bodyInert:!!document.querySelector('.config-leaf-body[inert]'),
    text:document.body.innerText.slice(-1900) })`).catch(() => null));
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
