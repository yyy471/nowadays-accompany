"use strict";

// 仓库根目录运行：Node 24 + 已构建的 renderer；只使用隔离的本地假服务。
// 覆盖 234 的 EX-R01（慢日记不挡其余资料）、EX-R02（多角色换人面板换行滚动）、
// EX-R03（换人面板焦点）、EX-R04（同批慢日记不挡已返回日记）、EX-R05（二级页换人面板不被裁掉）。
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = process.cwd();
const results = path.join(root, 'backend', 'test-results', 'review-234');
fs.mkdirSync(results, { recursive: true });
const temp = fs.mkdtempSync(path.join(results, 'profile-'));
// Chromium 的配置目录放在系统临时目录，避免退出时的文件锁把证据目录塞满。
const profile = path.join(require('node:os').tmpdir(), 'nowadays-review-234-chrome');
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
const now = '2026-11-09T10:00:00.000Z';
const requests = [];
const mode = process.argv[2] ?? 'base';
let releaseSlow;
const roles = ['role-one', 'role-two'].map((roleId, index) => ({ roleId, displayName: index ? '乙角色' : '甲角色', status: 'ready', defaultWindowId: `w${index}` }));
if (mode === 'many' || mode === 'inner') for (let index = 3; index <= 20; index++) roles.push({ roleId: 'extra-' + index, displayName: '角色 ' + index, status: 'ready', defaultWindowId: 'extra-w' + index });
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
    if (p === '/v1/roles') return json(res, { items: roles });
    if (p === `/v1/roles/${role.roleId}`) return json(res, { ...role, definition: { text: `${role.displayName}的介绍`, payload: {} }, definitionRevision: 1 });
    if (p.endsWith('/appearance/outfits')) return json(res, { items: [{ outfitId: 'o', roleId: role.roleId, name: '服饰', home: { assetId: 'portrait', outfitId: 'o', usage: 'home' }, sprites: [] }] });
    if (p.endsWith('/appearance/assets/portrait')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fs.readFileSync(path.join(root, 'desktop/desk-preview/renderer/src/assets/themes/xiacheng/character.png'))); }
    if (p.endsWith('/state')) return json(res, { state: { outfitId: 'o', mood: `${role.displayName}的近况` }, stateVersion: 1, updatedAt: now });
    if (p.endsWith('/memory/search')) {
      const type = body?.types?.[0];
      return json(res, { items: type === 'event' ? [{ type, id: 'event-1', title: `${role.displayName}的经历`, snippet: '一起散步' }] : [] });
    }
    if (p.endsWith('/memory/events/event-1')) return json(res, { title: `${role.displayName}的经历`, summary: '一起散步', subjectiveExperience: '很开心', experienceDate: '2026-11-09', sources: [{ evidenceId: 'e1' }] });
    if (p.endsWith('/memory/evidence/e1')) return json(res, { content: '保存的原始记录', occurredAt: now });
    if (p.endsWith('/diaries')) return json(res, { items: [...Array.from({ length: 9 }, (_, index) => ({ diaryId: `d${index + 1}`, experienceDate: `2026-11-${String(9 - index).padStart(2, '0')}` })), { diaryId: 'broken', experienceDate: '2026-10-01' }] });
    if ((mode === 'slow' || mode === 'switch') && p.includes('/roles/role-one') && p.endsWith('/diaries/d9')) {
      releaseSlow = () => json(res, { experienceDate: '2026-11-01', content: '# 第九篇日记' });
      return;
    }
    if (mode === 'batch' && p.includes('/roles/role-one') && p.endsWith('/diaries/d1')) {
      releaseSlow = () => json(res, { experienceDate: '2026-11-09', content: '# 第一篇日记' });
      return;
    }
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
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, NOWADAYS_BACKEND_URL: `http://127.0.0.1:${server.address().port}`, NOWADAYS_APP_ROOT: path.join(temp, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, path.join(root, 'desktop/desk-preview')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', chunk => logs += chunk); proc.stderr.on('data', chunk => logs += chunk);
  const port = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(logs)?.[1]);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.startsWith('desk://bundle/')));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id) { const job = waiting.get(message.id); waiting.delete(message.id); message.error ? job?.reject(message.error) : job?.resolve(message.result); } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text); };
  await cmd('Runtime.enable');
  await until(() => ev(`document.querySelector('.ui-page-dock') && document.querySelector('.studio-runtime')?.textContent.includes('${roles.length} 位角色')`));
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('关系')).click()");

  if (mode === 'slow') {
    // 第九篇日记挂起时：首页近况、经历和已读到的日记都应先出现。
    await until(() => releaseSlow && requests.some(request => request.path.endsWith('/memory/events/event-1')), 12000);
    await delay(900);
    const home = await ev("document.querySelector('.current-state').textContent.trim()");
    const preview = await ev("document.querySelector('.tab-experiences .tab-preview').textContent.trim()");
    await ev("document.querySelector('.tab-experiences').click()");
    const experience = await until(() => ev("document.querySelector('.moment-title')?.textContent ?? ''"), 6000);
    await delay(1100);
    await screenshot('slow-experience-before.png');
    await ev("document.querySelector('.back-button').click()");
    await until(() => ev("!!document.querySelector('.tab-diary')"), 6000);
    await ev("document.querySelector('.tab-diary').click()");
    await until(() => ev("document.querySelectorAll('.date-index button').length > 0"), 6000);
    const diariesBefore = await ev("document.querySelectorAll('.date-index button').length");
    const pendingHint = await ev("!![...document.querySelectorAll('.status-line')].find(x=>x.textContent.includes('还有日记正在读取'))");
    await delay(1100);
    await screenshot('slow-diary-before.png');
    releaseSlow();
    await until(() => ev("document.querySelectorAll('.date-index button').length===9"), 12000);
    const diariesAfter = await ev("document.querySelectorAll('.date-index button').length");
    assert.match(home, /甲角色的近况/, '第九篇日记挂起时首页应显示已保存的近况');
    assert.match(preview, /甲角色的经历/, '首页经历预览应先显示已返回的经历');
    assert.match(experience, /甲角色的经历/, '第九篇日记挂起时经历页应显示已返回的经历');
    assert.equal(diariesBefore, 8, '第一批日记应在第九篇之前可读');
    assert.equal(pendingHint, true, '已读到的日记旁应提示还有日记在读取');
    assert.equal(diariesAfter, 9, '第九篇返回后应补齐');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(JSON.stringify({ mode, home, preview, experience, diariesBefore, pendingHint, diariesAfter, errors }, null, 2));
    return;
  }

  if (mode === 'switch') {
    // 甲角色的第九篇日记挂起时换到乙角色：晚到的甲角色资料不能写进乙角色的页面。
    await until(() => releaseSlow && requests.some(request => request.path.endsWith('/roles/role-one/diaries')), 12000);
    await delay(600);
    await ev("document.querySelector('.plate-switch > button').click()");
    await until(() => ev("!!document.querySelector('.person-selector')"));
    await ev("[...document.querySelectorAll('.person-option')].find(x=>x.textContent.includes('乙角色')).click()");
    await until(() => ev("document.querySelector('.current-state')?.textContent.includes('乙角色的近况')"), 12000);
    await ev("document.querySelector('.tab-diary').click()");
    await until(() => ev("document.querySelectorAll('.date-index button').length===9"), 12000);
    const beforeRelease = await ev("({title:document.querySelector('.diary-paper h2').textContent.trim(),name:document.querySelector('[data-testid=rail-name]').textContent.trim(),diaries:document.querySelectorAll('.date-index button').length})");
    releaseSlow();
    await delay(1200);
    const afterRelease = await ev("({title:document.querySelector('.diary-paper h2').textContent.trim(),state:document.querySelector('.rail-identity p').textContent.trim(),diaries:document.querySelectorAll('.date-index button').length})");
    await screenshot('switch-role.png');
    assert.match(beforeRelease.title, /乙角色的日记/);
    assert.equal(beforeRelease.diaries, 9);
    assert.match(afterRelease.title, /乙角色的日记/, '甲角色晚到的日记不能覆盖乙角色');
    assert.match(afterRelease.state, /乙角色的近况/);
    assert.equal(afterRelease.diaries, 9);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(JSON.stringify({ mode, beforeRelease, afterRelease, errors }, null, 2));
    return;
  }

  if (mode === 'batch') {
    // 第一篇挂起时，同批和后续日记都应先可读；补入第一篇后仍停在用户选中的那篇。
    await until(() => releaseSlow && requests.some(request => request.path.endsWith('/roles/role-one/diaries')), 12000);
    await until(() => ev("!!document.querySelector('.tab-diary')"), 8000);
    await ev("document.querySelector('.tab-diary').click()");
    await until(() => ev("document.querySelectorAll('.date-index button').length===8"), 8000);
    await delay(700);
    const before = await ev("(()=>{const tabs=[...document.querySelectorAll('.date-index button')];return {count:tabs.length,dates:tabs.map(x=>x.textContent.trim()),pending:!![...document.querySelectorAll('.status-line')].find(x=>x.textContent.includes('还有日记正在读取'))}})()");
    const detailsBeforeRelease = requests.filter(x => /\/diaries\/d\d+$/.test(x.path)).map(x => x.path.split('/').at(-1)).sort();
    await ev("document.querySelectorAll('.date-index button')[2].click()");
    const picked = await ev("({date:document.querySelector('.date-index button[aria-selected=true]').textContent.trim(),paper:document.querySelector('.diary-paper .diary-meta').textContent.trim()})");
    await screenshot('batch-before.png');
    releaseSlow();
    await until(() => ev("document.querySelectorAll('.date-index button').length===9"), 12000);
    await delay(500);
    const after = await ev("({count:document.querySelectorAll('.date-index button').length,first:document.querySelector('.date-index button').textContent.trim(),date:document.querySelector('.date-index button[aria-selected=true]').textContent.trim(),paper:document.querySelector('.diary-paper .diary-meta').textContent.trim()})");
    await screenshot('batch-after.png');
    assert.equal(before.count, 8, '同批慢日记不应挡住已返回的日记');
    assert.equal(detailsBeforeRelease.includes('d9'), true, '并发窗口应在第一篇返回前继续读取后续日记');
    assert.equal(before.pending, true, '已读到的日记旁应提示还有日记在读取');
    assert.equal(after.count, 9, '第一篇返回后应补齐');
    assert.equal(after.first, '2026-11-09', '补入的第一篇应排在列表最前');
    assert.equal(after.date, picked.date, '补入靠前的日记后应保持当前选中的日记');
    assert.equal(after.paper, picked.paper);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(JSON.stringify({ mode, before, detailsBeforeRelease, picked, after, errors }, null, 2));
    return;
  }

  if (mode === 'inner') {
    // 经历页的换人入口在左栏中段：弹层应完整落在书页内，选项可点并真的完成换人。
    await until(() => ev("document.querySelector('.current-state')?.textContent.includes('甲角色的近况')"), 12000);
    await ev("document.querySelector('.tab-experiences').click()");
    await until(() => ev("!!document.querySelector('.plate-switch.in-rail > button')"), 8000);
    await delay(1000);
    await ev("document.querySelector('.plate-switch.in-rail > button').click()");
    await until(() => ev("document.querySelectorAll('.person-option').length===20"), 8000);
    await delay(500);
    const bounds = await ev("(()=>{const panel=document.querySelector('.person-selector'),p=panel.getBoundingClientRect(),b=document.querySelector('.collection').getBoundingClientRect(),list=document.querySelector('.person-options'),first=panel.querySelector('.person-option'),f=first.getBoundingClientRect(),firstHit=first.contains(document.elementFromPoint(f.x+f.width/2,f.y+f.height/2)),last=list.lastElementChild;const scrollable=list.scrollHeight>list.clientHeight+1;last.scrollIntoView({block:'nearest'});const l=last.getBoundingClientRect();return {count:panel.querySelectorAll('.person-option').length,panelTop:p.top,panelBottom:p.bottom,panelLeft:p.left,panelRight:p.right,bookTop:b.top,bookBottom:b.bottom,bookLeft:b.left,bookRight:b.right,firstHit,lastHit:last.contains(document.elementFromPoint(l.x+l.width/2,l.y+l.height/2)),scrollable,offsetParent:panel.offsetParent.className}})()");
    await ev("document.querySelector('.person-options').scrollTop = 0");
    await delay(300);
    await screenshot('inner-picker-fixed.png');
    const pickedHit = await ev("(()=>{const option=[...document.querySelectorAll('.person-option')].find(x=>x.textContent.includes('角色 12'));option.scrollIntoView({block:'center'});const r=option.getBoundingClientRect();return option.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()");
    await ev("[...document.querySelectorAll('.person-option')].find(x=>x.textContent.includes('角色 12')).click()");
    await until(() => ev("document.querySelector('.rail-identity p')?.textContent.includes('角色 12的近况')"), 12000);
    const switched = await ev("({name:document.querySelector('[data-testid=rail-name]').textContent.trim(),state:document.querySelector('.rail-identity p').textContent.trim(),selector:!!document.querySelector('.person-selector')})");
    assert.equal(bounds.count, 20);
    assert.ok(bounds.panelTop >= bounds.bookTop - 1, `面板超出书页顶边: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.panelBottom <= bounds.bookBottom + 1, `面板超出书页底边: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.panelLeft >= bounds.bookLeft - 1 && bounds.panelRight <= bounds.bookRight + 1, `面板横向超出书页: ${JSON.stringify(bounds)}`);
    assert.equal(bounds.firstHit, true, '首个角色选项应可点');
    assert.equal(bounds.lastHit, true, '末个角色选项应可点');
    assert.equal(bounds.scrollable, true, '20 位角色应可滚动');
    assert.equal(pickedHit, true, '选中的角色选项应可见可点');
    assert.equal(switched.name, '角色 12');
    assert.match(switched.state, /角色 12的近况/);
    assert.equal(switched.selector, false);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(JSON.stringify({ mode, bounds, pickedHit, switched, errors }, null, 2));
    return;
  }

  if (mode === 'many') {
    await until(() => ev("document.querySelector('.current-state')?.textContent.includes('甲角色的近况')"));
    await ev("document.querySelector('.plate-switch button').click()");
    await until(() => ev("document.querySelectorAll('.person-option').length===20"));
    await delay(400);
    const wide = await ev("(()=>{const p=document.querySelector('.person-selector').getBoundingClientRect(),b=document.querySelector('.collection').getBoundingClientRect();return {panelTop:p.top,panelBottom:p.bottom,bookTop:b.top,bookBottom:b.bottom}})()");
    assert.ok(wide.panelTop >= wide.bookTop - 1 && wide.panelBottom <= wide.bookBottom + 1, `1280×800 角色选择器被裁切: ${JSON.stringify(wide)}`);
    await screenshot('many-roles-wide.png');
    await ev("document.querySelector('.plate-switch > button').click()");
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
    await delay(400);
    await ev("document.querySelector('.plate-switch button').click()");
    await until(() => ev("document.querySelectorAll('.person-option').length===20"));
    const bounds = await ev("(()=>{const panel=document.querySelector('.person-selector').getBoundingClientRect(),book=document.querySelector('.collection').getBoundingClientRect(),list=document.querySelector('.person-options'),options=[...list.children],rects=options.map(o=>o.getBoundingClientRect());let overlap=false;for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(a.left<b.right-0.5&&b.left<a.right-0.5&&a.top<b.bottom-0.5&&b.top<a.bottom-0.5)overlap=true;}const last=list.lastElementChild;last.scrollIntoView({block:'nearest'});const r=last.getBoundingClientRect();return {options:options.length,panelTop:panel.top,panelBottom:panel.bottom,bookTop:book.top,bookBottom:book.bottom,minButtonWidth:Math.min(...rects.map(x=>x.width)),overlap,listClientHeight:list.clientHeight,listScrollHeight:list.scrollHeight,listScrollable:list.scrollHeight>list.clientHeight+1,overflowY:getComputedStyle(list).overflowY,horizontalOverflow:list.scrollWidth>list.clientWidth+1,lastClickable:last.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()");
    await ev("document.querySelector('.person-options').scrollTop = 0");
    await delay(600);
    await screenshot('many-roles.png');
    assert.ok(bounds.minButtonWidth >= 88, `角色按钮过窄: ${bounds.minButtonWidth}`);
    assert.equal(bounds.overlap, false, '角色选项互相重叠');
    assert.equal(bounds.listScrollable, true, '20 位角色应可滚动');
    assert.equal(bounds.overflowY, 'auto', '角色列表应可滚动');
    assert.equal(bounds.horizontalOverflow, false, '角色列表出现横向溢出');
    assert.ok(bounds.panelTop >= bounds.bookTop - 1 && bounds.panelBottom <= bounds.bookBottom + 1, `角色选择器被裁切: ${JSON.stringify(bounds)}`);
    assert.equal(bounds.lastClickable, true, '最后一位角色应可点击');
    // 窄屏同样要留在书页内，且角色列表可滚动。
    await ev("document.querySelector('.plate-switch > button').click()");
    await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await delay(500);
    await ev("document.querySelector('.plate-switch > button').click()");
    await until(() => ev("!!document.querySelector('.person-selector')"));
    await delay(400);
    const narrow = await ev("(()=>{const p=document.querySelector('.person-selector').getBoundingClientRect(),b=document.querySelector('.collection').getBoundingClientRect(),list=document.querySelector('.person-options'),r=[...list.children].map(o=>o.getBoundingClientRect());return {panelTop:p.top,panelBottom:p.bottom,panelLeft:p.left,panelRight:p.right,bookTop:b.top,bookBottom:b.bottom,bookLeft:b.left,bookRight:b.right,minButtonWidth:Math.min(...r.map(x=>x.width)),listScrollable:list.scrollHeight>list.clientHeight+1,horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1}})()");
    await screenshot('many-roles-mobile.png');
    assert.ok(narrow.panelTop >= narrow.bookTop - 1 && narrow.panelBottom <= narrow.bookBottom + 1, `窄屏角色选择器被裁切: ${JSON.stringify(narrow)}`);
    assert.ok(narrow.panelLeft >= narrow.bookLeft - 1 && narrow.panelRight <= narrow.bookRight + 1, `窄屏角色选择器横向超出: ${JSON.stringify(narrow)}`);
    assert.ok(narrow.minButtonWidth >= 88, `窄屏角色按钮过窄: ${narrow.minButtonWidth}`);
    assert.equal(narrow.listScrollable, true, '窄屏角色列表应可滚动');
    assert.equal(narrow.horizontalOverflow, false, '窄屏出现横向溢出');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(JSON.stringify({ mode, wide, bounds, narrow, errors }, null, 2));
    return;
  }

  if (mode === 'focus') {
    await until(() => ev("document.querySelector('.current-state')?.textContent.includes('甲角色的近况')"));
    await ev("(()=>{const trigger=document.querySelector('.plate-switch > button');trigger.focus();trigger.click();return true})()");
    await until(() => ev("!!document.querySelector('.person-option')"));
    const afterOpen = await ev("(()=>{const active=document.activeElement;return {option:active.matches('.person-option'),current:active.getAttribute('aria-pressed')==='true',label:active.textContent.trim(),trigger:active.matches('.plate-switch > button'),focusVisible:active.matches(':focus-visible'),outline:getComputedStyle(active).outlineStyle+' '+getComputedStyle(active).outlineColor+' '+getComputedStyle(active).outlineWidth}})()");
    await screenshot('focus-open.png');
    await ev("(()=>{const options=[...document.querySelectorAll('.person-option')];options[1].focus();options[1].dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()");
    await until(() => ev("!document.querySelector('.person-selector')"));
    const afterEscape = await ev("(()=>{const active=document.activeElement;return {body:active===document.body,trigger:active.matches('.plate-switch > button'),expanded:document.querySelector('.plate-switch > button').getAttribute('aria-expanded')}})()");
    await ev("document.querySelector('.plate-switch > button').click()");
    await until(() => ev("!!document.querySelector('.person-selector')"));
    await ev("(()=>{document.querySelectorAll('.person-option')[1].focus();document.querySelector('.selector-head button').click();return true})()");
    await until(() => ev("!document.querySelector('.person-selector')"));
    const afterClose = await ev("(()=>{const active=document.activeElement;return {trigger:active.matches('.plate-switch > button')}})()");
    assert.equal(afterOpen.current, true, '打开时应聚焦当前角色');
    assert.equal(afterOpen.label.includes('甲角色'), true, `打开时聚焦了错误的角色: ${afterOpen.label}`);
    assert.equal(afterEscape.trigger, true, 'Esc 关闭后焦点应回到「换一位」');
    assert.equal(afterEscape.expanded, 'false');
    assert.equal(afterClose.trigger, true, '× 关闭后焦点应回到「换一位」');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(JSON.stringify({ mode, afterOpen, afterEscape, afterClose, errors }, null, 2));
    return;
  }

  await until(() => ev("document.querySelector('.current-state')?.textContent.includes('甲角色的近况')"));
  await delay(1200);
  const width = await ev("document.querySelector('.collection').getBoundingClientRect().width");
  assert.ok(width > 1100, `书页意外收窄: ${width}`);
  await ev("document.querySelector('.plate-switch button').click()");
  const selector = await ev("(()=>{const p=document.querySelector('.person-selector').getBoundingClientRect(),b=document.querySelector('.collection').getBoundingClientRect();return {top:p.top,bottom:p.bottom,bookTop:b.top,bookBottom:b.bottom}})()");
  assert.ok(selector.top >= selector.bookTop && selector.bottom <= selector.bookBottom, `角色选择器被裁切: ${JSON.stringify(selector)}`);
  await ev("[...document.querySelectorAll('.person-option')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("document.querySelector('.current-state')?.textContent.includes('乙角色的近况')"));
  await ev("document.querySelector('.tab-experiences').click()");
  await until(() => ev("document.querySelector('.moment-title')?.textContent.includes('乙角色的经历')"));
  await ev("[...document.querySelectorAll('.inner-nav button')].find(x=>x.textContent.includes('日记')).click()");
  await until(() => ev("document.querySelectorAll('.date-index button').length===9 && document.querySelector('.status-line.error')?.textContent.includes('1 篇日记')"));
  await screenshot('base-day.png');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log(JSON.stringify({ mode, bookWidth: width, selector, errors }, null, 2));
}
run().catch(error => { console.error(error, logs.slice(-1500)); process.exitCode = 1; }).finally(async () => {
  try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 99999, method: 'Browser.close' })); ws.close(); } } catch {}
  await delay(600); if (proc && proc.exitCode === null) proc.kill(); server.close();
  try { if (path.dirname(path.resolve(temp)) === path.resolve(results) && path.basename(temp).startsWith('profile-')) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
});
