import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createBackendApp, listen, type BackendApp } from '../../src/bootstrap/app.js';
import { parseBackendConfig } from '../../src/bootstrap/config.js';
import { createFixture } from '../fixtures/conversation-fixture.js';

const imageSettings = (serviceId: string) => ({ serviceId, modelType: 'text2img' as const, modelPath: 'model', basePrompt: '', negativePrompt: '', outfitPrompts: {}, width: 1024, height: 1024, steps: 25, cfg: 2.5, sampler: 'er_sde', scheduler: 'simple', seed: null, workflow: null, outputNodeId: null });
async function api(base: string, method: string, route: string, body?: unknown) {
  const response = await fetch(`${base}${route}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const kind of ['voice', 'image'] as const) {
  test(`${kind} 服务维护只影响依赖角色，删除报告活动使用者`, async () => {
    const fixture = createFixture([], { disablePresetAssistant: true });
    try {
      const { app, roleId } = fixture;
      const base = `http://127.0.0.1:${await listen(app.server, 0, '127.0.0.1')}`;
      const unrelated = app.services.roles.createRole({ displayName: '无关角色', definition: { text: '无关' } });
      app.services.activity.resume(unrelated.roleId);
      const service = kind === 'voice'
        ? app.services.voiceServices.create({ name: '语音', config: { protocol: 'nowadays-tts-v1', baseUrl: 'http://localhost:9000' } })
        : app.services.imageServices.create({ name: '生图', config: { protocol: 'comfyui', baseUrl: 'http://localhost:9001' } });
      app.services.activity.requestStop(roleId);
      if (kind === 'voice') app.services.voice.saveVoice(roleId, { serviceId: service.serviceId, voiceSource: { kind: 'preset', voiceId: 'voice' } });
      else app.services.sceneImageSettings.save(roleId, imageSettings(service.serviceId));
      app.services.activity.resume(roleId);
      const url = `/v1/${kind}-services/${service.serviceId}`;
      const nameOnly = await api(base, 'PATCH', url, { name: '改名' });
      assert.equal(nameOnly.status, 200);
      assert.deepEqual(nameOnly.body.maintenance, { connectionChanged: false, pausedRoleIds: [] });
      assert.equal(app.services.activity.view(roleId).state, 'active');
      const harmless = kind === 'voice'
        ? { protocol: 'nowadays-tts-v1', baseUrl: 'http://localhost:9000/', defaultEngine: 'cosyvoice' }
        : { protocol: 'comfyui', baseUrl: 'http://localhost:9001/', modelName: 'new-model' };
      const defaults = await api(base, 'PATCH', url, { config: harmless });
      assert.equal(defaults.status, 200);
      assert.equal(defaults.body.maintenance.connectionChanged, false);
      assert.equal(app.services.activity.view(roleId).state, 'active');
      if (kind === 'image') {
        const noChange = await api(base, 'PATCH', url, { config: { ...harmless, timeoutMs: 180000 }, secret: null });
        assert.equal(noChange.status, 200);
        assert.equal(noChange.body.maintenance.connectionChanged, false);
        assert.equal(app.services.activity.view(roleId).state, 'active');
      }
      const blocked = await api(base, 'DELETE', url);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, 'MEDIA_SERVICE_IN_USE');
      assert.deepEqual(blocked.body.error.details.roles.map((role: any) => role.roleId), [roleId]);
      const changed = await api(base, 'PATCH', url, { enabled: false });
      assert.equal(changed.status, 200);
      assert.deepEqual(changed.body.maintenance.pausedRoleIds, [roleId]);
      assert.equal(app.services.activity.view(roleId).state, 'stopped');
      assert.equal(app.services.activity.view(unrelated.roleId).state, 'active');
      const enabled = await api(base, 'PATCH', url, { enabled: true });
      assert.equal(enabled.status, 200);
      assert.deepEqual(enabled.body.maintenance.pausedRoleIds, []);
      const deleted = await api(base, 'DELETE', url);
      assert.equal(deleted.status, 200);
      assert.equal(app.services.activity.view(unrelated.roleId).state, 'active');
    } finally { await fixture.close(); }
  });

  test(`${kind} 维护阻止新调用、改绑和恢复并等待已领取调用`, async () => {
    const fixture = createFixture([], { disablePresetAssistant: true });
    let release: (() => void) | undefined;
    try {
      const { app, roleId } = fixture;
      const base = `http://127.0.0.1:${await listen(app.server, 0, '127.0.0.1')}`;
      const service = kind === 'voice'
        ? app.services.voiceServices.create({ name: '语音', config: { protocol: 'nowadays-tts-v1', baseUrl: 'http://localhost:9000' } })
        : app.services.imageServices.create({ name: '生图', config: { protocol: 'comfyui', baseUrl: 'http://localhost:9001' } });
      app.services.activity.requestStop(roleId);
      if (kind === 'voice') app.services.voice.saveVoice(roleId, { serviceId: service.serviceId, voiceSource: { kind: 'preset', voiceId: 'voice' } });
      else app.services.sceneImageSettings.save(roleId, imageSettings(service.serviceId));
      app.services.activity.resume(roleId);
      release = app.services.mediaMaintenance.claim(kind, service.serviceId, roleId);
      const config = kind === 'voice' ? { protocol: 'nowadays-tts-v1', baseUrl: 'http://localhost:9010' } : { protocol: 'comfyui', baseUrl: 'http://localhost:9011' };
      const update = api(base, 'PATCH', `/v1/${kind}-services/${service.serviceId}`, { config });
      for (let i = 0; i < 100 && app.services.activity.view(roleId).state !== 'stopped'; i++) await delay(10);
      assert.equal(app.services.activity.view(roleId).state, 'stopped');
      assert.throws(() => app.services.activity.resume(roleId), { code: 'MEDIA_SERVICE_MAINTENANCE' });
      assert.throws(() => app.services.mediaMaintenance.claim(kind, service.serviceId, roleId), { code: 'MEDIA_SERVICE_MAINTENANCE' });
      if (kind === 'voice') assert.throws(() => app.services.voice.saveVoice(roleId, { serviceId: service.serviceId, voiceSource: { kind: 'preset', voiceId: 'voice' } }), { code: 'MEDIA_SERVICE_MAINTENANCE' });
      else assert.throws(() => app.services.sceneImageSettings.save(roleId, imageSettings(service.serviceId)), { code: 'MEDIA_SERVICE_MAINTENANCE' });
      const concurrent = await api(base, 'PATCH', `/v1/${kind}-services/${service.serviceId}`, { name: '并发改名' });
      assert.equal(concurrent.status, 409);
      release(); release = undefined;
      const result = await update;
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.maintenance.pausedRoleIds, [roleId]);
      app.services.activity.resume(roleId);
    } finally { release?.(); await fixture.close(); }
  });

  test(`${kind} 停用后重启只允许原角色保留原绑定并保存其他字段`, async () => {
    const fixture = createFixture([], { disablePresetAssistant: true });
    let restarted: BackendApp | undefined;
    try {
      const { app, roleId } = fixture;
      const create = (name: string) => kind === 'voice'
        ? app.services.voiceServices.create({ name, config: { protocol: 'nowadays-tts-v1', baseUrl: 'http://localhost:9000' } })
        : app.services.imageServices.create({ name, config: { protocol: 'comfyui', baseUrl: 'http://localhost:9001' } });
      const first = create('原服务');
      const second = create('另一项服务');
      const otherRole = app.services.roles.createRole({ displayName: '其他角色', definition: { text: '其他角色' } });
      const suffix = kind === 'voice' ? 'voice' : 'scene-image';
      const settingsRoute = (id: string) => `/v1/roles/${id}/${suffix}`;
      const body = (serviceId: string, changed = false) => kind === 'voice'
        ? { serviceId, voiceSource: { kind: 'preset', voiceId: 'voice' }, speed: changed ? 1.2 : 1 }
        : { ...imageSettings(serviceId), width: changed ? 768 : 1024 };
      const base = `http://127.0.0.1:${await listen(app.server, 0, '127.0.0.1')}`;
      app.services.activity.requestStop(roleId);
      app.services.activity.requestStop(otherRole.roleId);
      assert.equal((await api(base, 'PUT', settingsRoute(roleId), body(first.serviceId))).status, 200);
      const serviceRoute = (id: string) => `/v1/${kind}-services/${id}`;
      for (const item of [first, second]) assert.equal((await api(base, 'PATCH', serviceRoute(item.serviceId), { enabled: false })).status, 200);
      await app.close();

      restarted = createBackendApp(parseBackendConfig(['--app-root', fixture.root, '--port', '0']), { disablePresetAssistant: true, disableMemoryRuntime: true });
      const after = `http://127.0.0.1:${await listen(restarted.server, 0, '127.0.0.1')}`;
      restarted.services.activity.requestStop(roleId);
      restarted.services.activity.requestStop(otherRole.roleId);
      const kept = await api(after, 'PUT', settingsRoute(roleId), body(first.serviceId, true));
      assert.equal(kept.status, 200);
      if (kind === 'voice') {
        assert.equal(kept.body.voice.serviceId, first.serviceId);
        assert.equal(kept.body.voice.speed, 1.2);
        assert.equal((await api(after, 'PUT', `${settingsRoute(roleId)}/enabled`, { enabled: true })).body.error.code, 'VOICE_SERVICE_DISABLED');
      } else {
        assert.equal(kept.body.settings.serviceId, first.serviceId);
        assert.equal(kept.body.settings.width, 768);
        assert.equal(kept.body.configured, false);
      }
      const disabledCode = `${kind.toUpperCase()}_SERVICE_DISABLED`;
      assert.equal((await api(after, 'PUT', settingsRoute(roleId), body(second.serviceId))).body.error.code, disabledCode);
      assert.equal((await api(after, 'PUT', settingsRoute(otherRole.roleId), body(first.serviceId))).body.error.code, disabledCode);
      restarted.services.activity.resume(roleId);
      assert.equal((await api(after, 'POST', `${settingsRoute(roleId)}/preview`, kind === 'voice' ? { text: '试听' } : {})).body.error.code, disabledCode);
      restarted.services.activity.requestStop(roleId);
      assert.equal((await api(after, 'DELETE', serviceRoute(first.serviceId))).status, 200);
      assert.equal((await api(after, 'PUT', settingsRoute(roleId), body(first.serviceId))).body.error.code, `${kind.toUpperCase()}_SERVICE_NOT_FOUND`);
    } finally { await restarted?.close(); await fixture.close(); }
  });
}


test('真实语音试听在途时媒体维护等待调用结算', async () => {
  let entered!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  let complete!: () => void;
  const held = new Promise<void>(resolve => { complete = resolve; });
  const upstream = http.createServer(async (_req, res) => { entered(); await held; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"offline test"}'); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const fixture = createFixture([], { disablePresetAssistant: true });
  try {
    const { app, roleId } = fixture;
    const base = `http://127.0.0.1:${await listen(app.server, 0, '127.0.0.1')}`;
    const service = app.services.voiceServices.create({ name: '待完成语音', config: { protocol: 'nowadays-tts-v1', baseUrl: `http://127.0.0.1:${address.port}` } });
    app.services.activity.requestStop(roleId);
    app.services.voice.saveVoice(roleId, { serviceId: service.serviceId, voiceSource: { kind: 'preset', voiceId: 'voice' } });
    app.services.activity.resume(roleId);
    const preview = app.services.voice.preview(roleId, { text: '试听' }).then(() => 'ok', () => 'failed');
    await requested;
    let completed = false;
    const update = api(base, 'PATCH', `/v1/voice-services/${service.serviceId}`, { enabled: false }).then(result => { completed = true; return result; });
    await delay(250);
    assert.equal(completed, false, '在途试听未结算时不得提交停用');
    assert.equal(app.services.activity.view(roleId).state, 'stopped');
    complete();
    assert.equal(await preview, 'failed');
    const result = await update;
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.maintenance.pausedRoleIds, [roleId]);
  } finally { complete(); await fixture.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
