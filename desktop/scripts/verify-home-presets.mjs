// Actual React UI against loopback-only memory fixtures; never starts product Core.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium, _electron } = require(process.env.UI_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'devDoc/design/character-studio/home-presets');
await fs.mkdir(output, { recursive:true });
const origin = process.env.HOME_PREVIEW_URL || 'http://127.0.0.1:50320';
const url = `${origin}/?token=home-preview&preview=1#/home`;
const report = { date:new Date().toISOString(), checks:[], layouts:[], errors:[], native:[] };
const browser = await chromium.launch({ headless:true, ...(process.env.UI_CHROMIUM_PATH ? { executablePath:process.env.UI_CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport:{ width:1440,height:960 }, locale:'zh-CN' });
const page = await context.newPage();
page.on('pageerror', error => report.errors.push(error.message));
const control = await browser.newContext();
const reset = async () => { await control.request.post(`${origin}/__fixture/reset`); };
const snapshot = async () => (await control.request.get(`${origin}/__fixture/state`)).json();
const ready = async target => {
  await target.getByRole('button',{name:'进入工作台',exact:true}).waitFor();
  await target.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image=>image.decode().catch(()=>{}))); });
  await target.locator('.home-primary-actions .btn').evaluate(async element => { await Promise.all(element.getAnimations().map(animation=>animation.finished.catch(()=>{}))); });
  await target.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
};
const select = async (target, name) => { await target.getByRole('group',{name:'昼夜主题'}).getByRole('button',{name,exact:true}).click(); await ready(target); };
const metrics = async target => target.evaluate(() => {
  const main=document.querySelector('.studio-content'), footer=document.querySelector('.studio-footer'), scene=document.querySelector('.home-scene');
  const box=main.getBoundingClientRect(), dock=footer.getBoundingClientRect();
  const controls=[...main.querySelectorAll('button')].map(element=>({label:element.textContent,box:element.getBoundingClientRect().toJSON()}));
  return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,mainHeight:main.clientHeight,mainScroll:main.scrollHeight,mainTop:box.top,mainBottom:box.bottom,footerTop:dock.top,sceneHeight:scene.getBoundingClientRect().height,brokenImages:[...document.images].filter(image=>!image.complete||!image.naturalWidth).length,controls};
});
const assertFit = m => { assert.ok(m.documentWidth<=m.width);assert.ok(m.documentHeight<=m.height);assert.ok(m.mainScroll<=m.mainHeight+1,JSON.stringify(m));assert.ok(m.mainBottom<=m.footerTop+1);assert.ok(m.sceneHeight>0);assert.equal(m.brokenImages,0);for(const c of m.controls){assert.ok(c.box.top>=m.mainTop-1&&c.box.bottom<=m.mainBottom+1,JSON.stringify(c));assert.ok(c.box.left>=0&&c.box.right<=m.width,JSON.stringify(c));} };
const check = async (name, action) => { await action(); report.checks.push(name); };
let electron;
try {
  await reset();await page.goto(url);await ready(page);await page.locator('.home-account h2').waitFor();
  await check('requested homepage sections and duplicate top menu are removed',async()=>{
    assert.equal(await page.locator('.home-context,.home-agent-panel,.home-bindings,.home-scene-caption,.studio-account-switcher').count(),0);
    assert.equal(await page.getByRole('button',{name:'全部菜单',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'安排角色',exact:true}).count(),0);
    assert.equal(await page.getByRole('switch').count(),0);
    assert.equal(await page.getByRole('button',{name:'查看全部账号'}).count(),0);
  });
  await check('day and night each fit eleven viewports without a scrolling homepage or hidden primary action',async()=>{
    for(const [name,preset] of [['白昼来信','daylight'],['晚风电台','nightwave']]){
      await select(page,name);
      for(const [width,height] of [[1440,960],[1440,900],[1280,800],[1266,803],[1024,720],[819,576],[768,900],[414,896],[375,812],[320,780],[375,600]]){
        await page.setViewportSize({width,height});const m=await metrics(page);assertFit(m);report.layouts.push({preset,...m});
        if([1440,1280,819,375].includes(width)&&height!==600)await page.screenshot({path:path.join(output,`${preset}-${width}.png`)});
        await page.mouse.wheel(0,900);assert.equal(await page.locator('.studio-content').evaluate(element=>element.scrollTop),0);
      }
    }await page.setViewportSize({width:1440,height:960});
  });
  await check('theme changes art, palette, copy and selected state while preserving QQ identity and issuing no writes',async()=>{
    const account=await page.locator('.home-account h2').textContent();
    for(const [name,preset] of [['白昼来信','daylight'],['晚风电台','nightwave']]){
      await select(page,name);assert.equal(await page.locator('.home-account h2').textContent(),account);
      assert.equal(await page.getByRole('button',{name,exact:true}).getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('.studio-shell').getAttribute('data-ui-preset'),preset);
      assert.ok((await page.locator('.home-scene-background').getAttribute('src')).includes(preset==='nightwave'?'scene-night':'scene-ink'));
    }
    const requests=(await snapshot()).requests;assert.equal(requests.filter(request=>request.method!=='GET').length,0);
    assert.equal(requests.filter(request=>/role-bindings|\/policy$/.test(request.path||request.url||'')).length,0);
  });
  await check('local appearance preference survives a reload',async()=>{
    await page.reload();await ready(page);assert.equal(await page.locator('.studio-shell').getAttribute('data-ui-preset'),'nightwave');
  });
  await check('each theme loads its own production character, and the night illustration is not dimmed twice',async()=>{
    for(const [name,night] of [['白昼来信',false],['晚风电台',true],['白昼来信',false],['晚风电台',true]]){
      await select(page,name);
      const art=page.locator('.home-scene-character');
      const source=await art.getAttribute('src');
      assert.ok(source.includes(night?'character-night':'character.png'),source);
      assert.ok(await art.evaluate(image=>image.complete&&image.naturalWidth>0));
      assert.equal(await art.evaluate(image=>getComputedStyle(image).filter),'none');
      assert.ok((await art.getAttribute('alt')).includes(night?'坐在木凳':'日间'));
    }
    await page.reload();await ready(page);
    assert.ok((await page.locator('.home-scene-character').getAttribute('src')).includes('character-night'));
  });
  await check('all nine destinations remain available from the bottom menu',async()=>{
    for(const [label,id] of [['总览','overview'],['实例与监听','instances'],['资料与角色','roles'],['插件与Skill','plugins'],['模型配置','model-config'],['事件诊断','diagnostics'],['资源库','artifacts'],['主页','home']]){
      await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/^更多/}).click();await page.getByRole('menuitem',{name:label,exact:true}).click();await page.waitForFunction(id=>location.hash===`#/${id}`,id);
    }
    await page.getByRole('button',{name:'应用设置',exact:true}).click();await page.getByRole('dialog').waitFor();
    assert.equal(await page.locator('.ui-modal-backdrop').getAttribute('data-ui-preset'),'nightwave');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  });
  await check('theme switching preserves a real profile draft and route, while navigation still requests confirmation',async()=>{
    await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'关系',exact:true}).click();const field=page.getByLabel('主页昵称（本地展示）');await field.waitFor();await field.fill('尚未保存的主题切换草稿');
    await page.getByRole('group',{name:'昼夜主题'}).getByRole('button',{name:'白昼来信',exact:true}).click();assert.equal(await page.locator('.studio-shell').getAttribute('data-ui-preset'),'daylight');
    assert.equal(await field.inputValue(),'尚未保存的主题切换草稿');assert.equal(new URL(page.url()).hash,'#/roles');
    await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'桌面',exact:true}).click();await page.getByRole('alertdialog').waitFor();
    assert.equal(await page.locator('.ui-modal-backdrop').getAttribute('data-ui-preset'),'daylight');await page.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await field.inputValue(),'尚未保存的主题切换草稿');
    await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'桌面',exact:true}).click();await page.getByRole('button',{name:'放弃修改并继续',exact:true}).click();await ready(page);
  });
  await check('long account names and signatures remain bounded without internal scrollbars',async()=>{
    const data=await snapshot();data.accounts[0].nickname='很长的账号昵称'.repeat(30);data.accounts[0].signature='很长的签名\n'.repeat(70);await control.request.post(`${origin}/__fixture/control`,{data:{accounts:data.accounts}});await page.reload();await ready(page);await page.locator('.home-account h2').waitFor();
    for(const [width,height] of [[1280,800],[375,812]]){await page.setViewportSize({width,height});assertFit(await metrics(page));}
    assert.equal(await page.locator('.home-account-signature').evaluate(element=>getComputedStyle(element).overflow),'hidden');await reset();await page.reload();await ready(page);await page.setViewportSize({width:1440,height:960});
  });
  await check('failed art has a usable primary action and reduced motion clears parallax',async()=>{
    await page.locator('.home-scene-character').dispatchEvent('error');await page.getByText('主题插画暂时不可用',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'进入工作台',exact:true}).isEnabled(),true);
    await select(page,'晚风电台');const scene=page.locator('.home-scene'),box=await scene.boundingBox();await page.mouse.move(box.x+box.width*.8,box.y+box.height*.4);await page.waitForFunction(()=>document.querySelector('.home-scene').style.getPropertyValue('--home-parallax-x')!=='0px');
    await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('.home-scene').style.getPropertyValue('--home-parallax-x')==='0px');
  });
  if(process.argv.includes('--native')){
    await reset();for(const scale of [null,1.25]){
      const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
      electron=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'desktop/scripts/ui-workbench-window.cjs'),...(scale?['--force-device-scale-factor=1.25']:[]),`--ui-workbench-url=${url}`],env});
      const native=await electron.firstWindow();await ready(native);await native.locator('.home-account h2').waitFor();
      for(const [name,preset] of [['白昼来信','daylight'],['晚风电台','nightwave']]){
        await select(native,name);assertFit(await metrics(native));
        await native.waitForFunction(color=>getComputedStyle(document.querySelector('.home-primary-actions .btn')).backgroundColor===color,preset==='nightwave'?'rgb(212, 170, 135)':'rgb(145, 78, 90)');
        await native.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const png=await electron.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
        await fs.writeFile(path.join(output,`${preset}-electron-${scale?'125':'host'}.png`),Buffer.from(png,'base64'));
      }
      report.native.push(await electron.evaluate(({screen})=>({version:process.versions.electron,scaleFactor:screen.getPrimaryDisplay().scaleFactor})));
      await electron.close();electron=undefined;report.checks.push(scale?'both presets at forced 125% process rendering; host OS unchanged':'both presets in isolated native Electron at actual host scale');
    }
  }
  assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;throw error;}
finally{await electron?.close();await control.close();await context.close();await browser.close();await fs.writeFile(path.join(output,'review.json'),JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify({status:report.status,checks:report.checks.length,layouts:report.layouts.length,failure:report.failure,native:report.native},null,2)+'\n');}
