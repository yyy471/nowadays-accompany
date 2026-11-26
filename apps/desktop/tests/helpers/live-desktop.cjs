'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { desktopDir, repoRoot } = require('../helpers/paths.cjs');
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

async function withDesktop(base, verify) {
  const profile = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'nd-e2e-profile-'));
  let child, ws, exited, logs = '';
  try {
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
    function cmd(method, params = {}, sessionId) {
      return new Promise((resolve,reject) => {
        const id = ++serial;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('CDP 调用超时 ' + method));
        }, 10000);
        pending.set(id,{resolve,reject,timer});
        ws.send(JSON.stringify({id,method,params,sessionId}));
      });
    }
    async function ev(expression) {
      const result = await cmd('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true});
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    const wait = (expr, label) => until(() => ev(expr), label);
    await verify({cmd, ev, wait, ws});
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
    profile.remove();
  }
}
module.exports = { withDesktop, until };
