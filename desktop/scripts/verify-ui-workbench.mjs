// Optional browser/native QA. Uses an installed Playwright module; never starts the product Core.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, _electron } = process.env.UI_PLAYWRIGHT_MODULE ? require(process.env.UI_PLAYWRIGHT_MODULE) : require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'test-results/ui-workbench');
const art = path.join(root, 'devDoc/design/character-studio');
const url = process.env.UI_WORKBENCH_URL ?? 'http://127.0.0.1:50318/ui-workbench.html';
const report = { date: new Date().toISOString(), url, checks: [], layouts: [], errors: [], businessRequests: [], native: null };
await fs.mkdir(output, { recursive: true });
let browser, electron;
const check = async (name, action) => { await action(); report.checks.push(name); };
try {
  browser = await chromium.launch({ headless: true, ...(process.env.UI_CHROMIUM_PATH ? { executablePath: process.env.UI_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => { if (/^\/(accounts|instances|events|providers)(\/|$)/.test(new URL(request.url()).pathname)) report.businessRequests.push(request.url()); });
  await page.goto(url); await page.locator('h1').waitFor(); await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(art, 'workbench-desktop.png') });
  await page.screenshot({ path: path.join(art, 'workbench-full.png'), fullPage: true });
  await check('eight layout sizes, loaded art and no horizontal control overflow', async () => {
    for (const [width, height] of [[1440,960],[1280,800],[1024,720],[819,576],[768,900],[414,896],[375,812],[320,780]]) {
      await page.setViewportSize({ width, height });
      const result = await page.evaluate(() => ({
        rootWidth: document.documentElement.scrollWidth,
        controls: [...document.querySelectorAll('button,input,select,textarea')].filter(element => {
          const r = element.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
        }).map(element => element.outerHTML.slice(0,160)),
        brokenImages: [...document.images].filter(image => !image.complete || !image.naturalWidth).length
      }));
      report.layouts.push({ width, height, ...result });
      assert.ok(result.rootWidth <= width, `page overflow at ${width}`); assert.deepEqual(result.controls, [], `control overflow at ${width}`); assert.equal(result.brokenImages, 0);
      if (width === 375) await page.screenshot({ path: path.join(art, 'workbench-mobile.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  await check('field error association, body scale and 44px control alignment', async () => {
    const error = page.getByLabel('错误样例', { exact: true });
    assert.equal(await error.getAttribute('aria-invalid'), 'true');
    const descriptions = (await error.getAttribute('aria-describedby')).split(' ');
    for (const id of descriptions) assert.ok(await page.locator(`[id="${id}"]`).textContent());
    await error.focus();
    const appearance = await error.evaluate(element => { const css = getComputedStyle(element); return { height: element.getBoundingClientRect().height, size: css.fontSize, border: css.borderTopColor, focus: css.outlineWidth }; });
    assert.equal(appearance.height, 44); assert.equal(appearance.size, '14px'); assert.equal(appearance.focus, '2px'); assert.equal(appearance.border, 'rgb(163, 50, 71)');
    const input = page.getByLabel('显示名称', { exact: true }); await input.fill(''); await input.press('Tab');
    assert.equal(await input.getAttribute('aria-invalid'), 'true'); await input.fill('白昼来信'); assert.equal(await input.getAttribute('aria-invalid'), null);
  });
  await check('long account name remains selectable and does not stretch a small window', async () => {
    const name = '一个名字很长但仍然应该完整展示的样例账号';
    await page.getByLabel('完整样例账号列表').selectOption(name); await page.setViewportSize({width:320,height:780});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.locator('.ui-account-tabs [aria-pressed="true"]').textContent(), name);
    await page.getByLabel('完整样例账号列表').selectOption('白昼来信'); await page.setViewportSize({width:1440,height:960});
  });
  await check('keyboard switch blocks repeated busy activation and preserves focus', async () => {
    const control = page.getByRole('switch', { name: '自动回复样例' }); await control.focus(); await control.press('Space');
    assert.equal(await control.getAttribute('aria-busy'), 'true'); assert.equal(await control.evaluate(element => element === document.activeElement), true);
    await control.press('Space'); await page.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute('aria-busy') === null);
    assert.equal(await control.getAttribute('aria-checked'), 'false');
  });
  await check('password reveal, number bounds, radio and native file input stay usable', async () => {
    const key = page.getByLabel('密钥样例', {exact:true}); assert.equal(await key.getAttribute('type'),'password');
    await page.getByRole('button',{name:'显示样例密钥'}).click(); assert.equal(await key.getAttribute('type'),'text');
    await page.getByRole('button',{name:'隐藏样例密钥'}).click(); assert.equal(await key.getAttribute('type'),'password');
    const number = page.getByLabel('数值样例'); await number.fill('101'); assert.equal(await number.evaluate(element=>element.validity.rangeOverflow),true); await number.fill('20');
    await page.getByRole('radio',{name:'公用定义',exact:true}).check(); assert.equal(await page.getByRole('radio',{name:'当前账号',exact:true}).isChecked(),false);
    await page.getByLabel('文件选择样例').setInputFiles({name:'ui-sample.json',mimeType:'application/json',buffer:Buffer.from('{}')});
    assert.equal(await page.getByText('ui-sample.json',{exact:true}).isVisible(),true);
  });
  await check('busy button preserves focus, width and feedback; error hover stays readable', async () => {
    const area = page.locator('#behavior'); const save = area.locator('button.btn-primary');
    const width = (await save.boundingBox()).width; await save.focus(); await save.press('Enter');
    assert.equal(await save.evaluate(element => element === document.activeElement), true);
    assert.equal((await area.getByRole('button', { name: '保存中…', exact: true }).boundingBox()).width, width);
    await page.waitForFunction(() => [...document.querySelectorAll('#behavior button')].some(element => element.textContent === '样例已保存'));
    await page.getByLabel('下次保存模拟失败').check(); await area.getByRole('button', { name: '样例已保存' }).click();
    const retry = area.getByRole('button', { name: '重试保存样例' }); await retry.waitFor(); await retry.hover();
    const colors = await retry.evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    assert.equal(colors.foreground, 'rgb(163, 50, 71)'); assert.equal(colors.background, 'rgb(248, 231, 233)');
    await page.getByLabel('下次保存模拟失败').uncheck();
  });
  await check('themed portal, nested draft cancellation/discard, focus trap and restoration', async () => {
    const trigger = page.getByRole('button', { name: '检查弹窗与草稿' }); await trigger.click();
    const dialog = page.getByRole('dialog', { name: '给日常留一句话' }); const text = dialog.getByLabel('便签内容');
    assert.equal(await dialog.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 252, 247)');
    const backgroundScroll = await page.evaluate(() => scrollY); await page.mouse.wheel(0,500);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => scrollY), backgroundScroll);
    await text.fill('这是尚未保存的便签'); await text.press('Escape');
    const confirmation = page.getByRole('alertdialog'); await confirmation.waitFor();
    assert.equal(await confirmation.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 252, 247)');
    await page.waitForFunction(() => document.activeElement?.textContent === '继续编辑');
    assert.equal(await page.locator('#root').getAttribute('aria-hidden'), 'true');
    for (let i=0;i<5;i++) { await page.keyboard.press('Tab'); assert.equal(await confirmation.evaluate(element => element.contains(document.activeElement)), true); }
    await page.keyboard.press('Escape'); await confirmation.waitFor({ state: 'hidden' });
    assert.equal(await text.inputValue(), '这是尚未保存的便签'); assert.equal(await text.evaluate(element => element === document.activeElement), true);
    await text.press('Escape'); await page.getByRole('button', { name: '放弃修改并继续' }).click();
    await dialog.waitFor({ state: 'hidden' }); assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  });
  await check('disclosure supports keyboard, keeps draft inputs and hides folded content', async () => {
    const trigger = page.getByRole('button',{name:/文本能力 · 抽屉样例/}); await trigger.focus(); await trigger.press('Space');
    assert.equal(await trigger.getAttribute('aria-expanded'),'true');
    const input = page.getByLabel('抽屉内模型样例'); await input.fill('draft-model-name'); await trigger.click();
    assert.equal(await trigger.getAttribute('aria-expanded'),'false'); assert.equal(await input.isVisible(),false);
    await trigger.press('Enter'); assert.equal(await input.inputValue(),'draft-model-name'); await trigger.click();
  });
  await check('confirmation queue inherits caller theme and resets cancel focus for each request', async () => {
    const trigger = page.getByRole('button',{name:'检查确认队列'}); await trigger.click();
    const first = page.getByRole('alertdialog',{name:'队列第一项'}); await first.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === '取消');
    assert.equal(await first.evaluate(element => getComputedStyle(element).backgroundColor),'rgb(255, 252, 247)');
    await page.getByRole('button',{name:'确认第一项'}).click(); const second = page.getByRole('alertdialog',{name:'队列第二项'}); await second.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === '取消');
    assert.equal(await second.evaluate(element => getComputedStyle(element).backgroundColor),'rgb(255, 252, 247)');
    await page.keyboard.press('Escape'); await second.waitFor({state:'hidden'});
    assert.equal(await page.getByText('队列已结束：确认、取消。',{exact:true}).isVisible(),true);
    assert.equal(await trigger.evaluate(element=>element===document.activeElement),true);
  });
  await check('saving dialog rejects Escape without replaying a delayed close', async () => {
    await page.getByRole('button', { name: '检查弹窗与草稿' }).click();
    const dialog = page.getByRole('dialog', { name: '给日常留一句话' }); const save = dialog.getByRole('button', { name: '保存样例' }); await save.click();
    await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), true);
    await dialog.getByText('样例已保存，仅保留在本页。').waitFor(); assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole('button', { name: '关闭便签' }).click(); await dialog.waitFor({ state: 'hidden' });
  });
  await check('menu keyboard navigation, all nine actions, Escape and focus return', async () => {
    const trigger = page.getByRole('button', { name: '全部菜单', exact: true }); await trigger.focus(); await trigger.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '主页'); await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '资源库'); await page.keyboard.press('Escape');
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    for (const name of ['主页','总览','实例与监听','资料与角色','插件与 Skill','模型配置','事件诊断','应用设置','资源库']) {
      await trigger.click(); await page.getByRole('menuitem', { name, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `${name} · 入口样例` }); await dialog.waitFor(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    }
  });
  await check('menu stays inside viewport when anchored at bottom left', async () => {
    const menuRoot = page.locator('.ui-menu'); await menuRoot.evaluate(element => element.setAttribute('style','position:fixed;bottom:16px;left:16px;z-index:100'));
    const trigger = page.getByRole('button',{name:'全部菜单',exact:true}); await trigger.click();
    const bounds = await page.getByRole('menu').boundingBox(); assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x+bounds.width <= 1440 && bounds.y+bounds.height <= 960);
    await page.keyboard.press('Escape'); await menuRoot.evaluate(element => element.removeAttribute('style'));
  });
  await check('application and OS reduced motion both stop decorative animation', async () => {
    await page.getByLabel('减少动态效果', { exact: true }).check();
    assert.equal(await page.locator('.spinner').first().evaluate(element => getComputedStyle(element).animationName), 'none');
    await page.getByLabel('减少动态效果', { exact: true }).uncheck(); await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.spinner').first().evaluate(element => getComputedStyle(element).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
  await check('art failure keeps reserved geometry and primary controls usable', async () => {
    const before = (await page.locator('.wb-scene').boundingBox()).height; await page.getByLabel('查看插画失败回退').check();
    assert.equal((await page.locator('.wb-scene').boundingBox()).height, before);
    assert.equal(await page.getByText('主题插画暂时不可用').isVisible(), true);
    await page.getByRole('button', { name: '打开便签样例', exact: true }).click(); await page.keyboard.press('Escape');
    await page.getByLabel('查看插画失败回退').uncheck();
  });
  await check('async failure, empty, stale and ready remain distinct', async () => {
    for (const [name, text] of [['首次失败','读取失败：样例连接暂时不可用'],['确实为空','还没有角色绑定'],['旧数据过期','上次读取的数据'],['读取成功','读取成功']]) {
      await page.getByRole('button', { name, exact: true }).click(); assert.ok((await page.locator('.wb-async-example').textContent()).includes(text));
    }
  });
  await check('forced colors retains switch shape and visible keyboard focus', async () => {
    await page.emulateMedia({ forcedColors: 'active' }); const control = page.getByRole('switch'); await control.focus();
    assert.ok(await control.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth) >= 2));
    assert.equal(await control.locator('.ui-switch-track').evaluate(element => getComputedStyle(element).borderTopWidth), '1px');
    await page.emulateMedia({ forcedColors: 'none' });
  });
  if (process.argv.includes('--native')) {
    const nativeEnv = { ...process.env }; delete nativeEnv.ELECTRON_RUN_AS_NODE;
    electron = await _electron.launch({ executablePath: path.join(root,'node_modules/electron/dist/electron.exe'), args: [path.join(root,'desktop/scripts/ui-workbench-window.cjs'),`--ui-workbench-url=${url}`], env: nativeEnv });
    const window = await electron.firstWindow(); await window.locator('h1').waitFor();
    const properties = await electron.evaluate(({ BrowserWindow, screen }) => ({ version: process.versions.electron, scaleFactor: screen.getPrimaryDisplay().scaleFactor, windows: BrowserWindow.getAllWindows().length, preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences() }));
    assert.equal(properties.preferences.sandbox, true); assert.equal(properties.preferences.nodeIntegration, false); assert.equal(properties.preferences.contextIsolation, true);
    assert.equal(await window.evaluate(() => typeof window.nowadays), 'undefined');
    await window.getByRole('button',{name:'打开便签样例',exact:true}).click(); await window.getByRole('dialog').waitFor(); await window.keyboard.press('Escape'); await window.getByRole('dialog').waitFor({state:'hidden'});
    await window.screenshot({ path: path.join(art,'workbench-electron.png') });
    report.native = { ...properties, preferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }, note: 'Isolated native sample window; no product tray/Core integration or OS scale setting was changed.' };
    report.checks.push('native Electron window, sandbox, modal and no product bridge');
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.businessRequests, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack; throw error; }
finally {
  await electron?.close(); await browser?.close();
  await fs.writeFile(path.join(output,'review.json'), JSON.stringify(report,null,2)+'\n');
  await fs.writeFile(path.join(art,'workbench-review.json'), JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
}
