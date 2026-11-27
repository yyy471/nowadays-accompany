'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { repoRoot } = require('../helpers/paths.cjs');
const { resolveElectronExecutable } = require('../helpers/electron-executable.cjs');

async function session(profile, mode) {
  let waiting, healthy = false;
  const early = [], streams = new Set();
  const role = { roleId: 'a', displayName: '夏澄', isBuiltin: true, status: 'ready' };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const json = (data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (p === '/test/streams') return json([...streams]);
    if (p === '/test/fail' && waiting) {
      waiting.writeHead(503); waiting.end(); waiting = null; healthy = true;
      return json(early);
    }
    if (p === '/v1/health' && !healthy) { waiting = res; return; }
    if (p === '/v1/health') return json({ status: 'ok' });
    if (!healthy) early.push(p);
    if (req.headers.accept?.includes('text/event-stream')) {
      if (req.headers['x-nowadays-host-token'] === 'local-test') streams.add(p);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
      res.write('event: snapshot\ndata: []\n\n');
      return;
    }
    if (p === '/v1/roles') return json({ items: [role] });
    if (p === '/v1/roles/a') return json({ ...role, definitionRevision: 1, definition: { text: '角色设定', payload: {} } });
    if (p.endsWith('/voice')) return json({ voice: null });
    if (p.endsWith('/autonomy/budget')) return json({ localDate: '2026-11-27', usedPoints: 0, dailyLimit: 200, unlimited: false });
    if (p.endsWith('/state')) return json({ state: {}, stateVersion: 1 });
    if (p.endsWith('/activity')) return json({ activity: { state: 'active', initStatus: 'ready' } });
    if (p === '/v1/activities') return json({ items: [{ ...role, state: 'active', initStatus: 'ready' }] });
    if (p === '/v1/resources') return json({ items: [{ resourceId: 'm', name: '本地模型', kind: 'model', enabled: true, config: { protocol: 'openai' } }] });
    if (p.endsWith('/bindings')) return json({ revision: '1', items: [{ capability: 'chat_model', resourceId: 'm', modelName: '原稿', enabled: true }] });
    return json({ items: [] });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const env = { ...process.env, NOWADAYS_BACKEND_URL: 'http://127.0.0.1:' + server.address().port,
      NOWADAYS_SKIP_ROLE_PICKER: '1', NOWADAYS_HOST_TOKEN: 'local-test', STAGE4_MODE: mode };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronExecutable({ repoRoot }), ['--no-sandbox', '--user-data-dir=' + profile,
      path.join(__dirname, '../helpers/boot-window-session.cjs')], { env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 65000);
    let code;
    try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-5000));
    assert.ok(output.includes('STAGE4_EXIT_VERIFIED'), output.slice(-3000));
    assert.ok(streams.has('/v1/extension-events'), '扩展 SSE 收到主帧签名');
    assert.ok([...streams].some(url => url.includes('engineering')), '工程 SSE 收到主帧签名');
    console.log(mode, output.split(/\r?\n/).filter(s => s.startsWith('STAGE4')).join('\n'));
  } finally { server.closeAllConnections(); server.close(); }
}
async function run() {
  const profile = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'stage4-profile-'));
  try {
    await session(profile.path, 'daylight');
    await session(profile.path, 'nightwave');
    await session(profile.path, 'clean');
    await session(profile.path, 'unresponsive');
  } finally { profile.remove(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
