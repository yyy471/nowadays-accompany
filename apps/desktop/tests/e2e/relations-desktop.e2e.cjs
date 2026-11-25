"use strict";

// 仓库根目录运行：Node 24 + 已构建的 renderer；只使用隔离的本地假服务。
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { resolveElectronExecutable } = require('../helpers/electron-executable.cjs');

const { repoRoot: root, desktopDir, xiachengPortraitFixture, testResultsDir } = require('../helpers/paths.cjs');
const results = path.join(testResultsDir, 'relations-v2');
fs.mkdirSync(results, { recursive: true });
const temp = fs.mkdtempSync(path.join(results, 'profile-'));
const now = '2026-11-09T10:00:00.000Z';
const requests = [];
const evidenceResponses = [];
let rolesAvailable = false;
let firstRoleDetailAvailable = false;
let refreshResponse;
let holdRefresh = false;
const roles = ['role-one', 'role-two'].map((roleId, index) => ({ roleId, displayName: index ? '乙角色' : '甲角色', status: 'ready', defaultWindowId: `w${index}` }));
function json(res, value, status = 200) { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(value)); }
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => raw += chunk);
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    let body; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    requests.push({ path: p, body });
    const role = roles.find(item => p.includes(`/roles/${item.roleId}`)) ?? roles[0];
    if (p === '/v1/health') return json(res, { status: 'ok', version: 'test' });
    if (p === '/v1/roles') return rolesAvailable ? json(res, { items: roles }) : json(res, { error: { message: '本机角色库正在准备' } }, 503);
    if (p === `/v1/roles/${role.roleId}`) {
      if (role === roles[0] && !firstRoleDetailAvailable) return json(res, { error: { message: '首位角色的资料暂时不可读取' } }, 503);
      return json(res, { ...role, createdAt: now, definition: { text: `${role.displayName}的介绍`, payload: {} }, definitionRevision: 1 });
    }
    if (p.endsWith('/appearance/outfits')) return json(res, { items: [{ outfitId: 'o', roleId: role.roleId, name: '服饰', home: { assetId: 'portrait', outfitId: 'o', usage: 'home' }, sprites: [] }] });
    if (p.endsWith('/appearance/assets/portrait')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fs.readFileSync(xiachengPortraitFixture)); }
    if (p.endsWith('/state')) {
      if (holdRefresh && role.roleId === 'role-two') { refreshResponse = res; holdRefresh = false; return; }
      return json(res, { state: { outfitId: 'o', mood: `${role.displayName}的近况` }, stateVersion: 1, updatedAt: now });
    }
    if (p.endsWith('/memory/search')) {
      const type = body?.types?.[0];
      return json(res, { items: type === 'event' ? [{ type, id: 'event-1', title: `${role.displayName}的经历`, snippet: '一起散步' }] : [] });
    }
    if (p.endsWith('/memory/events/event-1')) return json(res, {
      title: `${role.displayName}的经历`, summary: '一起散步', subjectiveExperience: '很开心', experienceDate: '2026-11-09',
      sources: [{ evidenceId: 'e1' }], version: 1,
      claims: Array.from({ length: 12 }, (_, index) => ({ claimId: `c${index}`, kind: 'observation', text: `往事线索 ${index}` }))
    });
    if (p.endsWith('/memory/evidence/e1')) { evidenceResponses.push(res); return; }
    if (p.endsWith('/diaries')) return json(res, { items: [...Array.from({ length: 9 }, (_, index) => ({ diaryId: `d${index + 1}`, experienceDate: `2026-11-${String(9 - index).padStart(2, '0')}` })), { diaryId: 'broken', experienceDate: '2026-10-01' }] });
    if (p.endsWith('/diaries/broken')) return json(res, { error: { message: '日记文件不存在' } }, 404);
    if (/\/diaries\/d[1-9]$/.test(p)) return json(res, { experienceDate: `2026-11-${String(10 - Number(p.at(-1))).padStart(2, '0')}`, content: `# ${role.displayName}的日记\n\n这一天的记录。` });
    return json(res, { error: { message: `unhandled ${p}` } }, 404);
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, timeout = 18000) { let error; for (const start = Date.now(); Date.now() - start < timeout;) { try { const value = await test(); if (value) return value; } catch (e) { error = e; } await delay(80); } throw Error(`timeout ${error || ''}`); }
let proc, ws, nextId = 0, logs = '';
const waiting = new Map(), errors = [];
function cmd(method, params = {}) { return new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function ev(expression) { const result = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function screenshot(name) { const shot = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(results, name), Buffer.from(shot.data, 'base64')); }
async function verifyEntryRetry() {
  const notice = '.role-entry-note[role=alert]';
  const enter = "[...document.querySelectorAll('.role-entry-actions button')].find(button => button.textContent === '进入书房')";
  const retry = () => ev(`document.querySelector('${notice} button').click()`);
  await until(() => ev(`document.querySelector('${notice}')?.textContent.includes('本机角色库正在准备')`));
  assert.ok(await ev(`document.querySelector('${notice} p').textContent.startsWith('暂时无法读取角色列表。')`));
  assert.equal(await ev(`${enter}.disabled`), true);
  rolesAvailable = true;
  await retry();
  await until(() => ev(`document.querySelector('${notice}')?.textContent.includes('首位角色的资料暂时不可读取')`));
  assert.ok(await ev(`document.querySelector('${notice} p').textContent.startsWith('角色资料暂时无法更新。')`));
  assert.equal(await ev(`${enter}.disabled`), false);
  assert.equal(await ev("document.querySelectorAll('.role-entry-card').length"), roles.length);
  const listRequests = requests.filter(request => request.path === '/v1/roles').length;
  firstRoleDetailAvailable = true;
  await retry();
  await until(() => ev(`!document.querySelector('${notice}')`));
  assert.equal(requests.filter(request => request.path === '/v1/roles').length, listRequests);
  await ev(`${enter}.click()`);
}
async function checkStrip(mode) {
  const value = await ev(`(()=>{const r=s=>{const v=document.querySelector(s).getBoundingClientRect();return {left:v.left,right:v.right,top:v.top,bottom:v.bottom,width:v.width}};const strip=document.querySelector('.edition-strip');const active=strip.querySelector(${JSON.stringify(mode === 'night' ? '.glass' : '.letter-strip')});return {book:r('.collection'),strip:r('.edition-strip'),crumb:r('.breadcrumb'),folio:r('.folio'),visible:getComputedStyle(strip).display!=='none'&&getComputedStyle(active).display!=='none'&&Number(getComputedStyle(active).opacity)>.99,pointer:getComputedStyle(strip).pointerEvents}})()`);
  assert.ok(value.visible && value.pointer === 'none', `装饰条不可见或阻挡操作: ${JSON.stringify(value)}`);
  assert.ok(value.strip.left >= value.crumb.right && value.strip.right <= value.folio.left && value.strip.top >= value.book.top && value.strip.bottom <= value.book.bottom, `装饰条位置与导航或页码重叠: ${JSON.stringify(value)}`);
  assert.ok(value.strip.left - value.crumb.right >= 4 && value.folio.left - value.strip.right >= 4 && value.strip.width > 24, `装饰条和相邻文字之间没有留白: ${JSON.stringify(value)}`);
}
async function openEvidence() {
  await ev("document.querySelector('.moment-actions .evidence-button').focus(); document.querySelector('.moment-actions .evidence-button').click()");
  await until(() => ev("document.querySelector('.evidence[role=region] [role=status]')?.textContent.includes('正在读取原始记录')"));
  await until(() => evidenceResponses.length);
  return evidenceResponses.shift();
}
async function checkEvidenceAnimation(animationName) {
  const placement = await until(() => ev(`(() => {
    const record = document.querySelector('.evidence[data-state=ready]');
    const ink = record?.querySelector('.evidence-location-ink');
    if (!ink || document.activeElement !== record) return false;
    const rect = record.getBoundingClientRect();
    const host = document.querySelector('.reading-sheet').getBoundingClientRect();
    const style = getComputedStyle(ink);
    return { visible: rect.top < host.bottom && rect.bottom > host.top, name: style.animationName,
      duration: style.animationDuration, text: record.textContent.includes('保存的原始记录') };
  })()`));
  assert.ok(placement.visible && placement.text, JSON.stringify(placement));
  assert.equal(placement.name, animationName);
  if (animationName !== 'none') assert.equal(placement.duration, '1.2s');
}
async function verifyEvidence() {
  await cmd('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const first = await openEvidence();
  const record = { content: '保存的原始记录', occurredAt: '2026-11-09T18:04:12.000Z' };
  json(first, record);
  await checkEvidenceAnimation('relation-evidence-locate');
  const time = await ev(`(() => {
    const time = document.querySelector('.evidence time');
    return { dateTime: time.dateTime, label: time.textContent };
  })()`);
  assert.equal(time.dateTime, record.occurredAt);
  assert.match(time.label, /^2026年11月10日\s+02:04$/);
  await ev("window.firstEvidenceInk = document.querySelector('.evidence-location-ink'); document.querySelector('.moment-actions .evidence-button').click()");
  assert.equal(await ev("!!document.querySelector('.evidence')"), false);
  const second = await openEvidence();
  json(second, { error: { message: '原始记录暂时无法读取' } }, 503);
  await until(() => ev("document.querySelector('.evidence [role=alert]')?.textContent.includes('原始记录暂时无法读取')"));
  await ev("document.querySelector('.evidence button').click()");
  await until(() => evidenceResponses.length);
  json(evidenceResponses.shift(), { ...record, occurredAt: 'invalid-time' });
  await checkEvidenceAnimation('relation-evidence-locate');
  assert.equal(await ev("document.querySelector('.evidence .evidence-time')?.textContent"), '时间未记');
  assert.equal(await ev("!!document.querySelector('.evidence time')"), false);
  assert.equal(await ev("document.querySelector('.evidence-location-ink') !== window.firstEvidenceInk"), true, '重复回看应重新高亮');
  await ev("document.querySelector('.moment-actions .evidence-button').click()");
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until(() => ev("document.querySelector('.exlibris')?.dataset.motion === 'reduced'"));
  json(await openEvidence(), record);
  await checkEvidenceAnimation('none');
  await cmd('Emulation.setEmulatedMedia', { features: [] });
}
async function verifyRefresh() {
  holdRefresh = true;
  await ev("document.querySelector('[aria-label=刷新藏页]').focus(); document.querySelector('[aria-label=刷新藏页]').click()");
  await until(() => refreshResponse && ev("document.querySelector('[aria-label=刷新藏页]')?.getAttribute('aria-busy') === 'true'"));
  assert.ok(await ev("document.querySelector('.evidence[data-state=ready]')?.textContent.includes('保存的原始记录')"));
  json(refreshResponse, { state: { outfitId: 'o', mood: '已更新的近况' }, stateVersion: 2, updatedAt: now });
  await until(() => ev("document.querySelector('.rail-identity')?.textContent.includes('已更新的近况') && !document.querySelector('[aria-label=刷新藏页]').hasAttribute('aria-busy')"));
}
async function verifyCorrectionLayout() {
  await cmd('Emulation.setDeviceMetricsOverride', { width: 720, height: 540, deviceScaleFactor: 1, mobile: false });
  await until(() => ev('innerWidth === 720'));
  await checkStrip('day');
  await ev(`(() => {
    const button = [...document.querySelectorAll('.moment-actions button')].find(node => node.textContent === '更正经历');
    button.focus(); button.click();
  })()`);
  await until(() => ev("!!document.querySelector('.memory-correction details')"));
  await until(() => ev(`(() => {
    const dialog = document.querySelector('.memory-correction');
    return [dialog, dialog.closest('.ui-modal-backdrop')].every(layer =>
      getComputedStyle(layer).opacity === '1' && !layer.getAnimations().some(animation =>
        Number.isFinite(animation.effect.getComputedTiming().endTime) && (animation.pending || animation.playState === 'running')));
  })()`));
  const panel = await ev(`(() => {
    const dialog = document.querySelector('.memory-correction');
    const fields = dialog.querySelector('.memory-correction-fields');
    dialog.querySelector('details').open = true;
    const footer = dialog.querySelector('.ui-dialog-actions');
    const before = footer.getBoundingClientRect();
    fields.scrollTop = fields.scrollHeight;
    const after = footer.getBoundingClientRect();
    return { scrollTop: fields.scrollTop, bodyBottom: fields.getBoundingClientRect().bottom, footerTop: after.top,
      footerBottom: after.bottom, stationary: Math.abs(after.top - before.top) < .5, viewport: innerHeight };
  })()`);
  assert.ok(panel.scrollTop > 0 && panel.stationary && panel.bodyBottom <= panel.footerTop + .5 && panel.footerBottom <= panel.viewport, JSON.stringify(panel));
  await screenshot('compact-memory-correction.png');
  await ev("document.querySelector('.memory-correction [aria-label=关闭弹窗]').click()");
  await until(() => ev("!document.querySelector('.memory-correction') && document.activeElement?.textContent === '更正经历'"));
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => ev('innerWidth === 1280'));
}
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, NOWADAYS_BACKEND_URL: `http://127.0.0.1:${server.address().port}`, NOWADAYS_APP_ROOT: path.join(temp, 'data') };
  delete env.NOWADAYS_SKIP_ROLE_PICKER;
  delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(resolveElectronExecutable({ repoRoot: root }), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'chrome')}`, desktopDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', chunk => logs += chunk); proc.stderr.on('data', chunk => logs += chunk);
  const port = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(logs)?.[1]);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.startsWith('desk://bundle/')));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id) { const job = waiting.get(message.id); waiting.delete(message.id); message.error ? job?.reject(message.error) : job?.resolve(message.result); } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text); };
  await cmd('Runtime.enable');
  await verifyEntryRetry();
  await until(() => ev("document.querySelector('.ui-page-dock') && document.querySelector('.studio-runtime')?.textContent.includes('2 位角色')"));
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('关系')).click()");
  await until(() => ev("document.querySelector('.current-state')?.textContent.includes('甲角色的近况')"));
  await delay(1200);
  const width = await ev("document.querySelector('.collection').getBoundingClientRect().width");
  assert.ok(width > 1100, `书页意外收窄: ${width}`);
  const top = await ev("(()=>{const s=document.querySelector('.relationship-stage').getBoundingClientRect(),b=document.querySelector('.collection').getBoundingClientRect();return {stage:s.top,book:b.top,oldHeader:!!document.querySelector('.relationship-topbar')}})()");
  assert.ok(!top.oldHeader && Math.abs(top.book-top.stage) < 1, `书页未填满顶部: ${JSON.stringify(top)}`);
  await checkStrip('day');
  const leftRatio = await ev("document.querySelector('.book-surface .leaf.left').getBoundingClientRect().width / document.querySelector('.book-surface').getBoundingClientRect().width");
  assert.ok(Math.abs(leftRatio - .34) < .01, `左页比例意外改变: ${leftRatio}`);
  await screenshot('desktop-day.png');
  await ev("document.querySelector('.plate-switch button').click()");
  const selector = await ev("(()=>{const p=document.querySelector('.person-selector').getBoundingClientRect(),b=document.querySelector('.collection').getBoundingClientRect();return {top:p.top,bottom:p.bottom,bookTop:b.top,bookBottom:b.bottom}})()");
  assert.ok(selector.top >= selector.bookTop && selector.bottom <= selector.bookBottom, `角色选择器被裁切: ${JSON.stringify(selector)}`);
  await ev("[...document.querySelectorAll('.person-option')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("document.querySelector('.current-state')?.textContent.includes('乙角色的近况')"));
  await ev("document.querySelector('.tab-experiences').click()");
  await until(() => ev("document.querySelector('.moment-title')?.textContent.includes('乙角色的经历')"));
  assert.equal(await ev("document.querySelector('#inner-eyebrow')?.textContent"), '经历 · 回看');
  assert.equal(await ev("document.querySelector('#inner-title')?.textContent"), '一起经过');
  await checkStrip('day');
  await ev("document.querySelector('.moment-open').click()");
  await until(() => ev("!!document.querySelector('.evidence-button')"));
  await verifyEvidence();
  await screenshot('desktop-experience.png');
  await verifyRefresh();
  await verifyCorrectionLayout();
  await ev("[...document.querySelectorAll('.inner-nav button')].find(x=>x.textContent.includes('日记')).click()");
  await until(() => ev("document.querySelectorAll('.date-index button').length===9 && document.querySelector('.status-line.error')?.textContent.includes('1 篇日记')"));
  assert.equal(await ev("document.querySelector('#inner-eyebrow')?.textContent"), '日记 · 随笔');
  assert.equal(await ev("document.querySelector('#inner-title')?.textContent"), '留在纸上');
  await ev("document.querySelector('.date-index button').focus();document.querySelector('.date-index button').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))");
  assert.equal(await ev("document.activeElement===document.querySelectorAll('.date-index button')[1]"), true);
  assert.equal(await ev("document.querySelectorAll('.date-index button')[1].getAttribute('aria-selected')"), 'true');
  await ev("[...document.querySelectorAll('.inner-nav button')].find(x=>x.textContent.includes('角色介绍')).click()");
  await until(() => ev("document.querySelector('[data-testid=profile-definition]')?.textContent.includes('乙角色的介绍')"));
  await checkStrip('day');
  await ev("document.querySelector('.back-button').click()");
  await until(() => ev("!!document.querySelector('.tab-experiences')")); await delay(1000);
  assert.equal(await ev("document.activeElement?.classList.contains('tab-experiences')"), true, '返回时焦点回到最初的藏页');
  await ev("[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('晚风电台')).click()");
  await until(() => ev("document.querySelector('.exlibris')?.dataset.theme==='night'")); await delay(1800);
  await checkStrip('night');
  assert.equal(await ev("getComputedStyle(document.querySelector('.photo-caption .night-only')).display !== 'none' && getComputedStyle(document.querySelector('.photo-caption .day-only')).display === 'none'"), true, '夜间文案未切换');
  assert.equal(await ev("getComputedStyle(document.querySelector('.portrait-mat img')).objectFit"), 'contain', '全身立绘被裁切');
  await screenshot('desktop-night.png');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false }); await delay(400);
  const compact = await ev("(()=>{const s=document.querySelector('.plate-switch').getBoundingClientRect(),f=document.querySelector('.sheet-footer').getBoundingClientRect(),b=document.querySelector('.collection').getBoundingClientRect();return {switchBottom:s.bottom,footerTop:f.top,bookBottom:b.bottom}})()");
  assert.ok(compact.switchBottom <= compact.footerTop && compact.switchBottom <= compact.bookBottom, `紧凑窗口下换人入口遮挡: ${JSON.stringify(compact)}`);
  await screenshot('compact-night.png');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await delay(500);
  await checkStrip('night');
  assert.equal(await ev("document.documentElement.scrollWidth <= innerWidth + 1"), true, '窄屏出现横向溢出');
  await screenshot('mobile-night.png');
  const mobileSwitch = await ev("(()=>{const p=document.querySelector('.plate-switch').getBoundingClientRect(),b=document.querySelector('.collection').getBoundingClientRect();return {top:p.top,bottom:p.bottom,bookTop:b.top,bookBottom:b.bottom}})()");
  assert.ok(mobileSwitch.top >= mobileSwitch.bookTop && mobileSwitch.bottom <= mobileSwitch.bookBottom, `窄屏角色切换被裁切: ${JSON.stringify(mobileSwitch)}`);
  await cmd('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: false }); await delay(350);
  await checkStrip('night');
  await ev("document.querySelector('.tab-diary').click()");
  await until(() => ev("document.querySelector('.diary-paper')?.textContent.includes('乙角色的日记')"));
  await checkStrip('night');
  await ev("[...document.querySelectorAll('.inner-nav button')].find(x=>x.textContent.includes('角色介绍')).click()");
  await until(() => ev("document.querySelector('[data-testid=profile-definition]')?.textContent.includes('乙角色的介绍')"));
  await checkStrip('night');
  await ev("document.querySelector('.back-button').click()"); await delay(1000);
  assert.equal(await ev("document.activeElement?.classList.contains('tab-diary')"), true, '返回日记藏页时焦点应回到日记标签');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log(JSON.stringify({ bookWidth: width, leftRatio, selector, diaryErrorsIsolated: true, keyboardFocus: true, switchRole: true, evidence: true, refresh: true, correctionLayout: true, desktopNight: true, mobileDiary: true, errors }, null, 2));
}
run().catch(error => { console.error(error, logs.slice(-1500)); process.exitCode = 1; }).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 99999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(600); if (proc && proc.exitCode === null) proc.kill(); server.close();
  try { if (path.dirname(path.resolve(temp)) === path.resolve(results) && path.basename(temp).startsWith('profile-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
