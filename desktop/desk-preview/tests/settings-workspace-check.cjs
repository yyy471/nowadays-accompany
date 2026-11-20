'use strict';
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { resolveElectronExecutable } = require('./electron-executable.cjs');
const { button, configControls, editor, element, setValue, sheet } = require('./config-page-controls.cjs');
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
const resources = [{ resourceId: 'm1', kind: 'model', name: '测试模型', enabled: true, config: { protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1234', modelName:'local-model' }, credential: { status: 'missing' }, lastTest: null }, { resourceId: 'x1', kind: 'mcp', name: '文件工具', enabled: true, config: { command: 'node', args: [], env: {} } }];
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
const voiceServices = [];
let nextVoiceServiceId = 1;
let pendingVoiceCreate = null;
const voiceServiceProbes = [];
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
  if (role && p.endsWith('/activity')) return json(res, { activity: { roleId: role.roleId, state: roleStates[role.roleId], running: false, initStatus: 'ready' } });
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
  if (p === '/v1/voice-services/probe' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    return req.on('end', () => {
      const data = JSON.parse(body || '{}'); voiceServiceProbes.push(data);
      json(res, { probe: { protocol: 'nowadays-tts-v1', service: 'mock-tts', model: 'v2', ready: true, engines: { cosyvoice: { ready: true, active: true, onDemand: true }, indextts: { ready: false, active: false, onDemand: true } }, defaultEngine: 'cosyvoice', capabilities: { referenceModes: [{ id: 'zero_shot', label: '零样本', requiresReferenceText: true }, { id: 'cross_language', label: '跨语种', requiresReferenceText: false }], presetVoices: false, languages: ['zh', 'en'], speed: { min: 0.5, max: 2 } }, voices: null }, elapsedMs: 5 });
    });
  }
  const voiceProbeMatch = /^\/v1\/voice-services\/([^/]+)\/probe$/.exec(p);
  if (voiceProbeMatch && req.method === 'POST') {
    const svc = voiceServices.find(item => item.serviceId === voiceProbeMatch[1]);
    if (!svc) return json(res, { error: { code: 'VOICE_SERVICE_NOT_FOUND', message: '语音服务不存在' } }, 404);
    voiceServiceProbes.push({ serviceId: svc.serviceId });
    return json(res, { probe: { protocol: 'nowadays-tts-v1', service: 'mock-tts', model: 'v2', ready: true, engines: { cosyvoice: { ready: true, active: true, onDemand: true }, indextts: { ready: false, active: false, onDemand: true } }, defaultEngine: 'cosyvoice', capabilities: { referenceModes: [{ id: 'zero_shot', label: '零样本', requiresReferenceText: true }, { id: 'cross_language', label: '跨语种', requiresReferenceText: false }], presetVoices: false, languages: ['zh', 'en'], speed: { min: 0.5, max: 2 } }, voices: null }, elapsedMs: 6 });
  }
  const voiceServiceMatch = /^\/v1\/voice-services\/([^/]+)$/.exec(p);
  if (voiceServiceMatch) {
    const svc = voiceServices.find(item => item.serviceId === voiceServiceMatch[1]);
    if (!svc) return json(res, { error: { code: 'VOICE_SERVICE_NOT_FOUND', message: '语音服务不存在' } }, 404);
    if (roles.some(item => roleStates[item.roleId] !== 'stopped')) return json(res, { error: { code: 'ROLES_NOT_STOPPED', message: '角色尚未全部停止' } }, 409);
    if (req.method === 'PATCH') {
      let body = ''; req.on('data', c => body += c);
      return req.on('end', () => {
        const data = JSON.parse(body);
        if (typeof data.name === 'string') svc.name = data.name;
        if (typeof data.enabled === 'boolean') svc.enabled = data.enabled;
        if (data.config) svc.config = { ...data.config };
        json(res, { service: svc });
      });
    }
    if (req.method === 'DELETE') { voiceServices.splice(voiceServices.indexOf(svc), 1); return json(res, { deleted: true, serviceId: svc.serviceId }); }
  }
  if (p === '/v1/voice-services' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    return req.on('end', () => {
      const data = JSON.parse(body);
      const created = { serviceId: `voice-${nextVoiceServiceId++}`, name: data.name, enabled: data.enabled ?? true, config: { ...data.config }, createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z' };
      const reply = () => { voiceServices.push(created); json(res, { service: created }, 201); };
      if (pendingVoiceCreate && !pendingVoiceCreate.release) {
        pendingVoiceCreate.release = reply;
        pendingVoiceCreate.arrived();
        return;
      }
      reply();
    });
  }
  if (p === '/v1/voice-services') return json(res, { items: voiceServices });
  if (p.endsWith('/voice') && req.method === 'PUT' && role) {
    return readRaw(req, raw => {
      const text = raw.toString('utf8');
      const ct = req.headers['content-type'] || '';
      const m = /name="payload"\r\n\r\n([\s\S]*?)\r\n--/.exec(text);
      const data = m ? JSON.parse(m[1]) : JSON.parse(text);
      const svc = data.serviceId ? voiceServices.find(item => item.serviceId === data.serviceId) || null : null;
      const hasFile = text.includes('filename="sample.wav"');
      voicePutRequests.push({ contentType: ct, hasFile, data });
      let ref = null;
      if (hasFile) {
        ref = { assetId: `ref-${voiceReferences[role.roleId].length + 1}`, fileName: 'sample.wav', mediaType: 'audio/wav', createdAt: '2026-11-14T00:00:00Z' };
        voiceReferences[role.roleId] = [{ ...ref, inUse: true }];
      }
      voices[role.roleId] = {
        serviceId: svc ? svc.serviceId : null,
        service: svc ? { serviceId: svc.serviceId, name: svc.name, enabled: svc.enabled, protocol: svc.config.protocol, baseUrl: svc.config.baseUrl, defaultEngine: svc.config.defaultEngine } : null,
        engine: svc ? svc.config.protocol : (data.protocol || 'nowadays-tts-v1'),
        protocol: svc ? svc.config.protocol : (data.protocol || 'nowadays-tts-v1'),
        ttsEngine: data.ttsEngine || null,
        defaultEngine: svc?.config.defaultEngine || null,
        baseUrl: svc ? svc.config.baseUrl : data.baseUrl,
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
      const created = { serviceId: `img-${nextImageServiceId++}`, name: data.name, enabled: data.enabled ?? true, config: { protocol: 'comfyui', baseUrl: data.config.baseUrl, timeoutMs: 15000, ...(data.config.modelName ? { modelName: data.config.modelName } : {}), ...(data.secret ? { credentialRef: 'cred-img' } : {}) }, credential: { status: data.secret ? 'stored' : 'missing' } };
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
  if (p.endsWith('/model-test') || p === '/v1/model-services/test') return json(res, { ok: true, elapsedMs: 1, fingerprint: 'fixture' });
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
const { click, pickRole, tab, openRoleRow, openSheet } = configControls(ev, until);
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, NOWADAYS_BACKEND_URL: `http://127.0.0.1:${server.address().port}`, NOWADAYS_APP_ROOT: path.join(temp, 'data'), NOWADAYS_SKIP_ROLE_PICKER: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(resolveElectronExecutable({ repoRoot: root }), ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, path.join(root, 'desktop/desk-preview')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', x => logs += x); proc.stderr.on('data', x => logs += x);
  let port; await until(() => port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(logs)?.[1]);
  let target; await until(async () => target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.url.startsWith('desk://bundle/')));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if (msg.id) { const job = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? job?.reject(msg.error) : job?.resolve(msg.result); } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text); };
  await cmd('Runtime.enable'); await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => ev("!!document.querySelector('.ui-menu-trigger')"));
  await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev("[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes('角色配置'))"));
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes('角色配置')).click()");
  await until(() => ev("!!document.querySelector('.config-role-editor:not([hidden]) textarea')"));
  await until(() => ev("!!document.querySelector('.config-stage img')"));
  await delay(450);
  assert.ok(await ev("document.querySelector('.config-footer-ident strong')?.textContent==='甲角色'"), '当前编辑角色应为甲角色（包 3 起右页脚为切换按钮，不再显示陪伴名）');
  const visibleBounds = await ev("(()=>{const book=document.querySelector('.config-book').getBoundingClientRect(),last=document.querySelector('.config-tabs button:last-child').getBoundingClientRect(),button=document.querySelector('.config-role-switch').getBoundingClientRect();return {bookBottom:book.bottom,lastBottom:last.bottom,switchBottom:button.bottom,innerHeight}})()");
  assert.ok(visibleBounds.lastBottom <= visibleBounds.bookBottom && visibleBounds.switchBottom <= visibleBounds.innerHeight, JSON.stringify(visibleBounds));
  const portraitRect = await ev("(()=>{const r=document.querySelector('.config-stage .config-portrait').getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}})()");
  const beforeTheme = await pixels();
  await ev("[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('晚风电台')).click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.uiPreset==='nightwave'"));
  await delay(350); const duringTheme = await pixels();
  await delay(750); const afterTheme = await pixels();
  const midDiff = compareRect(beforeTheme, duringTheme, portraitRect), endDiff = compareRect(beforeTheme, afterTheme, portraitRect);
  await ev("[...document.querySelectorAll('.ui-theme-switcher button')].find(x=>x.textContent.includes('白昼来信')).click()");
  await until(() => ev("document.querySelector('.studio-shell').dataset.uiPreset==='daylight'")); await delay(1000);
  await cmd('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:'reduce' }] });
  await pickRole("b");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) textarea')?.value==='乙角色设定'"));
  assert.ok(await ev("document.querySelector('.config-footer-ident strong')?.textContent==='乙角色'"), '切换角色后编辑对象应为乙角色（DL-147：编辑对象独立于当前角色）');
  // DL-147：切换编辑对象不得改变「当前角色」。主页英雄区展示当前角色名，用它做可见断言。
  await ev("[...document.querySelectorAll('.ui-dock-item')].find(x=>x.textContent.includes('桌面')).click()");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='home'"), 'home-after-edit-switch');
  assert.ok(await ev("document.querySelector('.home-account h2')?.textContent?.trim()==='甲角色'"), '编辑对象切到乙角色后，当前角色（主页英雄区）仍应为甲角色');
  // 回到角色配置继续后续草稿流程；编辑对象应仍是乙。
  await ev("document.querySelector('.ui-menu-trigger').click()");
  await until(() => ev("[...document.querySelectorAll('.ui-menu-item')].some(x=>x.textContent.includes('角色配置'))"));
  await ev("[...document.querySelectorAll('.ui-menu-item')].find(x=>x.textContent.includes('角色配置')).click()");
  await until(() => ev("document.querySelector('.config-role-editor:not([hidden]) textarea')?.value==='乙角色设定'"), 'back-to-edit-b');
  const field = selector => element(`${sheet} ${selector}`);
  const body = '.config-leaf-body > .config-prose:not([hidden])';
  const actions = sheet + ' .config-sheet-actions';
  const sheetButton = label => button(label, sheet);
  const value = (selector, next) => ev(setValue(field(selector), next));
  const setProfile = text => ev(setValue(element(`${editor} textarea[aria-label="角色设定"]`), text));
  const modelName = 'input[role=combobox]';
  const heading = text => until(() => ev(`${element(body + ' h2')}?.textContent===${JSON.stringify(text)}`));
  const sheetTitle = text => until(() => ev(`${field('h3')}?.textContent===${JSON.stringify(text)}`));
  const sheetText = text => until(() => ev(`${element(sheet)}?.innerText.includes(${JSON.stringify(text)})`));
  const closed = () => until(() => ev(`!${element(`${sheet},.config-book-scrim,.config-leaf-body[inert]`)}`));
  const save = async (scope = actions) => click(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(button=>/^(?:暂停并|重试)?保存(?: *[0-9]+)?$/.test(button.textContent.trim()))`);
  const close = async () => { await click(field('.config-sheet-x')); await closed(); };
  const discard = () => click(button('放弃修改', sheet + ' .config-sheet-confirm'));
  const select = id => click(element(`.config-index-item[data-resource-id="${id}"]`));
  const edit = () => openSheet(element(`${body} .config-service-edit`));
  const add = title => openSheet(element('.config-index .config-index-new'), title);
  const kind = async text => {
    await click(button(text, '.config-kind-tabs'));
    await until(() => ev(`document.querySelector('.config-kind-tabs button[aria-pressed=true]')?.textContent===${JSON.stringify(text)}`));
  };
  const returnRole = async () => {
    await closed();
    await until(() => ev(`(() => {
      if(document.querySelector('.studio-shell')?.dataset.page==='role-config')return true;
      const link=document.querySelector('.config-return-link');
      if(link && !link.disabled)link.click();
      return false;
    })()`));
  };
  const poster = name => `[...document.querySelectorAll('.config-status-poster')].find(item=>item.querySelector('.config-status-name')?.textContent===${JSON.stringify(name)})`;
  const openModelSettings = async () => {
    await tab('模型');
    await openRoleRow('model:chat');
    await click(sheetButton('在设置中查看模型 →'));
    await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"));
  };
  const isPicked = name => until(() => ev(`document.querySelector('.config-footer-ident strong')?.textContent===${JSON.stringify(name)}`));
  const setFields = async entries => {
    for (const [selector, next] of entries) await value(selector, next);
  };
  async function openModelOptions(count) {
    await ev(`${field(modelName)}.focus();${field(modelName)}.click()`);
    await until(() => ev(`document.querySelectorAll('${sheet} .nd-model-options [role=option]').length===${count}`));
  }
  async function chooseModel(model, count) {
    await openModelOptions(count);
    await ev(`[...document.querySelectorAll('${sheet} .nd-model-options [role=option] button')].find(option=>option.textContent===${JSON.stringify(model)}).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`);
    await until(() => ev(`${field(modelName)}?.value===${JSON.stringify(model)}`));
  }
  const image = sheet + ' .nd-image';
  const voice = sheet + ' .nd-voice';
  const startPath = path.join(root, 'desktop/desk-preview/renderer/src/assets/themes/xiacheng/character.png');
  await setProfile('乙的未保存草稿');
  await until(() => ev("!!document.querySelector('.config-tabs [aria-current=page] .tab-dot')"));
  await pickRole('a');
  await sheetTitle('切换角色');
  await click(sheetButton('取消'));
  await closed();
  await isPicked('乙角色');
  assert.equal(await ev(`${element(editor + ' textarea')}.value`), '乙的未保存草稿', '取消切换保留设定草稿');
  await pickRole('a');
  await sheetTitle('切换角色');
  await click(sheetButton('放弃并切换'));
  await isPicked('甲角色');
  await pickRole('b');
  await until(() => ev(`${element(editor + ' textarea')}?.value==='乙角色设定'`));
  await setProfile('乙已修改的设定');
  await click(element('.ui-menu-trigger:not([aria-expanded=true])'));
  await click(button('设置', '.ui-menu-panel:not([inert])'));
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"));
  await tab('角色');
  await click(`${poster('乙角色')}.querySelector('button')`);
  await until(() => roleStates.b === 'stopped');
  await until(() => ev(`${poster('乙角色')}?.dataset.state==='stopped'`));
  await returnRole();
  await tab('设定');
  assert.equal(await ev(`${element(editor + ' textarea')}?.value`), '乙已修改的设定', '访问设置并停止活动后，未离开整个工作区的设定草稿仍在');
  await save('.config-leaf-foot');
  await until(() => definitions.b === '乙已修改的设定' && roleStates.b === 'stopped');
  await shot('role-1280.png');

  // 外观：改名、预览差分、替换立绘、删除差分和服饰、最后一套守卫。
  await tab('外观');
  const outfit = name => element(`${editor} button[aria-label="编辑服饰：${name}"]`);
  await openSheet(outfit('测试立绘'), '编辑服饰');
  await value('input[data-sheet-focus]', '改名服饰');
  await save();
  await until(() => wardrobes.b[0].name === '改名服饰');
  await closed();
  await openSheet(outfit('改名服饰'), '编辑服饰');
  await click(field('.config-face'));
  await until(() => ev("document.querySelector('.config-stage .config-portrait img')?.getAttribute('src')?.includes('sprite-1')"));
  const doc = await cmd('DOM.getDocument');
  const homeInput = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `${sheet} input[type=file]:nth-of-type(2)` });
  await cmd('DOM.setFileInputFiles', { nodeId: homeInput.nodeId, files: [startPath] });
  await until(() => wardrobes.b[0].home.assetId === 'home-new');
  await click(button('删除', sheet + ' .config-sprite-list'));
  await click(button('删除', actions));
  await until(() => wardrobes.b[0].sprites.length === 0);
  await click(sheetButton('删除服饰…'));
  await click(button('删除', actions));
  await until(() => wardrobes.b.length === 1);
  await closed();
  await openSheet(outfit('另一套'), '编辑服饰');
  await until(() => ev(`${sheetButton('删除服饰…')}?.disabled`));
  assert.match(await ev(`${element(sheet)}.innerText`), /至少保留一套服饰/);
  await close();
  await tab('设定');
  await pickRole('a');
  await until(() => ev(`${element(editor + ' textarea')}?.value==='甲角色设定'`));
  await pickRole('b');
  await until(() => ev(`${element(editor + ' textarea')}?.value==='乙已修改的设定'`));

  await tab('模型');
  await openRoleRow('model:chat');
  await value('select', 'm1');
  await value(modelName, 'local-model');
  await save();
  await until(() => bindings.b.some(item => item.capability === 'chat_model' && item.modelName === 'local-model'));
  await closed();
  await tab('扩展');
  await openRoleRow('ext:mcp');
  await click(field('[role=switch][aria-label="为角色开启文件工具"]'));
  await save();
  await until(() => bindings.b.some(item => item.capability === 'mcp' && !item.enabled));
  assert.ok(bindings.b.some(item => item.capability === 'chat_model'));
  await closed();
  await tab('额度');
  await openRoleRow('quota');
  for (const invalid of ['0', '1.5', '', '1000001']) {
    await value('input[type=number]', invalid);
    await sheetText('请输入 1–1000000 的整数');
    assert.equal(await ev(`${button('保存', actions)}?.disabled`), true, '非法额度不能提交');
  }
  await click(field('input[type=checkbox]'));
  await until(() => ev(`!${element(sheet)}?.innerText.includes('请输入 1–1000000 的整数')`));
  assert.equal(await ev(`!!${element(`${actions} .config-save-btn:not(:disabled)`)}`), true, '不限制时无需校验每日限额');
  await click(field('input[type=checkbox]'));
  await value('input[type=number]', '350');
  await save();
  await until(() => budgets.b.dailyLimit === 350);
  await closed();

  // 模型列表与测试日志、跨页 T9、只在明确点击时显示密钥、保留密钥不提交。
  await openModelSettings();
  await heading('测试模型');
  await edit();
  await click(sheetButton('读取列表'));
  await sheetText('已读取 1 个模型');
  await value(modelName, 'local-model');
  await click(button('测试连接', sheet + ' .config-grp:has(input[role=combobox])'));
  await sheetText('测试通过');
  assert.ok(!(await ev(`${element(sheet)}.innerText`)).includes('已读取 1 个模型'), '测试日志应覆盖列表日志');
  assert.equal(await ev(`${element(`${actions} .config-save-btn`)}?.disabled`), true, '读取列表与测试不点亮保存');
  await close();
  await shot('settings-1280.png');
  await tab('角色');
  await click(`${poster('甲角色')}.querySelector('button')`);
  await until(() => roleStates.a === 'stopped');
  await until(() => ev(`${poster('甲角色')}?.dataset.state==='stopped'`));
  await tab('模型');
  await edit();
  assert.ok(!(await ev(`${element(sheet)}.innerText`)).includes('测试通过 ·'), '重开纸笺不保留旧测试点击日志');
  const name = 'input[aria-label="模型服务名称"]';
  const secret = 'input[aria-label="模型密钥"]';
  await value(name, '模型待保存');
  await sheetText('1 处改动未保存');
  await click(element('.config-return-link'));
  await until(() => ev("!!document.querySelector('.config-sheet-confirm')"));
  await discard();
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"));
  await openModelSettings();
  await heading('测试模型');
  await edit();
  assert.equal(await ev(`${field(name)}.value`), '测试模型', '放弃设置纸笺恢复保存值');
  await setFields([[name, '模型待保存'], [secret, 'secret-value']]);
  await save();
  await until(() => modelPatches.length === 1 && resources[0].name === '模型待保存');
  assert.equal(savedModelBody.secret, 'secret-value');
  await closed();
  await edit();
  await until(() => ev(`${field(secret)}?.type==='password' && ${field(secret)}?.value==='************'`));
  await click(sheetButton('显示'));
  await until(() => ev(`${field(secret)}?.type==='text' && ${field(secret)}?.value==='secret-value'`));
  await click(sheetButton('隐藏'));
  await until(() => ev(`${field(secret)}?.type==='password' && ${field(secret)}?.value==='************'`));
  await value(name, '模型保留密钥');
  await save();
  await until(() => modelPatches.length === 2);
  assert.equal(Object.hasOwn(savedModelBody, 'secret'), false);
  await closed();
  await add('添加模型服务');
  await setFields([['input[placeholder="起一个好认的名字"]', '新模型'], ['.config-connection input', 'http://127.0.0.1:9000'], ['input[type=password]', 'secret'], [modelName, 'gemini-2.5-flash']]);
  await click(sheetButton('添加'));
  await heading('新模型');
  await until(() => ev(`${element(`${body} [data-service-group=模型]`)}?.innerText.includes('gemini-2.5-flash')`));
  assert.ok(!(await ev('document.body.innerText')).includes('secret'), '密钥不应显示在正文');
  await click(button('删除模型服务…'));
  await click(sheetButton('删除'));
  await until(() => !resources.some(item => item.resourceId === 'm2'));

  // MCP/Skill 创建、编辑、引用守卫、全局停用与删除，关联模型应保留。
  bindings.b.find(item => item.capability === 'mcp').enabled = true;
  await tab('MCP');
  await heading('文件工具');
  await until(() => ev(`${button('删除 MCP…')}?.disabled`));
  await edit();
  await value('input', '有引用时不可写入');
  await sheetText('请先解除正在使用的绑定或任务。');
  assert.match(await ev(`${field('.config-save-btn')}?.textContent`), /保存\s*1/);
  await until(() => ev(`${field('.config-save-btn')}?.disabled`));
  await click(field('.config-sheet-x'));
  await discard();
  await closed();
  bindings.b.find(item => item.capability === 'mcp').enabled = false;
  await tab('模型');
  await tab('MCP');
  const group = (label, selector) => `[...document.querySelectorAll('${sheet} .config-grp')].find(group=>group.querySelector('.config-grp-label b')?.textContent===${JSON.stringify(label)})?.querySelector(${JSON.stringify(selector)})`;
  await add('添加 MCP');
  await ev(setValue(group('名称', 'input'), '临时工具'));
  await ev(setValue(group('启动', 'input'), 'node'));
  await click(sheetButton('添加'));
  await heading('临时工具');
  await edit();
  await ev(setValue(group('启动', 'input'), 'node2'));
  await save();
  await until(() => resources.find(item => item.resourceId === 'x2')?.config.command === 'node2');
  await closed();
  await click(element('[role=switch][aria-label="全局启用临时工具"]'));
  await until(() => resources.find(item => item.resourceId === 'x2')?.enabled === false);
  await click(button('删除 MCP…'));
  await click(sheetButton('删除'));
  await until(() => !resources.some(item => item.resourceId === 'x2'));
  await select('x1');
  await click(button('删除 MCP…'));
  await click(sheetButton('删除'));
  await until(() => !resources.some(item => item.resourceId === 'x1'));
  assert.ok(!bindings.b.some(item => item.resourceId === 'x1') && bindings.b.some(item => item.capability === 'chat_model'), '关闭的扩展删除后保留模型绑定');
  await tab('Skill');
  await add('添加 Skill');
  await ev(setValue(group('名称', 'input'), '临时方法'));
  await ev(setValue(group('来源目录', 'input'), 'C:/fixture/skill'));
  await click(sheetButton('添加'));
  await heading('临时方法');
  assert.equal(resources.find(item => item.resourceId === 'x3').config.sourcePath, 'C:/fixture/skill');

  // 挂起创建语音服务响应，验证返回按钮在途挡住导航，完成后可返回并带入探测缓存。
  await tab('模型');
  assert.deepEqual(await ev("[...document.querySelectorAll('.config-kind-tabs button')].map(x=>x.textContent)"), ['模型', '语音', '生图']);
  await kind('语音');
  await add('添加语音服务');
  await setFields([['input[aria-label="语音服务名称"]', '本机测试语音'], ['input[aria-label="语音服务地址"]', 'http://127.0.0.1:8880']]);
  await click(sheetButton('探测服务'));
  await until(() => voiceServiceProbes.length === 1);
  await sheetText('探测到');
  await value('select[aria-label="默认语音引擎"]', 'cosyvoice');
  const voiceCreateArrived = new Promise(resolve => { pendingVoiceCreate = { arrived: resolve, release: null }; });
  await click(sheetButton('添加'));
  await until(() => pendingVoiceCreate?.release);
  await voiceCreateArrived;
  const releaseVoiceCreate = pendingVoiceCreate.release;
  pendingVoiceCreate = null;
  try {
    await ev(`${element('.config-return-link')}.click()`);
    assert.equal(await ev("document.querySelector('.studio-shell')?.dataset.page"), 'settings', '写入期间返回不能卸载纸笺');
    assert.equal(await ev(`${field('h3')}?.textContent`), '添加语音服务');
  } finally { releaseVoiceCreate(); }
  await heading('本机测试语音');
  assert.equal(voiceServices[0].config.defaultEngine, 'cosyvoice');
  await returnRole();
  await tab('模型');
  await openRoleRow('media:voice');
  await until(() => ev(`${field('select[aria-label="语音服务"]')}?.value==='voice-1'`));
  await sheetText('mock-tts');
  assert.equal(await ev(`!!${field('.config-save-btn:disabled[aria-label="保存（暂无改动）"]')}`), true, '目录自动填入的语音服务保持未编辑');
  await click(button('在设置中管理 →', voice));
  await heading('本机测试语音');
  await kind('模型');
  await kind('语音');
  assert.equal(await ev(`!!${element(sheet)}`), false, '切分类不回显旧探测纸笺');

  await kind('生图');
  await add('添加生图服务');
  await ev(setValue(group('名称', 'input'), '本机测试生图'));
  await ev(setValue(group('连接', 'input'), 'http://127.0.0.1:8188'));
  await value('input[aria-label="生图密钥"]', 'secret-img');
  await click(sheetButton('读取模型列表'));
  await sheetText('已读取 2 个模型');
  await chooseModel('moss-v1.safetensors', 2);
  await click(button('测试连接', sheet + ' .config-grp:has(input[role=combobox])'));
  await until(() => imageServiceProbes.length === 2);
  await sheetText('已确认模型「moss-v1.safetensors」');
  assert.ok(!(await ev(`${element(sheet)}.innerText`)).includes('已读取 2 个模型'), '单次探测后只显示最新日志');
  await click(sheetButton('添加'));
  await heading('本机测试生图');
  assert.equal(imageServices[0].config.timeoutMs, 15000);
  assert.equal(imageServices[0].config.modelName, 'moss-v1.safetensors');
  await edit();
  await value('input[aria-label="生图服务名称"]', '默认 ComfyUI');
  await value('input[aria-label="生图密钥"]', 'img-secret-2');
  await click(sheetButton('读取模型列表'));
  await until(() => imageServiceProbes.length === 3);
  await save();
  await heading('默认 ComfyUI');
  assert.equal(imageServices[0].config.timeoutMs, 15000, '保存新界面字段时保留既有生图等待上限');
  await edit();
  await click(button('测试连接', sheet + ' .config-grp:has(input[role=combobox])'));
  await until(() => imageServiceProbes.length === 4);
  await sheetText('已确认模型「moss-v1.safetensors」');
  await close();
  await kind('模型');
  await kind('生图');
  await select('img-1');
  await heading('默认 ComfyUI');
  const imageSwitch = element('[role=switch][aria-label="全局启用默认 ComfyUI"]');
  await ev(`(() => {
    const original = window.fetch;
    window.fetch = function(input, options) {
      if (String(input)==='/v1/image-services/img-1' && options?.method==='PATCH') {
        window.fetch = original;
        return new Promise(resolve => {
          window.rejectFixtureToggle = () => resolve(new Response(JSON.stringify({ error: { message: '测试替身写入失败' } }), { status: 503, headers: {'content-type':'application/json'} }));
        });
      }
      return original.call(this,input,options);
    };
  })()`);
  await click(imageSwitch);
  await until(() => ev("typeof window.rejectFixtureToggle==='function'"));
  assert.equal(await ev(`${imageSwitch}?.disabled`), true, '写入期间管理开关禁用');
  await ev('window.rejectFixtureToggle()');
  await until(() => ev(`${imageSwitch}?.checked && !${imageSwitch}?.disabled && document.body.innerText.includes('已恢复原状')`));
  assert.equal(imageServices[0].enabled, true, '点击失败不能写入新启停状态');
  await click(imageSwitch);
  await until(() => imageServices[0].enabled === false);
  await edit();
  await ev(`${field(modelName)}.focus()`);
  assert.equal(await ev(`document.querySelectorAll('${sheet} .nd-model-options [role=option]').length`), 0, '停用生图服务要清空候选');
  await close();
  await click(imageSwitch);
  await until(() => imageServices[0].enabled === true);
  await edit();
  await click(sheetButton('读取模型列表'));
  await until(() => imageServiceProbes.length === 5);
  await sheetText('已读取 2 个模型');
  await close();
  for (const [width,height] of [[1440,840],[720,540]]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth+1'), true, `${width} 横向溢出`);
    const bounds = await ev("(()=>{const a=document.querySelector('.config-book').getBoundingClientRect(),b=document.querySelector('.config-leaf-foot').getBoundingClientRect(),c=document.querySelector('.ui-page-dock').getBoundingClientRect();return {bookBottom:a.bottom,footBottom:b.bottom,dockBottom:c.bottom,height:innerHeight}})()");
    assert.ok(bounds.footBottom<=bounds.bookBottom+1 && bounds.dockBottom<=bounds.height+1, JSON.stringify({width,bounds}));
    await shot(`settings-${width}.png`);
  }
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  await returnRole();
  await tab('模型');
  assert.equal(bindings.b.find(item => item.capability === 'chat_model').resourceId, 'm1');
  await openRoleRow('media:image');
  await until(() => ev(`${field('.nd-image-service-row select')}?.value==='img-1' && ${field(modelName)}?.value==='moss-v1.safetensors'`));
  assert.equal(await ev(`!!${field('.config-save-btn:disabled[aria-label="保存（暂无改动）"]')}`), true, '目录自动填入的生图服务及模型保持未编辑');
  const outfitPrompt = 'input[placeholder="例如：米色风衣，深色长裤"]';
  const basePrompt = 'textarea[aria-label="基础锚点提示词"]';
  assert.ok(await ev(`!!${field(outfitPrompt)}`));
  await openModelOptions(2);
  await ev(`${field(basePrompt)}.focus()`);
  await setFields([[modelName, 'draft-model'], [outfitPrompt, '风衣草稿']]);
  await sheetText('处改动未保存');
  await click(button('在设置中管理 →', image));
  await until(() => ev("!!document.querySelector('.config-sheet-confirm')"));
  await discard();
  await heading('默认 ComfyUI');
  await add('添加生图服务');
  await ev(setValue(group('名称', 'input'), '备用生图'));
  await ev(setValue(group('连接', 'input'), 'http://127.0.0.1:8189'));
  await click(sheetButton('添加'));
  await heading('备用生图');
  await click(button('删除生图服务…'));
  await click(sheetButton('删除'));
  await until(() => imageServices.length === 1);
  await returnRole();
  await openRoleRow('media:image');
  assert.equal(await ev(`${field(modelName)}.value`), 'moss-v1.safetensors');
  assert.notEqual(await ev(`${field(outfitPrompt)}.value`), '风衣草稿');
  await value(outfitPrompt, '风衣草稿');
  await click(button('读取模型列表', image));
  await sheetText('已读取 2 个模型');
  await chooseModel('moss-v2.safetensors', 2);
  await click(button('测试连接', image));
  await sheetText('已确认模型「moss-v2.safetensors」');
  const generateBase = field('button[aria-label="用对话模型生成基础锚点提示词"]');
  await click(generateBase);
  await until(() => ev(`${field(basePrompt)}?.value==='初版基础特征，银发碧眼'`));
  await click(generateBase);
  await until(() => ev(`${field(basePrompt)}?.value==='精修基础特征，银发琥珀瞳'`));
  assert.equal(anchorPromptCalls.at(-1).previousPrompt, '初版基础特征，银发碧眼');
  await click(field('button[aria-label="用对话模型生成「另一套」服饰提示词"]'));
  await until(() => ev(`${field(outfitPrompt)}?.value==='精修服饰：米色长款风衣，黑色短靴'`));
  assert.equal(anchorPromptCalls.at(-1).previousPrompt, '风衣草稿');
  await ev(`${field('.nd-image input[type=file]')}.click=()=>{}`);
  await click(field('button[aria-label="上传参考图生成基础锚点提示词"]'));
  const docImg = await cmd('DOM.getDocument');
  const anchorUpload = await cmd('DOM.querySelector', { nodeId: docImg.root.nodeId, selector: `${image} input[type=file]` });
  await cmd('DOM.setFileInputFiles', { nodeId: anchorUpload.nodeId, files: [startPath] });
  await until(() => ev(`${field(basePrompt)}?.value==='参考图提炼：黑发杏眼，柔和眉眼'`));
  await ev(`delete ${field('.nd-image input[type=file]')}.click`);
  assert.equal(anchorPromptCalls.at(-1).hasUpload, true);
  assert.equal(await ev(`${field(modelName)}.value`), 'moss-v2.safetensors');
  await click(button('测试生图', image));
  await until(() => imagePreviews.length === 1 && ev(`${field('.nd-image-figure img')}?.naturalWidth>0`));
  assert.equal(imagePreviews[0].settings.modelPath, 'moss-v2.safetensors');
  assert.equal(sceneImages.b, undefined, '草稿试生图不落库');
  for (const [width,height] of [[1280,800],[1440,840],[720,540]]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth+1'), true, `role-image ${width} 横向溢出`);
    await shot(`image-${width}.png`);
  }
  await click("[...document.querySelectorAll('.ui-theme-switcher button')].find(item=>item.textContent.includes('晚风电台'))");
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.uiPreset==='nightwave'"));
  await shot('image-night-720.png');
  await save();
  await until(() => !!sceneImages.b);
  await closed();
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await openRoleRow('media:voice');
  await until(() => ev(`${field('select[aria-label="语音服务"]')}?.value==='voice-1'`));
  await sheetText('mock-tts');
  const referenceMode = `[...document.querySelectorAll('${voice} select')].find(select=>[...select.options].some(option=>option.value==='cross_language'))`;
  await ev(setValue(referenceMode, 'cross_language'));
  const docVoice = await cmd('DOM.getDocument');
  const voiceFileInput = await cmd('DOM.querySelector', { nodeId: docVoice.root.nodeId, selector: `${voice} input[type=file]` });
  await cmd('DOM.setFileInputFiles', { nodeId: voiceFileInput.nodeId, files: [sampleWavPath] });
  await sheetText('待上传：sample.wav');
  assert.equal(voiceUploadCalled, false);
  await click(button('生成试听', voice));
  await until(() => voicePreviewRequests.length === 1);
  assert.ok(voicePreviewRequests[0].contentType.includes('multipart/form-data') && voicePreviewRequests[0].hasPayload && voicePreviewRequests[0].hasFile);
  assert.equal(voiceUploadCalled, false);
  await save();
  await until(() => voicePutRequests.length === 1);
  assert.ok(voicePutRequests[0].contentType.includes('multipart/form-data') && voicePutRequests[0].hasFile);
  assert.equal(voiceUploadCalled, false);
  await closed();
  await openRoleRow('media:voice');
  await sheetText('sample.wav');
  await close();

  await pickRole('__new');
  await sheetTitle('新建角色');
  await setFields([['input', '丙角色'], ['textarea', '丙的设定']]);
  await click(sheetButton('创建角色'));
  await isPicked('丙角色');
  await closed();
  await until(() => ev("document.querySelectorAll('.config-scrim,.config-book-scrim').length===0"));
  await pickRole('b');
  await isPicked('乙角色');
  await tab('设定');
  await openSheet(button('删除角色', editor), '删除角色');
  await click(field('input[name=role-delete]:checked'));
  await click(sheetButton('删除'));
  await until(() => roleDeletes.some(item => item.roleId === 'b' && item.choice === '1'));
  await closed();
  await pickRole('a');
  await isPicked('甲角色');
  await openSheet(button('删除角色', editor), '删除角色');
  await click(`document.querySelectorAll('${sheet} input[name=role-delete]')[1]`);
  await click(sheetButton('删除'));
  await until(() => roleDeletes.some(item => item.roleId === 'a' && item.choice === '0'));
  await isPicked('丙角色');
  await until(() => ev("document.querySelector('.config-result-notice')?.textContent.includes('尚待清理')"));
  await until(() => ev(`${button('删除角色', editor)}?.disabled`));
  assert.deepEqual(errors, []);
  assert.ok(requests.includes('DELETE /v1/resources/x2'));
  assert.ok(midDiff.changed < midDiff.checked * .01 && endDiff.changed < endDiff.checked * .01, `立绘随主题变化：${JSON.stringify({midDiff,endDiff})}`);
  console.log(JSON.stringify({ editIsolation:true, profileDiscard:true, activityStop:true, profileSave:true, outfitManagement:true, roleDeleteBothPaths:true, bindingPreservation:true, quotaSave:true, settingsThreeTabs:true, voiceServiceCreateAndProbe:true, imageServiceCrudAndProbe:true, roleImageDraftProbeAndPreview:true, voiceStagingPreviewAndSave:true, roleCreation:true, modelCreation:true, modelList:true, modelTest:true, extensionManagement:true, night:true, visibleBounds, widths:[1280,1440,720], errors }, null, 2));
}
run().catch(async error => {
  console.error(error, errors, logs.slice(-1200));
  if (ws?.readyState === 1) console.error(await ev(`({ page:document.querySelector('.studio-shell')?.dataset.page, sheet:document.querySelector('.config-sheet h3')?.textContent, text:document.body.innerText.slice(-1800) })`).catch(() => null));
  process.exitCode = 1;
}).finally(async () => { try { if (ws?.readyState === 1) { ws.send(JSON.stringify({ id: 99999, method: 'Browser.close' })); ws.close(); } } catch {} await delay(500); if (proc && proc.exitCode === null) proc.kill(); server.close(); try { if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('settings-workspace-')) fs.rmSync(temp, { recursive: true, force: true }); } catch {} });
