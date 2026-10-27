// Actual renderer in an isolated fixture host; never starts product Core or QQ.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, _electron } = require(process.env.UI_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.HOME_PREVIEW_URL || 'http://127.0.0.1:50330';
const url = `${origin}/?token=home-preview&preview=1#/home`;
const output = path.resolve('devDoc/design/character-studio/theme-transition');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.UI_CHROMIUM_PATH ? { executablePath: process.env.UI_CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
const page = await context.newPage();
const report = { date: new Date().toISOString(), checks: [], errors: [], samples: [] };
page.on('pageerror', error => report.errors.push(error.message));
const check = async (name, action) => { await action(); report.checks.push(name); };
const button = (target, preset) => target.getByRole('group', { name: '昼夜主题' }).getByRole('button', { name: preset === 'nightwave' ? '晚风电台' : '白昼来信', exact: true });
const settled = async target => target.waitForFunction(() => !document.documentElement.dataset.themeTransition && !document.querySelector('.ui-theme-weather'));
const select = async (target, preset) => { await button(target, preset).click(); await settled(target); };
// Pause actual pseudo-element animations for deterministic visual inspection.
const sample = async (target, preset) => {
  await target.evaluate(preset => {
    window.__themeSamples = [];
    buttonClick();
    function buttonClick() { [...document.querySelectorAll('.ui-theme-switcher button')].find(b => b.textContent.includes(preset === 'nightwave' ? '晚风电台' : '白昼来信')).click(); }
    function frame() {
      const animations = document.getAnimations().filter(a => a.effect?.pseudoElement?.startsWith('::view-transition-'));
      if (animations.length) {
        for (const animation of animations) { animation.pause(); animation.currentTime = 190; }
        window.__themeSamples = animations.map(a => ({ pseudo: a.effect.pseudoElement, frames: a.effect.getKeyframes(), duration: a.effect.getTiming().duration }));
      } else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }, preset);
  await target.waitForFunction(() => window.__themeSamples?.length > 0);
  report.samples.push({ preset, animations: await target.evaluate(() => window.__themeSamples) });
  if (native) {
    const png = await native.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await fs.writeFile(path.join(output, `${preset}-electron-midpoint.png`), Buffer.from(png, 'base64'));
  } else await target.screenshot({ path: path.join(output, `${preset}-midpoint.png`) });
  await target.evaluate(() => { for (const animation of document.getAnimations()) if (animation.playState === 'paused') animation.play(); });
  await settled(target);
};
let native;
try {
  await context.request.post(`${origin}/__fixture/reset`);
  await page.goto(url);
  await page.locator('.home-account h2').waitFor();
  await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode().catch(() => {}))); });
  await check('both weather directions render named snapshots and settle without leftover layers', async () => {
    await sample(page, 'nightwave'); await sample(page, 'daylight');
    assert.equal(report.samples[0].animations.length, 4);
    assert.equal(report.samples[1].animations.length, 2);
    assert.equal(report.samples[0].animations.find(a => a.pseudo.includes('(root)')).duration, 400);
    assert.ok(report.samples[0].animations.filter(a => !a.pseudo.includes('(root)')).every(a => a.duration === 550));
  });
  await check('rapid reverse selection is last-choice-wins and pointer input is not blocked', async () => {
    await button(page, 'nightwave').click();
    await page.waitForFunction(() => document.documentElement.dataset.themeTransition === 'nightwave');
    await button(page, 'daylight').click({ timeout: 500 });
    await settled(page);
    assert.equal(await button(page, 'daylight').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => { const buttons = document.querySelectorAll('.ui-theme-switcher button'); for (let i = 0; i < 30; i++) buttons[i % 2 === 0 ? 1 : 0].click(); });
    await settled(page);
    assert.equal(await button(page, 'daylight').getAttribute('aria-pressed'), 'true');
  });
  await check('profile draft, editor node, selection, scroll and focus survive switching', async () => {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '关系', exact: true }).click();
    const field = page.getByLabel('主页昵称（本地展示）');
    await field.fill('天气切换保留草稿');
    await field.evaluate(element => { window.__editor = element; element.focus(); element.setSelectionRange(2, 5); window.__scroll = document.querySelector('.studio-content').scrollTop; });
    await page.evaluate(() => [...document.querySelectorAll('.ui-theme-switcher button')].find(b => b.textContent.includes('晚风电台')).click());
    await settled(page);
    assert.deepEqual(await field.evaluate(element => ({ same: element === window.__editor, focused: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd, scroll: document.querySelector('.studio-content').scrollTop === window.__scroll })), { same: true, focused: true, start: 2, end: 5, scroll: true });
    assert.equal(await field.inputValue(), '天气切换保留草稿');
    assert.equal(new URL(page.url()).hash, '#/roles');
    await page.reload(); await page.locator('.studio-shell').waitFor();
  });
  await check('system reduced motion, explicit full override and preference changes mid-flight', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await select(page, 'daylight');
    assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.effect?.pseudoElement).length), 0);
    await page.evaluate(() => { document.documentElement.dataset.motion = 'full'; });
    await sample(page, 'nightwave');
    await button(page, 'daylight').click();
    await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
    await settled(page); assert.equal(await button(page, 'daylight').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => { delete document.documentElement.dataset.motion; });
    await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'active' });
    await select(page, 'nightwave');
    assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.effect?.pseudoElement).length), 0);
    await page.emulateMedia({ forcedColors: 'none' });
  });
  await check('unavailable transition API and denied storage still update the theme', async () => {
    await page.evaluate(() => { document.startViewTransition = undefined; Storage.prototype.setItem = () => { throw new Error('denied'); }; });
    await select(page, 'daylight'); assert.equal(await button(page, 'daylight').getAttribute('aria-pressed'), 'true');
    await page.reload(); await page.locator('.studio-shell').waitFor();
  });
  await check('appearance persists across reload, with no business writes', async () => {
    await select(page, 'daylight'); await select(page, 'nightwave'); await page.reload();
    await button(page, 'nightwave').waitFor(); assert.equal(await button(page, 'nightwave').getAttribute('aria-pressed'), 'true');
    const fixture = await (await context.request.get(`${origin}/__fixture/state`)).json();
    assert.deepEqual(fixture.requests.filter(request => request.method !== 'GET'), []);
  });
  await check('both themes settle without overflow at desktop and narrow widths', async () => {
    await page.goto(url); await page.locator('.home-account h2').waitFor();
    for (const [width, height] of [[1440, 900], [1024, 720], [375, 812]]) {
      await page.setViewportSize({ width, height });
      for (const preset of ['daylight', 'nightwave']) {
        await select(page, preset);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight));
      }
    }
  });
  if (process.argv.includes('--native')) {
    await check('Electron 39 renders both transitions in an isolated sandboxed window', async () => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      native = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: [path.resolve('desktop/scripts/ui-workbench-window.cjs'), `--ui-workbench-url=${url}`], env });
      const target = await native.firstWindow(); await target.locator('.home-account h2').waitFor();
      await sample(target, 'nightwave'); await sample(target, 'daylight');
      report.electron = await native.evaluate(() => process.versions.electron);
      await native.close(); native = undefined;
    });
  }
  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack; throw error; }
finally {
  await native?.close(); await context.close(); await browser.close();
  await fs.writeFile(path.join(output, 'review.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: report.status, checks: report.checks, failure: report.failure }, null, 2) + '\n');
}
