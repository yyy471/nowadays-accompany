const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const runtime='C:/Users/24349/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const {chromium}=require(path.join(runtime,'playwright'));
const sharp=require(path.join(runtime,'sharp'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--allow-file-access-from-files']});
 const page=await browser.newPage({viewport:{width:1440,height:960},deviceScaleFactor:1});
 const issues=[];page.on('pageerror',e=>issues.push(e.message));
 await page.goto(pathToFileURL(path.join(__dirname,'index.html')).href);
 await page.waitForFunction(()=>typeof state!=='undefined');
 await page.evaluate(()=>document.fonts.ready);
 const routes=['home','overview','connect','roles','extensions','models','diagnostics','library','settings'];
 const check=async()=>page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,mainWidth:document.querySelector('main').getBoundingClientRect().width,missingImages:[...document.images].filter(i=>!i.complete||i.naturalWidth===0).map(i=>i.src),clippedButtons:[...document.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right>innerWidth+1}).map(b=>b.textContent.trim())}));
 const layouts=[];
 for(const route of routes){await page.evaluate(r=>{state.dirty=false;state.page=r;render();},route);await page.waitForTimeout(300);layouts.push({route,width:1440,...await check()});await page.screenshot({path:path.join(__dirname,`preview-${route}.png`),fullPage:true});}
 for(const width of [1280,768,414,375,320]){await page.setViewportSize({width,height:width===1280?800:900});for(const route of routes){await page.evaluate(r=>{state.dirty=false;state.page=r;render();},route);await page.waitForTimeout(40);layouts.push({route,width,...await check()});}if(width===1280||width===375){await page.evaluate(()=>{state.page='home';render();});await page.waitForTimeout(260);await page.screenshot({path:path.join(__dirname,`preview-home-${width}.png`),fullPage:true});}}
 await page.setViewportSize({width:1440,height:960});
 await page.evaluate(()=>{state.page='roles';state.dirty=false;render();});
 await page.locator('#target-search').fill('小岛');const search=await page.locator('#target-rows tr').count()===1;await page.locator('#target-search').fill('');
 await page.locator('#role-select').selectOption('鹿眠');await page.locator('[data-page="models"]').click();const draftGuard=await page.locator('#modal').evaluate(d=>d.open);await page.locator('[data-action="stay"]').click();
 await page.locator('[data-action="save"]').click();const roleSaved=await page.evaluate(()=>targets[0].role==='鹿眠');
 await page.locator('[data-page="models"]').click();await page.locator('[data-test="0"]').first().click();const testLoading=await page.locator('[data-test="0"]').first().isDisabled();await page.waitForTimeout(1000);const testFeedback=(await page.locator('#test-result').innerText()).includes('示例回复');
 await page.locator('[data-page="diagnostics"]').click();await page.locator('[data-action="event-detail"]').first().click();const details=await page.locator('.details').first().isVisible();
 await page.locator('[data-diag="需要留意"]').click();const filter=await page.locator('.event:visible').count()===1;
 await page.locator('[data-page="home"]').click();const before=await page.evaluate(()=>current().paused);await page.locator('[data-action="pause"]').click();const pause=await page.evaluate(b=>current().paused!==b&&current().connected,before);
 await page.locator('[data-action="accounts"]').click();await page.locator('[data-account="1"]').click();const accountSwitch=await page.locator('#switch-name').innerText()==='晚风电台';
 const checks={search,draftGuard,roleSaved,testLoading,testFeedback,details,filter,pause,accountSwitch};
 const boardRoutes=['home','roles','models','library'];
 const tiles=await Promise.all(boardRoutes.map(r=>sharp(path.join(__dirname,`preview-${r}.png`)).resize(960,640,{fit:'cover',position:'top'}).png().toBuffer()));
 const labels=['01  主页 / 账号与日常','02  资料与角色 / 安排每段关系','03  模型配置 / 能力与测试','04  资源库 / 收藏喜欢的设定'];
 const xmlEscape=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
 const title=Buffer.from(`<svg width="2064" height="1632" xmlns="http://www.w3.org/2000/svg"><rect width="2064" height="1632" fill="#e9ede7"/><text x="48" y="68" font-family="Microsoft YaHei" font-size="32" fill="#252e2c">nowadays · 晴日通信</text><text x="48" y="101" font-family="Microsoft YaHei" font-size="15" fill="#68716a">桌面前端视觉与交互设计提案  /  2026.10.27  /  页面内为示例数据</text>${labels.map((t,i)=>`<text x="${48+(i%2)*1008}" y="${153+Math.floor(i/2)*732}" font-family="Microsoft YaHei" font-size="17" fill="#252e2c">${xmlEscape(t)}</text>`).join('')}</svg>`);
 await sharp(title).composite(tiles.map((input,i)=>({input,left:48+(i%2)*1008,top:176+Math.floor(i/2)*732}))).jpeg({quality:94}).toFile(path.join(__dirname,'design-board.jpg'));
 const report={date:'2026-10-27',runtime:'Chrome headless',layouts,interactions:checks,pageErrors:issues,limitations:'Fixture prototype only; no project source read, no QQ/model/network integration tested.'};
 fs.writeFileSync(path.join(__dirname,'review.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({screenshots:routes.length,layoutCases:layouts.length,layoutIssues:layouts.filter(r=>r.overflow||r.clippedButtons.length||r.missingImages.length),checks,pageErrors:issues},null,2));await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
