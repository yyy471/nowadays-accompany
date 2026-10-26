import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { ProviderDto } from '../desktop/renderer/src/types';
vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());
const h = vi.hoisted(() => ({ cells: [] as any[], index: 0, effects: [] as Array<() => any>, cleanups: [] as Array<() => void>, registration: null as any, api: vi.fn(), confirm: vi.fn(), transition: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = h.index++;
    if (!(index in h.cells)) h.cells[index] = typeof initial === 'function' ? initial() : initial;
    return [h.cells[index], (next: any) => { h.cells[index] = typeof next === 'function' ? next(h.cells[index]) : next; }];
  },
  useRef: (initial: any) => { const index = h.index++; return h.cells[index] ??= { current: initial }; },
  useEffect: (effect: () => any, deps: unknown[]) => {
    const index = h.index++; const previous = h.cells[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) h.effects.push(effect);
    h.cells[index] = deps;
  }
}));
vi.mock('../desktop/renderer/src/api', () => ({ api: (...args: any[]) => h.api(...args) }));
vi.mock('../desktop/renderer/src/hooks', () => ({ errorMessage: (error: Error) => error.message }));
vi.mock('../desktop/renderer/src/components/DraftProtectionProvider', () => ({ useDraftProtection: () => ({ requestTransition: h.transition }) }));
vi.mock('../desktop/renderer/src/lib/use-draft-registration', () => ({ useDraftRegistration: (value: any) => { h.registration = value; } }));
vi.mock('../desktop/renderer/src/ui', () => ({ Button: 'Button', Card: 'Card', ControlButton: 'ControlButton', ErrorNote: 'ErrorNote', Field: 'Field', Input: 'Input', Tag: 'Tag', useConfirm: () => h.confirm }));
import { ProviderManager } from '../desktop/renderer/src/components/ProviderManager';
const provider: ProviderDto = {
  id: 'same-origin-a', baseUrl: 'https://one.example/v1', adapterId: 'openai-compatible-v1', location: 'cloud',
  models: [{ id: 'chat', capabilities: ['chat'], input: ['text'], supportsTools: false, parameters: { custom: { x: 1 } } }],
  capabilities: ['chat'], credential: { configured: true, ref: 'provider/same-origin-a' }, mediaTransports: ['inline'],
  limits: { maxConcurrent: 1, maxQueue: 8 }, timeouts: { requestMs: 1000, pollIntervalMs: 100, pollTimeoutMs: 10000 },
  retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 }, options: { vendor: { retained: true } }
};
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) { const match = find(child, predicate); if (match) return match; }
}
let props: Parameters<typeof ProviderManager>[0];
function render() {
  h.index = 0; h.effects = [];
  const tree = ProviderManager(props);
  for (const effect of h.effects) { const cleanup = effect(); if (cleanup) h.cleanups.push(cleanup); }
  return tree;
}
const button = (tree: any, label: string) => find(tree, node => node.type === 'Button' && node.props.children === label);
const input = (tree: any, label: string) => find(find(tree, node => node.type === 'Field' && node.props.label === label), node => node.type === 'Input');
beforeEach(() => {
  h.cells = []; h.cleanups = []; h.api.mockReset(); h.confirm.mockReset(); h.transition.mockReset().mockResolvedValue({ ok: true });
  props = { providers: [structuredClone(provider)], refresh: vi.fn().mockResolvedValue(undefined) };
});
async function edit() { await button(render(), '编辑服务').props.onClick(); return render(); }
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

it('registers dirty, freezes edits throughout save, and retains failed drafts and baseline during polling', async () => {
  let tree = await edit();
  input(tree, 'Base URL').props.onChange({ target: { value: 'https://one.example/v2' } }); tree = render();
  expect(h.registration).toMatchObject({ dirty: true, busy: false });
  let reject!: (error: Error) => void;
  h.api.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  button(tree, '保存服务修改').props.onClick(); tree = render();
  expect(h.registration.busy).toBe(true); expect(input(tree, 'Base URL').props.disabled).toBe(true);
  input(tree, 'Base URL').props.onChange({ target: { value: 'https://unexpected.example/' } });
  props = { ...props, providers: [{ ...provider, baseUrl: 'https://polled.example/v1' }] }; tree = render();
  expect(input(tree, 'Base URL').props.value).toBe('https://one.example/v2');
  reject(new Error('save failed')); await settle(); tree = render();
  expect(h.registration).toMatchObject({ dirty: true, busy: false });
  expect(input(tree, 'Base URL').props.value).toBe('https://one.example/v2');
  expect(find(tree, node => node.type === 'ErrorNote').props.message).toBe('save failed');
  h.registration.discard(); tree = render();
  expect(input(tree, 'Base URL').props.value).toBe(provider.baseUrl);
});
it('asks the shared transition controller before switching edit targets and preserves a cancelled draft', async () => {
  let tree = await edit(); input(tree, 'Base URL').props.onChange({ target: { value: 'https://one.example/v2' } }); tree = render();
  h.transition.mockResolvedValue({ ok: false, reason: 'cancelled' });
  await button(tree, '编辑服务').props.onClick(); tree = render();
  expect(h.transition).toHaveBeenLastCalledWith({ scope: { kind: 'ids', ids: ['settings:provider-manager'] }, actionLabel: '切换服务' });
  expect(input(tree, 'Base URL').props.value).toBe('https://one.example/v2'); expect(h.registration.dirty).toBe(true);
});
it('blocks stale saves after another editor updates a service and guards reloading its baseline', async () => {
  let tree = await edit(); input(tree, 'Base URL').props.onChange({ target: { value: 'https://one.example/v2' } }); tree = render();
  props = { ...props, providers: [{ ...provider, options: { vendor: { newest: true } } }] }; tree = render();
  expect(button(tree, '保存服务修改').props.disabled).toBe(true);
  button(tree, '保存服务修改').props.onClick(); await settle(); tree = render();
  expect(h.api).not.toHaveBeenCalled(); expect(h.registration.dirty).toBe(true);
  h.transition.mockResolvedValueOnce({ ok: false, reason: 'cancelled' });
  await button(tree, '重新读取当前服务').props.onClick(); tree = render();
  expect(input(tree, 'Base URL').props.value).toBe('https://one.example/v2');
  await button(tree, '重新读取当前服务').props.onClick(); tree = render();
  expect(input(tree, 'Base URL').props.value).toBe(provider.baseUrl); expect(h.registration.dirty).toBe(false);
  input(tree, 'Base URL').props.onChange({ target: { value: 'https://one.example/v3' } }); tree = render();
  h.api.mockResolvedValue({ provider: props.providers[0] });
  button(tree, '保存服务修改').props.onClick(); await settle();
  expect(JSON.parse(h.api.mock.calls[0]![1].body).provider.options).toEqual({ vendor: { newest: true } });
});
it('holds busy during read-only preview and confirmation and prevents DELETE after unmount', async () => {
  h.api.mockResolvedValue({ ok: true, providerId: provider.id, exists: true, affectedAccounts: ['10001'] });
  let accept!: (value: boolean) => void;
  h.confirm.mockImplementation(() => new Promise(resolve => { accept = resolve; }));
  button(render(), '删除服务').props.onClick(); await settle(); render();
  expect(h.registration.busy).toBe(true); expect(h.api.mock.calls).toEqual([[`/providers/${provider.id}/impact`]]);
  h.cleanups.forEach(cleanup => cleanup()); accept(true); await settle();
  expect(h.api).toHaveBeenCalledTimes(1);
});
it('clear-key cancellation has no write; accepted clear keeps an unrelated unsaved key draft', async () => {
  let tree = await edit(); input(tree, 'API Key').props.onChange({ target: { value: 'unsaved-new-key' } }); tree = render();
  h.confirm.mockResolvedValue(false); button(tree, '清除密钥').props.onClick(); await settle(); tree = render();
  expect(h.api).not.toHaveBeenCalled(); expect(h.registration.dirty).toBe(true);
  h.confirm.mockResolvedValue(true); h.api.mockResolvedValue({ provider: { ...provider, credential: { configured: false } } });
  button(tree, '清除密钥').props.onClick(); await settle(); tree = render();
  expect(h.api.mock.calls).toEqual([[`/providers/${provider.id}/credential`, { method: 'DELETE' }]]);
  expect(input(tree, 'API Key').props.value).toBe('unsaved-new-key'); expect(h.registration.dirty).toBe(true);
});
