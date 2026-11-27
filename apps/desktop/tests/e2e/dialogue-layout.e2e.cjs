"use strict";
// 从仓库根目录运行；桌面运行时与本地 HTTP 替身，不调用真实模型。
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { resolveElectronExecutable } = require('../helpers/electron-executable.cjs');
const { repoRoot: root, desktopDir, testResultsDir } = require('../helpers/paths.cjs'), output = path.join(testResultsDir, 'dialogue-layout');
fs.mkdirSync(output, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-layout-'));
const date = '2026-11-09T10:00:00.000Z';
const roles = [{ roleId: 'a', displayName: '甲角色', status: 'ready', defaultWindowId: 'w1' }, { roleId: 'b', displayName: '乙角色', status: 'ready', defaultWindowId: 'w1' }];
const streams = new Set(), requests = [];
const voiceLines = ['这句可以播放。', '这句暂时无法播放。'];
const prefetchedSpeechPath = '/v1/roles/b/windows/w2/segments/s2/speech';
let speechResponse;
let prefetchedSpeechResponse;
function silentWav() {
  const sampleRate = 16000;
  const bytes = sampleRate * 2 * 4;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(bytes, 40);
  return wav;
}
function json(res, data, status = 200) { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(data)); }
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://127.0.0.1').pathname;
  requests.push(p);
  const role = roles.find(item => p.includes(`/roles/${item.roleId}`)) ?? roles[0];
  if (p === '/v1/health') return json(res, { status: 'ok' });
  if (p === '/v1/roles') return json(res, { items: roles });
  if (p === `/v1/roles/${role.roleId}`) return json(res, { ...role, definition: { text: '', payload: {} }, definitionRevision: 1 });
  if (p.endsWith('/appearance/outfits')) return json(res, { items: [] });
  if (p.endsWith('/state')) return json(res, { state: {}, stateVersion: 1, updatedAt: date });
  if (p.endsWith('/voice')) return json(res, { voice: null });
  if (p.endsWith('/windows')) return json(res, { items: ['w1', 'w2'].map((windowId, i) => ({ windowId, roleId: role.roleId, kind: i ? 'custom' : 'main', source: 'nowadays', createdAt: date, updatedAt: date })) });
  if (p.endsWith('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' }); res.write(': connected\n\n'); streams.add(res); res.on('close', () => streams.delete(res)); return; }
  if (p === '/v1/roles/b/windows/w2/segments/s1/speech') { speechResponse = res; return; }
  if (p === prefetchedSpeechPath) { prefetchedSpeechResponse = res; return; }
  if (p === '/v1/roles/b/windows/w2/messages') {
    return json(res, {
      items: [{ messageId: 'r1', windowId: 'w2', sender: 'assistant', content: voiceLines.join('\n'), sequence: 1, status: 'interrupted', sourcePlatform: 'nowadays', submissionId: null, createdAt: date, updatedAt: date }],
      segments: voiceLines.map((text, ordinal) => ({ messageId: 'r1', segmentId: `s${ordinal + 1}`, ordinal, kind: 'speech', text, createdAt: date })),
      sceneImages: [], nextAfter: null, nextBefore: null, activeReply: null, cursor: 0,
    });
  }
  if (p.endsWith('/messages')) return json(res, { items: [{ messageId: 'm1', windowId: p.includes('/w2/') ? 'w2' : 'w1', sender: 'user', content: '一条历史消息', sequence: 1, status: 'completed', sourcePlatform: 'nowadays', submissionId: null, createdAt: date, updatedAt: date }], segments: [], sceneImages: [], nextAfter: null, nextBefore: null, activeReply: null, cursor: 0 });
  return json(res, { error: { message: '测试接口未配置' } }, 404);
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { let error; for (const start = Date.now(); Date.now() - start < 16000;) { try { const value = await fn(); if (value) return value; } catch (e) { error = e; } await delay(80); } throw Error(`等待超时 ${error || ''}`); }
let proc, ws, id = 0, logs = '';
const waiting = new Map(), errors = [];
function cmd(method, params = {}) { return new Promise((resolve, reject) => { const n = ++id; waiting.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); }); }
async function ev(expression, userGesture = false) { const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function shot(name) { const result = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name), Buffer.from(result.data, 'base64')); }
async function pressKey(key, windowsVirtualKeyCode) {
  const params = { key, code: key, windowsVirtualKeyCode };
  await cmd('Input.dispatchKeyEvent', { ...params, type: 'keyDown', text: key === 'Enter' ? '\r' : undefined });
  await cmd('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
}
async function layoutAt(width, height) {
  await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return ev(`(async () => {
    await document.fonts.ready;
    const names = ['stage', 'pane', 'page', 'pane-toolbar', 'messages', 'zone'];
    return Object.fromEntries(names.map(name => [name, document.querySelector('.dialogue-' + name).getBoundingClientRect().toJSON()]));
  })()`);
}
async function locateHistoryMessage() {
  await ev("document.querySelector('.dialogue-history-button').click()");
  await until(() => ev("!!document.querySelector('.dialogue-history[data-open] .dialogue-snippet-card.front')"));
  await ev(`(() => {
    const input = document.querySelector('#dialogue-history-search');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '一条历史消息');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(() => ev("!!document.querySelector('.dialogue-snippet-card.front mark')"));
  await ev("document.querySelector('.dialogue-snippet-card.front').click()");
  await until(() => ev("!document.querySelector('.dialogue-history')"));
  return until(() => ev(`(() => {
    const row = document.querySelector('.dialogue-message[data-message-id="m1"][data-located]');
    const ink = row?.querySelector('.dialogue-location-ink');
    if (!ink || document.activeElement !== row) return false;
    const host = row.closest('.dialogue-messages').getBoundingClientRect(), box = ink.getBoundingClientRect();
    return { sequence: Number(row.dataset.located), animation: getComputedStyle(ink).animationName,
      visible: box.bottom > host.top && box.top < host.bottom };
  })()`));
}
async function verifyHistorySearchFocus() {
  const search = "document.querySelector('#dialogue-history-search')";
  await until(() => ev(`document.activeElement === ${search} && ${search}?.matches(':focus-visible')`));
  for (const forcedColors of [false, true]) {
    if (forcedColors) await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    const ring = await ev(`(() => {
      const input = ${search};
      const field = getComputedStyle(input.parentElement);
      const probe = document.createElement('span');
      probe.style.cssText = 'color: Highlight; forced-color-adjust: none';
      document.body.append(probe);
      const highlight = getComputedStyle(probe).color;
      probe.remove();
      return { outer: field.outlineStyle, width: field.outlineWidth, radius: parseFloat(field.borderTopLeftRadius),
        inner: getComputedStyle(input).outlineStyle, systemColor: field.outlineColor === highlight };
    })()`);
    assert.equal(ring.outer, 'solid', '聚焦搜索时焦点环位于外层');
    assert.equal(ring.width, '2px');
    assert.ok(ring.radius > 0);
    assert.equal(ring.inner, 'none', '搜索输入内部没有第二条焦点环');
    if (forcedColors) assert.equal(ring.systemColor, true, '强制颜色模式下使用系统焦点色');

    await cmd('Input.insertText', { text: '一条历史消息' });
    await until(() => ev("!!document.querySelector('.dialogue-snippet-card.front mark')"));
    await pressKey('Tab', 9);
    assert.equal(await ev(`(() => {
      const clear = document.querySelector('.dialogue-search-clear');
      return document.activeElement === clear && clear.matches(':focus-visible') && getComputedStyle(clear).outlineStyle === 'solid'
        && getComputedStyle(clear.parentElement).outlineStyle === 'none';
    })()`), true, '清除按钮具有独立的键盘焦点环');
    await pressKey('Enter', 13);
    await until(() => ev(`document.activeElement === ${search} && ${search}?.value === '' && !document.querySelector('.dialogue-search-clear')`));
  }
  await cmd('Emulation.setEmulatedMedia', { features: [] });
}
async function verifyVoiceFeedback() {
  const speaker = segment => `document.querySelector('[data-segment-id="${segment}"] .dialogue-speaker')`;
  const first = speaker('s1');
  await until(() => ev(`!!${first}`));
  assert.equal(await ev("document.querySelectorAll('.dialogue-interrupted').length"), 1);
  await ev(`${first}.focus(); ${first}.click()`, true);
  await until(() => speechResponse && ev(`${first}.dataset.voice === 'synthesizing'`));
  assert.ok(await ev(`${first} === document.activeElement && ${first}.getAttribute('aria-busy') === 'true'`));
  assert.equal(await ev(`${first}.querySelectorAll('.ui-voice-wave > span').length`), 4);
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until(() => ev(`getComputedStyle(${first}.querySelector('.ui-voice-wave > span')).animationName === 'none'`));
  await cmd('Emulation.setEmulatedMedia', { features: [] });
  speechResponse.writeHead(200, { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' });
  speechResponse.end(silentWav());
  await until(() => ev(`${first}.dataset.voice === 'playing' && ${first}.textContent.includes('停止')`));
  await ev(`${first}.click()`, true);
  await until(() => ev(`${first}.getAttribute('aria-label').startsWith('播放这句')`));
  await until(() => prefetchedSpeechResponse);
  const second = speaker('s2');
  assert.equal(await ev(`${second}.dataset.voice ?? null`), null, '后台预取不显示合成状态');
  await ev(`${second}.click()`, true);
  await until(() => ev(`${second}.dataset.voice === 'synthesizing'`));
  const failure = '语音测试暂不可用。' + '当前语音服务未能合成所选句段，请稍后重试。'.repeat(5);
  json(prefetchedSpeechResponse, { error: { code: 'TTS_SYNTHESIS_FAILED', message: failure } }, 502);
  await until(() => ev(`document.querySelector('.dialogue-toast')?.textContent.includes('语音测试暂不可用')`));
  assert.equal(await ev(`${second}.dataset.voice ?? null`), null);
  const stageDir = path.join(testResultsDir, 'frontend-refinement-stage2');
  fs.mkdirSync(stageDir, {recursive:true});
  for (const [width,height] of [[1280,800],[720,540]]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor:1, mobile:false });
    const info = await ev(`(() => {
      const toast = document.querySelector('.dialogue-toast'), pane = toast.closest('.dialogue-pane');
      const box = toast.getBoundingClientRect(), toolbar = pane.querySelector('.dialogue-pane-toolbar').getBoundingClientRect();
      return {gap:box.top-toolbar.bottom,width:box.width,available:pane.clientWidth-32,height:box.height,
        pointer:getComputedStyle(toast).pointerEvents,role:toast.getAttribute('role'),message:toast.textContent};
    })()`);
    assert.ok(Math.abs(info.gap - 8) < .1 && info.height > 0 && info.height <= 64 && info.width <= Math.min(320,info.available), JSON.stringify(info));
    assert.equal(info.pointer, 'auto', '长错误可在反馈位内滚动');
    assert.equal(info.role, 'status');
    assert.ok(info.message.includes(failure), info.message);
    console.log('对话反馈位', width, height, JSON.stringify(info));
    const png = await cmd('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(stageDir, 'toast-' + width + 'x' + height + '.png'), Buffer.from(png.data,'base64'));
  }
  assert.equal(requests.filter(p => p === prefetchedSpeechPath).length, 1, '手动点播应合并尚未完成的预取');
}
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, NOWADAYS_BACKEND_URL: `http://127.0.0.1:${server.address().port}`, NOWADAYS_APP_ROOT: path.join(temp, 'data'), NOWADAYS_SKIP_ROLE_PICKER: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(resolveElectronExecutable({ repoRoot: root }), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, desktopDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', chunk => logs += chunk); proc.stderr.on('data', chunk => logs += chunk);
  const port = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(logs)?.[1]);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.startsWith('desk://bundle/')));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if (msg.id) { const job = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? job?.reject(msg.error) : job?.resolve(msg.result); } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text); };
  await cmd('Runtime.enable'); await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => ev("!!document.querySelector('.ui-page-dock')"));
  assert.equal(await ev("!!document.querySelector('.ui-settings-launcher')"), false);
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('对话')).click()");
  await until(() => ev("document.querySelector('.dialogue-connection')?.dataset.state==='open'")); await delay(500);
  const layouts = new Map();
  for (const [width, height] of [[1440, 840], [720, 540], [1280, 800]]) {
    const boxes = await layoutAt(width, height);
    layouts.set(width, boxes);
    const { stage, pane, page, messages, zone } = boxes;
    assert.ok(await ev(`(async () => {
      const image = document.querySelector('.dialogue-background img.active');
      await image.decode();
      const stage = image.closest('.dialogue-stage').getBoundingClientRect();
      const box = image.getBoundingClientRect();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0, 32, 32);
      return box.width === stage.width && box.height === stage.height && getComputedStyle(image).objectFit === 'cover'
        && ctx.getImageData(0, 0, 32, 32).data.every((channel, i) => i % 4 !== 3 || channel === 255);
    })()`), '背景应铺满左侧舞台，素材边缘也应有画面');
    const toolbar = boxes['pane-toolbar'];
    const tolerance = 0.5;
    assert.ok(Math.abs(stage.top - pane.top) < tolerance && stage.top - page.top < 12 && stage.right <= pane.left + tolerance, JSON.stringify(boxes));
    assert.ok(toolbar.right <= pane.right + tolerance && toolbar.top >= pane.top - tolerance &&
      toolbar.bottom <= messages.top + tolerance && messages.bottom <= zone.top + tolerance && zone.bottom <= pane.bottom + tolerance, JSON.stringify(boxes));
    if (width === 720) {
      assert.ok(stage.width < page.width * 0.35 && messages.height > 160, '窄窗舞台应为消息留出阅读空间');
    }
    await shot(width === 1280 ? 'desktop.png' : `desktop-${width}.png`);
  }
  assert.equal(await ev("!!document.querySelector('.dialogue-topbar')"), false);
  await ev("document.querySelector('[aria-label=演出设置]').click()");
  await until(() => ev("[...document.querySelectorAll('[role=dialog]')].some(x=>x.textContent.includes('演出设置'))"));
  await ev("[...document.querySelectorAll('.dialogue-option')].find(x=>x.textContent.includes('隐藏底部导航栏')).querySelector('input').click()");
  await until(() => ev("!document.querySelector('.ui-page-dock')"));
  assert.ok(await ev(`document.querySelector('.dialogue-pane').getBoundingClientRect().bottom > ${layouts.get(1280).pane.bottom} + 70`), '隐藏导航后没有释放对话空间');
  await ev("document.querySelector('[role=dialog] [aria-label=关闭弹窗]').click()"); await delay(300);
  const compactHidden = await layoutAt(720, 540);
  assert.ok(compactHidden.messages.height > layouts.get(720).messages.height + 70, '窄窗隐藏导航后没有扩展消息区');
  await shot('desktop-720-dock-hidden.png');
  await layoutAt(1280, 800);
  await ev("document.querySelector('.ui-studio-brand').click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='home' && !!document.querySelector('.ui-page-dock')"));
  await cmd('Page.reload');
  await until(() => ev("!!document.querySelector('.ui-page-dock')"));
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('对话')).click()");
  await until(() => ev("document.querySelector('.dialogue-connection')?.dataset.state==='open' && !document.querySelector('.ui-page-dock')"));
  await ev("document.querySelector('[aria-label=演出设置]').click()");
  await until(() => ev("!!document.querySelector('.dialogue-option input')"));
  assert.equal(await ev("[...document.querySelectorAll('.dialogue-option')].find(x=>x.textContent.includes('隐藏底部导航栏')).querySelector('input').checked"), true, '重启后未保留对话页导航偏好');
  await ev("[...document.querySelectorAll('.dialogue-option')].find(x=>x.textContent.includes('隐藏底部导航栏')).querySelector('input').click()");
  await until(() => ev("!!document.querySelector('.ui-page-dock')"));
  await ev("document.querySelector('[role=dialog] [aria-label=关闭弹窗]').click()"); await delay(300);
  await ev("document.querySelector('.dialogue-history-button').focus();document.querySelector('.dialogue-history-button').click()");
  await until(() => ev("!!document.querySelector('.dialogue-history[data-open]')"));
  await verifyHistorySearchFocus();
  await ev("document.querySelector('.dialogue-history-close').click()");
  await until(() => ev("!document.querySelector('.dialogue-history')"));
  assert.equal(await ev("document.activeElement===document.querySelector('.dialogue-history-button')"), true, '关闭历史后焦点未恢复');
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const firstLocation = await locateHistoryMessage();
  assert.equal(firstLocation.animation, 'dialogue-locate');
  assert.equal(firstLocation.visible, true);
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const repeatLocation = await locateHistoryMessage();
  assert.equal(repeatLocation.animation, 'none');
  assert.equal(repeatLocation.visible, true);
  assert.ok(repeatLocation.sequence > firstLocation.sequence, '再次定位同一条消息应重新反馈');
  await cmd('Emulation.setEmulatedMedia', { features: [] });
  await ev("document.querySelector('.dialogue-role-switch button').click()");
  await ev("[...document.querySelectorAll('.dialogue-role-switch [role=menuitem]')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("document.querySelector('.dialogue-role-switch button')?.getAttribute('aria-label')?.includes('乙角色')"));
  await until(() => ev("document.querySelector('.dialogue-connection')?.dataset.state==='open'"));
  await ev("document.querySelector('.dialogue-window-switch button').click()");
  await ev("[...document.querySelectorAll('.dialogue-window-switch [role=menuitem]')].find(x=>x.textContent.includes('页面窗口')).click()");
  await until(() => requests.some(p => p.includes('/roles/b/windows/w2/messages')));
  await until(() => ev("document.querySelector('.dialogue-connection')?.dataset.state==='open'"));
  await verifyVoiceFeedback();
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await delay(350);
  assert.equal(await ev("document.documentElement.scrollWidth<=innerWidth+1"), true);
  const inside = await ev("(()=>{const p=document.querySelector('.dialogue-pane').getBoundingClientRect();return [...document.querySelectorAll('.dialogue-pane-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=p.left&&r.right<=p.right})})()");
  assert.equal(inside, true, '窄屏工具超出对话框'); await shot('mobile.png');
  await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev("[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes('设置'))"));
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes('设置')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"));
  assert.deepEqual(errors, []); console.log(JSON.stringify({ windowSizes: [...layouts.keys()], dockPreference: true, otherPagesKeepDock: true, historyFocus: true, historyLocation: true, voiceFeedback: true, roleSwitch: true, windowSwitch: true, mobile: true, settingsMenu: true, errors }, null, 2));
}
run().catch(error => { console.error(error, logs.slice(-1000)); process.exitCode = 1; }).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 99999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(500); if (proc && proc.exitCode === null) proc.kill(); for (const stream of streams) stream.end(); server.close();
  try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('dialogue-layout-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
