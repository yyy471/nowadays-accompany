'use strict';
/**
 * 包 3 · 冷启动选角页真实桌面核验（DL-147）：
 * 1. 冷启动先停在选角页，不直接进入工作区；
 * 2. 列表展示已建角色，主角色显示席位标识和当前人物介绍；
 * 3. 选定后进入共享工作区（主页），页面不残留「陪伴」概念。
 * 运行：node tests/e2e/pack3-entry.e2e.cjs（在 apps/desktop 下）
 * 夜间截图：$env:PAGE_LAYOUT_THEME="nightwave"; node tests/e2e/pack3-entry.e2e.cjs
 */
const { button, configControls, editor, element, setValue, sheet } = require('../helpers/config-page-controls.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { resolveElectronExecutableInfo } = require('../helpers/electron-executable.cjs');

const { repoRoot: root, desktopDir, backendDir, xiachengPortraitFixture, testResultsDir } = require('../helpers/paths.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-p3-entry-'));
const hostToken = require('node:crypto').randomBytes(32).toString('hex');
const hostHeaders = { 'X-Nowadays-Host-Token': hostToken };

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

const layoutTheme = process.env.PAGE_LAYOUT_THEME || 'daylight';
assert.ok(['daylight', 'nightwave'].includes(layoutTheme), 'PAGE_LAYOUT_THEME 应为 daylight 或 nightwave');
const layoutIssues = [];
async function checkLayout(page) {
  const out = path.join(testResultsDir, 'page-layout');
  fs.mkdirSync(out, { recursive: true });
  for (const [width, height] of [[720, 540], [920, 600], [1024, 640], [1280, 800], [1440, 840]]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    // 只等待可见元素上的有限动画，循环动画不能阻塞截图或常规验收。
    await ev(`(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const animations = document.getAnimations().filter(animation => {
        const target = animation.effect?.target;
        return target instanceof Element && target.getClientRects().length &&
          Number.isFinite(animation.effect.getComputedTiming().endTime);
      });
      await Promise.race([Promise.allSettled(animations.map(animation => animation.finished)),
        new Promise(resolve => setTimeout(resolve, 1500))]);
    })()`);
    const issues = await ev(`(() => {
      const issues = [];
      for (const el of document.querySelectorAll('main, .studio-content, .role-entry-stage, .role-entry-card, .ui-page-dock')) {
        if (!el.clientWidth || !el.getClientRects().length) continue;
        if (el.scrollWidth > el.clientWidth + 2) issues.push(el.className + ' overflows by ' + (el.scrollWidth-el.clientWidth));
      }
      for (const el of document.querySelectorAll('.role-entry-name em,.role-entry-figure,.role-entry-meta')) {
        const r = el.getBoundingClientRect(), card = el.closest('button').getBoundingClientRect();
        if (r.right > card.right+1 || r.left < card.left-1 || r.bottom > card.bottom+1) issues.push(el.className || el.tagName);
      }
      const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
      const theme = rect('.studio-header .ui-theme-switcher'), motion = rect('.studio-header .config-motion-toggle');
      if (theme && !motion?.width) issues.push('减少动效开关不可见');
      if (theme) {
        const heights = ['.studio-header', '.studio-footer', '.ui-page-dock'].map(selector => rect(selector)?.height);
        const expected = innerWidth <= 959 ? [44, 54, 48] : [58, 68, 60];
        if (heights.some((height, i) => height !== expected[i])) issues.push('壳层高度 ' + heights.join('/'));
      }
      if (theme && motion && motion.width && motion.left < theme.right && motion.right > theme.left && motion.top < theme.bottom && motion.bottom > theme.top) issues.push('主题与动效控件重叠');
      const brand = rect('.studio-header .ui-studio-brand');
      if (innerWidth === 720 && brand && theme && (brand.bottom <= theme.top || theme.bottom <= brand.top || brand.right > theme.left + 1)) {
        issues.push('窄窗品牌与主题切换未在同一行分开排列');
      }
      for (const selector of ['.ui-page-dock', '.config-sheet', '.config-sheet-actions', '.dialogue-history[data-open]']) {
        const r = rect(selector);
        if (r?.width && (r.left < -2 || r.top < -2 || r.bottom > innerHeight + 2 || r.right > innerWidth + 2)) issues.push(selector + ' outside window');
      }
      const enter = rect('.home-primary-actions button'), content = rect('.studio-content');
      if (enter && content && enter.bottom > content.bottom + 1) issues.push('主页按钮被裁切');
      const art = rect('.home-scene-art'), caption = rect('.home-scene-caption');
      if (art && caption && (art.height === 0 || caption.top < art.bottom - 1)) issues.push('主页图注侵入绘图区');
      const plate = rect('.portrait-mat');
      if (plate && content && innerWidth === 720 && innerHeight === 540) {
        const visible = Math.min(plate.bottom, content.bottom) - Math.max(plate.top, content.top);
        if (visible < plate.height / 2) issues.push('首屏露出的藏书票人像不足一半');
      }
      return issues;
    })()`);
    if (page === 'entry') assert.ok(await ev("document.querySelector('.role-entry-card').getBoundingClientRect().bottom <= document.querySelector('.role-entry-actions').getBoundingClientRect().top + 1"), '单个角色的完整卡片在页脚上方');
    layoutIssues.push(...issues.map(issue => page + ' ' + width + ' ' + issue));
    if ((width === 720 && height === 540) || (width === 1280 && height === 800) || (width === 1440 && height === 840)) {
      const screenshot = Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      const sizeDir = path.join(out, layoutTheme, width + 'x' + height);
      fs.mkdirSync(sizeDir, { recursive: true });
      fs.writeFileSync(path.join(sizeDir, page + '.png'), screenshot);
      if (width === 720 && layoutTheme === 'daylight') fs.writeFileSync(path.join(out, page + '.png'), screenshot);
    }
  }
}

async function run() {
  backend = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--app-root', path.join(temp, 'app'), '--port', '0'], {
    cwd: backendDir,
    env: { ...process.env, NOWADAYS_HOST_TOKEN: hostToken },
    windowsHide: true,
  });
  backend.stdout.on('data', data => backendLog += data);
  backend.stderr.on('data', data => backendLog += data);
  const port = await until(() => /"event":"listening","host":"[^"]+","port":(\d+)/.exec(backendLog)?.[1], 'backend-listen');
  base = `http://127.0.0.1:${port}`;

  // 冷启动：不设置 NOWADAYS_SKIP_ROLE_PICKER，验证入口页真实出现。
  const env = { ...process.env, NOWADAYS_BACKEND_URL: base, NOWADAYS_APP_ROOT: path.join(temp, 'desktop'), NOWADAYS_HOST_TOKEN: hostToken };
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
  assert.equal(builtin.badge, '常驻主角色 · 默认保留');
  assert.ok(builtin.bio.trim().length > 10, '入口页应显示首次播种的人物介绍');
  assert.ok(builtin.bio.includes('既能在日常对话里随时聊聊') && !builtin.bio.includes('陪伴'));
  if (layoutTheme === 'nightwave') {
    // 通过实际主题控件保存偏好，再冷启动选角页，覆盖入口本身的夜间样式。
    await ev("[...document.querySelectorAll('.role-entry-actions button')].find(b => b.textContent === '进入书房')?.click()");
    await until(() => ev("!!document.querySelector('.studio-shell[data-page=\"home\"]')"), 'theme-workspace-home');
    await until(() => ev("!!document.querySelector('.ui-theme-switcher [data-theme-choice=\"nightwave\"]')"), 'night-theme-control');
    await ev("document.querySelector('.ui-theme-switcher [data-theme-choice=\"nightwave\"]').click()");
    await until(() => ev("document.querySelector('.ui-theme-switcher [data-theme-choice=\"nightwave\"]')?.getAttribute('aria-pressed') === 'true'"), 'night-theme-selected');
    await until(() => ev("localStorage.getItem('nowadays.theme-preset.v1') === 'nightwave'"), 'night-theme-saved');
    await cmd('Page.reload');
    await until(() => ev("!!document.querySelector('.role-entry-card[data-builtin]')"), 'night-role-entry');
  }
  await checkLayout('entry');
  await until(() => ev("document.activeElement?.matches('.role-entry-card[data-autofocus]')"), '首卡获得自动焦点');
  await cmd('Input.dispatchKeyEvent', {type:'keyDown', key:'ArrowRight', code:'ArrowRight', windowsVirtualKeyCode:39});
  await cmd('Input.dispatchKeyEvent', {type:'keyUp', key:'ArrowRight', code:'ArrowRight', windowsVirtualKeyCode:39});
  assert.equal(await ev("document.activeElement?.matches('.role-entry-card:focus-visible:not([data-autofocus])')"), true, '首次按键恢复标准焦点环');

  // 3. 进入工作区，主页显示当前角色。
  await ev("[...document.querySelectorAll('.role-entry-actions button')].find(b => b.textContent === '进入书房')?.click()");
  await until(() => ev("!!document.querySelector('.studio-shell[data-page=\"home\"]')"), 'workspace-home');
  assert.equal(await ev("!!document.querySelector('.role-entry')"), false, '进入后不再显示选角页');
  assert.equal(await ev("document.body.innerText.includes('陪伴')"), false, '全站不应残留「陪伴」文案');

  const { click, tab, openSheet } = configControls(ev, until);
  await checkLayout('home');
  for (const [page, label, menu] of [['roles','关系'], ['conversation','对话'], ['feed','动态',true], ['extensions','扩展',true], ['settings','设置',true], ['role-config','角色配置',true]]) {
    if (menu) await click(element('.ui-page-dock .ui-menu-trigger'));
    await click(button(label, menu ? '.ui-menu-panel:not([inert])' : '.ui-page-dock'));
    await until(() => ev(`document.querySelector('.studio-shell').dataset.page === ${JSON.stringify(page)}`), page);
    await delay(350);
    if (page === 'feed') {
      await until(() => ev("document.querySelector('.feed-next-empty')?.textContent === '接下来 · 暂无安排'"), '无安排时显示单行提示');
      assert.equal(await ev("!!document.querySelector('.feed-bookmark .ui-disclosure-trigger, .feed-next-list')"), false);
    }
    if (page === 'settings') assert.equal(await ev("document.querySelector('.studio-footer-info')?.innerText.trim()"), cards.length + ' 位角色');
    await checkLayout(page);
    if (page === 'settings' || page === 'conversation') {
      const settings = page === 'settings';
      await click(element(settings ? '.config-index-new' : '.dialogue-history-button'));
      await until(() => ev(settings ? "!!document.querySelector('.config-sheet')" : "!!document.querySelector('.dialogue-history[data-open]')"));
      await delay(350);
      if (!settings) {
        await until(() => ev("!!document.querySelector('.dialogue-history-empty > svg')"), '无历史时直接显示时钟');
        assert.equal(await ev("!!document.querySelector('.dialogue-timeline, .dialogue-history-day, .dialogue-clear-filters, .dialogue-empty-reset, .dialogue-card-controls')"), false);
        assert.equal(await ev("document.querySelector('.dialogue-history-empty > svg').getBoundingClientRect().height"), 30);
      }
      await checkLayout(settings ? 'model-editor' : 'history');
      await click(element(settings ? '.config-sheet-x' : '.dialogue-history-close'));
      await until(() => ev(settings ? "!document.querySelector('.config-sheet')" : "!document.querySelector('.dialogue-history')"));
    }
  }
  assert.deepEqual(layoutIssues, [], '各页面的内容应适应窗口宽度');
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
  await checkLayout('outfit-editor');
  assert.deepEqual(layoutIssues, []);
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
  const roleId = (await (await fetch(`${base}/v1/roles`, { headers: hostHeaders })).json()).items.find(role => role.builtinKey === 'xiacheng').roleId;
  const outfits = async () => (await (await fetch(`${base}/v1/roles/${roleId}/appearance/outfits`, { headers: hostHeaders })).json()).items;
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
  assert.equal(await ev("document.querySelector('.role-entry-card[data-builtin] .role-entry-bio').textContent"), '暂未写下介绍');
  await click(button('进入书房', '.role-entry-actions'));

  // 关系页也读取用户保存的名字。
  await until(() => ev("[...document.querySelectorAll('.ui-dock-item')].some(x=>x.textContent.includes('关系'))"), 'dock-relations');
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('关系')).click()");
  await until(() => ev("!!document.querySelector('.exlibris') && !!document.querySelector('[data-testid=\"plate-name\"]')"), 'relations-loaded');
  const plateName = await ev("document.querySelector('[data-testid=\"plate-name\"]').textContent.trim()");
  assert.equal(plateName, '岚', '关系页应停在选角页选定的角色上');

  for (let i = 0; i < 12; i++) {
    const response = await fetch(base + '/v1/roles', { method: 'POST', headers: { ...hostHeaders, 'Content-Type':'application/json'},
      body: JSON.stringify({ displayName: 'ArchiveKeeperWithAnUnbrokenName' + i, definition: {text:'选角布局测试'} }) });
    assert.ok(response.ok, '创建长名称测试角色');
  }
  await cmd('Page.reload');
  await until(() => ev("document.querySelectorAll('.role-entry-card').length >= 13"), 'multi-row-entry');
  await checkLayout('entry-many');
  assert.deepEqual(layoutIssues, []);
  assert.ok(await ev(`(() => {
    const stage = document.querySelector('.role-entry-stage');
    stage.scrollTop = 0;
    const cards = document.querySelectorAll('.role-entry-card');
    const first = cards[0].getBoundingClientRect().top >= stage.getBoundingClientRect().top;
    stage.scrollTop = stage.scrollHeight;
    return first && cards[cards.length - 1].getBoundingClientRect().bottom <= stage.getBoundingClientRect().bottom + 1;
  })()`), '多行选角可滚动到首尾');

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
