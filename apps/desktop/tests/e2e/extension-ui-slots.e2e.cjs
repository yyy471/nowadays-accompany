'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { backendDir, desktopDir, repoRoot } = require('../helpers/paths.cjs');
const { resolveElectronExecutable } = require('../helpers/electron-executable.cjs');

async function until(read, label) {
  const deadline = Date.now() + 15000;
  do {
    const value = await read();
    if (value) return value;
    await delay(60);
  } while (Date.now() < deadline);
  throw Error('等待超时 ' + label);
}

function extension(version, base) {
  const slots = ['page', 'widget', 'overlay'];
  const ui = slots.map(slot => ({slot, file:'ui/' + slot + '.html'}));
  const files = {'entry.mjs':"export default async (_,api)=>{await api.notify({message:'展签已打开'})}",
    'ui/label.js':"document.documentElement.dataset.label = 'ready'"};
  for (const {slot, file} of ui) {
    files[file] = `<!doctype html><meta charset=utf-8><script src="./label.js"></script><p>${slot} ${version}</p><script>
      let parentRead, request, directive;
      try { parentRead = parent.document.title; } catch (e) { parentRead = e.name; }
      document.addEventListener('securitypolicyviolation', e => { directive = e.effectiveDirective; report(); });
      fetch(${JSON.stringify(base + '/v1/roles')}).then(() => {request='allowed';report()}, e => {request=e.name;report()});
      let theme;
      function report() {
        if (!theme || !request || !directive) return;
        parent.postMessage({type:'test:report', text:document.querySelector('p').textContent, parentRead, request, directive,
          asset:document.documentElement.dataset.label, preset:theme.preset,
          color:getComputedStyle(document.body).getPropertyValue('--nd-semantic-color-text').trim()}, '*');
      }
      addEventListener('message', e => {
        if (e.source !== parent || e.data?.type !== 'host:theme') return;
        theme = e.data;
        for (const [name,value] of Object.entries(theme.tokens)) document.body.style.setProperty(name,value);
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
  const f = createFixtureWithModel(new ScriptedChatModel([]));
  const profile = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'nd-slot-profile-'));
  let child, ws, exited, logs = '';
  try {
    const server = f.app.server;
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const host = f.app.services.extensions;
    const env = {...process.env, NOWADAYS_BACKEND_URL:base, NOWADAYS_SKIP_ROLE_PICKER:'1'};
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(resolveElectronExecutable({repoRoot}), ['--no-sandbox','--remote-debugging-port=0','--user-data-dir='+profile.path,desktopDir],
      {env, stdio:['ignore','pipe','pipe'], windowsHide:true});
    exited = once(child,'exit');
    child.once('exit', (code, signal) => { if (code) console.error('Electron exit',code,signal,logs.slice(-2000)); });
    child.stderr.on('data', data => { logs += data; });
    child.stdout.on('data', data => { logs += data; });
    const port = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(logs)?.[1], 'Electron DevTools');
    const devtools = 'http://127.0.0.1:' + port;
    const browser = await (await fetch(devtools + '/json/version')).json();
    assert.match(browser['User-Agent'], /Electron\/39\./);
    const target = await until(async () => (await (await fetch(devtools+'/json/list')).json()).find(t => t.url.startsWith('desk://bundle/')), '生产窗口');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await Promise.race([once(ws,'open'), delay(5000,undefined,{ref:false}).then(() => {throw Error('CDP_OPEN_TIMEOUT')})]);
    let serial = 0;
    const pending = new Map();
    ws.addEventListener('close', () => {
      for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Error('Electron 调试连接已关闭')); }
      pending.clear();
    });
    ws.onmessage = ({data}) => {
      const msg = JSON.parse(data);
      const job = pending.get(msg.id);
      if (job) {
        clearTimeout(job.timer);
        pending.delete(msg.id);
        if (msg.error) job.reject(Error(msg.error.message));
        else job.resolve(msg.result);
      }
    };
    function cmd(method, params = {}) {
      return new Promise((resolve,reject) => {
        const id = ++serial;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('CDP 调用超时 ' + method));
        }, 10000);
        pending.set(id,{resolve,reject,timer});
        ws.send(JSON.stringify({id,method,params}));
      });
    }
    async function ev(expression) {
      const result = await cmd('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true});
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    const wait = (expr, label) => until(() => ev(expr), label);
    await wait("!!document.querySelector('.ui-menu-trigger')",'桌面');
    await ev(`window.slotReports = []; window.addEventListener('message', e => {
      if (e.data?.type === 'test:report' && [...document.querySelectorAll('iframe[data-extension-slot]')].some(f => f.contentWindow === e.source))
        window.slotReports.push(e.data);
    }); document.querySelector('.ui-menu-trigger').click()`);
    await ev("[...document.querySelectorAll('.ui-menu-item')].find(b=>b.textContent.trim()==='扩展').click()");
    await wait("document.querySelector('.extension-page p')?.textContent==='尚未安装扩展。'",'订阅初始空快照');
    const verify = async (version,preset) => {
      for (const slot of ['page','widget','overlay']) {
        const report = await wait(`window.slotReports.find(r=>r.text==='${slot} ${version}' && r.preset==='${preset}')`, slot+' '+version+' '+preset);
        assert.equal(report.parentRead,'SecurityError');
        assert.equal(report.asset,'ready');
        assert.equal(report.request,'TypeError');
        assert.equal(report.directive,'connect-src');
        const token = await ev(`getComputedStyle(document.querySelector('[data-extension-slot="${slot}"]')).getPropertyValue('--nd-semantic-color-text').trim()`);
        assert.ok(token);
        assert.equal(report.color,token);
      }
    };
    console.log('桌面已订阅，安装 v1');
    await host.upsert(extension('v1',base));
    await verify('v1','daylight');
    assert.equal(await ev("fetch('/v1/extensions/slot-demo/ui/page.html').then(r=>r.status)"),404);
    await wait("document.querySelector('.extension-overlays p')?.textContent==='展签已打开'",'实时通知');
    const light = await ev('slotReports[0].color');
    await ev("document.querySelector('[data-theme-choice=nightwave]').click()");
    await verify('v1','nightwave');
    assert.notEqual(light,await ev("slotReports.find(r=>r.preset==='nightwave').color"));
    await host.upsert(extension('v2',base));
    await verify('v2','nightwave');
    const oldUrl = await ev("document.querySelector('[data-extension-slot=page]').src");
    const toggle = () => ev("document.querySelector('.extension-page [role=switch]').click()");
    const removed = () => wait("!document.querySelector('iframe[data-extension-slot], .extension-overlays')",'三类槽位和提示撤销');
    await toggle(); await removed();
    assert.equal(host.get('slot-demo').status,'disabled');
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
    assert.equal((await fetch(base+'/v1/extensions/slot-demo/ui/page.html?v=v2')).status,404);
    console.log('Electron 39 三槽安装、主题、热升级、沙箱/CSP、停用及删除通过');
  } catch (error) {
    console.error(logs.slice(-3500));
    throw error;
  } finally {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({id:999999,method:'Browser.close'})); ws.close();
    }
    if (child && child.exitCode === null) {
      await Promise.race([exited,delay(1500,undefined,{ref:false})]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    await f.close();
    profile.remove();
  }
}
run().catch(error => {console.error(error); process.exitCode=1;});
