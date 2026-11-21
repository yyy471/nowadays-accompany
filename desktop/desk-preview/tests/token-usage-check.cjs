'use strict';

// 仓库根目录或 desktop/desk-preview 下运行：临时后端 + 离线 OpenAI HTTP 桩 + 真实 Electron 全局设置「用量」E2E 验证。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveElectronExecutable } = require('./electron-executable.cjs');
const { button, configControls, element, setValue } = require('./config-page-controls.cjs');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-token-usage-e2e-'));
const node = process.execPath;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, label = 'condition') {
  let last;
  for (const start = Date.now(); Date.now() - start < 30000; ) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`等待超时 (${label}): ${last || ''}`);
}

let backend, electron, upstream, ws;
let backendLog = '';
let electronLog = '';
let nextId = 0;
let base = '';
const waiting = new Map();
const errors = [];

function cmd(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function ev(expression) {
  const result = await cmd('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

const { click, tab } = configControls(ev, until);

async function request(route, options = {}) {
  const response = await fetch(base + route, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const json = (body, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function run() {
  const tokenFmt = await import(
    pathToFileURL(path.join(root, 'desktop/desk-preview/renderer/src/token-usage.js')).href
  );

  // 1) 启动离线 OpenAI Chat Completions 桩端点，稳定回报 input / cached / output token 用量。
  let stubCalls = 0;
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      stubCalls += 1;
      const systemText = JSON.stringify(parsed.messages ?? []);
      const isAnnotation = systemText.includes('segmentId') && systemText.includes('spriteAssetId');
      const replyText = isAnnotation ? JSON.stringify({ segments: [] }) : '好的，我在听。';
      const usage = isAnnotation
        ? {
            prompt_tokens: 400,
            completion_tokens: 50,
            total_tokens: 450,
            prompt_tokens_details: { cached_tokens: 200 },
          }
        : {
            prompt_tokens: 1200,
            completion_tokens: 300,
            total_tokens: 1500,
            prompt_tokens_details: { cached_tokens: 600 },
          };

      if (parsed.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chatcmpl-stub-${stubCalls}`,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
            usage,
          }),
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-stub-${stubCalls}`,
          choices: [{ index: 0, delta: { content: replyText }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-stub-${stubCalls}`,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage,
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const stubPort = upstream.address().port;

  // 2) 启动真实后端并构造连通性测试 + 角色对话 + 删角留存数据
  backend = spawn(
    node,
    ['--import', 'tsx', 'src/main.ts', '--app-root', path.join(temp, 'app'), '--port', '0'],
    { cwd: path.join(root, 'backend'), windowsHide: true },
  );
  backend.stdout.on('data', (data) => {
    backendLog += data;
  });
  backend.stderr.on('data', (data) => {
    backendLog += data;
  });
  const backendPort = await until(() => {
    const match = /"event":"listening","host":"[^"]+","port":(\d+)/.exec(backendLog);
    return match?.[1];
  }, 'backend listening');
  base = `http://127.0.0.1:${backendPort}`;

  const modelRes = await request(
    '/v1/resources',
    json({
      kind: 'model',
      name: '离线用量测试模型',
      enabled: true,
      secret: 'offline-test-key',
      config: {
        protocol: 'openai-chat',
        provider: 'deepseek',
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        modelName: 'stub-chat',
      },
    }),
  );

  const testResult = await request(
    `/v1/resources/${modelRes.resourceId}/model-test`,
    json({ model: 'stub-chat' }),
  );
  assert.equal(testResult.ok, true, '连接测试应通过');

  const roleA = await request(
    '/v1/roles',
    json({ displayName: '用量测试角色', definition: { text: '用于验证 Token 用量留存与筛选' } }),
  );
  await request(`/v1/roles/${roleA.roleId}/activity/stop`, { method: 'POST' });
  await until(async () => {
    const act = await request(`/v1/roles/${roleA.roleId}/activity`);
    return act.activity.state === 'stopped';
  }, 'roleA stopped');

  await request(
    `/v1/roles/${roleA.roleId}/bindings`,
    json(
      {
        bindings: [
          {
            capability: 'chat_model',
            resourceId: modelRes.resourceId,
            modelName: 'stub-chat',
            enabled: true,
          },
        ],
      },
      'PUT',
    ),
  );

  await request(`/v1/roles/${roleA.roleId}/activity/resume`, { method: 'POST' });
  // 等待首次开启触发的自主运行落稳，再发一条用户消息触发对话回复
  await until(async () => {
    const act = await request(`/v1/roles/${roleA.roleId}/activity`);
    return act.activity.state === 'active' && act.activity.running === false;
  }, 'roleA initial idle');

  await request(
    `/v1/roles/${roleA.roleId}/windows/${roleA.defaultWindowId}/messages`,
    json({ content: '你好，请简短问候一声。', submissionId: randomUUID() }),
  );

  await until(async () => {
    const usage = await request('/v1/usage/tokens?range=all');
    const act = await request(`/v1/roles/${roleA.roleId}/activity`);
    const hasDialogue = usage.byCategory.some((item) => item.category === 'dialogue');
    const hasTest = usage.byCategory.some((item) => item.category === 'connection_test');
    return hasDialogue && hasTest && act.activity.running === false;
  }, 'dialogue + connection_test recorded');

  await request(`/v1/roles/${roleA.roleId}/activity/stop`, { method: 'POST' });
  await until(async () => {
    const act = await request(`/v1/roles/${roleA.roleId}/activity`);
    return act.activity.state === 'stopped' && act.activity.running === false;
  }, 'roleA stopped before deletion');

  await request(`/v1/roles/${roleA.roleId}?keepHistory=false`, { method: 'DELETE' });

  const api7d = await request('/v1/usage/tokens?range=7d');
  const apiAll = await request('/v1/usage/tokens?range=all');
  const apiConnTest = await request('/v1/usage/tokens?range=all&category=connection_test');
  assert.ok(apiAll.byCategory.some((c) => c.category === 'dialogue'), '后端应记录 dialogue 用量');
  assert.ok(apiAll.byCategory.some((c) => c.category === 'connection_test'), '后端应记录 connection_test 用量');
  const deletedRoleRow = apiAll.byRole.find((r) => r.roleId === roleA.roleId);
  assert.ok(deletedRoleRow && deletedRoleRow.deleted === true, '删除角色后历史消耗应保留并标记 deleted=true');

  // 3) 启动真实 Electron 并检查全局设置「用量」页面
  const env = {
    ...process.env,
    NOWADAYS_BACKEND_URL: base,
    NOWADAYS_APP_ROOT: path.join(temp, 'desktop'),
    NOWADAYS_SKIP_ROLE_PICKER: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;

  electron = spawn(
    resolveElectronExecutable({ repoRoot: root }),
    ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, path.join(root, 'desktop/desk-preview')],
    { env, windowsHide: true },
  );
  electron.stdout.on('data', (data) => {
    electronLog += data;
  });
  electron.stderr.on('data', (data) => {
    electronLog += data;
  });

  const debugPort = await until(
    () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(electronLog)?.[1],
    'electron devtools',
  );
  const target = await until(
    async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((item) => item.url.startsWith('desk://bundle/')),
    'electron bundle target',
  );
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const job = waiting.get(message.id);
      waiting.delete(message.id);
      message.error ? job?.reject(message.error) : job?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
  };

  await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cmd('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });

  await until(
    () =>
      ev(`(() => {
        const trigger = document.querySelector('.ui-menu-trigger');
        if (!trigger) return false;
        if (trigger.getAttribute('aria-expanded') !== 'true') { trigger.click(); return false; }
        const item = [...document.querySelectorAll('.ui-menu-panel:not([inert]) .ui-menu-item')].find(x => x.textContent.trim() === '设置');
        if (!item) return false;
        item.click();
        return true;
      })()`),
    'open settings menu',
  );
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page === 'settings'"), 'settings page');

  await tab('用量');
  await until(() => ev("!!document.querySelector('[data-testid=\"usage-total-tokens\"]')"), 'usage section loaded');

  // 校验默认近 7 天 KPI 与后端返回一致
  const expectedTotal7d = tokenFmt.formatTokenCount(api7d.totals.totalTokens);
  const expectedInput7d = tokenFmt.formatTokenCount(api7d.totals.inputTokens);
  const expectedOutput7d = tokenFmt.formatTokenCount(api7d.totals.outputTokens);
  const expectedCalls7d = `${tokenFmt.formatTokenCount(api7d.totals.callCount)} 次`;
  await until(
    () =>
      ev(
        `document.querySelector('[data-testid="usage-total-tokens"]')?.textContent?.trim() === ${JSON.stringify(expectedTotal7d)}`,
      ),
    '7d total matches backend',
  );
  const kpis7d = await ev(`({
    total: document.querySelector('[data-testid="usage-total-tokens"]')?.textContent?.trim(),
    input: document.querySelector('[data-testid="usage-input-tokens"]')?.textContent?.trim(),
    output: document.querySelector('[data-testid="usage-output-tokens"]')?.textContent?.trim(),
    calls: document.querySelector('[data-testid="usage-call-count"]')?.textContent?.trim(),
    deletedTag: [...document.querySelectorAll('.nd-usage-row-name')].find(el => el.textContent.includes('用量测试角色'))?.querySelector('.nd-usage-tag')?.textContent?.trim(),
    hasResetBtn: [...document.querySelectorAll('.nd-usage-page button')].some(b => /清零|清空|重置用量/.test(b.textContent)),
    breakdownHeaders: [...document.querySelectorAll('.nd-usage-breakdowns h3')].map(h => h.textContent.trim()),
  })`);
  assert.deepEqual(kpis7d, {
    total: expectedTotal7d,
    input: expectedInput7d,
    output: expectedOutput7d,
    calls: expectedCalls7d,
    deletedTag: '已删除',
    hasResetBtn: false,
    breakdownHeaders: ['按用途', '按角色', '按模型与服务商'],
  });

  // 切换时间范围：今日 -> 全部
  await click(button('今日', '.nd-usage-ranges'));
  await until(() => ev(`(${button('今日', '.nd-usage-ranges')}).getAttribute('aria-pressed') === 'true'`), 'range today');
  await click(button('全部', '.nd-usage-ranges'));
  await until(() => ev(`(${button('全部', '.nd-usage-ranges')}).getAttribute('aria-pressed') === 'true'`), 'range all');

  // 按用途筛选 connection_test 并再清除筛选
  const catSelect = element('select[aria-label="按用途筛选"]');
  await ev(setValue(catSelect, 'connection_test'));
  const expectedConnCalls = `${tokenFmt.formatTokenCount(apiConnTest.totals.callCount)} 次`;
  await until(
    () => ev(`document.querySelector('[data-testid="usage-call-count"]')?.textContent?.trim() === ${JSON.stringify(expectedConnCalls)}`),
    'filtered connection_test count',
  );
  await click(button('清除筛选', '.nd-usage-filters'));
  await until(
    () => ev(`document.querySelector('[data-testid="usage-total-tokens"]')?.textContent?.trim() === ${JSON.stringify(tokenFmt.formatTokenCount(apiAll.totals.totalTokens))}`),
    'cleared filter restores all totals',
  );

  // 白昼/晚风双主题 + 1280x800 / 900x720 / 720x540 视口下无横向溢出
  const overflowChecks = [];
  for (const theme of ['白昼来信', '晚风电台']) {
    await ev(`[...document.querySelectorAll('.ui-theme-switcher button')].find(btn => btn.textContent.includes(${JSON.stringify(theme)})).click()`);
    for (const [width, height] of [[1280, 800], [900, 720], [720, 540]]) {
      await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await ev('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const check = await ev(`(() => {
        const book = document.querySelector('.config-book');
        const leaf = document.querySelector('.config-leaf-body');
        const kpis = document.querySelector('.nd-usage-kpis');
        return {
          bookOverflow: book.scrollWidth - book.clientWidth,
          leafOverflow: leaf.scrollWidth - leaf.clientWidth,
          kpiRectCount: kpis ? kpis.getClientRects().length : 0,
        };
      })()`);
      assert.ok(check.bookOverflow <= 1 && check.leafOverflow <= 1, `${theme} ${width}x${height} 横向溢出: ${JSON.stringify(check)}`);
      assert.ok(check.kpiRectCount > 0, `${theme} ${width}x${height} 应可见 KPI 总览`);
      overflowChecks.push({ theme, width, height, ...check });
    }
  }

  assert.deepEqual(errors, [], `不应存在前端未捕获异常: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ tokenUsageE2E: true, kpis7d, stubCalls, overflowChecks, errors }, null, 2));
}

run()
  .catch(async (error) => {
    console.error(error, backendLog.slice(-1500), electronLog.slice(-1000));
    if (ws?.readyState === 1) {
      console.error(await ev('document.body.innerText.slice(-1500)').catch(() => null));
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
        ws.close();
      }
    } catch {}
    await delay(300);
    if (electron && electron.exitCode === null) electron.kill();
    if (backend && backend.exitCode === null) backend.kill();
    if (upstream) {
      upstream.closeAllConnections?.();
      upstream.close();
    }
    await delay(500);
    try {
      if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('nowadays-token-usage-e2e-')) {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    } catch {}
  });
