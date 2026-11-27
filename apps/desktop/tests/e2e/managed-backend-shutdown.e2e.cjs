'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');
const { backendDir, repoRoot } = require('../helpers/paths.cjs');
const { resolveElectronExecutable } = require('../helpers/electron-executable.cjs');
const { until } = require('../helpers/live-desktop.cjs');

function readLog(profile) {
  try { return fs.readFileSync(path.join(profile, 'logs', 'backend-latest.log'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
}
function pidFrom(log, marker) {
  return Number(new RegExp(marker + ' (?:pid=)?(\\d+)').exec(log)?.[1]);
}
function alive(pid) {
  assert.ok(pid > 0, 'missing observed PID');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
}
function cleanObservedPid(pid) {
  if (!pid) return;
  try { process.kill(pid); }
  catch (error) { if (error.code !== 'ESRCH') console.error('TEST_CLEANUP_FAILED', pid, error); }
}

async function electronSession() {
  const { app, BrowserWindow, Tray } = require('electron');
  const mode = process.env.ND_SHUTDOWN_TEST_MODE;
  const profile = app.getPath('userData');
  let tray;
  const attach = Tray.prototype.setContextMenu;
  Tray.prototype.setContextMenu = function (menu) { tray = menu; return attach.call(this, menu); };
  const preloadOption = '--require "' + process.env.ND_SHUTDOWN_TEST_PRELOAD.replaceAll('\\', '/') + '"';
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preloadOption].filter(Boolean).join(' ');
  app.on('will-quit', () => console.log('SHUTDOWN_TEST_WILL_QUIT'));
  require('../../electron/main.cjs');
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'managed window');
  const ev = source => win.webContents.executeJavaScript(source);
  if (mode === 'timeout') {
    await until(() => pidFrom(readLog(profile), 'SHUTDOWN_TEST_HUNG_CHILD'), 'noncooperating backend descendant');
  } else {
    await until(async () => {
      try {
        const result = await ev("fetch('/api-config.json').then(r=>r.json())");
        return result.connected && result;
      } catch { return false; }
    }, 'managed health');
    // 渲染层不再持有宿主令牌：同源 /v1/* 经 desk:// 代理补签，真实请求走渲染层。
    const request = async (url, body) => {
      const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      const result = await ev(`fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}).then(async response => ({
        ok: response.ok, status: response.status, data: await response.json()
      }))`);
      assert.ok(result.ok, JSON.stringify(result.data));
      return result.data;
    };
    const ext = await until(async () => {
      const item = await request('/v1/extensions/shutdown-probe');
      return item.status === 'enabled' && item;
    }, 'real active extension');
    console.log('SHUTDOWN_TEST_EXTENSION', ext.pid);
    if (mode === 'active') {
      const { roleId, windowId } = JSON.parse(process.env.ND_SHUTDOWN_TEST_ROLE);
      await request(`/v1/roles/${roleId}/windows/${windowId}/messages`, {
        content: 'shutdown-test-start-pi', submissionId: crypto.randomUUID(),
      });
      const job = await until(async () => (await request('/v1/engineering/jobs')).items.find(item => item.extId === 'shutdown-job'),
        'real active engineering job');
      await until(() => fs.existsSync(process.env.ND_SHUTDOWN_TEST_MODEL_READY), 'Pi worker waiting at offline upstream');
      const piPid = pidFrom(readLog(profile), 'SHUTDOWN_TEST_PI');
      assert.ok(alive(piPid) && alive(ext.pid));
      console.log('SHUTDOWN_TEST_ACTIVE', JSON.stringify({ jobId: job.jobId, piPid, extensionPid: ext.pid }));
      // 给直接 app.quit 注入一次取消回执，检查后端没有先收到 EOF。
      const installDecision = `void window.nowadaysDesk.onIntent(request => {
        if (request.action === 'quit') {
          window.lastQuitIntent = request.id;
          window.nowadaysDesk.reply(request.id, !!window.confirmNextShutdown);
        }
      })`;
      await until(() => ev("!!document.querySelector('.studio-shell')"), 'desktop mounted');
      await ev(installDecision);
      app.quit();
      await until(() => ev('window.lastQuitIntent'), 'direct quit confirmation');
      await delay(125);
      assert.doesNotMatch(readLog(profile), /backend_shutdown_request/);
      assert.equal((await request('/v1/health')).status, 'ok');
      await ev('window.confirmNextShutdown = true');
    }
  }
  console.log('SHUTDOWN_TEST_QUIT_AT', Date.now());
  tray.items.find(item => item.label === '退出 Nowadays').click();
}

async function launch(tmp, root, mode, extra = {}) {
  // 重启复用同一 Electron userData 配置目录，与真实关启一致（safeStorage/DPAPI 密钥随同一 profile 解密）。
  const profile = path.join(tmp, mode === 'restart' ? 'active' : mode);
  const env = { ...process.env, ...extra, NOWADAYS_APP_ROOT: root, NOWADAYS_SKIP_ROLE_PICKER: '1',
    NOWADAYS_NODE_PATH: process.execPath, ND_SHUTDOWN_TEST_MODE: mode,
    ND_SHUTDOWN_TEST_PRELOAD: path.join(tmp, 'backend-probe.cjs') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NOWADAYS_BACKEND_URL;
  delete env.NOWADAYS_BACKEND_ROOT;
  const child = spawn(resolveElectronExecutable({ repoRoot }), ['--no-sandbox', '--user-data-dir=' + profile, __filename],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 35_000);
  let log;
  try {
    const [code] = await closed;
    log = readLog(profile);
    const elapsedMs = Date.now() - pidFrom(output, 'SHUTDOWN_TEST_QUIT_AT');
    if (mode === 'timeout') {
      console.log('SHUTDOWN_TEST_FALLBACK_EVIDENCE', JSON.stringify({
        elapsedMs, taskkillLog: log.split('\n').filter(line => /backend_shutdown_timeout|backend_taskkill_|backend_shutdown_drain_timeout/.test(line)),
      }));
    }
    assert.equal(code, 0, output + '\n' + log);
    assert.match(output, /SHUTDOWN_TEST_WILL_QUIT/);
    const backendPid = pidFrom(log, 'backend_spawn');
    await until(() => !alive(backendPid), 'managed backend PID gone');
    if (mode === 'timeout') {
      const at = pidFrom(output, 'SHUTDOWN_TEST_QUIT_AT');
      assert.ok(Date.now() - at >= 5000 && Date.now() - at < 10_000, output + '\n' + log);
      assert.match(log, /backend_shutdown_timeout .* after 5000ms/);
      assert.match(log, /backend_taskkill_complete/);
      await until(() => !alive(pidFrom(log, 'SHUTDOWN_TEST_HUNG_CHILD')), 'forced descendant PID gone');
      assert.doesNotMatch(log, /shutdown_complete/);
    } else {
      assert.equal((log.match(/"event":"shutdown_complete"/g) ?? []).length, 1, log);
      assert.doesNotMatch(log, /backend_shutdown_timeout|PROCESS_INTERRUPTED|interrupted_unknown/);
    }
    if (mode === 'active') {
      const pids = JSON.parse(/SHUTDOWN_TEST_ACTIVE (.+)/.exec(output)[1]);
      for (const pid of [pids.piPid, pids.extensionPid]) await until(() => !alive(pid), 'active descendant PID gone');
      console.log('SHUTDOWN_TEST_ACTIVE_EVIDENCE', JSON.stringify({
        jobId: pids.jobId, exitedPids: { backend: backendPid, pi: pids.piPid, extension: pids.extensionPid }, livePidCount: 0,
      }));
      return pids.jobId;
    }
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    log ??= readLog(profile);
    for (const marker of ['backend_spawn', 'SHUTDOWN_TEST_PI', 'SHUTDOWN_TEST_HUNG_CHILD']) {
      cleanObservedPid(pidFrom(log, marker));
    }
    cleanObservedPid(pidFrom(output, 'SHUTDOWN_TEST_EXTENSION'));
  }
}

async function run() {
  if (process.platform !== 'win32') return;
  const tmp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'nd-managed-quit-'));
  const modelReady = path.join(tmp.path, 'pi-in-flight');
  let piDispatched = false;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method !== 'POST') return res.writeHead(404).end();
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.model === 'shutdown-pi') {
        fs.writeFileSync(modelReady, '');
        return; // 保持真实 Pi 上游请求处于活跃状态。
      }
      const call = !piDispatched && body.messages?.some(m => m.role === 'user' && m.content?.includes?.('shutdown-test-start-pi')) &&
        body.tools?.some(t => t.function?.name === 'pi_task_start');
      if (call) piDispatched = true;
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_shutdown', type: 'function',
        function: { name: 'pi_task_start', arguments: JSON.stringify({ extId: 'shutdown-job', prompt: 'Produce an offline test fixture' }) } }] } :
        { role: 'assistant', content: 'Offline fixture response' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }]) {
        res.write('data: ' + JSON.stringify({ id: 'offline', model: body.model, choices: [{ index: 0, ...choice }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { console.error(error); res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    fs.writeFileSync(path.join(tmp.path, 'backend-probe.cjs'), `
      const cp = require('node:child_process');
      if (process.argv[1]?.endsWith('main.ts')) {
        if (process.env.ND_SHUTDOWN_TEST_MODE === 'timeout') {
          // 模拟拒不退出的后端，并用真实子进程验证 taskkill /T。
          const kid = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore',windowsHide:true});
          console.log('SHUTDOWN_TEST_HUNG_CHILD', kid.pid);
          process.stdin.once = () => process.stdin;
          process.stdin.resume = () => process.stdin;
          setInterval(()=>{},1000);
        } else {
          const spawn = cp.spawn;
          cp.spawn = function (bin, args, options) {
            const child = spawn.call(this, bin, args, options);
            if (args?.some(arg => typeof arg === 'string' && /pi-mcp/.test(arg))) {
              console.log('SHUTDOWN_TEST_PI', child.pid);
            }
            return child;
          };
          require('node:module').syncBuiltinESMExports();
        }
      }`);
    const { tsImport } = createRequire(path.join(backendDir, 'package.json'))('tsx/esm/api');
    const load = relative => tsImport(pathToFileURL(path.join(backendDir, relative)).href, __filename);
    const { createBackendApp } = await load('src/bootstrap/app.ts');
    const { parseBackendConfig, rolePaths } = await load('src/bootstrap/config.ts');
    const { EngineeringJobs } = await load('src/storage/conversation/engineering-jobs.ts');
    const root = path.join(tmp.path, 'data-active');
    const config = parseBackendConfig(['--app-root', root]);
    const seed = createBackendApp(config);
    let roleId, windowId;
    try {
      roleId = seed.appStore.getRoleIndexByBuiltinKey('xiacheng').roleId;
      windowId = seed.services.roles.initializeRole(roleId).defaultWindowId;
      const [pi] = seed.services.resources.listBindings(roleId);
      const model = seed.services.resources.create({ kind: 'model', name: 'offline shutdown model',
        secret: 'offline-fixture', config: { protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' } });
      seed.services.engineeringPool.update({ members: [{ resourceId: model.resourceId, modelName: 'shutdown-pi', enabled: true }] });
      seed.services.resources.replaceBindings(roleId, [
        { resourceId: pi.resourceId, capability: 'mcp', enabled: true },
        { resourceId: model.resourceId, capability: 'chat_model', modelName: 'shutdown-chat', enabled: true },
      ]);
      await seed.services.extensions.upsert({ extId: 'shutdown-probe', manifest: { version: 'v1', entry: 'entry.mjs' },
        files: { 'entry.mjs': 'export default () => {}' } });
      seed.services.activity.resume(roleId);
      await seed.conversation.waitForIdle(roleId, 10_000);
    } finally { await seed.close(); }
    const jobId = await launch(tmp.path, root, 'active', {
      ND_SHUTDOWN_TEST_ROLE: JSON.stringify({ roleId, windowId }), ND_SHUTDOWN_TEST_MODEL_READY: modelReady,
    });
    await launch(tmp.path, root, 'restart');
    const Database = createRequire(path.join(backendDir, 'package.json'))('better-sqlite3');
    const db = new Database(rolePaths(config.dataRoot, roleId).businessDatabasePath, { readonly: true });
    try {
      const row = new EngineeringJobs(db).find(jobId);
      assert.ok(row);
      assert.equal(row.status, 'cancelled', JSON.stringify(row));
      const linked = 'SELECT execution_id FROM execution_tasks WHERE task_id=?';
      const executionRecords = [
        ['tasks', 'SELECT * FROM tasks WHERE task_id=?'],
        ['executions', `SELECT * FROM executions WHERE execution_id IN (${linked})`],
        ['tool_calls', 'SELECT * FROM tool_calls WHERE task_id=?'],
        ['tool_results', 'SELECT * FROM tool_results JOIN tool_calls USING(tool_call_id) WHERE task_id=?'],
        ['model_calls', `SELECT * FROM model_calls WHERE execution_id IN (${linked})`],
      ].map(([table, query]) => [table, db.prepare(query).all(row.taskId)]);
      assert.ok(executionRecords.every(([, entries]) => entries.length), JSON.stringify(executionRecords));
      assert.doesNotMatch(JSON.stringify(executionRecords), /PROCESS_INTERRUPTED|interrupted_unknown/);
      console.log('SHUTDOWN_TEST_RESTART_EVIDENCE', JSON.stringify({ jobId, status: row.status, interruptedCount: 0 }));
    } finally { db.close(); }
    await launch(tmp.path, path.join(tmp.path, 'data-timeout'), 'timeout');
    console.log('Windows taskkill /T /F timeout verified with live backend and descendant.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    tmp.remove();
  }
}

if (process.versions.electron) {
  electronSession().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  run().catch(error => { console.error(error); process.exitCode = 1; });
}
