'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const { backendDir, testResultsDir } = require('../helpers/paths.cjs');
const { withDesktop, until } = require('../helpers/live-desktop.cjs');

function extension(version, roleIds) {
  const slots = ['page', 'widget', 'overlay'];
  const ui = slots.map(slot => ({slot, file:'ui/' + slot + '.html'}));
  ui[0].coplay = [{action:'roll', label:'掷骰'}];
  const files = {'entry.mjs':`export default async (_, api) => {
    api.tools.register({name:'stamp', description:'盖章', inputSchema:{type:'object'},
      scope:'selected_roles', roleIds:${JSON.stringify(roleIds)}}, (_, ctx) => ctx.roleId);
    const read = async () => (await api.kv.get('count')) ?? 0;
    let rolls = 0;
    api.ui.onAction('roll', () => ({ data: ++rolls, summary:'骰点 ' + rolls }));
    api.ui.onAction('read', read);
    api.ui.onAction('increment', async () => {
      const count = await read() + 1;
      await api.kv.set('count', count);
      return count;
    });
    await api.notify({message:'展签已打开'});
  }`,
    'ui/label.js':"document.documentElement.dataset.label = 'ready'"};
  for (const {slot, file} of ui) {
    files[file] = `<!doctype html><meta charset=utf-8><style>
      body {background:var(--nd-semantic-color-surface);color:var(--nd-semantic-color-text);font-family:var(--nd-semantic-font-body)}
      button {background:var(--nd-semantic-color-surface);color:inherit;border:1px solid var(--nd-semantic-color-line-control);padding:.35em .7em}
    </style><script src="./label.js"></script><p>${slot} ${version}</p>
      <button>increment</button><button>read</button><button>unknown</button><output></output><script>
      const instance = Math.random().toString();
      let serial = 0, pending, trustedClick;
      const buttons = [...document.querySelectorAll('button')];
      for (const button of buttons) button.onclick = event => {
        trustedClick = event.isTrusted;
        pending = String(++serial);
        parent.postMessage({type:'ext:action', id:pending, action:button.textContent, payload:null}, '*');
      };
      let parentRead, request, directive;
      try { parentRead = parent.document.title; } catch (e) { parentRead = e.name; }
      document.addEventListener('securitypolicyviolation', e => { directive = e.effectiveDirective; report(); });
      fetch('/v1/roles').then(() => {request='allowed';report()}, e => {request=e.name;report()});
      let theme;
      function report() {
        if (!theme || !request || !directive) return;
        parent.postMessage({type:'test:report', text:document.querySelector('p').textContent, instance, parentRead, request, directive, hasBridge: !!window.nowadaysDesk,
          asset:document.documentElement.dataset.label, preset:theme.preset,
          color:getComputedStyle(document.body).getPropertyValue('--nd-semantic-color-text').trim()}, '*');
      }
      addEventListener('message', e => {
        if (e.source !== parent) return;
        if (e.data?.type === 'ext:coplay-result' && e.data.action === 'roll') {
          const output = document.querySelector('output');
          output.textContent = e.data.ok ? '骰点 ' + e.data.data : e.data.error;
          parent.postMessage({type:'test:coplay', display:output.textContent}, '*');
          return;
        }
        if (e.data?.type === 'host:action-result' && e.data.id === pending) {
          const output = document.querySelector('output');
          output.textContent = e.data.ok ? e.data.data : e.data.error;
          parent.postMessage({type:'test:result', result:e.data, display:output.textContent, trustedClick}, '*');
          pending = null;
          return;
        }
        if (e.data?.type !== 'host:theme') return;
        theme = e.data;
        for (const [name,value] of Object.entries(theme.tokens)) if (name.startsWith('--nd-semantic-')) document.body.style.setProperty(name,value);
        report();
      });
      parent.postMessage({type:'ext:ready'}, '*');
    </script>`;
  }
  ui.push({slot:'asset',file:'ui/label.js'});
  return {extId:'slot-demo', manifest:{version, entry:'entry.mjs', ui}, files};
}

async function run() {
  const backendRequire = createRequire(path.join(backendDir,'package.json'));
  const { tsImport } = backendRequire('tsx/esm/api');
  const fixtureSource = path.join(backendDir, 'tests/fixtures/conversation-fixture.ts');
  const { createFixtureWithModel, ScriptedChatModel } = await tsImport(pathToFileURL(fixtureSource).href, __filename);
  process.env.NOWADAYS_HOST_TOKEN = require("node:crypto").randomBytes(32).toString("hex");
  const f = createFixtureWithModel(new ScriptedChatModel([
    request => {
      assert.match(request.system, /共玩 1 次。最后一次掷骰：骰点 1/);
      return [{type:'tool_call', callId:'dice-share', name:'autonomy_share', arguments:{content:'我看见这次的骰点了。'}},
        {type:'completed', stopReason:'tool_calls'}];
    }, [{type:'text_delta', text:'已分享。'}, {type:'completed', stopReason:'stop'}]
  ]), {
    disablePresetAssistant: false, presetAssetsDir: path.join(backendDir, 'tests/fixtures')
  });
  try {
    const server = f.app.server;
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const host = f.app.services.extensions;
    // 只延迟升级快照的交付，确保点击发生在后台已换版、桌面仍显示旧文档的窗口。
    const subscribe = host.subscribeUi.bind(host);
    let holdSnapshot = true, deliverSnapshot, stream;
    server.prependListener('request', (req, res) => { if (req.url === '/v1/extension-events') stream = res; });
    host.subscribeUi = listener => subscribe((event, data) => {
      if (event === 'snapshot') {
        deliverSnapshot = () => listener(event, data);
        if (holdSnapshot) return;
      }
      listener(event, data);
    });
    await withDesktop(base, async ({cmd, ev, wait, ws}) => {
      await wait("!!document.querySelector('.ui-menu-trigger')",'桌面');
      assert.equal(await ev("window.nowadaysDesk?.hostHeaders?.['X-Nowadays-Host-Token']?.length"), 64);
      await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 840, deviceScaleFactor: 1, mobile: false });
      await wait('innerWidth === 1440', '扩展页面宽屏尺寸');
      await ev(`window.slotReports = []; window.actionResults = []; window.addEventListener('message', e => {
        const frame = [...document.querySelectorAll('iframe[data-extension-slot]')].find(f => f.contentWindow === e.source);
        if (!frame) return;
        if (e.data?.type === 'test:coplay' && frame.dataset.extensionSlot === 'page') window.diceDisplay = e.data.display;
        if (e.data?.type === 'test:report') window.slotReports.push(e.data);
        if (e.data?.type === 'test:result') window.actionResults.push({...e.data, slot:frame.dataset.extensionSlot});
      }); document.querySelector('.ui-menu-trigger').click()`);
      await ev("[...document.querySelectorAll('.ui-menu-item')].find(b=>b.textContent.trim()==='扩展').click()");
      const invitation = "document.querySelector('.extension-catalog .extension-invitation button')";
      await wait("document.querySelector('.extension-catalog [role=status]')?.textContent.includes('正在读取')", '等待初始快照');
      assert.equal(await ev('!!' + invitation), false);
      deliverSnapshot();
      await wait(invitation + "?.textContent==='去对话里提一个想法'", '收到成功空快照');
      assert.equal(await ev("document.querySelector('.extension-invitation h3')?.textContent"), '台面还空着');
      const originalStream = stream;
      originalStream.end();
      await wait("document.querySelector('.extension-catalog [role=status]')?.textContent.includes('正在重连')", '真实 SSE 断线');
      assert.equal(await ev('!!' + invitation), false);
      await until(() => stream !== originalStream, '扩展事件重连');
      holdSnapshot = false;
      deliverSnapshot();
      await wait('!!' + invitation, '重连空快照');
      await ev(invitation + '.click()');
      await wait("document.querySelector('.studio-shell').dataset.page==='conversation'", '邀请笺进入对话');
      await ev("document.querySelector('.ui-menu-trigger').click()");
      await ev("[...document.querySelectorAll('.ui-menu-item')].find(b=>b.textContent.trim()==='扩展').click()");
      await wait('!!' + invitation, '从对话回到空台');
      const resize = async (width, height) => {
        await cmd('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor:1, mobile:false});
        await wait('innerWidth===' + width + ' && innerHeight===' + height, '视口尺寸');
      };
      const switchView = label => ev(`[...document.querySelectorAll('.extension-view-switch button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
      const capture = async preset => {
        const dir = path.join(testResultsDir, 'frontend-refinement-stage1');
        fs.mkdirSync(dir, {recursive:true});
        for (const [width, height] of [[1280,800], [720,540]]) {
          await resize(width, height);
          await ev("document.querySelector('.extension-page h1').scrollIntoView({block:'start'})");
          await ev('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
          const shot = await cmd('Page.captureScreenshot', {format:'png', captureBeyondViewport:false});
          fs.writeFileSync(path.join(dir, `extensions-${width}x${height}-${preset}.png`), Buffer.from(shot.data, 'base64'));
        }
      };
      const verifyLayout = async (hasSlots) => {
        const layout = await ev(`(() => {
          const page = document.querySelector('.extension-page');
          const host = page.parentElement.getBoundingClientRect();
          const heading = page.querySelector('h1').getBoundingClientRect();
          const catalog = page.querySelector('.extension-catalog').getBoundingClientRect();
          const slots = page.querySelector('.extension-slots')?.getBoundingClientRect();
          return { heading: heading.left, headingRight: heading.right, catalog: catalog.left, catalogRight: catalog.right,
            hostCenter: (host.left + host.right) / 2, layoutCenter: (heading.left + heading.right) / 2,
            slots: slots?.left ?? null };
        })()`);
        assert.ok(Math.abs(layout.heading - layout.catalog) < 1, '扩展标题与目录卡片左侧应对齐');
        assert.ok(Math.abs(layout.hostCenter - layout.layoutCenter) < 1, '扩展内容应在页面中居中');
        if (hasSlots) assert.ok(layout.slots > layout.catalogRight, '宽屏微页和挂件应位于独立右栏');
        else {
          assert.equal(layout.slots, null, '无显示槽位时只保留目录栏');
          assert.ok(Math.abs(layout.headingRight - layout.catalogRight) < 1, '单栏标题与目录卡片占用同一宽度');
        }
      };
      await verifyLayout(false);
      const verify = async (version,preset) => {
        for (const slot of ['page','widget','overlay']) {
          const report = await wait(`window.slotReports.find(r=>r.text==='${slot} ${version}' && r.preset==='${preset}')`, slot+' '+version+' '+preset);
          assert.equal(report.parentRead,'SecurityError');
          assert.equal(report.hasBridge,false);
          assert.equal(report.asset,'ready');
          assert.equal(report.request,'TypeError');
          assert.equal(report.directive,'connect-src');
          const token = await ev(`getComputedStyle(document.querySelector('[data-extension-slot="${slot}"]')).getPropertyValue('--nd-semantic-color-text').trim()`);
          assert.ok(token);
          assert.equal(report.color,token);
        }
      };
      console.log('桌面已订阅，安装 v1');
      await host.upsert(extension('v1', [f.roleId, 'removed-role']));
      await verify('v1','daylight');
      await wait("document.querySelector('.extension-tool')?.textContent==='stamp → 主角色、阿澄、removed-role'", '名单显示角色名与缺失 ID');
      await verifyLayout(true);
      await capture('daylight-with-overlays');
      await wait("document.querySelector('.extension-slots').offsetWidth>0 && !document.querySelector('.extension-catalog').offsetWidth", '窄屏默认台面');
      await ev("window.beforeSwitch = document.querySelector('[data-extension-slot=page]').contentWindow");
      await switchView('已安装');
      deliverSnapshot();
      await wait("document.querySelector('.extension-catalog').offsetWidth>0", '快照保留已安装视图');
      await switchView('台面');
      assert.ok(await ev("beforeSwitch === document.querySelector('[data-extension-slot=page]').contentWindow"));
      await resize(1440,840);
      async function clickAction(slot, version, action, expected) {
        const index = await ev('actionResults.length');
        const url = `nd-ext://slot-demo/ui/${slot}.html?v=${version}`;
        const target = (await cmd('Target.getTargets')).targetInfos.find(t=>t.type==='iframe' && t.url===url);
        assert.ok(target, url);
        const {sessionId} = await cmd('Target.attachToTarget', {targetId:target.targetId,flatten:true});
        try {
          // 对实际跨进程子帧发送键盘输入，Chromium 激活已聚焦的按钮。
          const focused = await cmd('Runtime.evaluate', {expression:`(() => {
            const button = [...document.querySelectorAll('button')].find(b=>b.textContent==='${action}');
            button.focus(); return document.activeElement === button;
          })()`, returnByValue:true, userGesture:true}, sessionId);
          assert.equal(focused.result.value, true);
          for (const type of ['keyDown', 'keyUp']) await cmd('Input.dispatchKeyEvent', {
            type, key:'Enter', code:'Enter', windowsVirtualKeyCode:13, text:type==='keyDown' ? '\r' : ''
          }, sessionId);
        } finally { await cmd('Target.detachFromTarget', {sessionId}); }
        const reply = await wait(`actionResults[${index}]`, slot+' '+action);
        assert.equal(reply.slot, slot);
        assert.equal(reply.trustedClick, true);
        assert.match(reply.result.id, /^\d+$/);
        assert.deepEqual(reply.result, {type:'host:action-result', id:reply.result.id, ...expected});
        assert.equal(reply.display, String(expected.data ?? expected.error));
      }
      const select = ".extension-coplay-bar select";
      const play = ".extension-coplay-bar button";
      const seat = f.app.services.roles.listRoles().find(role => role.isBuiltin && role.status === 'ready');
      assert.equal(await ev(`document.querySelector('${select}').value`), seat.roleId);
      await ev(`document.querySelector('${play}').click(); document.querySelector('${select}').focus()`);
      const firstRole = await ev(`document.querySelector('${select}').options[0].value`);
      async function key(key, code) {
        for (const type of ['keyDown','keyUp']) await cmd('Input.dispatchKeyEvent', {type, key, code:key,
          windowsVirtualKeyCode:code, ...(key === 'Enter' && type === 'keyDown' ? {text:'\r'} : {})});
      }
      if (firstRole === f.roleId) await key('Home',36); else await key('End',35);
      await wait(`document.querySelector('${play}').textContent === '掷骰 · 让阿澄回应'`, '真实键盘切换陪玩角色');
      await ev(`document.querySelector('${play}').focus()`);
      await key('Enter',13);
      await wait("window.diceDisplay === '骰点 1'", '当前微页显示宿主动作结果');
      await wait("document.querySelector('.share-slip p')?.textContent === '我看见这次的骰点了。'", '普通角色共玩分享纸签');
      assert.equal(await ev("document.querySelector('.share-slip strong').textContent"), '阿澄');
      const coplay = id => f.app.services.autonomy.listWakes(id).filter(w => w.wakeId.startsWith('coplay/'));
      assert.equal(coplay(seat.roleId).length, 0);
      assert.equal(coplay(f.roleId).length, 1);
      assert.match(coplay(f.roleId)[0].intent, /共玩 1 次。最后一次掷骰：骰点 1/);
      assert.equal(f.app.services.messages.list(f.roleId, f.windowId, null, 10).items.at(-1).content, '我看见这次的骰点了。');
      await ev("document.querySelector('.share-slip aside > button:last-child').click()");
      const back = "[...document.querySelectorAll('.dialogue-role-button')].find(b=>b.textContent==='回到刚才的台面')";
      await wait('!!(' + back + ')','对话页台面书签');
      await ev(back + '.click()');
      await wait("document.activeElement?.dataset.deskFile==='ui/page.html'", '回访之前的微页');
      console.log('默认主角色、合成点击零派发、真实点名普通角色、画面同步、单次共玩唤醒与默认窗口分享纸签通过');
      await clickAction('page','v1','increment',{ok:true,data:1});
      await host.toggle('slot-demo','reload');
      await ev(`window.oldWidget = slotReports.find(r=>r.text==='widget v1').instance;
        window.slotReports = slotReports.filter(r => r.text !== 'widget v1');
        const widget = document.querySelector('[data-extension-slot="widget"]');
        widget.src = widget.src`);
      await verify('v1','daylight');
      await wait("slotReports.some(r=>r.text==='widget v1' && r.instance!==oldWidget)", "挂件已重新载入新文档");
      await clickAction('widget','v1','read',{ok:true,data:1});
      await clickAction('page','v1','unknown',{ok:false,error:'EXTENSION_UI_ACTION_NOT_FOUND'});
      assert.equal(await ev("fetch('/v1/extensions/slot-demo/ui/page.html').then(r=>r.status)"),404);
      await wait("document.querySelector('.extension-overlays p')?.textContent==='展签已打开'",'实时通知');
      const light = await ev('slotReports[0].color');
      await ev("document.querySelector('[data-theme-choice=nightwave]').click()");
      await verify('v1','nightwave');
      assert.notEqual(light,await ev("slotReports.find(r=>r.preset==='nightwave').color"));
      await capture('nightwave-with-overlays');
      await resize(1440,840);
      holdSnapshot = true;
      await host.upsert(extension('v2', []));
      await clickAction('page','v1','increment',{ok:false,error:'EXTENSION_VERSION_MISMATCH'});
      holdSnapshot = false;
      deliverSnapshot();
      await verify('v2','nightwave');
      await wait("document.querySelector('.extension-tool')?.textContent==='stamp → 仅主角色'", '新版空名单已刷新');
      await clickAction('widget','v2','increment',{ok:true,data:2});
      const oldUrl = await ev("document.querySelector('[data-extension-slot=page]').src");
      const toggle = () => ev("document.querySelector('.extension-page [role=switch]').click()");
      const removed = () => wait("!document.querySelector('iframe[data-extension-slot], .extension-overlays')",'三类槽位和提示撤销');
      await toggle(); await removed();
      assert.equal(host.get('slot-demo').status,'disabled');
      await verifyLayout(false);
      // 通过新 iframe 重新读取原协议地址，观察 Chromium 收到的实际响应。
      async function unavailable() {
        await cmd('Network.enable');
        const responseStatus = new Promise(resolve => {
          const onMessage = ({data}) => {
            const msg = JSON.parse(data);
            if (msg.method === 'Network.responseReceived' && msg.params.response.url === oldUrl) {
              ws.removeEventListener('message',onMessage);
              resolve(msg.params.response.status);
            }
          };
          ws.addEventListener('message',onMessage);
        });
        await ev(`{const probe=document.createElement('iframe'); probe.sandbox='allow-scripts';probe.id='slot-probe';probe.src=${JSON.stringify(oldUrl)};document.body.append(probe)}`);
        assert.equal(await Promise.race([responseStatus,delay(5000,0,{ref:false})]),404);
        await ev("document.querySelector('#slot-probe').remove(); window.slotReports=[]");
      }
      await unavailable();
      await toggle(); await verify('v2','nightwave');
      await ev("document.querySelector('.ui-dock-item').click()");
      await wait("document.querySelector('.studio-shell').dataset.page==='home' && !!document.querySelector('[data-extension-slot=overlay]')",'浮层跨页保留');
      await ev("document.querySelector('.ui-menu-trigger').click()");
      await ev("[...document.querySelectorAll('.ui-menu-item')].find(b=>b.textContent.trim()==='扩展').click()");
      await wait("document.querySelectorAll('iframe[data-extension-slot]').length===3",'卸载前的全部槽位');
      await host.delete('slot-demo');
      await removed();
      await unavailable();
      assert.equal((await fetch(base+'/v1/extensions/slot-demo/ui/page.html?v=v2')).status,401);
      console.log('Electron 39 三槽安装、计数回显、KV 重载、未知动作、旧页拒绝、新版计数、主题、CSP、停用及删除通过');

      const messages = () => f.app.services.messages.list(seat.roleId, seat.defaultWindowId, null, 30).items
        .filter(message => message.sender === 'user');
      f.app.services.activity.requestStop(seat.roleId);
      await assert.rejects(host.upsert({
        extId: 'broken-label', manifest: { version: 'v3', entry: 'entry.mjs' },
        files: { 'entry.mjs': "export default () => { throw new Error('展签初始化失败') }" }
      }), { code: 'EXTENSION_LOAD_FAILED' });
      await host.upsert(extension('v4', []));
      await resize(720,540);
      await switchView('已安装');
      const button = "document.querySelector('.extension-repair button')";
      const notice = "document.querySelector('.extension-repair [role=status]')?.textContent";
      await wait(button + "?.textContent === '交给主角色修复'", '故障行出现修复入口');
      await ev(button + '.click()');
      const repairError = "document.querySelector('.extension-repair [role=alert]')?.textContent";
      assert.ok(await ev("!!document.querySelector('.extension-error[role=status]')"));
      await wait(repairError + " === '请先恢复主角色活动'", '停机时留页提示');
      assert.equal(messages().length, 0);
      f.app.services.activity.resume(seat.roleId);

      // 真实 POST 已入库，仅丢弃首次成功回执，检验手动重试不会多投一条。
      await ev(`const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (args[0] === ${JSON.stringify(`/v1/roles/${seat.roleId}/windows/${seat.defaultWindowId}/messages`)} && response.status === 201) {
            window.fetch = originalFetch;
            throw new TypeError('回执丢失');
          }
          return response;
        }`);
      await ev(button + '.click()');
      await wait(repairError + " === '暂未确认送达，请重试'", '已入库但桌面未收到回执');
      const [first] = messages();
      assert.ok(first.submissionId);
      await ev(button + '.click()');
      await wait(notice + " === '已交给主角色排查'", '重试送达后显示行内提示');
      assert.equal(await ev("document.querySelector('.studio-shell').dataset.page"), 'extensions');
      assert.equal(await ev(button + '.disabled'), true);
      await switchView('台面'); await switchView('已安装');
      assert.equal(await ev(button + '.textContent'), '已交给主角色排查');
      assert.equal(await ev(button + '.disabled'), true);
      const delivered = messages();
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].messageId, first.messageId);
      assert.match(first.content, /extId：broken-label\nversion：v3\nstatus：failed\n最近错误（扩展原始诊断文本）：EXTENSION_LOAD_FAILED · .*展签初始化失败/);
      console.log('主角色停机提示、丢失回执后重试、默认窗口唯一消息与送达留页通过');
      await switchView('台面');
      await ev("document.querySelectorAll('.extension-overlays header button').forEach(b=>b.click())");
      await wait("!document.querySelector('.extension-overlays')", '收起浮层查看完整台面');
      await capture('nightwave');
      await ev("document.querySelector('[data-theme-choice=daylight]').click()");
      await wait("slotReports.some(r=>r.text==='page v4' && r.preset==='daylight') && !document.querySelector('.config-theme-veil')", '白昼台面');
      await capture('daylight');
    });
  } finally { await f.close(); }
}
run().catch(error => {console.error(error); process.exitCode=1;});
