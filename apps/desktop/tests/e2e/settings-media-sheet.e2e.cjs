'use strict';
// 通过本机 HTTP 替身验证角色媒体分组、草稿与晚到探测，以及设置页的长文本、强制色和对比度。
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { resolveElectronExecutable } = require('../helpers/electron-executable.cjs');
const { repoRoot: root, desktopDir, xiachengPortraitFixture, testResultsDir } = require('../helpers/paths.cjs');
const out = path.join(testResultsDir, 'settings-media-sheet');
fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-media-sheet-'));
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
const portraitFixture = fs.readFileSync(xiachengPortraitFixture);
const roles = [{ roleId: 'a', displayName: '甲角色', isBuiltin: false }, { roleId: 'b', displayName: '乙角色', isBuiltin: false }];
const longResourceName = '模型服务'.repeat(80);
const longResourceAddress = `https://model.test/${'long-address-'.repeat(50)}`;
const resources = [{ resourceId: 'm1', kind: 'model', name: longResourceName, enabled: true, config: { protocol: 'openai-chat', baseUrl: longResourceAddress, modelName: 'deepseek-chat' }, createdAt: date, updatedAt: date }];
const bindings = {
  a: [{ capability: 'chat_model', resourceId: 'm1', modelName: 'deepseek-chat', enabled: true }],
  b: [{ capability: 'chat_model', resourceId: 'm1', modelName: 'deepseek-chat', enabled: true }],
};
let voiceProbeCount = 0;
let scenarioRoute;
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://127.0.0.1').pathname;
  if (scenarioRoute?.(p, req, res)) return;
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
  if (p === '/v1/roles/a/appearance/outfits') return json({ items: [{ outfitId:'coat', roleId:'a', name:'甲的服饰', home:{ assetId:'home' }, sprites:[] }] });
  if (p === '/v1/roles/a/appearance/assets/home') { res.writeHead(200, { 'content-type':'image/png' }); res.end(portraitFixture); return; }
  if (p === '/v1/resources') return json({ items: resources });
  if (p === '/v1/activities') return json({ items: roles.map(role => ({ roleId: role.roleId, state: role.roleId === 'b' ? 'stopped' : 'active', initStatus: 'ready' })) });
  if (p === '/v1/resources/m1/references') return json({ references: [], canUpdate: true, canDisable: true, canDelete: true });
  if (p === '/v1/resources/m1/impact') return json({ roles: [], blockingTasks: 0 });
  if (p === '/v1/voice-services') return json({ items: [
    { serviceId:'v1', name:'语音甲', enabled:true, config:{protocol:'nowadays-tts-v1',baseUrl:'http://voice-a'} },
    { serviceId:'v2', name:'语音乙', enabled:true, config:{protocol:'nowadays-tts-v1',baseUrl:'http://voice-b'} },
  ] });
  if (p === '/v1/image-services') return json({ items: [{ serviceId:'i1', name:'画室', enabled:true, config:{baseUrl:'http://image',modelName:'art.safetensors'}, credential:{status:'unset'} }] });
  if (p.endsWith('/scene-image')) return json({ settings: {serviceId:'i1',modelType:'text2img',modelPath:'art.safetensors',basePrompt:'portrait',negativePrompt:'',outfitPrompts:{},width:832,height:1216,steps:28,cfg:6.5,sampler:'dpmpp_2m',scheduler:'karras',seed:null,workflow:null,outputNodeId:null}, service:{serviceId:'i1',name:'画室',enabled:true,baseUrl:'http://image'}, configured:true });
  if (p === '/v1/voice-services/v1/probe') {
    voiceProbeCount++;
    const response = { probe:{protocol:'nowadays-tts-v1',service:'语音甲',model:'',ready:true,capabilities:{referenceModes:[],presetVoices:true,languages:['zh'],speed:{min:0.5,max:2}},voices:[],engines:{},defaultEngine:null}, elapsedMs: 23 };
    if (voiceProbeCount === 1) return json(response);
    if (voiceProbeCount === 4) return json({error:{code:'MODEL_REQUEST_TIMEOUT',message:'timeout'}}, 504);
    setTimeout(() => json(response), 900);
    return;
  }
  const detail = /^\/v1\/roles\/([^/]+)$/.exec(p);
  if (detail) { const role = roles.find(item => item.roleId === detail[1]); return json({ ...role, definition: { text: '正文', payload: {} }, definitionRevision: 1, bio: '' }); }
  const bind = /^\/v1\/roles\/([^/]+)\/bindings$/.exec(p);
  if (bind) {
    if (req.method === 'PUT') { let body = ''; req.on('data', chunk => body += chunk); return req.on('end', () => { bindings[bind[1]] = JSON.parse(body || '{}').bindings || []; return json({ items: bindings[bind[1]], revision: 'r2' }); }); }
    return json({ items: bindings[bind[1]] || [], revision: 'r1' });
  }
  if (p.includes('/autonomy/budget')) return json({ localDate: '2026-11-19', usedPoints: 12, dailyLimit: 200, unlimited: false });
  if (p.endsWith('/activity')) return json({ activity: { state: p.startsWith('/v1/roles/b/') ? 'stopped' : 'active', initStatus: 'ready' } });
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
// 立绘像素断言前等到图片解码、动画落定且合成器提交两帧，避免并发下采到中间帧。
async function waitPortraitSettled() {
  await until(() => ev(`(() => {
    const img = document.querySelector('.config-stage .config-portrait img');
    return !!img && img.complete && img.naturalWidth > 0;
  })()`), 'portrait decoded');
  await ev(`document.querySelector('.config-stage .config-portrait img')?.decode().catch(() => {})`);
  await until(() => ev('document.getAnimations().every(a => a.playState !== \'running\')'), 'portrait animations settled', 8000);
  await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
}
const clickTab = async (label) => {
  const ok = await ev(`(()=>{const b=[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes(${JSON.stringify(label)}));if(!b)return false;b.click();return true;})()`);
  if (!ok) throw Error('no tab ' + label);
};
async function nav(label) {
  await clickTab(label);
  await until(() => ev(`document.querySelector('.config-tabs button[aria-current=page]')?.textContent.includes(${JSON.stringify(label)})`), 'tab ' + label);
}
async function clickSheetButton(label) {
  const ok = await ev(`(()=>{const b=[...document.querySelectorAll('.config-sheet button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true;})()`);
  if (!ok) throw Error('no sheet button ' + label);
}
async function run(verify) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, NOWADAYS_BACKEND_URL: `http://127.0.0.1:${server.address().port}`, NOWADAYS_APP_ROOT: path.join(temp, 'app'), NOWADAYS_SKIP_ROLE_PICKER: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(resolveElectronExecutable({ repoRoot: root }), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, desktopDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

  if (verify) {
    await verify({ cmd, ev, until, nav, out, errors, longResourceName, longResourceAddress });
    return;
  }
  await nav('模型');
  const imageRow = '.config-role-editor:not([hidden]) [data-edit="media:image"]';
  const voiceRow = '.config-role-editor:not([hidden]) [data-edit="media:voice"]';
  await until(() => ev(`!!document.querySelector('${imageRow}') && !!document.querySelector('${voiceRow}')`), 'media rows');
  assert.equal(await ev(`document.querySelector('${imageRow}').hasAttribute('tabindex')`), false);
  assert.match(await ev(`document.querySelector('${imageRow}').innerText`), /画室.*art/);
  await until(() => ev("document.querySelector('.config-stage .config-portrait img')?.naturalWidth > 0"), 'fixture portrait loaded');
  await waitPortraitSettled();
  const portrait = await ev(`(()=>{const r=document.querySelector('.config-stage .config-portrait').getBoundingClientRect();return {x:Math.ceil(r.x)+3,y:Math.ceil(r.y)+3,width:Math.floor(r.width)-6,height:Math.floor(r.height)-6,scale:1};})()`);
  const changeTheme = async preset => {
    await ev(`document.querySelector('.ui-theme-switcher [data-theme-choice="${preset}"]').click()`);
    await until(() => ev(`document.documentElement.dataset.uiPreset === '${preset}' && !document.querySelector('.config-theme-veil') && !document.documentElement.hasAttribute('data-switching')`), `${preset} settled`);
  };
  assert.equal(await ev('document.documentElement.dataset.uiPreset'), 'daylight');
  const before = await cmd('Page.captureScreenshot', {format:'png',clip:portrait});
  fs.writeFileSync(path.join(out,'portrait-before.png'), Buffer.from(before.data,'base64'));
  await cmd('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:'no-preference' }] });
  await ev("document.querySelector('.ui-theme-switcher [data-theme-choice=nightwave]').click()");
  await until(() => ev("document.querySelector('.theme-snapshot')?.style.maskComposite.includes('subtract') && parseFloat(getComputedStyle(document.querySelector('.theme-feather')).getPropertyValue('--theme-edge')) > 8"), '羽化中间帧保留立绘挖空');
  const middle = await cmd('Page.captureScreenshot', {format:'png',clip:portrait});
  const midPixels = PNG.sync.read(Buffer.from(middle.data,'base64'));
  await until(() => ev("!document.querySelector('.theme-snapshot') && document.documentElement.dataset.uiPreset==='nightwave'"), '夜幕收束');
  await waitPortraitSettled();
  const night = await cmd('Page.captureScreenshot', { format: 'png', clip: portrait });
  fs.writeFileSync(path.join(out, 'portrait-nightwave.png'), Buffer.from(night.data, 'base64'));
  const originalPixels = PNG.sync.read(Buffer.from(before.data, 'base64'));
  const nightPixels = PNG.sync.read(Buffer.from(night.data, 'base64'));
  assert.equal(nightPixels.width, originalPixels.width);
  assert.equal(nightPixels.height, originalPixels.height);
  let changedPixels = 0, midChangedPixels = 0;
  for (let i = 0; i < originalPixels.data.length; i += 4) {
    if (!originalPixels.data.subarray(i, i + 4).equals(midPixels.data.subarray(i, i + 4))) midChangedPixels++;
    if (!originalPixels.data.subarray(i, i + 4).equals(nightPixels.data.subarray(i, i + 4))) changedPixels++;
  }
  const totalPixels = originalPixels.width * originalPixels.height;
  assert.ok(midChangedPixels / totalPixels < .01, '中间帧立绘变化 ' + midChangedPixels + '/' + totalPixels);
  const portraitThemeChangedPercent = 100 * changedPixels / totalPixels;
  assert.ok(portraitThemeChangedPercent < 1, `昼夜实际切换后的立绘差异 ${changedPixels}/${totalPixels} (${portraitThemeChangedPercent.toFixed(3)}%)`);
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await ev(`(() => {
    const controls = document.querySelector('.studio-shell:not(.config-theme-veil) .ui-theme-switcher');
    controls.querySelector('[data-theme-choice="daylight"]').click();
    const nightButton = controls.querySelector('[data-theme-choice="nightwave"]');
    nightButton.focus();
    nightButton.click();
  })()`);
  await until(() => ev("!!document.querySelector('.config-theme-veil')"), 'rapid theme change has one in-flight snapshot');
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until(() => ev("document.documentElement.dataset.uiPreset === 'nightwave' && !document.querySelector('.config-theme-veil') && !document.documentElement.hasAttribute('data-config-switching') && !document.documentElement.hasAttribute('data-switching')"), 'reduced motion commits the final requested preset and removes its veil');
  assert.equal(await ev("document.activeElement?.matches('.ui-theme-switcher [data-theme-choice=nightwave]')"), true, '快速切换后焦点保留在真实主题按钮');
  await changeTheme('daylight');
  await cmd('Emulation.setEmulatedMedia', { features: [] });
  await ev(`document.querySelector('${imageRow} .config-chip-k').click()`);
  await until(() => ev("document.querySelector('.config-sheet h3')?.textContent==='生图 · 参数'"), 'image compact');
  assert.equal(await ev("[...document.querySelectorAll('.config-sheet .config-grp')].filter(e=>!e.hidden).length"), 1);
  await until(() => ev("document.activeElement?.matches('.config-sheet input[type=number]')"), 'compact focus');
  await waitPortraitSettled();
  const after = await cmd('Page.captureScreenshot', {format:'png',clip:portrait});
  fs.writeFileSync(path.join(out,'portrait-after.png'), Buffer.from(after.data,'base64'));
  const visiblePixels = PNG.sync.read(Buffer.from(after.data, 'base64'));
  assert.ok(originalPixels.width === visiblePixels.width && originalPixels.height === visiblePixels.height && originalPixels.data.equals(visiblePixels.data), '打开纸笺前后的立绘区域逐像素一致');
  assert.equal(await ev("getComputedStyle(document.querySelector('.config-book-scrim')).maskImage.split('linear-gradient').length-1"), 3, '书本压暗层应挖去右页及立绘');
  await ev(`(()=>{const i=document.querySelector('.config-sheet input[type=number]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'896');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(() => ev("!!document.querySelector('.config-tabs [aria-current=page] .tab-dot')"), 'image dirty');
  await ev("document.querySelector('.config-sheet-x').click()");
  await until(() => ev("!!document.querySelector('.config-sheet-confirm')"), 'image confirm');
  await clickSheetButton('放弃修改');
  await until(() => ev("!document.querySelector('.config-sheet')"), 'image closed'); await delay(320);
  await ev(`document.querySelector('${imageRow} .config-chip-k').click()`);
  await until(() => ev("document.querySelector('.config-sheet h3')?.textContent==='生图 · 参数'"), 'image reopen');
  assert.equal(await ev("document.querySelector('.config-sheet input[type=number]')?.value"), '832');
  await ev("document.querySelector('.config-sheet-x').click()");
  await until(() => ev("!document.querySelector('.config-sheet')"), 'image close'); await delay(300);
  assert.equal(await ev(`document.activeElement === document.querySelector('${imageRow} .config-sum-edit')`), true, '从参数片段打开纸笺后，关闭时焦点回该行编辑按钮');
  await ev(`document.querySelector('${voiceRow} .config-sum-edit').click()`);
  await until(() => ev("document.querySelector('.config-sheet h3')?.textContent==='编辑语音'"), 'voice full');
  await cmd('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  const probeFeedback = "document.querySelector('.config-sheet .config-probe-feedback')";
  const probeSweep = `${probeFeedback}?.querySelector('.config-probe-sweep')`;
  await clickSheetButton('测试连接');
  await until(() => ev("document.querySelector('#live')?.textContent.includes('连接成功')"), 'voice announce');
  assert.match(await ev(`${probeFeedback}.textContent`), /连接成功.*23 ms/);
  assert.ok(await ev(`(${probeSweep}).getAnimations().some(animation=>animation.animationName==='config-probe-sweep')`));
  await ev(`void (window.firstProbeSweep = ${probeSweep})`);
  await ev("[...document.querySelectorAll('.config-sheet button')].find(b=>b.textContent.trim()==='测试连接').focus()");
  await clickSheetButton('测试连接');
  await until(() => ev(`${probeFeedback}?.dataset.state==='busy'`), 'voice pulse while probe is in flight');
  assert.equal(await ev(`${probeFeedback}.textContent`), '正在测试连接…');
  assert.equal(await ev("document.activeElement.matches('.config-sheet button[aria-busy=true]')"), true, '测试中保留按钮焦点');
  await until(() => ev(`(() => {
    const sweep = ${probeSweep};
    return !!sweep && sweep !== window.firstProbeSweep
      && sweep.getAnimations().some(animation => animation.animationName === 'config-probe-sweep');
  })()`), 'repeated voice probe restarts the sweep');
  await cmd('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await until(() => ev(`(${probeSweep})?.getAnimations().length===0`), 'reduced motion shows result without the sweep');
  assert.match(await ev(`${probeFeedback}.textContent`), /连接成功.*23 ms/);
  await cmd('Emulation.setEmulatedMedia', {features:[]});
  await clickSheetButton('测试连接');
  await until(() => ev("[...document.querySelectorAll('.config-sheet button')].some(b=>b.textContent.includes('正在测试'))"), 'voice probe pending');
  await ev("document.querySelector('.config-sheet-x').click()");
  await until(() => ev("!document.querySelector('.config-sheet')"), 'voice close during probe');
  await delay(1200);
  await ev(`document.querySelector('${voiceRow} .config-sum-edit').click()`);
  await until(() => ev("document.querySelector('.config-sheet h3')?.textContent==='编辑语音'"), 'voice reopen after late probe');
  assert.equal(await ev(`!!${probeFeedback}`), false, '关闭后的迟到探测不得回显');
  await clickSheetButton('测试连接');
  await until(() => ev(`${probeFeedback}?.dataset.state==='error' && ${probeFeedback}.textContent.includes('语音服务响应超时')`), 'saved voice probe keeps the real failure after cache invalidation');
  const setInput = async (label, value) => ev(`(()=>{const i=document.querySelector('.config-sheet input[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'${value}');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const select = async value => ev(`(()=>{const i=document.querySelector('.config-sheet select[aria-label="语音服务"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(i,'${value}');i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await setInput('语速','1.3'); await select('v2');
  await until(() => ev("document.querySelector('.config-sheet select[aria-label=语音服务]')?.value==='v2'"), 'voice b');
  await setInput('语速','0.7'); await select('v1');
  await until(() => ev("document.querySelector('.config-sheet input[aria-label=语速]')?.value==='1.3'"), 'voice draft a');
  await select('v2');
  await until(() => ev("document.querySelector('.config-sheet input[aria-label=语速]')?.value==='0.7'"), 'voice draft b');
  await ev("document.querySelector('.config-sheet-x').click()");
  await until(() => ev("!!document.querySelector('.config-sheet-confirm')"), 'voice confirm');
  await clickSheetButton('放弃修改');
  await until(() => ev("!document.querySelector('.config-sheet')"), 'voice close'); await delay(320);
  await ev(`document.querySelector('${voiceRow} .config-sum-edit').click()`);
  await until(() => ev("document.querySelector('.config-sheet h3')?.textContent==='编辑语音'"), 'voice reopen');
  assert.equal(await ev("document.querySelector('.config-sheet select[aria-label=语音服务]')?.value"), 'v1');
  assert.equal(await ev("document.querySelector('.config-sheet input[aria-label=语速]')?.value"), '1');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ imageGroup:true, imageDiscard:true, voiceSessionDraft:true, voiceDiscard:true, voiceAnnounce:true, lateProbeIgnored:true, midChangedPixels, portraitThemeChangedPixels: changedPixels, portraitThemeTotalPixels: totalPixels, portraitThemeChangedPercent }));

}
function check(verify, route) {
  scenarioRoute = route;
  return run(verify).catch(error => { console.error(error, errors, logs.slice(-1200)); process.exitCode = 1; }).finally(async () => {
    try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); ws.close(); } } catch {}
    await delay(400); if (proc && proc.exitCode === null) proc.kill(); server.close();
    try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('settings-media-sheet-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  });
}

if (require.main === module) check();
module.exports = { check };
