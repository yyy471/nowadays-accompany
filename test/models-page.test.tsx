import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { ProviderDto } from '../desktop/renderer/src/types';

vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());

const h = vi.hoisted(() => ({
  cells: [] as any[], index: 0, effects: [] as Array<() => any>, registration: null as any,
  api: vi.fn(), statuses: [] as any[], busy: [] as boolean[]
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = h.index++;
    if (!(index in h.cells)) h.cells[index] = typeof initial === 'function' ? initial() : initial;
    return [h.cells[index], (next: any) => { h.cells[index] = typeof next === 'function' ? next(h.cells[index]) : next; }];
  },
  useRef: (initial: any) => { const index = h.index++; return h.cells[index] ??= { current: initial }; },
  useMemo: (factory: () => any) => factory(),
  useEffect: (effect: () => any, deps: unknown[]) => {
    const index = h.index++; const previous = h.cells[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) h.effects.push(effect);
    h.cells[index] = deps;
  }
}));
vi.mock('../desktop/renderer/src/api', () => ({ api: (...args: any[]) => h.api(...args), appVersion: 'fixture' }));
vi.mock('../desktop/renderer/src/hooks', () => ({ errorMessage: (error: Error) => error.message }));
vi.mock('../desktop/renderer/src/lib/use-draft-registration', () => ({ useDraftRegistration: (value: any) => { h.registration = value; } }));
vi.mock('../desktop/renderer/src/components/ProviderManager', () => ({ ProviderManager: 'ProviderManager' }));
vi.mock('../desktop/renderer/src/ui', () => ({
  Button: 'Button', Checkbox: 'Checkbox', ConfirmButton: 'ConfirmButton', ErrorNote: 'ErrorNote',
  Field: 'Field', Icon: 'Icon', Input: 'Input', Select: 'Select', Tag: 'Tag'
}));

import { ModelsPage } from '../desktop/renderer/src/pages/Models';
import { createServiceWriteCoordinator, type ServiceWriteGuard } from '../desktop/renderer/src/lib/service-write-coordinator';

const provider: ProviderDto = {
  id: 'fixture-service', baseUrl: 'https://api.example.com/v1', adapterId: 'openai-compatible-v1', location: 'cloud',
  models: [
    { id: 'chat-model', capabilities: ['chat'], input: ['text'], supportsTools: true, parameters: {} },
    { id: 'vision-model', capabilities: ['image.understand'], input: ['text', 'image'], supportsTools: false, parameters: {} },
    { id: 'video-model', capabilities: ['video.understand'], input: ['text', 'video'], supportsTools: false, parameters: {} },
    { id: 'image-a', capabilities: ['image.generate'], input: ['text'], supportsTools: false, parameters: {} },
    { id: 'image-b', capabilities: ['image.generate'], input: ['text'], supportsTools: false, parameters: {} },
    { id: 'voice-model', capabilities: ['audio.generate'], input: ['text'], supportsTools: false, parameters: { voice: 'gentle' } }
  ],
  capabilities: ['chat', 'image.understand', 'video.understand', 'image.generate', 'audio.generate'],
  credential: { configured: true, ref: 'provider/fixture-service' }, mediaTransports: ['inline'],
  limits: { maxConcurrent: 1, maxQueue: 8 }, timeouts: { requestMs: 30000, pollIntervalMs: 100, pollTimeoutMs: 10000 },
  retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 }, options: { settingsModels: { chat: 'chat-model' } }
};

function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = find(child, predicate);
    if (match) return match;
  }
}
const fieldInput = (tree: any, label: string) =>
  find(find(tree, node => node.type === 'Field' && node.props.label === label), node => node.type === 'Input');
const button = (tree: any, label: string) =>
  find(tree, node => (node.type === 'Button' || node.type === 'ConfirmButton') && node.props.children === label);
function text(node: any): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const children = Array.isArray(node) ? node : node.props?.children;
  return (Array.isArray(children) ? children : [children]).map(text).join('');
}

let props: Parameters<typeof ModelsPage>[0];
let coordinator: ReturnType<typeof createServiceWriteCoordinator>;
const guard = (): ServiceWriteGuard => ({
  get locks() { return coordinator.getSnapshot().locks; },
  get writes() { return coordinator.getSnapshot().writes; },
  setIntents: coordinator.setIntents,
  begin: coordinator.begin,
  end: coordinator.end
});
function render(): any {
  h.index = 0; h.effects = [];
  const tree = ModelsPage(props);
  for (const effect of h.effects) effect();
  return tree;
}
function settleRender(): any {
  for (let index = 0; index < 4; index++) render();
  return render();
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

beforeEach(() => {
  h.cells = []; h.registration = undefined; h.api.mockReset(); h.statuses = []; h.busy = [];
  coordinator = createServiceWriteCoordinator();
  props = {
    data: { ok: true, providers: [structuredClone(provider)] } as any,
    refresh: vi.fn().mockResolvedValue(undefined),
    writeGuard: guard(),
    capability: 'chat',
    onStatusChange: (value: any) => h.statuses.push(value),
    onBusyChange: (value: boolean) => h.busy.push(value),
    onGoAccountModels: vi.fn()
  };
});

it('registers one page-owned service draft and reports per-capability status', () => {
  settleRender();
  expect(h.registration).toMatchObject({ id: 'models:services', owner: 'page', dirty: false, busy: false });
  const statuses = h.statuses.at(-1);
  expect(statuses.chat).toMatchObject({ label: '已配置', tone: 'ok' });
  expect(statuses['image.understand']).toMatchObject({ label: '已配置' });
  expect(statuses['image.generate']).toMatchObject({ label: '未配置', tone: 'idle' });
  expect(statuses['audio.generate']).toMatchObject({ label: '已配置' });
  expect(fieldInput(render(), '模型名').props.value).toBe('chat-model');
});

it('distinguishes loading and failure from the unconfigured status', () => {
  props = { ...props, data: undefined };
  render();
  expect(Object.values(h.statuses.at(-1) as Record<string, any>).every((status) => status.label === '读取中')).toBe(true);
  props = { ...props, error: 'provider directory unavailable' };
  render();
  const failed = h.statuses.at(-1) as Record<string, any>;
  expect(Object.values(failed).every((status) => status.label === '读取失败' && status.tone === 'bad')).toBe(true);
});

it('keeps drafts independent per capability and discards them back to baseline', () => {
  let tree = settleRender();
  fieldInput(tree, '模型名').props.onChange({ target: { value: 'chat-draft' } });
  tree = render();
  expect(h.registration.dirty).toBe(true);
  expect(h.statuses.at(-1)?.chat).toMatchObject({ label: '待保存', tone: 'warn' });

  props = { ...props, capability: 'image.understand' };
  tree = render();
  expect(fieldInput(tree, '模型名').props.value).toBe('vision-model');
  fieldInput(tree, '模型名').props.onChange({ target: { value: 'vision-draft' } });
  tree = render();

  props = { ...props, capability: 'chat' };
  tree = render();
  expect(fieldInput(tree, '模型名').props.value).toBe('chat-draft');
  props = { ...props, capability: 'image.understand' };
  tree = render();
  expect(fieldInput(tree, '模型名').props.value).toBe('vision-draft');

  h.registration.discard();
  tree = render();
  expect(h.registration.dirty).toBe(false);
  expect(fieldInput(tree, '模型名').props.value).toBe('vision-model');
});

it('keeps capability-specific fields on the right capability', () => {
  let tree = render();
  expect(find(tree, node => node.type === 'Checkbox' && node.props.children === undefined)).toBeTruthy();
  expect(find(tree, node => node.type === 'Field' && node.props.label === '默认音色')).toBeUndefined();
  props = { ...props, capability: 'audio.generate' };
  tree = render();
  expect(find(tree, node => node.type === 'Field' && node.props.label === '默认音色')).toBeTruthy();
  expect(find(tree, node => node.type === 'Checkbox')).toBeUndefined();
});

it('treats HTTP 200 with result.ok=false as a failed test and never saves', async () => {
  const tree = settleRender();
  h.api.mockResolvedValue({ result: { ok: false, providerId: provider.id, modelId: 'chat-model', detail: 'quota exceeded' } });
  button(tree, '测试连接').props.onClick();
  await settle();
  const after = render();
  expect(h.api).toHaveBeenCalledTimes(1);
  expect(h.api.mock.calls[0]![0]).toBe('/providers/validate');
  expect(h.api.mock.calls[0]![1].body).toContain('"capability":"chat"');
  expect(h.api.mock.calls[0]![1].body).toContain('"confirmCost":true');
  expect(h.api.mock.calls.some(call => call[0] === '/providers/simple')).toBe(false);
  const notice = find(after, node => node.props?.role === 'status' && typeof node.props.children === 'string');
  expect(notice.props.children).toContain('quota exceeded');
});

it('clears fetched models after the draft changes and keeps manual model input', async () => {
  let tree = settleRender();
  h.api.mockResolvedValue({ models: ['fresh-model'] });
  button(tree, '获取模型').props.onClick();
  await settle();
  tree = render();
  expect(find(tree, node => node.type === 'datalist')).toBeTruthy();
  expect(find(tree, node => node.type === 'option' && node.props.value === 'fresh-model')).toBeTruthy();

  fieldInput(tree, '服务地址').props.onChange({ target: { value: 'https://api.example.com/v2' } });
  tree = render();
  expect(find(tree, node => node.type === 'option' && node.props.value === 'fresh-model')).toBeUndefined();
  expect(fieldInput(tree, '模型名').props.value).toBe('chat-model');
});

it('flags ambiguous initialization without picking a model automatically', () => {
  props = { ...props, capability: 'image.generate' };
  const tree = render();
  expect(h.statuses.at(-1)?.['image.generate']).toMatchObject({ label: '未配置' });
  expect(fieldInput(tree, '模型名').props.value).toBe('');
  const notice = find(tree, node => node.props?.className === 'notice notice-warn');
  expect(notice.props.children).toContain('检测到多个支持此能力的服务或模型');
});

it('blocks requests to another origin until the credential is re-entered', async () => {
  let tree = settleRender();
  fieldInput(tree, '服务地址').props.onChange({ target: { value: 'https://other.example/v1' } });
  tree = render();
  button(tree, '测试连接').props.onClick(); await settle();
  tree = render();
  expect(h.api).not.toHaveBeenCalled();
  expect(find(tree, node => node.type === 'Field' && node.props.label === 'API Key').props.error).toContain('更换地址后请重新输入');
  expect(find(tree, node => node.type === 'ErrorNote').props.message).toContain('更换地址后请重新输入');

  fieldInput(tree, 'API Key').props.onChange({ target: { value: 'sk-other' } });
  tree = render();
  h.api.mockResolvedValue({ result: { ok: true } });
  button(tree, '测试连接').props.onClick(); await settle();
  expect(h.api).toHaveBeenCalledTimes(1);
  expect(h.api.mock.calls[0]![1].body).toContain('"secret":"sk-other"');
});

it('keeps a dirty draft and requires the latest source before saving after a provider refresh', async () => {
  let tree = settleRender();
  expect(fieldInput(tree, 'API Key').props.placeholder).toBe('已保存（留空保持）');
  fieldInput(tree, '模型名').props.onChange({ target: { value: 'chat-draft' } });
  tree = render();
  props = { ...props, data: { ok: true, providers: [{ ...provider, baseUrl: 'https://api.example.com/v2' }] } as any };
  tree = render(); tree = render();
  expect(fieldInput(tree, '模型名').props.value).toBe('chat-draft');
  expect(h.registration.dirty).toBe(true);
  expect(find(tree, node => node.props?.className?.includes('model-source-stale') && node.props.children)).toBeTruthy();
  expect(button(tree, '保存模型服务').props.disabled).toBe(true);
  find(tree, node => node.type === 'Button' && node.props.children === '使用最新服务信息').props.onClick();
  tree = render();
  expect(fieldInput(tree, '服务地址').props.value).toBe('https://api.example.com/v2');
  expect(find(tree, node => node.props?.className?.includes('model-source-stale'))).toBeUndefined();
  expect(button(tree, '保存模型服务').props.disabled).toBe(false);
  h.api.mockResolvedValue({ provider: { ...provider, baseUrl: 'https://api.example.com/v2' } });
  button(tree, '保存模型服务').props.onClick(); await settle();
  expect(JSON.parse(h.api.mock.calls[0]![1].body)).not.toHaveProperty('secret');
});

it('blocks a simple save while advanced edits own the shared provider', () => {
  coordinator.setIntents('advanced', [provider.id]);
  const tree = render();
  expect(button(tree, '保存模型服务').props.disabled).toBe(true);
  const notice = find(tree, node => node.props?.className === 'notice notice-warn' && String(node.props.children).includes('高级管理'));
  expect(notice).toBeTruthy();
});

it('does not treat prototype-named provider ids as locked', async () => {
  const prototypeProvider = { ...structuredClone(provider), id: 'constructor' };
  props = { ...props, data: { ok: true, providers: [prototypeProvider] } as any };
  let tree = settleRender();
  expect(button(tree, '保存模型服务').props.disabled).toBe(false);
  expect(find(tree, node => node.props?.className === 'notice notice-warn' && String(node.props.children).includes('高级管理'))).toBeUndefined();
  h.api.mockResolvedValue({ provider: prototypeProvider });
  button(tree, '保存模型服务').props.onClick(); await settle(); tree = render();
  expect(h.api.mock.calls[0]![0]).toBe('/providers/simple');
  coordinator.setIntents('advanced', ['constructor']);
  tree = render();
  expect(button(tree, '保存模型服务').props.disabled).toBe(true);
  coordinator.setIntents('advanced', []);
  tree = render();
  expect(button(tree, '保存模型服务').props.disabled).toBe(false);
  expect(coordinator.begin('constructor', 'advanced')).toBe(true);
  tree = render();
  expect(button(tree, '保存模型服务').props.disabled).toBe(true);
  coordinator.end('constructor', 'advanced');
  tree = render();
  expect(button(tree, '保存模型服务').props.disabled).toBe(false);
});

it('blocks a simple save while an advanced write holds the shared service', () => {
  expect(coordinator.begin(provider.id, 'advanced')).toBe(true);
  let tree = render();
  expect(button(tree, '保存模型服务').props.disabled).toBe(true);
  coordinator.end(provider.id, 'advanced');
  tree = render();
  expect(button(tree, '保存模型服务').props.disabled).toBe(false);
});

it('converts a deleted last source into a new service while keeping the dirty draft', async () => {
  let tree = settleRender();
  fieldInput(tree, '模型名').props.onChange({ target: { value: 'chat-unsaved' } });
  fieldInput(tree, 'API Key').props.onChange({ target: { value: 'sk-kept' } });
  tree = render();
  props = { ...props, data: { ok: true, providers: [] } as any };
  tree = render(); tree = render();
  expect(fieldInput(tree, '模型名').props.value).toBe('chat-unsaved');
  expect(find(tree, node => node.type === 'Field' && node.props.label === '服务来源')).toBeUndefined();
  expect(button(tree, '保存模型服务').props.disabled).toBe(true);
  const convert = button(tree, '转为新建服务');
  expect(convert).toBeTruthy();
  convert.props.onClick();
  tree = render();
  expect(find(tree, node => node.props?.className?.includes('model-source-stale'))).toBeUndefined();
  expect(fieldInput(tree, '服务地址').props.value).toBe(provider.baseUrl);
  expect(fieldInput(tree, '模型名').props.value).toBe('chat-unsaved');
  expect(fieldInput(tree, 'API Key').props.value).toBe('sk-kept');
  expect(button(tree, '保存模型服务').props.disabled).toBe(false);
  h.api.mockResolvedValue({ provider: { ...provider, id: 'created-service' } });
  button(tree, '保存模型服务').props.onClick(); await settle();
  const body = JSON.parse(h.api.mock.calls[0]![1].body);
  expect(body).not.toHaveProperty('providerId');
  expect(body).toMatchObject({ capability: 'chat', baseUrl: provider.baseUrl, modelId: 'chat-unsaved', secret: 'sk-kept' });
});

it('converts a deleted source to a new service when another provider remains', () => {
  let tree = settleRender();
  fieldInput(tree, '模型名').props.onChange({ target: { value: 'chat-unsaved' } });
  tree = render();
  const other = { ...provider, id: 'other-service', capabilities: ['image.understand'] };
  props = { ...props, data: { ok: true, providers: [other] } as any };
  tree = render(); tree = render();
  expect(button(tree, '保存模型服务').props.disabled).toBe(true);
  const source = find(tree, node => node.type === 'Field' && node.props.label === '服务来源');
  expect(find(source, node => node.type === 'Select').props.value).toBe(provider.id);
  button(tree, '转为新建服务').props.onClick();
  tree = render();
  const sourceAfter = find(tree, node => node.type === 'Field' && node.props.label === '服务来源');
  expect(find(sourceAfter, node => node.type === 'Select').props.value).toBe('');
  expect(fieldInput(tree, '模型名').props.value).toBe('chat-unsaved');
  expect(button(tree, '保存模型服务').props.disabled).toBe(false);
});

it('allows adopting the source again after a removed provider returns', () => {
  let tree = settleRender();
  fieldInput(tree, '模型名').props.onChange({ target: { value: 'chat-draft' } });
  tree = render();
  props = { ...props, data: { ok: true, providers: [] } as any };
  tree = render(); tree = render();
  expect(button(tree, '转为新建服务')).toBeTruthy();
  props = { ...props, data: { ok: true, providers: [structuredClone(provider)] } as any };
  tree = render(); tree = render();
  expect(fieldInput(tree, '模型名').props.value).toBe('chat-draft');
  const adopt = button(tree, '使用最新服务信息');
  expect(adopt).toBeTruthy();
  adopt.props.onClick();
  tree = render();
  expect(button(tree, '保存模型服务').props.disabled).toBe(false);
});

it('does not let a late test result write a success notice for a changed source', async () => {
  let resolve!: (value: any) => void;
  h.api.mockImplementation(() => new Promise((done) => { resolve = done; }));
  let tree = settleRender();
  button(tree, '测试连接').props.onClick(); await settle(); tree = render();
  expect(h.busy.at(-1)).toBe(true);
  props = { ...props, data: { ok: true, providers: [{ ...provider, baseUrl: 'https://api.example.com/v2' }] } as any };
  tree = render(); tree = render();
  resolve({ result: { ok: true } }); await settle(); tree = render();
  const content = text(tree);
  expect(content).not.toContain('测试请求成功');
  expect(content).toContain('本次测试结果已作废');
});


it('keeps the failed draft and input when saving reports a credential-store failure', async () => {
  let tree = settleRender();
  fieldInput(tree, '服务地址').props.onChange({ target: { value: 'https://api.example.com/v2' } });
  tree = render();
  h.api.mockRejectedValue(new Error('credential store unavailable'));
  button(tree, '保存模型服务').props.onClick(); await settle();
  tree = render();
  expect(fieldInput(tree, '服务地址').props.value).toBe('https://api.example.com/v2');
  expect(find(tree, node => node.type === 'ErrorNote').props.message).toContain('credential store unavailable');
  expect(find(tree, node => node.type === 'ConfirmButton' && node.props.feedback === 'error')).toBeTruthy();
  expect(h.registration.dirty).toBe(true);
});

it('saves the current draft explicitly, keeps the secret out of state, and marks success feedback', async () => {
  let tree = settleRender();
  fieldInput(tree, '服务地址').props.onChange({ target: { value: 'https://api.example.com/v2' } });
  fieldInput(tree, 'API Key').props.onChange({ target: { value: 'sk-new' } });
  tree = render();
  h.api.mockResolvedValue({ provider: { ...provider, baseUrl: 'https://api.example.com/v2', credential: { configured: true, ref: 'provider/fixture-service' } } });
  button(tree, '保存模型服务').props.onClick();
  await settle();
  tree = render();
  const body = JSON.parse(h.api.mock.calls[0]![1].body);
  expect(h.api.mock.calls[0]![0]).toBe('/providers/simple');
  expect(body).toMatchObject({ capability: 'chat', baseUrl: 'https://api.example.com/v2', modelId: 'chat-model', secret: 'sk-new' });
  expect(h.registration.dirty).toBe(false);
  expect(fieldInput(tree, 'API Key').props.value).toBe('');
  expect(find(tree, node => node.type === 'ConfirmButton' && node.props.feedback === 'success')).toBeTruthy();
});
