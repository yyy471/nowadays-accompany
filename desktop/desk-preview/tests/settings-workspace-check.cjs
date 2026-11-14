'use strict';
// 在仓库根目录运行：Electron + 本地 HTTP 替身，不访问真实模型或外部服务。
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { resolveElectronExecutable } = require('./electron-executable.cjs');
const root = path.resolve(__dirname, '../../..');
const { PNG } = require(require.resolve('pngjs', { paths: [path.resolve(__dirname, '..'), root, path.join(root, 'backend')] }));
const out = path.join(root, 'test-results/settings-workspace');
fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-workspace-'));
const sampleWavPath = path.join(temp, 'sample.wav');
const wavHeader = Buffer.alloc(48);
wavHeader.write('RIFF', 0); wavHeader.writeUInt32LE(40, 4); wavHeader.write('WAVEfmt ', 8);
wavHeader.writeUInt32LE(16, 16); wavHeader.writeUInt16LE(1, 20); wavHeader.writeUInt16LE(1, 22);
wavHeader.writeUInt32LE(16000, 24); wavHeader.writeUInt32LE(32000, 28); wavHeader.writeUInt16LE(2, 32);
wavHeader.writeUInt16LE(16, 34); wavHeader.write('data', 36); wavHeader.writeUInt32LE(4, 40);
fs.writeFileSync(sampleWavPath, wavHeader);
const roles = ['甲', '乙'].map((name, i) => ({ roleId: i ? 'b' : 'a', displayName: `${name}角色`, status: 'ready' }));
const resources = [{ resourceId: 'm1', kind: 'model', name: '测试模型', enabled: true, config: { protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1234' }, credential: { status: 'missing' }, lastTest: null }, { resourceId: 'x1', kind: 'mcp', name: '文件工具', enabled: true, config: { command: 'node', args: [], env: {} } }];
const roleStates = { a: 'active', b: 'active', c: 'active' };
const definitions = {};
const bindings = { a: [], b: [{ capability: 'mcp', resourceId: 'x1', enabled: true, modelName: null }] };
const revisions = { a: 1, b: 1 };
const budgets = { a: { localDate: '2026-11-11', usedPoints: 7, dailyLimit: 200, unlimited: false }, b: { localDate: '2026-11-11', usedPoints: 7, dailyLimit: 200, unlimited: false } };
const wardrobes = Object.fromEntries(['a','b','c'].map(id => [id, [
  { outfitId: 'outfit-1', roleId: id, name: '测试立绘', description: null, home: { assetId: 'home-1' }, sprites: [{ assetId: 'sprite-1', displayName: '微笑' }] },
  { outfitId: 'outfit-2', roleId: id, name: '另一套', description: null, home: { assetId: 'home-2' }, sprites: [] },
]]));
const imageServices = [];
let nextImageServiceId = 1;
const sceneImages = {};
const imageServiceProbes = [];
const imagePreviews = [];
const anchorPromptCalls = [];
const voices = {};
const voiceReferences = { a: [], b: [], c: [] };
let voiceUploadCalled = false;
const voicePreviewRequests = [];
const voicePutRequests = [];
const roleDeletes = [];
let savedModelBody;
let nextModelId = 2;
let nextExtId = 2;
const modelPatches = [];
const savedSecrets = {};
const requests = [];
const readRaw = (req, fn) => { const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => fn(Buffer.concat(chunks))); };
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  requests.push(`${req.method} ${p}`);
  const role = roles.find(item => p.includes(`/roles/${item.roleId}`));
  if (p === '/v1/health') return json(res, { status: 'ok' });
  if (p === '/v1/roles' && req.method === 'POST') { let body = ''; req.on('data', chunk => body += chunk); return req.on('end', () => { const data = JSON.parse(body); const created = { roleId: 'c', displayName: data.displayName, status: 'ready' }; roles.push(created); json(res, { ...created, definition: { text: data.definition.text, payload: {} }, definitionRevision: 1 }, 201); }); }
  if (p === '/v1/roles') return json(res, { items: roles });
  if (role && p === `/v1/roles/${role.roleId}` && req.method === 'DELETE') { if (roleStates[role.roleId] !== 'stopped' || roles.length < 2) return json(res, { error: { message: '无法删除' } }, 409); const choice = url.searchParams.get('keepHistory'); if (choice !== '0' && choice !== '1') return json(res, { error: { message: '请明确选择历史处理方式' } }, 400); roleDeletes.push({ roleId: role.roleId, choice }); roles.splice(roles.indexOf(role), 1); return json(res, { roleId: role.roleId, keepHistory: choice === '1', filesRemoved: false }); }
  if (role && p === `/v1/roles/${role.roleId}`) return setTimeout(() => json(res, { ...role, definition: { text: definitions[role.roleId] || `${role.displayName}设定`, payload: {} }, definitionRevision: definitions[role.roleId] ? 2 : 1 }), role.roleId === 'b' ? 300 : 0);
  if (role && p.endsWith('/definition') && req.method === 'PATCH') { let body = ''; req.on('data', chunk => body += chunk); return req.on('end', () => { const data = JSON.parse(body); if (roleStates[role.roleId] !== 'stopped') return json(res, { error: { message: '角色尚未停止' } }, 409); definitions[role.roleId] = data.definition.text; json(res, { definitionRevision: 2, updatedAt: '2026-11-11T00:00:00Z' }); }); }
  if (role && (p.endsWith('/activity/stop') || p.endsWith('/activity/resume'))) { roleStates[role.roleId] = p.endsWith('/stop') ? 'stopped' : 'active'; return json(res, { activity: { roleId: role.roleId, state: roleStates[role.roleId], running: false, initStatus: 'ready' } }); }
  if (p.endsWith('/state')) return json(res, { state: {}, stateVersion: 1, updatedAt: '2026-11-11T00:00:00Z' });
  if (p.endsWith('/appearance/outfits')) return json(res, { items: wardrobes[role?.roleId] || [] });
  const outfitMatch = /\/appearance\/outfits\/([^/]+)(?:\/(home|sprites)(?:\/([^/]+))?)?$/.exec(p);
  if (outfitMatch && role) {
    const list = wardrobes[role.roleId], outfit = list.find(item => item.outfitId === outfitMatch[1]);
    if (!outfit) return json(res, { error: { message: '服饰不存在' } }, 404);
    if (roleStates[role.roleId] !== 'stopped') return json(res, { error: { code: 'ROLE_NOT_STOPPED', message: '角色尚未停止' } }, 409);
    if (!outfitMatch[2] && req.method === 'PATCH') { let body = ''; req.on('data', chunk => body += chunk); return req.on('end', () => { outfit.name = JSON.parse(body).name; json(res, outfit); }); }
    if (!outfitMatch[2] && req.method === 'DELETE') { if (list.length === 1) return json(res, { error: { code: 'LAST_OUTFIT_REQUIRED', message: '至少保留一套服饰' } }, 409); list.splice(list.indexOf(outfit), 1); return json(res, { outfitId: outfit.outfitId, removedAssets: 0, retainedAssets: 1 }); }
    if (outfitMatch[2] === 'home' && req.method === 'POST') { req.resume(); outfit.home = { assetId: 'home-new' }; return json(res, outfit.home, 201); }
    if (outfitMatch[2] === 'sprites' && outfitMatch[3] && req.method === 'DELETE') { outfit.sprites = outfit.sprites.filter(item => item.assetId !== outfitMatch[3]); return json(res, { assetId: outfitMatch[3], retained: true }); }
  }
  if (p.includes('/appearance/assets/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fs.readFileSync(path.join(root, 'desktop/desk-preview/renderer/src/assets/themes/xiacheng/character.png'))); }
  if (p.endsWith('/bindings') && req.method === 'PUT') { let body = ''; req.on('data', chunk => body += chunk); return req.on('end', () => { const data = JSON.parse(body), id = role.roleId; if (roleStates[id] !== 'stopped') return json(res, { error: { message: '角色尚未停止' } }, 409); if (data.expectedRevision !== String(revisions[id])) return json(res, { error: { message: '绑定版本已变化' } }, 409); bindings[id] = data.bindings.map(item => ({ ...item, modelName: item.modelName || null })); revisions[id]++; json(res, { items: bindings[id], revision: String(revisions[id]) }); }); }
  if (p.endsWith('/bindings')) return json(res, { items: bindings[role?.roleId] || [], revision: String(revisions[role?.roleId] || 1) });
  if (p.endsWith('/autonomy/budget') && req.method === 'PUT') { let body = ''; req.on('data', chunk => body += chunk); return req.on('end', () => { if (roleStates[role.roleId] !== 'stopped') return json(res, { error: { message: '角色尚未停止' } }, 409); budgets[role.roleId] = { ...budgets[role.roleId], ...JSON.parse(body) }; json(res, budgets[role.roleId]); }); }
  if (p.endsWith('/autonomy/budget')) return json(res, budgets[role?.roleId] || budgets.a);
  if (p.endsWith('/voice/references') && req.method === 'POST') { req.resume(); voiceUploadCalled = true; return json(res, { assetId: 'unexpected-upload' }, 201); }
  if (p.endsWith('/voice/references')) return json(res, { items: voiceReferences[role?.roleId] || [] });
  if (p.endsWith('/voice/probe') && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    return req.on('end', () => {
      const data = JSON.parse(body || '{}');
      json(res, { probe: { protocol: 'nowadays-tts-v1', service: 'mock-tts', model: 'v2', ready: true, capabilities: { referenceModes: [{ id: 'zero_shot', label: '零样本', requiresReferenceText: true }, { id: 'cross_language', label: '跨语种', requiresReferenceText: false }], presetVoices: false, languages: ['zh', 'en'], speed: { min: 0.5, max: 2 } }, voices: null, baseUrl: data.baseUrl } });
    });
  }
  if (p.endsWith('/voice/preview') && req.method === 'POST') {
    return readRaw(req, raw => {
      const text = raw.toString('utf8');
      voicePreviewRequests.push({ contentType: req.headers['content-type'] || '', hasPayload: text.includes('name="payload"'), hasFile: text.includes('filename="sample.wav"'), rawText: text });
      res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wavHeader);
    });
  }
  if (p.endsWith('/voice') && req.method === 'PUT' && role) {
    return readRaw(req, raw => {
      const text = raw.toString('utf8');
      const ct = req.headers['content-type'] || '';
      const m = /name="payload"\r\n\r\n([\s\S]*?)\r\n--/.exec(text);
      const data = m ? JSON.parse(m[1]) : JSON.parse(text);
      const hasFile = text.includes('filename="sample.wav"');
      voicePutRequests.push({ contentType: ct, hasFile, data });
      let ref = null;
      if (hasFile) {
        ref = { assetId: `ref-${voiceReferences[role.roleId].length + 1}`, fileName: 'sample.wav', mediaType: 'audio/wav', createdAt: '2026-11-14T00:00:00Z' };
        voiceReferences[role.roleId] = [{ ...ref, inUse: true }];
      }
      voices[role.roleId] = {
        engine: data.protocol || 'nowadays-tts-v1', protocol: data.protocol || 'nowadays-tts-v1', baseUrl: data.baseUrl,
        voiceSource: { kind: 'reference', referenceAssetId: ref ? ref.assetId : (data.referenceAssetId || null), referenceMode: data.referenceMode || 'cross_language', referenceText: data.referenceText || null },
        reference: ref, capabilities: { referenceModes: [{ id: 'zero_shot', label: '零样本', requiresReferenceText: true }, { id: 'cross_language', label: '跨语种', requiresReferenceText: false }], presetVoices: false, languages: ['zh', 'en'], speed: { min: 0.5, max: 2 } },
        enabled: true, language: data.language || 'zh', speed: data.speed || 1, emoAlpha: data.emoAlpha || 1, createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z',
      };
      json(res, { voice: voices[role.roleId] });
    });
  }
  if (p.endsWith('/voice')) return json(res, { voice: voices[role?.roleId] || null });
  if (p.endsWith('/scene-image/probe') && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    return req.on('end', () => json(res, { probe: { reachable: true, comfyuiVersion: '0.3.60', workflowReady: true, models: ['moss-v1.safetensors', 'moss-v2.safetensors'], missingNodes: [] }, elapsedMs: 4 }));
  }
  if (p.endsWith('/scene-image/anchor-prompts') && req.method === 'POST' && role) {
    return readRaw(req, raw => {
      const ct = req.headers['content-type'] || '';
      const text = raw.toString('utf8');
      let data;
      let hasUpload = false;
      if (ct.includes('multipart/form-data')) {
        const m = /name="payload"\r\n\r\n([\s\S]*?)\r\n--/.exec(text);
        data = m ? JSON.parse(m[1]) : {};
        hasUpload = text.includes('name="image"');
      } else {
        data = JSON.parse(text || '{}');
      }
      anchorPromptCalls.push({ roleId: role.roleId, target: data.target, outfitId: data.outfitId || null, previousPrompt: data.previousPrompt || null, hasUpload });
      if (data.target === 'base') {
        const prompt = hasUpload
          ? '参考图提炼：黑发杏眼，柔和眉眼'
          : data.previousPrompt
            ? '精修基础特征，银发琥珀瞳'
            : '初版基础特征，银发碧眼';
        return json(res, {
          target: 'base',
          outfitId: null,
          prompt,
          source: hasUpload
            ? { kind: 'uploaded', fileName: 'character.png', outfitId: null, outfitName: null }
            : { kind: 'outfit_asset', fileName: 'home.png', outfitId: data.outfitId || wardrobes[role.roleId]?.[0]?.outfitId || null, outfitName: wardrobes[role.roleId]?.[0]?.name || '另一套' },
        });
      }
      const matchedOutfit = (wardrobes[role.roleId] || []).find(item => item.outfitId === data.outfitId) || null;
      return json(res, {
        target: 'outfit',
        outfitId: data.outfitId || null,
        prompt: data.previousPrompt ? '精修服饰：米色长款风衣，黑色短靴' : '米色风衣，深色长裤',
        source: hasUpload
          ? { kind: 'uploaded', fileName: 'character.png', outfitId: matchedOutfit?.outfitId || null, outfitName: matchedOutfit?.name || null }
          : { kind: 'outfit_asset', fileName: 'home.png', outfitId: matchedOutfit?.outfitId || null, outfitName: matchedOutfit?.name || null },
      });
    });
  }
  if (p.endsWith('/scene-image/preview') && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    return req.on('end', () => {
      const data = JSON.parse(body); imagePreviews.push(data);
      const pngBytes = fs.readFileSync(path.join(root, 'desktop/desk-preview/renderer/src/assets/themes/xiacheng/character.png'));
      json(res, { width: 512, height: 512, prompt: data.prompt || data.settings.basePrompt, mediaType: 'image/png', dataBase64: pngBytes.toString('base64') });
    });
  }
  if (p.endsWith('/scene-image') && req.method === 'PUT' && role) {
    let body = ''; req.on('data', c => body += c);
    return req.on('end', () => {
      const data = JSON.parse(body);
      const svc = imageServices.find(item => item.serviceId === data.serviceId) || null;
      sceneImages[role.roleId] = { settings: { ...data, roleId: role.roleId }, service: svc, configured: true };
      json(res, sceneImages[role.roleId]);
    });
  }
  if (p.endsWith('/scene-image')) return json(res, sceneImages[role?.roleId] || { settings: null, service: null, configured: false });
  if (p === '/v1/image-services/probe' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    return req.on('end', () => {
      const data = JSON.parse(body || '{}'); imageServiceProbes.push(data);
      json(res, { probe: { reachable: true, comfyuiVersion: '0.3.60', workflowReady: true, models: ['moss-v1.safetensors', 'moss-v2.safetensors'], missingNodes: [] }, elapsedMs: 5 });
    });
  }
  const imgProbeMatch = /^\/v1\/image-services\/([^/]+)\/probe$/.exec(p);
  if (imgProbeMatch && req.method === 'POST') {
    const svc = imageServices.find(item => item.serviceId === imgProbeMatch[1]);
    if (!svc) return json(res, { error: { message: '生图服务不存在' } }, 404);
    imageServiceProbes.push({ serviceId: svc.serviceId });
    return json(res, { probe: { reachable: true, comfyuiVersion: '0.3.60', workflowReady: true, models: ['moss-v1.safetensors', 'moss-v2.safetensors'], missingNodes: [] }, elapsedMs: 6 });
  }
  const imgServiceMatch = /^\/v1\/image-services\/([^/]+)$/.exec(p);
  if (imgServiceMatch) {
    const svc = imageServices.find(item => item.serviceId === imgServiceMatch[1]);
    if (!svc) return json(res, { error: { message: '生图服务不存在' } }, 404);
    if (roles.some(item => roleStates[item.roleId] !== 'stopped')) return json(res, { error: { code: 'ROLES_NOT_STOPPED', message: '角色尚未全部停止' } }, 409);
    if (req.method === 'PATCH') {
      let body = ''; req.on('data', c => body += c);
      return req.on('end', () => {
        const data = JSON.parse(body);
        if (typeof data.name === 'string') svc.name = data.name;
        if (typeof data.enabled === 'boolean') svc.enabled = data.enabled;
        if (data.config) svc.config = { ...data.config };
        if (data.secret === null) svc.credential = { status: 'missing' };
        else if (typeof data.secret === 'string') { svc.config.credentialRef = 'cred-img'; svc.credential = { status: 'stored' }; }
        json(res, { service: svc });
      });
    }
    if (req.method === 'DELETE') { imageServices.splice(imageServices.indexOf(svc), 1); return json(res, { deleted: true, serviceId: svc.serviceId }); }
  }
  if (p === '/v1/image-services' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    return req.on('end', () => {
      const data = JSON.parse(body);
      const created = { serviceId: `img-${nextImageServiceId++}`, name: data.name, enabled: data.enabled ?? true, config: { protocol: 'comfyui', baseUrl: data.config.baseUrl, ...(data.config.modelName ? { modelName: data.config.modelName } : {}), ...(data.config.timeoutMs ? { timeoutMs: data.config.timeoutMs } : {}), ...(data.secret ? { credentialRef: 'cred-img' } : {}) }, credential: { status: data.secret ? 'stored' : 'missing' } };
      imageServices.push(created); json(res, { service: created }, 201);
    });
  }
  if (p === '/v1/image-services') return json(res, { items: imageServices });
  const resourceMatch = /^\/v1\/resources\/([xm]\d+)(\/references)?$/.exec(p);
  if (resourceMatch) {
    const resource = resources.find(item => item.resourceId === resourceMatch[1]);
    if (!resource) return json(res, { error: { message: '资源不存在' } }, 404);
    if (resourceMatch[2]) { const entries = Object.entries(bindings).flatMap(([roleId, list]) => list.filter(item => item.resourceId === resource.resourceId).map(item => ({ roleId, reason: 'ROLE_BINDING', bindingEnabled: item.enabled }))); const available = !entries.some(item => item.bindingEnabled); return json(res, { references: entries, canUpdate: available, canDisable: available, canDelete: available }); }
    if (req.method === 'PATCH' && resource.kind !== 'model') { let body = ''; req.on('data', chunk => body += chunk); return req.on('end', () => { const data = JSON.parse(body); Object.assign(resource, data); json(res, resource); }); }
    if (req.method === 'DELETE') { resources.splice(resources.indexOf(resource), 1); for (const id of Object.keys(bindings)) { const before = bindings[id].length; bindings[id] = bindings[id].filter(item => item.resourceId !== resource.resourceId); if (bindings[id].length !== before) revisions[id]++; } return json(res, { deleted: true }); }
  }
  if (p === '/v1/resources/m1' && req.method === 'PATCH') { let body = ''; req.on('data', chunk => body += chunk); return req.on('end', () => { savedModelBody = JSON.parse(body); modelPatches.push(savedModelBody); if (roles.some(item => roleStates[item.roleId] !== 'stopped')) return json(res, { error: { message: '角色尚未全部停止' } }, 409); if (resources[0].credential.status === 'stored' && new URL(savedModelBody.config.baseUrl).origin !== new URL(resources[0].config.baseUrl).origin && savedModelBody.secret === undefined) return json(res, { error: { message: '服务地址已更换，请重新确认密钥', code: 'RESOURCE_CREDENTIAL_STALE' } }, 409); if (typeof savedModelBody.secret === 'string') savedSecrets.m1 = savedModelBody.secret; else if (savedModelBody.secret === null) delete savedSecrets.m1; Object.assign(resources[0], { name: savedModelBody.name, config: savedModelBody.config, credential: { status: typeof savedModelBody.secret === 'string' ? 'stored' : savedModelBody.secret === null ? 'missing' : resources[0].credential.status } }); json(res, resources[0]); }); }
  const revealMatch = /^\/v1\/resources\/([^/]+)\/secret\/reveal$/.exec(p);
  if (revealMatch && req.method === 'POST') { const target = resources.find(item => item.resourceId === revealMatch[1]); if (!target) return json(res, { error: { message: '资源不存在' } }, 404); const secret = savedSecrets[target.resourceId]; return json(res, secret ? { status: 'stored', secret } : { status: 'missing' }); }
  if (p === '/v1/resources' && req.method === 'POST') { let body = ''; req.on('data', chunk => body += chunk); return req.on('end', () => { const data = JSON.parse(body); const resourceId = data.kind === 'model' ? `m${nextModelId++}` : `x${nextExtId++}`; if (typeof data.secret === 'string') savedSecrets[resourceId] = data.secret; const created = { resourceId, kind: data.kind, name: data.name, enabled: true, config: data.config, credential: { status: data.secret ? 'stored' : 'missing' }, lastTest: null }; resources.push(created); json(res, created, 201); }); }
  if (p === '/v1/resources') return json(res, { items: resources });
  if (p === '/v1/activities') return json(res, { items: roles.map(role => ({ roleId: role.roleId, state: roleStates[role.roleId], running: false, initStatus: 'ready' })) });
  if (p.endsWith('/models')) return json(res, { models: ['local-model'] });
  if (p.endsWith('/model-test')) return json(res, { ok: true, elapsedMs: 1, fingerprint: 'fixture' });
  return json(res, { error: { message: '测试接口未配置' } }, 404);
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { let last; for (const start = Date.now(); Date.now() - start < 16000;) { try { if (await fn()) return; } catch (e) { last = e; } await delay(80); } throw Error(`等待超时 ${last || ''}`); }
let proc, ws, id = 0, logs = '';
const waiting = new Map(), errors = [];
function cmd(method, params = {}) { return new Promise((resolve, reject) => { const n = ++id; waiting.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); }); }
async function ev(expression) { const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function shot(name) { const data = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(data.data, 'base64')); }
async function pixels() { const data = await cmd('Page.captureScreenshot', { format: 'png' }); return PNG.sync.read(Buffer.from(data.data, 'base64')); }
function compareRect(a, b, rect) { let changed = 0, checked = 0; for (let y = Math.ceil(rect.top) + 2; y < Math.floor(rect.bottom) - 2; y += 4) for (let x = Math.ceil(rect.left) + 2; x < Math.floor(rect.right) - 2; x += 4) { const i = (y * a.width + x) * 4; checked++; if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) changed++; } return { changed, checked }; }
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, NOWADAYS_BACKEND_URL: `http://127.0.0.1:${server.address().port}`, NOWADAYS_APP_ROOT: path.join(temp, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(resolveElectronExecutable({ repoRoot: root }), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, path.join(root, 'desktop/desk-preview')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', x => logs += x); proc.stderr.on('data', x => logs += x);
  let port; await until(() => port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(logs)?.[1]);
  let target; await until(async () => target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.startsWith('desk://bundle/')));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if (msg.id) { const job = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? job?.reject(msg.error) : job?.resolve(msg.result); } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text); };
  await cmd('Runtime.enable'); await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => ev("!!document.querySelector('.ui-menu-trigger')"));
  await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev("[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes('角色配置'))"));
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes('角色配置')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) textarea')"));
  await until(() => ev("!!document.querySelector('.config-stage img')"));
  await delay(450);
  assert.ok(await ev("document.querySelector('#config-footer-right').textContent.includes('甲角色')"));
  const visibleBounds = await ev("(()=>{const book=document.querySelector('.config-book').getBoundingClientRect(),last=document.querySelector('.config-tabs button:last-child').getBoundingClientRect(),button=document.querySelector('.config-switch-role').getBoundingClientRect();return {bookBottom:book.bottom,lastBottom:last.bottom,switchBottom:button.bottom,innerHeight}})()");
  assert.ok(visibleBounds.lastBottom <= visibleBounds.bookBottom && visibleBounds.switchBottom <= visibleBounds.innerHeight, JSON.stringify(visibleBounds));
  const portraitRect = await ev("(()=>{const r=document.querySelector('.config-stage .config-portrait').getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}})()");
  const beforeTheme = await pixels();
  await ev("[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('晚风电台')).click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.uiPreset==='nightwave'"));
  await delay(350); const duringTheme = await pixels();
  await delay(750); const afterTheme = await pixels();
  const midDiff = compareRect(beforeTheme, duringTheme, portraitRect), endDiff = compareRect(beforeTheme, afterTheme, portraitRect);
  assert.ok(midDiff.changed < midDiff.checked * .01 && endDiff.changed < endDiff.checked * .01, `立绘随主题变化：${JSON.stringify({midDiff,endDiff})}`);
  await ev("[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('白昼来信')).click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.uiPreset==='daylight'")); await delay(1000);
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-poster-hit')"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) textarea')?.value==='乙角色设定'"));
  assert.ok(await ev("document.querySelector('#config-footer-right').textContent.includes('甲角色')"));
  await ev("(()=>{const e=document.querySelector('.config-role-editor:not([hidden]) textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'乙的未保存草稿');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until(() => ev("!!document.querySelector('.config-dirty-ribbon')"));
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-poster-hit')"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('甲角色')).click()");
  await until(() => ev("!!document.querySelector('.config-dirty-prompt')"));
  await ev("[...document.querySelectorAll('.config-dirty-prompt button')].find(x=>x.textContent.includes('保留草稿')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) textarea')?.value==='甲角色设定'"));
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-poster-hit')"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) textarea')?.value==='乙的未保存草稿'"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent.includes('去角色状态')).click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='settings' && document.querySelector('.config-leaf').innerText.includes('角色状态')"));
  await ev("[...document.querySelectorAll('.config-status-poster')].find(x=>x.textContent.includes('乙角色')).querySelector('button').click()");
  await until(() => ev("[...document.querySelectorAll('.config-status-poster')].find(x=>x.textContent.includes('乙角色')).textContent.includes('已停止')"));
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) textarea')?.value==='乙的未保存草稿'"));
  await delay(450);
  await shot('role-1280.png');
  await ev("[...document.querySelectorAll('.config-leaf-foot button')].find(x=>x.textContent==='保存设定').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden])').innerText.includes('角色设定已保存')"));
  assert.equal(definitions.b, '乙的未保存草稿');
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('外观')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-outfit-manage input:not([type=file])')"));
  await ev("(()=>{const e=document.querySelector('.config-role-editor:not([hidden]) .nd-outfit-manage input:not([type=file])');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'改名服饰');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].find(x=>x.textContent==='保存名称').click()");
  await until(() => wardrobes.b[0].name === '改名服饰');
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-outfit-manage h3')?.textContent==='改名服饰'"));
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-sprite-preview').click()");
  await until(() => ev("document.querySelector('.config-stage .config-portrait img')?.getAttribute('src')?.includes('sprite-1')"));
  const doc = await cmd('DOM.getDocument');
  const homeInput = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.config-role-editor:not([hidden]) .nd-outfit-manage input[type=file]' });
  await cmd('DOM.setFileInputFiles', { nodeId: homeInput.nodeId, files: [path.join(root, 'desktop/desk-preview/renderer/src/assets/themes/xiacheng/character.png')] });
  await until(() => wardrobes.b[0].home.assetId === 'home-new');
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].some(x=>x.textContent==='删除差分'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].find(x=>x.textContent==='删除差分').click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-confirm button')].find(x=>x.textContent==='确认删除').click()");
  await until(() => wardrobes.b[0].sprites.length === 0);
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].some(x=>x.textContent==='删除服饰'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].find(x=>x.textContent==='删除服饰').click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-confirm button')].find(x=>x.textContent==='确认删除').click()");
  await until(() => wardrobes.b.length === 1);
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-outfit-manage button')].find(x=>x.textContent==='删除服饰')?.disabled"));
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('设定')).click()");
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-poster-hit')"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('甲角色')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) textarea')?.value==='甲角色设定'"));
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-poster-hit')"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) textarea')?.value==='乙的未保存草稿'"));
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) select')"));
  await ev("(()=>{const a=document.querySelector('.config-role-editor:not([hidden]) .config-model-details:not([hidden]) select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(a,'m1');a.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .config-model-details:not([hidden]) input[role=combobox]')"));
  await ev("(()=>{const b=document.querySelector('.config-role-editor:not([hidden]) .config-model-details:not([hidden]) input[role=combobox]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(b,'local-model');b.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='保存模型选择'&&!x.disabled).click()");
  await until(() => bindings.b.some(item => item.capability === 'chat_model'));
  assert.ok(bindings.b.some(item => item.capability === 'mcp' && item.enabled), '保存模型时必须保留原扩展');
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('扩展')).click()");
  await ev("document.querySelector('.config-role-editor:not([hidden]) input[type=checkbox]').click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='保存扩展').click()");
  await until(() => bindings.b.some(item => item.capability === 'mcp' && !item.enabled));
  assert.ok(bindings.b.some(item => item.capability === 'chat_model' && item.modelName === 'local-model'), '保存扩展时必须保留模型');
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('额度')).click()");
  await ev("(()=>{const e=document.querySelector('.config-role-editor:not([hidden]) input[type=number]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'350');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='保存额度').click()");
  await until(() => budgets.b.dailyLimit === 350);
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.textContent.includes('语音')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"http://127.0.0.1:8000\"]')"));
  await ev("(()=>{const e=document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"http://127.0.0.1:8000\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'http://127.0.0.1:8020');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.textContent.includes('生图')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"moss_image_sft_int8_convrot.safetensors\"]')"));
  await ev("(()=>{const e=document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"moss_image_sft_int8_convrot.safetensors\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'/models/draft');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until(() => ev("document.querySelector('.config-leaf-foot').textContent.includes('语音') && document.querySelector('.config-leaf-foot').textContent.includes('生图')"));
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-poster-hit')"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('甲角色')).click()");
  await until(() => ev("document.querySelector('.config-dirty-prompt')?.textContent.includes('语音') && document.querySelector('.config-dirty-prompt')?.textContent.includes('生图')"));
  await ev("[...document.querySelectorAll('.config-dirty-prompt button')].find(x=>x.textContent.includes('保留草稿')).click()");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"));
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-poster-hit')"));
  assert.equal(await ev("[...document.querySelectorAll('.config-poster')].find(x=>x.textContent.includes('乙角色'))?.querySelector('.config-poster-dirty')?.textContent"), '未保存');
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"moss_image_sft_int8_convrot.safetensors\"]')?.value==='/models/draft'"));
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"http://127.0.0.1:8000\"]')?.value"), 'http://127.0.0.1:8020');
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-poster-hit')"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('甲角色')).click()");
  await until(() => ev("!!document.querySelector('.config-dirty-prompt')"));
  await ev("[...document.querySelectorAll('.config-dirty-prompt button')].find(x=>x.textContent.includes('放弃改动')).click()");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"));
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-poster-hit')"));
  assert.equal(await ev("[...document.querySelectorAll('.config-poster')].find(x=>x.textContent.includes('乙角色'))?.querySelector('.config-poster-dirty')?.textContent"), undefined);
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"moss_image_sft_int8_convrot.safetensors\"]')?.value===''"));
  assert.notEqual(await ev("document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"http://127.0.0.1:8000\"]')?.value"), 'http://127.0.0.1:8020');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.textContent.includes('对话')).click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent.includes('在设置中查看模型')).click()");
  await until(() => ev("document.querySelector('.config-leaf').innerText.includes('测试模型')"));
  await ev("(()=>{const e=document.querySelector('.config-prose:not([hidden]) input[role=combobox]');e.focus();})()");
  await ev("[...document.querySelectorAll('.config-prose:not([hidden]) button')].find(x=>x.textContent.includes('读取模型列表')).click()");
  await until(() => ev("[...document.querySelectorAll('.config-prose:not([hidden]) [role=option]')].some(x=>x.textContent==='local-model')"));
  await until(() => ev("document.querySelector('.config-prose:not([hidden])').innerText.includes('已读取 1 个模型')"));
  await ev("(()=>{const e=document.querySelector('.config-prose:not([hidden]) input[role=combobox]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'local-model');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-prose:not([hidden]) button')].find(x=>x.textContent.includes('测试连接')).click()");
  await until(() => ev("document.querySelector('.config-leaf').innerText.includes('测试通过')"));
  assert.ok(!await ev("document.querySelector('.config-prose:not([hidden])').innerText.includes('已读取 1 个模型')"), '测试连接日志应覆盖读取模型列表日志');
  await shot('settings-1280.png');
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('角色')).click()");
  await until(() => ev("!!document.querySelector('.config-status-poster')"));
  await ev("[...document.querySelectorAll('.config-status-poster')].find(x=>x.textContent.includes('甲角色')).querySelector('button').click()");
  await until(() => ev("[...document.querySelectorAll('.config-status-poster')].find(x=>x.textContent.includes('甲角色')).textContent.includes('已停止')"));
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  await until(() => ev("!!document.querySelector('.config-prose:not([hidden]) input[aria-label=模型服务名称]')"));
  assert.ok(!await ev("document.querySelector('.config-prose:not([hidden])').innerText.includes('测试通过 ·')"), '切走再切回后读取与测试点击日志应清空');
  await ev("(()=>{const e=document.querySelector('.config-prose:not([hidden]) input[aria-label=模型服务名称]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'模型待保存');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='role-config'"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent.includes('在设置中查看模型')).click()");
  await until(() => ev("document.querySelector('.config-prose:not([hidden]) input[aria-label=模型服务名称]')?.value==='模型待保存'"));
  await ev("(()=>{const e=document.querySelector('.config-prose:not([hidden]) input[aria-label=模型密钥]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'secret-value');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-prose:not([hidden]) button')].find(x=>x.textContent==='保存模型服务'&&!x.disabled).click()");
  await until(() => modelPatches.length === 1);
  assert.equal(savedModelBody.secret, 'secret-value'); assert.equal(resources[0].name, '模型待保存');
  await until(() => ev("document.querySelector('input[aria-label=模型服务名称]').closest('.config-prose').innerText.includes('模型服务已保存')"));
  await until(() => ev("document.querySelector('.config-prose:not([hidden]) input[aria-label=模型密钥]')?.type==='password' && document.querySelector('.config-prose:not([hidden]) input[aria-label=模型密钥]')?.value==='************'"));
  await ev("document.querySelector('.config-prose:not([hidden]) .nd-secret-row button').click()");
  await until(() => ev("document.querySelector('.config-prose:not([hidden]) input[aria-label=模型密钥]')?.type==='text' && document.querySelector('.config-prose:not([hidden]) input[aria-label=模型密钥]')?.value==='secret-value'"));
  await ev("document.querySelector('.config-prose:not([hidden]) .nd-secret-row button').click()");
  await until(() => ev("document.querySelector('.config-prose:not([hidden]) input[aria-label=模型密钥]')?.type==='password' && document.querySelector('.config-prose:not([hidden]) input[aria-label=模型密钥]')?.value==='************'"));
  await ev("(()=>{const e=document.querySelector('.config-prose:not([hidden]) input[aria-label=模型服务名称]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'模型保留密钥');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-prose:not([hidden]) button')].find(x=>x.textContent==='保存模型服务'&&!x.disabled).click()");
  await until(() => modelPatches.length === 2);
  assert.equal(Object.hasOwn(savedModelBody, 'secret'), false, '保留密钥时不应提交密钥');
  await ev("[...document.querySelectorAll('.config-index button')].find(x=>x.textContent.includes('添加模型服务')).click()");
  await ev("(()=>{const p=[...document.querySelectorAll('.config-prose')].find(x=>!x.hidden&&x.textContent.includes('添加模型服务'));const set=(e,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));};set(p.querySelector('input[type=text]'),'新模型');set(p.querySelectorAll('input[type=text]')[1],'http://127.0.0.1:9000');set(p.querySelector('input[type=password]'),'secret');set(p.querySelector('input[role=combobox]'),'gemini-2.5-flash');})()");
  await ev("[...document.querySelectorAll('.config-prose:not([hidden]) button')].find(x=>x.textContent.includes('保存模型服务')).click()");
  await until(() => ev("document.querySelector('.config-leaf').innerText.includes('新模型')"));
  await until(() => ev("document.querySelector('.config-prose:not([hidden]) input[role=combobox]')?.value==='gemini-2.5-flash'"));
  assert.ok(!await ev("document.body.innerText.includes('secret')"), '密钥不应显示在页面中');
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='删除模型服务'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='删除模型服务').click()");
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='确认删除模型').click()");
  await until(() => !resources.some(item => item.resourceId === 'm2'));
  bindings.b.find(item => item.capability === 'mcp').enabled = true;
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('MCP')).click()");
  await until(() => ev("document.querySelector('.config-leaf').innerText.includes('角色已开启')"));
  assert.equal(await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='编辑')?.disabled"), true, '使用中的资源不能编辑');
  bindings.b.find(item => item.capability === 'mcp').enabled = false;
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('MCP')).click()");
  await until(() => ev("document.querySelector('.config-leaf').innerText.includes('角色已关闭')"));
  await ev("[...document.querySelectorAll('.config-index button')].find(x=>x.textContent.includes('添加 MCP')).click()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) h2')].some(x=>x.textContent==='添加 MCP')"));
  await ev("(()=>{const p=[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden])')].find(x=>x.textContent.includes('添加 MCP'));const inputs=p.querySelectorAll('input');for(const [i,v] of [[0,'临时工具'],[1,'node']]){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inputs[i],v);inputs[i].dispatchEvent(new Event('input',{bubbles:true}));}})()");
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存资源').click()");
  await until(() => ev("document.querySelector('.config-leaf').innerText.includes('临时工具') && document.querySelector('.config-leaf').innerText.includes('当前没有角色或任务引用')"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='编辑').click()");
  await ev("(()=>{const p=document.querySelector('.config-leaf-body > .config-prose:not([hidden])');const e=p.querySelectorAll('input')[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'node2');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存资源').click()");
  await until(() => resources.find(item => item.resourceId === 'x2')?.config.command === 'node2');
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='全局停用'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='全局停用').click()");
  await until(() => resources.find(item => item.resourceId === 'x2')?.enabled === false);
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='全局启用'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='删除').click()");
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='确认删除').click()");
  await until(() => !resources.some(item => item.resourceId === 'x2'));
  await until(() => ev("[...document.querySelectorAll('.config-index button')].some(x=>x.textContent.includes('文件工具'))"));
  await ev("[...document.querySelectorAll('.config-index button')].find(x=>x.textContent.includes('文件工具')).click()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='删除'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='删除').click()");
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='确认删除').click()");
  await until(() => !resources.some(item => item.resourceId === 'x1'));
  assert.ok(!bindings.b.some(item => item.resourceId === 'x1') && bindings.b.some(item => item.capability === 'chat_model'), '删除关闭的扩展后保留模型绑定');
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('Skill')).click()");
  await ev("[...document.querySelectorAll('.config-index button')].find(x=>x.textContent.includes('添加 Skill')).click()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) h2')].some(x=>x.textContent==='添加 Skill')"));
  await ev("(()=>{const p=[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden])')].find(x=>x.textContent.includes('添加 Skill'));const inputs=p.querySelectorAll('input');for(const [i,v] of [[0,'临时方法'],[1,'C:/fixture/skill']]){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inputs[i],v);inputs[i].dispatchEvent(new Event('input',{bubbles:true}));}})()");
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存资源').click()");
  await until(() => ev("document.querySelector('.config-leaf').innerText.includes('临时方法') && document.querySelector('.config-leaf').innerText.includes('当前没有角色或任务引用')"));
  assert.equal(resources.find(item => item.resourceId === 'x3').config.sourcePath, 'C:/fixture/skill');
  await ev("[...document.querySelectorAll('.config-tabs button')].find(x=>x.textContent.includes('模型')).click()");
  assert.deepEqual(await ev("[...document.querySelectorAll('.config-kind-tabs button')].map(x=>x.textContent)"), ['模型', '生图'], '设置模型页只保留模型与生图两项');
  await ev("[...document.querySelectorAll('.config-kind-tabs button')].find(x=>x.textContent==='生图').click()");
  await until(() => ev("!!document.querySelector('.config-index button.config-index-new') && document.querySelector('.config-index').textContent.includes('添加生图服务')"));
  await ev("document.querySelector('.config-index button.config-index-new').click()");
  await until(() => ev("document.querySelector('.config-leaf').innerText.includes('添加生图服务')"));
  await ev("(()=>{const p=document.querySelector('.config-leaf-body > .config-prose:not([hidden])');const set=(e,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));};const inputs=p.querySelectorAll('input');set(inputs[0],'本机测试生图');set(inputs[1],'http://127.0.0.1:8188');set(inputs[2],'secret-img');set(inputs[3],'15000');})()");
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='读取模型列表').click()");
  await until(() => imageServiceProbes.length === 1 && ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('已读取 2 个模型')"));
  await ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[role=combobox]').focus()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) .nd-model-options [role=option]')].length === 2"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) .nd-model-options [role=option] button')].find(x=>x.textContent==='moss-v1.safetensors').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))");
  await until(() => ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[role=combobox]')?.value==='moss-v1.safetensors'"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => imageServiceProbes.length === 2 && ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('moss-v1.safetensors')"));
  assert.equal(await ev("document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) [role=status], .config-leaf-body > .config-prose:not([hidden]) [role=alert]').length"), 1, '设置生图探测日志只保留最新一条相互覆盖');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存生图服务').click()");
  await until(() => imageServices.length === 1 && ev("document.querySelector('.config-leaf').innerText.includes('本机测试生图') && document.querySelector('.config-index').innerText.includes('moss-v1.safetensors')"));
  assert.equal(imageServices[0].config.timeoutMs, 15000);
  assert.equal(imageServices[0].config.modelName, 'moss-v1.safetensors');
  await ev("(()=>{const e=document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[aria-label=生图服务名称]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'默认 ComfyUI');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='替换').click()");
  await ev("(()=>{const e=document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'img-secret-2');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='读取模型列表').click()");
  await until(() => imageServiceProbes.length === 3 && ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('已读取 2 个模型')"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存生图服务').click()");
  await until(() => imageServices[0].name === '默认 ComfyUI');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => imageServiceProbes.length === 4 && ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('已确认模型「moss-v1.safetensors」')"));
  await ev("[...document.querySelectorAll('.config-kind-tabs button')].find(x=>x.textContent==='模型').click()");
  await until(() => ev("document.querySelector('.config-kind-tabs button[aria-pressed=\"true\"]')?.textContent==='模型'"));
  await ev("[...document.querySelectorAll('.config-kind-tabs button')].find(x=>x.textContent==='生图').click()");
  await until(() => ev("document.querySelector('.config-kind-tabs button[aria-pressed=\"true\"]')?.textContent==='生图' && !!document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[aria-label=生图服务名称]')"));
  assert.equal(await ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .nd-model-picker ~ .config-actions ~ [role=status]')"), null, '切换标签后生图测试日志不应保留');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='全局停用').click()");
  await until(() => imageServices[0].enabled === false);
  await ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) input[role=combobox]').focus()");
  assert.equal(await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) .nd-model-options [role=option]')].length"), 0, '停用生图服务应清空旧候选缓存');
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='全局启用').click()");
  await until(() => imageServices[0].enabled === true);
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='读取模型列表').click()");
  await until(() => imageServiceProbes.length === 5 && ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('已读取 2 个模型')"));
  for (const [width,height] of [[1440,840],[720,540]]) { await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await delay(250); assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth+1'), true, `${width} 横向溢出`); const bounds = await ev("(()=>{const a=document.querySelector('.config-book').getBoundingClientRect(),b=document.querySelector('.config-leaf-foot').getBoundingClientRect(),c=document.querySelector('.ui-page-dock').getBoundingClientRect();return {bookBottom:a.bottom,footBottom:b.bottom,dockBottom:c.bottom,height:innerHeight}})()"); assert.ok(bounds.footBottom<=bounds.bookBottom+1 && bounds.dockBottom<=bounds.height+1, JSON.stringify({width,bounds})); await shot(`settings-${width}.png`); }
  await ev("[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('晚风电台')).click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.uiPreset==='nightwave'")); await delay(500); await shot('settings-night-720.png');
  await ev("[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('白昼来信')).click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.uiPreset==='daylight'"));
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='role-config'"));
  assert.equal(await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].some(x=>x.textContent.includes('新建模型服务'))"), false, '角色页不再提供新建模型服务入口');
  assert.equal(bindings.b.find(item => item.capability === 'chat_model').resourceId, 'm1', '模型绑定保持不变');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.textContent.includes('生图')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image-service-row select')?.value==='img-1'"));
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"moss_image_sft_int8_convrot.safetensors\"]')?.value==='moss-v1.safetensors'"));
  assert.ok(await ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-image-outfits input[placeholder=\"例如：米色风衣，深色长裤\"]')"), '服饰锚点提示词应直接展开可见');
  await ev("(()=>{const el=document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]');el.focus();el.click();})()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image .nd-model-options [role=option]')].length === 2"));
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await ev("(()=>{const e=document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"moss_image_sft_int8_convrot.safetensors\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'draft-model');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent.includes('生成参数')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-image input[placeholder=\"nsfw, worst quality, bad anatomy, watermark, jpeg artifact\"]')"));
  await ev("(()=>{const e=document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"例如：米色风衣，深色长裤\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'风衣草稿');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent.includes('在设置中管理')).click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='settings' && document.querySelector('.config-kind-tabs button[aria-pressed=\"true\"]')?.textContent==='生图'"));
  await ev("document.querySelector('.config-index button.config-index-new').click()");
  await until(() => ev("document.querySelector('.config-leaf').innerText.includes('添加生图服务')"));
  await ev("(()=>{const p=document.querySelector('.config-leaf-body > .config-prose:not([hidden])');const set=(e,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));};const inputs=p.querySelectorAll('input');set(inputs[0],'备用生图');set(inputs[1],'http://127.0.0.1:8189');})()");
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='保存生图服务').click()");
  await until(() => imageServices.length === 2 && ev("document.querySelector('.config-leaf-body > .config-prose:not([hidden]) h2')?.textContent==='备用生图' && [...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='删除生图服务')"));
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='删除生图服务').click()");
  await until(() => ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].some(x=>x.textContent==='确认删除'||x.textContent==='暂停并删除')")).catch(async e => {
    console.error('DIAG delete confirm:', await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].map(x=>x.textContent)"));
    throw e;
  });
  await ev("[...document.querySelectorAll('.config-leaf-body > .config-prose:not([hidden]) button')].find(x=>x.textContent==='确认删除'||x.textContent==='暂停并删除').click()");
  await until(() => imageServices.length === 1);
  await ev("document.querySelector('.config-return-footer').click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.page==='role-config'"));
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"moss_image_sft_int8_convrot.safetensors\"]')?.value"), 'draft-model', '跳转设置管理后应保留角色生图草稿');
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"例如：米色风衣，深色长裤\"]')?.value"), '风衣草稿');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='读取模型列表').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('已读取 2 个模型')"));
  await ev("(()=>{const el=document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]');el.focus();el.click();})()");
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image .nd-model-options [role=option]')].some(x=>x.textContent==='moss-v2.safetensors')"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image .nd-model-options [role=option] button')].find(x=>x.textContent==='moss-v2.safetensors').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image input[role=combobox]')?.value==='moss-v2.safetensors'"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image .nd-model-picker ~ .config-actions ~ [role=status]')?.textContent.includes('已确认模型「moss-v2.safetensors」')"));
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image button[aria-label=\"用对话模型生成基础锚点提示词\"]').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image textarea[aria-label=\"基础锚点提示词\"]')?.value==='初版基础特征，银发碧眼'"));
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image button[aria-label=\"用对话模型生成基础锚点提示词\"]').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image textarea[aria-label=\"基础锚点提示词\"]')?.value==='精修基础特征，银发琥珀瞳'"));
  assert.equal(anchorPromptCalls.at(-1).previousPrompt, '初版基础特征，银发碧眼', '重新生成应携带上一次草稿供对话模型优化');
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image button[aria-label=\"用对话模型生成「另一套」服饰提示词\"]').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image-outfits input[placeholder=\"例如：米色风衣，深色长裤\"]')?.value==='精修服饰：米色长款风衣，黑色短靴'"));
  assert.equal(anchorPromptCalls.at(-1).previousPrompt, '风衣草稿', '已有服饰草稿时点击重生成也应携带上一次内容');
  await ev("(()=>{const el=document.querySelector('.config-role-editor:not([hidden]) .nd-image input[type=file]');el.click=()=>{};})()");
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image button[aria-label=\"上传参考图生成基础锚点提示词\"]').click()");
  const docImg = await cmd('DOM.getDocument');
  const anchorUpload = await cmd('DOM.querySelector', { nodeId: docImg.root.nodeId, selector: '.config-role-editor:not([hidden]) .nd-image input[type=file]' });
  await cmd('DOM.setFileInputFiles', { nodeId: anchorUpload.nodeId, files: [path.join(root, 'desktop/desk-preview/renderer/src/assets/themes/xiacheng/character.png')] });
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image textarea[aria-label=\"基础锚点提示词\"]')?.value==='参考图提炼：黑发杏眼，柔和眉眼'"));
  await ev("delete document.querySelector('.config-role-editor:not([hidden]) .nd-image input[type=file]').click");
  assert.equal(anchorPromptCalls.at(-1).hasUpload, true);
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) input[placeholder=\"moss_image_sft_int8_convrot.safetensors\"]')?.value"), 'moss-v2.safetensors');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='测试生图').click()");
  await until(() => imagePreviews.length === 1 && ev("(() => { const img = document.querySelector('.config-role-editor:not([hidden]) .nd-image-figure img'); return !!(img && img.complete && img.naturalWidth > 0); })()"));
  assert.equal(imagePreviews[0].settings.modelPath, 'moss-v2.safetensors');
  assert.equal(sceneImages.b, undefined, '草稿测试生图不应写入已保存配置');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-image button')].find(x=>x.textContent==='保存配置').click()");
  await until(() => !!sceneImages.b);
  for (const [width, height] of [[1280, 800], [1440, 840], [720, 540]]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(250);
    assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth+1'), true, `role-image ${width} 横向溢出`);
    await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image')?.scrollIntoView({block:'start'})");
    await delay(120);
    await shot(`image-${width}.png`);
    if (width === 1280 || width === 720) {
      await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image-outfits')?.scrollIntoView({block:'center'})");
      await delay(120);
      await shot(`image-outfits-${width}.png`);
      await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image-preview')?.scrollIntoView({block:'end'})");
      await delay(120);
      await shot(`image-preview-${width}.png`);
    }
  }
  await ev("[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('晚风电台')).click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.uiPreset==='nightwave'"));
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image-outfits')?.scrollIntoView({block:'center'})");
  await delay(500);
  await shot('image-outfits-night-720.png');
  await ev("document.querySelector('.config-role-editor:not([hidden]) .nd-image')?.scrollIntoView({block:'start'})");
  await delay(250);
  await shot('image-night-720.png');
  await ev("[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('白昼来信')).click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.uiPreset==='daylight'"));
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-model-toggle')].find(x=>x.textContent.includes('语音')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) .nd-voice input[placeholder=\"http://127.0.0.1:8000\"]')"));
  await ev("(()=>{const e=document.querySelector('.config-role-editor:not([hidden]) .nd-voice input[placeholder=\"http://127.0.0.1:8000\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'http://127.0.0.1:8880');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].find(x=>x.textContent==='测试连接').click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-voice-probe')?.textContent.includes('mock-tts')"));
  await ev("(()=>{const s=[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice select')].find(x=>[...x.options].some(o=>o.value==='cross_language'));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'cross_language');s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  const docVoice = await cmd('DOM.getDocument');
  const voiceFileInput = await cmd('DOM.querySelector', { nodeId: docVoice.root.nodeId, selector: '.config-role-editor:not([hidden]) .nd-voice input[type=file]' });
  await cmd('DOM.setFileInputFiles', { nodeId: voiceFileInput.nodeId, files: [sampleWavPath] });
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) .nd-voice')?.innerText.includes('待上传：sample.wav')"));
  assert.equal(voiceUploadCalled, false, '选择参考音频后只暂存待上传，不得提前上传');
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].find(x=>x.textContent==='生成试听').click()");
  await until(() => voicePreviewRequests.length === 1);
  assert.ok(voicePreviewRequests[0].contentType.includes('multipart/form-data') && voicePreviewRequests[0].hasPayload && voicePreviewRequests[0].hasFile, '待上传录音试听应发送 multipart FormData');
  assert.equal(voiceUploadCalled, false);
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .nd-voice button')].find(x=>x.textContent==='保存声音配置').click()");
  await until(() => voicePutRequests.length === 1 && ev("document.querySelector('.config-role-editor:not([hidden]) .nd-voice-references')?.innerText.includes('sample.wav')"));
  assert.ok(voicePutRequests[0].contentType.includes('multipart/form-data') && voicePutRequests[0].hasFile);
  assert.equal(voiceUploadCalled, false);
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-create-role')"));
  await ev("document.querySelector('.config-create-role').click()");
  await until(() => ev("!!document.querySelector('.config-dialog textarea')"));
  await ev("(()=>{const d=document.querySelector('.config-dialog');const input=d.querySelector('input');const area=d.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'丙角色');input.dispatchEvent(new Event('input',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'丙的设定');area.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("[...document.querySelectorAll('.config-dialog button')].find(x=>x.textContent==='创建角色').click()");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='丙角色'"));
  assert.ok(await ev("document.querySelector('#config-footer-right').textContent.includes('甲角色')"));
  await ev("document.querySelector('.config-switch-role').click()");
  await until(() => ev("!!document.querySelector('.config-poster-hit')"));
  await ev("[...document.querySelectorAll('.config-poster-hit')].find(x=>x.textContent.includes('乙角色')).click()");
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='乙角色'"));
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].some(x=>x.textContent==='删除角色'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='删除角色').click()");
  assert.equal(await ev("document.querySelector('.config-role-editor:not([hidden]) .config-delete-options button')?.disabled"), true, '未选择历史处理方式时不得删除');
  await ev("document.querySelector('.config-role-editor:not([hidden]) .config-delete-options input[type=radio]').click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-delete-options button')].find(x=>x.textContent==='确认删除').click()");
  await until(() => roleDeletes.some(item => item.roleId === 'b' && item.choice === '1'));
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"));
  assert.ok(await ev("document.querySelector('#config-footer-right').textContent.includes('甲角色')"));
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].some(x=>x.textContent==='删除角色'&&!x.disabled)"));
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent==='删除角色').click()");
  await ev("document.querySelectorAll('.config-role-editor:not([hidden]) .config-delete-options input[type=radio]')[1].click()");
  await ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) .config-delete-options button')].find(x=>x.textContent==='确认删除').click()");
  await until(() => roleDeletes.some(item => item.roleId === 'a' && item.choice === '0'));
  await until(() => ev("document.querySelector('.config-footer-ident strong')?.textContent==='丙角色' && document.querySelector('#config-footer-right').textContent.includes('丙角色')"));
  assert.ok(await ev("document.querySelector('.config-delete-notice')?.textContent.includes('尚待清理')"));
  await until(() => ev("[...document.querySelectorAll('.config-role-editor:not([hidden]) button')].find(x=>x.textContent.includes('删除角色'))?.disabled"));
  assert.deepEqual(errors, []); assert.ok(requests.includes('DELETE /v1/resources/x2')); console.log(JSON.stringify({ editIsolation: true, crossPageDraft: true, roleDraft: true, voiceImageDraft: true, activityStop: true, profileSave: true, outfitManagement: true, roleDeleteBothPaths: true, bindingPreservation: true, quotaSave: true, settingsTwoTabs: true, imageServiceCrudAndProbe: true, roleImageDraftProbeAndPreview: true, voiceStagingPreviewAndSave: true, roleCreation: true, modelCreation: true, modelList: true, modelTest: true, extensionManagement: true, night: true, visibleBounds, widths: [1280,1440,720], errors }, null, 2));
}
run().catch(error => { console.error(error, logs.slice(-1200)); process.exitCode = 1; }).finally(async () => { try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 99999, method: 'Browser.close' })); ws.close(); } } catch {} await delay(500); if (proc && proc.exitCode === null) proc.kill(); server.close(); try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('settings-workspace-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {} });
