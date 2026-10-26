import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftRegistry } from '../desktop/renderer/src/lib/drafts/registry';
import { TransitionController } from '../desktop/renderer/src/lib/drafts/transition-controller';
import type { WorldbookEditorSeed } from '../desktop/renderer/src/lib/worldbook-editor';

vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());

const h = vi.hoisted(() => ({ cells: [] as any[], index: 0, effects: [] as Array<() => any>, cleanups: [] as Array<() => void>, protection: null as any, api: vi.fn(), confirm: null as any, unmounted: false }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => { const i = h.index++; const cells = h.cells; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
    return [cells[i], (value: any) => { if (h.unmounted) throw new Error('setState after unmount'); cells[i] = typeof value === 'function' ? value(cells[i]) : value; }]; },
  useRef: (value: any) => { const i = h.index++; return h.cells[i] ??= { current: value }; },
  useEffect: (effect: () => any, deps: unknown[]) => { const i = h.index++; const before = h.cells[i];
    if (!before || deps.some((dep, index) => !Object.is(dep, before[index]))) h.effects.push(effect); h.cells[i] = deps; }
}));
vi.mock('../desktop/renderer/src/components/DraftProtectionProvider', () => ({ useDraftProtection: () => h.protection }));
vi.mock('../desktop/renderer/src/api', () => ({ api: (...args: any[]) => h.api(...args) }));
vi.mock('../desktop/renderer/src/hooks', () => ({ errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock('../desktop/renderer/src/ui', () => ({ Button: 'Button', CancelButton: 'CancelButton', ConfirmButton: 'ConfirmButton', ControlButton: 'ControlButton', Modal: 'Modal', ErrorNote: 'ErrorNote',
  Field: 'Field', Input: 'Input', Checkbox: 'Checkbox', Textarea: 'Textarea', Select: 'Select', Tag: 'Tag', useConfirm: () => h.confirm }));

import { WorldbookEditor } from '../desktop/renderer/src/components/WorldbookEditor';

function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) { const result = find(child, predicate); if (result) return result; }
}
function run<T>(fn: () => T, cells = h.cells) { h.unmounted = false; h.cells = cells; h.index = 0; h.effects = []; const tree = fn();
  for (const effect of h.effects) { const cleanup = effect(); if (typeof cleanup === 'function') h.cleanups.push(cleanup); } return tree; }
function unmount() { for (const cleanup of h.cleanups.splice(0)) cleanup(); h.unmounted = true; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function byLabel(tree: any, label: string) { return find(tree, n => n.props?.['aria-label'] === label); }
function click(tree: any, label: string) { return find(tree, n => n.props?.children === label).props.onClick(); }
function text(tree: any): string {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  const children = Array.isArray(tree) ? tree : tree.props?.children;
  return (Array.isArray(children) ? children : [children]).map(text).join('');
}

const entry = { id: 'tree', keys: ['花园'], content: '银杏树。', enabled: true, constant: false, caseSensitive: false, priority: 0, position: 'after-role' as const };
let seed: WorldbookEditorSeed;
let onClose: ReturnType<typeof vi.fn>, onSaved: ReturnType<typeof vi.fn>, onRefresh: ReturnType<typeof vi.fn>, confirm: ReturnType<typeof vi.fn>;
function render(locked = false) { return run(() => WorldbookEditor({ seed, locked, onClose, onSaved, onRefresh })); }

beforeEach(() => {
  unmount(); h.cells = []; h.api.mockReset();
  seed = { mode: 'derive', id: 'garden', revision: 'r2', name: '花园', base: { id: 'garden', revision: 'r1', fingerprint: 'a'.repeat(64) }, worldbook: { version: 1, scanDepth: 4, budgetChars: 2000, entries: [entry] } };
  onClose = vi.fn(); onSaved = vi.fn(); onRefresh = vi.fn(async () => {}); confirm = vi.fn(async () => false);
  const registry = new DraftRegistry(); const controller = new TransitionController(registry);
  h.protection = { registry, requestTransition: vi.fn((options: any) => controller.request({ ...options, confirm })) };
  h.confirm = confirm;
});

it('previews the unsaved draft through the read-only endpoint with book defaults and no history', async () => {
  h.api.mockResolvedValue({ evaluation: { beforeRole: 'BEFORE', afterRole: 'AFTER', selectedIds: ['tree'], skippedIds: [], usedChars: 12 } });
  let tree = render();
  byLabel(tree, '名称').props.onChange({ target: { value: '花园草稿' } });
  byLabel(tree, '草稿测试文本').props.onChange({ target: { value: '花园' } });
  tree = render();
  find(tree, n => n.type === 'Input' && n.props.max === 8000).props.onChange({ target: { value: '3000' } });
  tree = render(); click(tree, '测试当前草稿'); await settle(); tree = render();
  expect(h.api).toHaveBeenCalledOnce();
  expect(h.api.mock.calls[0][0]).toBe('/worldbooks/preview');
  const body = JSON.parse(h.api.mock.calls[0][1].body);
  expect(body).toMatchObject({ text: '花园', scanDepth: 4, budgetChars: 3000 });
  expect(body).not.toHaveProperty('historyTexts');
  expect(body.book.entries[0].id).toBe('tree');
  const status = find(tree, n => n.props?.role === 'status');
  const html = renderToStaticMarkup(status);
  expect(html).toContain('草稿测试，尚未保存');
  expect(html).toContain('BEFORE'); expect(html).toContain('AFTER');
  expect(onSaved).not.toHaveBeenCalled();
  expect(h.protection.registry.snapshot()[0].dirty).toBe(true);
});

it('reuses one request id across failed retries and uses the base fingerprint for a new version', async () => {
  let tree = render(); byLabel(tree, '名称').props.onChange({ target: { value: '花园v2' } }); tree = render();
  h.api.mockRejectedValueOnce(new Error('network lost'));
  click(tree, '保存新版本'); await settle(); tree = render();
  h.api.mockRejectedValueOnce(new Error('network lost again'));
  click(tree, '保存新版本'); await settle(); tree = render();
  const first = JSON.parse(h.api.mock.calls[0][1].body), second = JSON.parse(h.api.mock.calls[1][1].body);
  expect(first.requestId).toBe(second.requestId);
  expect(first).toMatchObject({ baseRef: { id: 'garden', revision: 'r1' }, expectedBaseFingerprint: 'a'.repeat(64) });
  expect(first.manifest).toMatchObject({ id: 'garden', kind: 'worldbook', revision: 'r2', name: '花园v2' });
  h.api.mockResolvedValueOnce({ manifest: { ...first.manifest, name: '花园v2' }, fingerprint: 'b'.repeat(64), created: true });
  onRefresh.mockRejectedValueOnce(new Error('list offline'));
  click(tree, '保存新版本'); await settle(); tree = render();
  const third = JSON.parse(h.api.mock.calls[2][1].body);
  expect(third.requestId).toBe(first.requestId);
  expect(onSaved).toHaveBeenCalledOnce();
  expect(find(tree, n => n.type === 'ErrorNote' && String(n.props.message).includes('列表刷新失败'))).toBeDefined();
  expect(find(tree, n => n.type === 'ConfirmButton' && n.props.children === '保存新版本').props.disabled).toBe(true);
  byLabel(tree, '新版本号').props.onChange({ target: { value: 'r3' } });
  byLabel(tree, '名称').props.onChange({ target: { value: '花园v3' } }); tree = render();
  h.api.mockRejectedValueOnce(new Error('stop'));
  click(tree, '保存新版本'); await settle();
  const fourth = JSON.parse(h.api.mock.calls[3][1].body);
  expect(fourth.requestId).not.toBe(first.requestId);
  expect(fourth.manifest.revision).toBe('r3');
});

it('blocks saving when the new revision equals the base and locates entry errors', () => {
  let tree = render();
  byLabel(tree, '新版本号').props.onChange({ target: { value: 'r1' } }); tree = render();
  expect(text(tree)).toContain('新版本不能与基础版本 r1 相同');
  expect(find(tree, n => n.type === 'ConfirmButton' && n.props.children === '保存新版本').props.disabled).toBe(true);
  byLabel(tree, '新版本号').props.onChange({ target: { value: 'r3' } });
  byLabel(tree, '条目关键词').props.onChange({ target: { value: '' } }); tree = render();
  expect(text(tree)).toContain('启用且非常驻的条目至少需要一个关键词');
  expect(find(tree, n => n.type === 'ConfirmButton' && n.props.children === '保存新版本').props.disabled).toBe(true);
  h.api.mockResolvedValue({ evaluation: { beforeRole: '', afterRole: '', selectedIds: [], skippedIds: [], usedChars: 0 } });
  byLabel(tree, '草稿测试文本').props.onChange({ target: { value: 'x' } }); tree = render();
  click(tree, '测试当前草稿'); void settle();
  expect(h.api).not.toHaveBeenCalled();
});

it('confirms before closing dirty drafts and rejects old callbacks while locked or busy', async () => {
  let tree = render(); byLabel(tree, '名称').props.onChange({ target: { value: '未保存' } }); tree = render();
  const oldClose = find(tree, n => n.type === 'Modal').props.onClose;
  const oldSave = find(tree, n => n.type === 'ConfirmButton' && n.props.children === '保存新版本').props.onClick;
  const oldEdit = byLabel(tree, '名称').props.onChange;
  tree = render(true);
  oldClose(); oldSave(); oldEdit({ target: { value: '不应生效' } }); await settle(); tree = render(true);
  expect(confirm).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  tree = render(false);
  find(tree, n => n.type === 'Modal').props.onClose(); await settle(); tree = render();
  expect(confirm).toHaveBeenCalledOnce(); expect(onClose).not.toHaveBeenCalled();
  confirm.mockResolvedValue(true);
  find(tree, n => n.type === 'Modal').props.onClose(); await settle();
  expect(onClose).toHaveBeenCalledOnce();
});

it('rejects callbacks captured before unmount and ignores a late save response', async () => {
  let tree = render(); byLabel(tree, '名称').props.onChange({ target: { value: '卸载前草稿' } }); tree = render();
  const staleSave = find(tree, n => n.type === 'ConfirmButton' && n.props.children === '保存新版本').props.onClick;
  const stalePreview = find(tree, n => n.props.children === '测试当前草稿').props.onClick;
  const staleClose = find(tree, n => n.type === 'Modal').props.onClose;
  const staleEdit = byLabel(tree, '名称').props.onChange;
  unmount();
  staleSave(); stalePreview(); staleEdit({ target: { value: '不应生效' } }); staleClose(); await settle();
  expect(h.api).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();

  h.cells = []; h.api.mockReset(); let finish!: (value: any) => void;
  h.api.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  tree = render(); byLabel(tree, '名称').props.onChange({ target: { value: '迟到响应' } }); tree = render();
  click(tree, '保存新版本'); await settle(); expect(h.api).toHaveBeenCalledOnce();
  unmount();
  finish({ manifest: { id: 'garden', kind: 'worldbook', revision: 'r2', name: '迟到响应', worldbook: seed.worldbook }, fingerprint: 'd'.repeat(64), created: true });
  await settle();
  expect(onSaved).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
});

it('ignores delete confirmation completion after unmount without modifying the draft', async () => {
  let finish!: (value: boolean) => void;
  confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const tree = render();
  find(tree, n => n.props.children === '删除').props.onClick();
  await settle();
  const states = () => JSON.stringify(h.cells.map(cell => cell && typeof cell === 'object' && 'current' in cell ? '<ref>' : cell));
  const before = states();
  unmount();
  finish(true); await settle();
  expect(states()).toBe(before);
  expect(h.api).not.toHaveBeenCalled();
});

it('treats a copied book as a new unsaved resource and saves it without extra edits', async () => {
  seed = { mode: 'copy', id: 'garden-copy', revision: 'r1', name: '花园 副本', worldbook: { version: 1, scanDepth: 4, budgetChars: 2000, entries: [entry] } };
  h.api.mockResolvedValueOnce({ manifest: { id: 'garden-copy', kind: 'worldbook', revision: 'r1', name: '花园 副本', worldbook: seed.worldbook }, fingerprint: 'e'.repeat(64), created: true });
  let tree = render();
  const save = find(tree, n => n.type === 'ConfirmButton' && n.props.children === '保存新版本');
  expect(save.props.disabled).toBe(false);
  save.props.onClick(); await settle(); tree = render();
  expect(h.api).toHaveBeenCalledOnce();
  const body = JSON.parse(h.api.mock.calls[0][1].body);
  expect(body.manifest).toMatchObject({ id: 'garden-copy', revision: 'r1', name: '花园 副本' });
  expect(body).not.toHaveProperty('baseRef');
  expect(onSaved).toHaveBeenCalledOnce(); expect(onRefresh).toHaveBeenCalledOnce();
  expect(find(tree, n => n.type === 'ConfirmButton' && n.props.children === '保存新版本').props.disabled).toBe(true);
});

it('preserves a copied draft when the target version already exists', async () => {
  const longId = 'a'.repeat(64);
  seed = { mode: 'copy', id: longId, revision: 'r1', name: '长 id 副本', worldbook: { version: 1, scanDepth: 4, budgetChars: 2000, entries: [entry] } };
  h.api.mockRejectedValueOnce(new Error('HTTP 409 版本或请求标识冲突'));
  let tree = render();
  click(tree, '保存新版本'); await settle(); tree = render();
  expect(find(tree, n => n.type === 'ErrorNote' && String(n.props.message).includes('409'))).toBeDefined();
  expect(byLabel(tree, '世界书 id').props.value).toBe(longId);
  expect(byLabel(tree, '名称').props.value).toBe('长 id 副本');
  expect(find(tree, n => n.type === 'ConfirmButton' && n.props.children === '保存新版本').props.disabled).toBe(false);
});

it('adds, copies and confirms deletion of entries without losing the current draft', async () => {
  let tree = render();
  click(tree, '新增条目'); tree = render();
  expect(h.protection.registry.snapshot()[0].dirty).toBe(true);
  click(tree, '复制条目'); tree = render();
  expect(find(tree, n => n.props?.children === 'entry-copy')).toBeDefined();
  const rowsBefore = find(tree, n => n.props?.className === 'worldbook-entry-list').props.children.length;
  click(tree, '删除'); await settle(); tree = render();
  const rowsAfterCancelled = find(tree, n => n.props?.className === 'worldbook-entry-list').props.children.length;
  expect(rowsAfterCancelled).toBe(rowsBefore);
  confirm.mockResolvedValue(true);
  click(tree, '删除'); await settle(); tree = render();
  expect(find(tree, n => n.props?.className === 'worldbook-entry-list').props.children.length).toBe(rowsBefore - 1);
  expect(byLabel(tree, '名称').props.value).toBe('花园');
});
