import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftRegistry } from '../desktop/renderer/src/lib/drafts/registry';
import { TransitionController } from '../desktop/renderer/src/lib/drafts/transition-controller';
vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());
const h = vi.hoisted(() => ({ cells: [] as any[], index: 0, effects: [] as Array<() => any>, cleanups: [] as Array<() => void>, protection: null as any, api: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => { const i = h.index++; const cells = h.cells; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
    return [cells[i], (value: any) => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }]; },
  useRef: (value: any) => { const i = h.index++; return h.cells[i] ??= { current: value }; },
  useMemo: (fn: any) => { h.index++; return fn(); },
  useEffect: (effect: () => any, deps: unknown[]) => { const i = h.index++; const before = h.cells[i];
    if (!before || deps.some((dep, index) => !Object.is(dep, before[index]))) h.effects.push(effect); h.cells[i] = deps; }
}));
vi.mock('../desktop/renderer/src/components/DraftProtectionProvider', () => ({ useDraftProtection: () => h.protection }));
vi.mock('../desktop/renderer/src/api', () => ({ api: (...args: any[]) => h.api(...args) }));
vi.mock('../desktop/renderer/src/hooks', () => ({ errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock('../desktop/renderer/src/ui', () => ({ Button: 'Button', CancelButton: 'CancelButton', ConfirmButton: 'ConfirmButton', Modal: 'Modal', ErrorNote: 'ErrorNote', Field: 'Field', Input: 'Input', Checkbox: 'Checkbox', Textarea: 'Textarea', Card: 'Card', Empty: 'Empty', Icon: 'Icon', LoadingNote: 'LoadingNote', Select: 'Select', Tag: 'Tag', copyText: vi.fn(), useConfirm: () => async () => true }));
vi.mock('../desktop/renderer/src/lib/use-account-entry-focus', () => ({ useAccountEntryFocus: (options: any) => { if (!options.selectedAccount && options.accountIds?.length) options.selectAccount(options.accountIds[0]); } }));
import { WorldbookSettings, type WorldbookBinding } from '../desktop/renderer/src/components/WorldbookSettings';
import { AccountsPage } from '../desktop/renderer/src/pages/Accounts';
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) { const result = find(child, predicate); if (result) return result; }
}
function run<T>(fn: () => T, cells = h.cells) { h.cells = cells; h.index = 0; h.effects = []; const tree = fn();
  for (const effect of h.effects) { const cleanup = effect(); if (typeof cleanup === 'function') h.cleanups.push(cleanup); } return tree; }
function unmount() { for (const cleanup of h.cleanups.splice(0)) cleanup(); }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
let binding: WorldbookBinding;
let onSaved: ReturnType<typeof vi.fn>, onReload: ReturnType<typeof vi.fn>, confirm: ReturnType<typeof vi.fn>;
function render(locked = false, disabled = false, visible = true) { return run(() => WorldbookSettings({ binding, onSaved, onReload, locked, disabled, visible })); }
function click(tree: any, label: string) { find(tree, n => n.props?.children === label).props.onClick(); }
function input(tree: any, max: number, value: string) { find(tree, n => n.type === 'Input' && n.props.max === max).props.onChange({ target: { value } }); }
beforeEach(() => {
  unmount(); h.cells = []; h.api.mockReset();
  binding = { accountId: '10001', kind: 'private', peerId: 'peer/A', revision: 'binding-r1', worldbookEntryCount: 2, worldbookDefaults: { scanDepth: 6, budgetChars: 3456 } };
  onSaved = vi.fn(); onReload = vi.fn(); confirm = vi.fn(async () => false);
  const registry = new DraftRegistry(); const controller = new TransitionController(registry);
  h.protection = { registry, requestTransition: vi.fn((options: any) => controller.request({ ...options, confirm })) };
});

it('uses card defaults without enabling, and disables enabling for an empty book', () => {
  let tree = render();
  expect(find(tree, n => n.type === 'Checkbox').props.checked).toBe(false);
  expect(find(tree, n => n.type === 'Input' && n.props.max === 20).props.value).toBe(6);
  expect(find(tree, n => n.type === 'Input' && n.props.max === 8000).props.value).toBe(3456);
  unmount(); h.cells = []; binding = { ...binding, worldbookEntryCount: 0 };
  tree = render(); expect(find(tree, n => n.type === 'Checkbox').props.disabled).toBe(true);
  expect(find(tree, n => n.type === 'Input' && n.props.max === 20).props.value).toBe(4);
  find(tree, n => n.type === 'Checkbox').props.onChange({ target: { checked: true } }); tree = render();
  expect(find(tree, n => n.type === 'Checkbox').props.checked).toBe(false);
});
it('saves only worldbook options and expected binding revision, preserves metadata, and prevents duplicate requests', async () => {
  let finish!: (value: any) => void; h.api.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let tree = render(); find(tree, n => n.type === 'Checkbox').props.onChange({ target: { checked: true } });
  input(tree, 20, '0'); input(tree, 8000, '8000'); tree = render();
  click(tree, '保存世界书设置'); click(tree, '保存世界书设置'); tree = render();
  input(tree, 20, '10');
  expect(h.api).toHaveBeenCalledOnce(); expect(h.api.mock.calls[0][0]).toBe('/accounts/10001/role-bindings/private/peer%2FA/worldbook');
  expect(JSON.parse(h.api.mock.calls[0][1].body)).toEqual({ worldbook: { enabled: true, scanDepth: 0, budgetChars: 8000 }, source: { kind: 'role-card' }, expectedRevision: 'binding-r1' });
  expect(h.protection.registry.snapshot()[0].busy).toBe(true);
  expect(find(tree, n => n.type === 'Input').props.disabled).toBe(true);
  finish({ binding: { ...binding, worldbook: { enabled: true, scanDepth: 0, budgetChars: 8000 }, revision: 'binding-r2' } }); await settle(); tree = render();
  expect(onSaved).toHaveBeenCalledOnce(); expect(h.protection.registry.snapshot()[0]).toMatchObject({ busy: false, dirty: false });
  expect(find(tree, n => n.type === 'Checkbox').props.checked).toBe(true);
});
it.each([[-1, '20'], [21, '20'], [1.5, '20'], [8001, '8000'], [-1, '8000']])('rejects invalid range %s for max %s', async (value, max) => {
  input(render(), Number(max), String(value)); const tree = render(); click(tree, '保存世界书设置'); await settle();
  expect(h.api).not.toHaveBeenCalled(); expect(find(tree, n => n.type === 'ConfirmButton').props.disabled).toBe(true);
});
it('tests current text with saved options without saving, reading history or rendering injected HTML', async () => {
  const evaluation = { beforeRole: '<script>unsafe</script>', afterRole: 'after', selectedIds: ['entry-a'], skippedIds: ['entry-b'], usedChars: 40 };
  h.api.mockResolvedValue({ evaluation }); let tree = render(); input(tree, 20, '2');
  find(tree, n => n.type === 'Textarea').props.onChange({ target: { value: 'cat keyword' } }); tree = render();
  click(tree, '测试关键词'); await settle(); tree = render();
  expect(h.api).toHaveBeenCalledOnce(); expect(h.api.mock.calls[0][0]).toBe('/accounts/10001/role-bindings/private/peer%2FA/worldbook/preview');
  expect(JSON.parse(h.api.mock.calls[0][1].body)).toEqual({ text: 'cat keyword' });
  const before = find(tree, n => n.type === 'pre'); expect(before.props.children).toBe(evaluation.beforeRole);
  expect(renderToStaticMarkup(before)).toContain('&lt;script&gt;');
  expect(onSaved).not.toHaveBeenCalled(); expect(h.protection.registry.snapshot()[0].dirty).toBe(true);
});
it('shows partial-scan warnings and unscanned IDs as escaped text separate from budget skips', async () => {
  h.api.mockResolvedValue({ evaluation: { beforeRole: '', afterRole: '', selectedIds: ['selected'], skippedIds: ['budget-skip'], usedChars: 10,
    scanLimited: true, unscannedIds: ['<img src=x onerror=alert(1)>', '<script>unscanned</script>'] } });
  find(render(), n => n.type === 'Textarea').props.onChange({ target: { value: 'keyword' } });
  click(render(), '测试关键词'); await settle(); const tree = render();
  const result = find(tree, n => n.props?.role === 'status');
  const html = renderToStaticMarkup(result);
  expect(html).toContain('扫描受限'); expect(html).toContain('仅完成部分检查');
  expect(html).toContain('不能将剩余条目理解为完整检查后未命中');
  expect(html).toContain('扫描优先当前文本与最近历史'); expect(html).toContain('本次测试仍只检查当前文本');
  expect(html).toContain('未完成检查的条目：'); expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;unscanned');
  expect(html).not.toContain('<img'); expect(html).not.toContain('<script>');
  expect(html).toContain('预算不足跳过：budget-skip'); expect(html).toContain('已选用：selected');
});
it('explains zero scanning only from saved injection budget rather than the draft', () => {
  input(render(), 8000, '0'); let tree = render();
  expect(find(tree, n => n.props?.children === '预算为0，不注入也不执行关键词扫描。')).toBeUndefined();
  unmount(); h.cells = []; binding = { ...binding, worldbook: { enabled: true, scanDepth: 4, budgetChars: 0 } };
  tree = render(); input(tree, 8000, '500'); tree = render();
  expect(find(tree, n => n.props?.children === '预算为0，不注入也不执行关键词扫描。')).toBeDefined();
});
it('preserves drafts when close is cancelled and discards only after acceptance', async () => {
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); tree = render(); input(tree, 20, '3'); tree = render();
  click(tree, '关闭'); await settle(); tree = render();
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(true);
  expect(find(tree, n => n.type === 'Input').props.value).toBe(3);
  confirm.mockResolvedValue(true); click(tree, '关闭'); await settle(); tree = render();
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(false);
  expect(find(tree, n => n.type === 'Input').props.value).toBe(6);
});
it('retains a conflict draft and guards reread with the same confirmation', async () => {
  h.api.mockRejectedValueOnce(new Error('HTTP409 binding changed'));
  input(render(), 20, '3'); click(render(), '保存世界书设置'); await settle(); let tree = render();
  expect(find(tree, n => n.type === 'Input').props.value).toBe(3);
  click(tree, '重新读取已保存设置'); await settle(); expect(onReload).not.toHaveBeenCalled();
  confirm.mockResolvedValue(true); click(render(), '重新读取已保存设置'); await settle();
  render();
  expect(onReload).toHaveBeenCalledOnce(); expect(h.protection.registry.snapshot()[0].dirty).toBe(false);
});
it('rejects stale edit/save/preview/close callbacks while quit is locked and resumes after cancellation', async () => {
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick();
  input(tree, 20, '3'); find(tree, n => n.type === 'Textarea').props.onChange({ target: { value: 'test' } }); tree = render();
  const staleSave = find(tree, n => n.type === 'ConfirmButton').props.onClick;
  const stalePreview = find(tree, n => n.props?.children === '测试关键词').props.onClick;
  const staleClose = find(tree, n => n.type === 'Modal').props.onClose;
  const staleEdit = find(tree, n => n.type === 'Input').props.onChange;
  tree = render(true); staleSave(); stalePreview(); staleClose(); staleEdit({ target: { value: '9' } }); await settle(); tree = render(true);
  expect(h.api).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  expect(find(tree, n => n.type === 'Modal').props).toMatchObject({ open: true, closeDisabled: true });
  expect(find(tree, n => n.type === 'Input').props.value).toBe(3);
  tree = render(false); expect(find(tree, n => n.type === 'Input').props.disabled).toBe(false);
});
it('ignores slow save completion after unmount and rejects old callbacks', async () => {
  let finish!: (value: any) => void; h.api.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  input(render(), 20, '3'); const tree = render(); const staleSave = find(tree, n => n.type === 'ConfirmButton').props.onClick;
  staleSave(); render(); unmount(); finish({ binding: { ...binding, revision: 'binding-r2' } }); await settle(); staleSave();
  expect(onSaved).not.toHaveBeenCalled(); expect(h.api).toHaveBeenCalledOnce(); expect(h.protection.registry.snapshot()).toEqual([]);
});
it('hides the portal without discarding drafts and rejects old action callbacks while invisible', async () => {
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); input(tree, 20, '3');
  find(tree, n => n.type === 'Textarea').props.onChange({ target: { value: 'pending sample' } }); tree = render();
  const oldSave = find(tree, n => n.type === 'ConfirmButton').props.onClick;
  const oldPreview = find(tree, n => n.props?.children === '测试关键词').props.onClick;
  const oldClose = find(tree, n => n.type === 'Modal').props.onClose;
  const oldEdit = find(tree, n => n.type === 'Input').props.onChange;
  tree = render(false, false, false);
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(false);
  oldSave(); oldPreview(); oldClose(); oldEdit({ target: { value: '9' } }); await settle();
  tree = render(false, false, false);
  expect(h.api).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  expect(h.protection.registry.snapshot()[0]).toMatchObject({ dirty: true, busy: false });
  tree = render(); expect(find(tree, n => n.type === 'Modal').props.open).toBe(false);
  expect(find(tree, n => n.type === 'Input').props.value).toBe(3);
  expect(find(tree, n => n.type === 'Textarea').props.value).toBe('pending sample');
  find(tree, n => n.type === 'Button').props.onClick();
  expect(find(render(), n => n.type === 'Modal').props.open).toBe(true);
});
it('selects a fixed independent book, adopts suggested parameters without enabling, and reconciles saved metadata', async () => {
  const source = { kind: 'artifact' as const, ref: { source: 'public' as const, id: 'book', revision: 'r2' } };
  const summary = { id: 'book', revision: 'r2', name: '花园书', entryCount: 2, enabledEntryCount: 1, fingerprint: 'f'.repeat(64) };
  const detail = { manifest: { id: 'book', kind: 'worldbook', revision: 'r2', name: '花园书', worldbook: { version: 1, scanDepth: 7, budgetChars: 1234,
    entries: [{ id: 'a', keys: ['花园'], content: 'A' }, { id: 'b', keys: [], content: 'B', enabled: false }] } }, fingerprint: 'f'.repeat(64) };
  const fresh = { ...binding, revision: 'binding-r2', worldbook: { enabled: true, scanDepth: 7, budgetChars: 1234 }, worldbookSource: source,
    worldbookEntryCount: 2, worldbookDefaults: { scanDepth: 7, budgetChars: 1234 },
    effectiveWorldbook: { source, state: 'ready', revision: 'r2', name: '花园书', entryCount: 2, enabledEntryCount: 1 } };
  h.api.mockImplementation(async (url: string, init?: any) => {
    if (url.startsWith('/worldbooks?')) return { items: [summary] };
    if (url === '/worldbooks/book/revisions/r2') return detail;
    if (url === '/accounts/10001/role-bindings/private/peer%2FA/worldbook' && init?.method === 'PUT') {
      return { binding: { accountId: '10001', kind: 'private', peerId: 'peer/A', revision: 'binding-r2', worldbook: { enabled: true, scanDepth: 7, budgetChars: 1234 }, worldbookSource: source } };
    }
    if (url === '/accounts/10001/role-bindings') return { bindings: [fresh] };
    throw new Error(`unexpected ${url}`);
  });
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); tree = render();
  const sourceSelect = find(tree, n => n.type === 'Select' && n.props['aria-label'] === '世界书来源');
  sourceSelect.props.onChange({ target: { value: 'artifact' } }); await settle(); tree = render();
  expect(h.api).toHaveBeenCalledWith('/worldbooks?limit=100');
  expect(find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择世界书').props.value).toBe('book');
  expect(find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择固定版本').props.value).toBe('r2');
  expect(find(tree, n => n.type === 'Checkbox').props.checked).toBe(false);
  click(tree, '采用书中建议参数'); tree = render();
  expect(find(tree, n => n.type === 'Input' && n.props.max === 20).props.value).toBe(7);
  expect(find(tree, n => n.type === 'Input' && n.props.max === 8000).props.value).toBe(1234);
  expect(find(tree, n => n.type === 'Checkbox').props.checked).toBe(false);
  find(tree, n => n.type === 'Checkbox').props.onChange({ target: { checked: true } }); tree = render();
  click(tree, '保存世界书设置'); await settle(); tree = render();
  const put = h.api.mock.calls.find(call => call[0].endsWith('/worldbook') && call[1]?.method === 'PUT');
  expect(JSON.parse(put![1].body)).toEqual({ worldbook: { enabled: true, scanDepth: 7, budgetChars: 1234 }, source, expectedRevision: 'binding-r1' });
  expect(h.api.mock.calls.some(call => call[0] === '/accounts/10001/role-bindings')).toBe(true);
  expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ worldbookSource: source, effectiveWorldbook: expect.objectContaining({ state: 'ready', revision: 'r2' }) }));
  expect(find(tree, n => n.type === 'Select' && n.props['aria-label'] === '世界书来源').props.value).toBe('artifact');
});

it('keeps the saved source when the version list or detail cannot be read', async () => {
  const source = { kind: 'artifact' as const, ref: { source: 'public' as const, id: 'book', revision: 'r1' } };
  binding = { ...binding, worldbookSource: source, effectiveWorldbook: { source, state: 'missing', revision: 'r1', entryCount: 0, enabledEntryCount: 0, error: '世界书版本缺失或损坏' } };
  h.api.mockRejectedValue(new Error('列表暂不可用'));
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); await settle(); tree = render();
  expect(find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择世界书').props.value).toBe('book');
  expect(find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择固定版本').props.value).toBe('r1');
  expect(find(tree, n => n.type === 'ErrorNote')).toBeDefined();
  click(tree, '关闭'); await settle();
  expect(confirm).not.toHaveBeenCalled();
});

it('keeps the last source intent when a slow version list resolves after switching back', async () => {
  let finish!: (value: any) => void;
  const detailCalls: string[] = [];
  h.api.mockImplementation((url: string) => {
    if (url.startsWith('/worldbooks?')) return new Promise(resolve => { finish = resolve; });
    if (url.includes('/revisions/')) { detailCalls.push(url); return {}; }
    throw new Error(`unexpected ${url}`);
  });
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); tree = render();
  const source = () => find(tree, n => n.type === 'Select' && n.props['aria-label'] === '世界书来源');
  source().props.onChange({ target: { value: 'artifact' } }); await settle(); tree = render();
  expect(source().props.value).toBe('artifact');
  source().props.onChange({ target: { value: 'role-card' } }); tree = render();
  finish({ items: [{ id: 'book', revision: 'r1', name: 'Book', entryCount: 1, enabledEntryCount: 1, fingerprint: 'f'.repeat(64) }] });
  await settle(); tree = render();
  expect(source().props.value).toBe('role-card');
  expect(detailCalls).toEqual([]);
});

it('ignores an older list response when two opposite artifact intents finish out of order', async () => {
  const resolvers: Array<(value: any) => void> = [];
  const detailCalls: string[] = [];
  h.api.mockImplementation((url: string) => {
    if (url.startsWith('/worldbooks?')) return new Promise(resolve => { resolvers.push(resolve); });
    if (url.includes('/revisions/')) { detailCalls.push(url); return { manifest: { id: 'b', kind: 'worldbook', revision: 'r1', worldbook: { version: 1, entries: [] } }, fingerprint: 'b'.repeat(64) }; }
    throw new Error(`unexpected ${url}`);
  });
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); tree = render();
  const source = () => find(tree, n => n.type === 'Select' && n.props['aria-label'] === '世界书来源');
  source().props.onChange({ target: { value: 'artifact' } }); await settle(); tree = render();
  source().props.onChange({ target: { value: 'role-card' } }); tree = render();
  source().props.onChange({ target: { value: 'artifact' } }); await settle(); tree = render();
  expect(resolvers).toHaveLength(2);
  resolvers[1]!({ items: [{ id: 'b', revision: 'r1', name: 'B', entryCount: 0, enabledEntryCount: 0, fingerprint: 'b'.repeat(64) }] });
  await settle(); tree = render();
  expect(find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择世界书').props.value).toBe('b');
  resolvers[0]!({ items: [{ id: 'a', revision: 'r9', name: 'A', entryCount: 1, enabledEntryCount: 1, fingerprint: 'a'.repeat(64) }] });
  await settle(); tree = render();
  expect(find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择世界书').props.value).toBe('b');
  expect(detailCalls.filter(url => url.includes('/a/'))).toEqual([]);
});

it('does not continue a source selection after the modal becomes locked or hidden', async () => {
  let finish!: (value: any) => void;
  const detailCalls: string[] = [];
  h.api.mockImplementation((url: string) => {
    if (url.startsWith('/worldbooks?')) return new Promise(resolve => { finish = resolve; });
    if (url.includes('/revisions/')) { detailCalls.push(url); return {}; }
    throw new Error(`unexpected ${url}`);
  });
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); tree = render();
  find(tree, n => n.type === 'Select' && n.props['aria-label'] === '世界书来源').props.onChange({ target: { value: 'artifact' } });
  await settle(); tree = render(true); finish({ items: [{ id: 'book', revision: 'r1', name: 'Book', entryCount: 1, enabledEntryCount: 1, fingerprint: 'f'.repeat(64) }] });
  await settle(); tree = render(true);
  expect(find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择世界书').props.value).toBe('');
  expect(detailCalls).toEqual([]);
});

it('invalidates a pending source selection when the account identity changes', async () => {
  let finish!: (value: any) => void;
  const detailCalls: string[] = [];
  h.api.mockImplementation((url: string) => {
    if (url.startsWith('/worldbooks?')) return new Promise(resolve => { finish = resolve; });
    if (url.includes('/revisions/')) { detailCalls.push(url); return {}; }
    throw new Error(`unexpected ${url}`);
  });
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); tree = render();
  find(tree, n => n.type === 'Select' && n.props['aria-label'] === '世界书来源').props.onChange({ target: { value: 'artifact' } });
  await settle();
  binding = { ...binding, accountId: '10002' }; tree = render();
  finish({ items: [{ id: 'book', revision: 'r1', name: 'Book', entryCount: 1, enabledEntryCount: 1, fingerprint: 'f'.repeat(64) }] });
  await settle(); tree = render();
  expect(find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择世界书').props.value).toBe('');
  expect(detailCalls).toEqual([]);
});

function detailFor(revision: string, name: string) {
  return { manifest: { id: 'book', kind: 'worldbook', revision, name, worldbook: { version: 1, scanDepth: 4, budgetChars: 2000,
    entries: [{ id: 'e', keys: ['k'], content: 'C' }] } }, fingerprint: 'f'.repeat(64) };
}
function textOf(node: any): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  const children = Array.isArray(node) ? node : node.props?.children;
  return (Array.isArray(children) ? children : [children]).map(textOf).join('');
}
function textContaining(node: any, value: string): any {
  return find(node, n => textOf(n).includes(value));
}
function artifactBinding(revision = 'r1'): WorldbookBinding {
  return { ...binding, worldbookSource: { kind: 'artifact', ref: { source: 'public', id: 'book', revision } }, worldbookEntryCount: 1 };
}
function detailMocks() {
  const details: Array<(value: any) => void> = [];
  h.api.mockImplementation((url: string) => {
    if (url.startsWith('/worldbooks?')) return Promise.resolve({ items: [
      { id: 'book', revision: 'r2', name: 'Book', entryCount: 1, enabledEntryCount: 1, fingerprint: '2'.repeat(64) },
      { id: 'book', revision: 'r1', name: 'Book', entryCount: 1, enabledEntryCount: 1, fingerprint: '1'.repeat(64) }
    ] });
    if (url.includes('/revisions/')) return new Promise(resolve => { details.push(resolve); });
    throw new Error(`unexpected ${url}`);
  });
  return details;
}

it('ends the stale detail loading state when quit locking is cancelled and restores it with a new request', async () => {
  binding = artifactBinding(); const details = detailMocks();
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); await settle(); tree = render();
  expect(details).toHaveLength(1);
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeDefined();
  render(true); tree = render(true);
  expect(details).toHaveLength(1);
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeUndefined();
  render(false); tree = render(false);
  expect(details).toHaveLength(2);
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeDefined();
  details[0]!(detailFor('r1', '旧响应')); await settle(); tree = render();
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeDefined();
  expect(textContaining(tree, '旧响应')).toBeUndefined();
  details[1]!(detailFor('r1', '新响应')); await settle(); tree = render();
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeUndefined();
  expect(textContaining(tree, '新响应')).toBeDefined();
});

it('ends the detail loading state when the settings view hides and never backfills the stale response', async () => {
  binding = artifactBinding(); const details = detailMocks();
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); await settle(); tree = render();
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeDefined();
  render(false, false, false); tree = render(false, false, false);
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeUndefined();
  expect(details).toHaveLength(1);
  details[0]!(detailFor('r1', '隐藏旧响应')); await settle(); tree = render(false, false, false);
  expect(textContaining(tree, '隐藏旧响应')).toBeUndefined();
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeUndefined();
});

it('ends the detail loading state and discards the response when the account identity changes', async () => {
  binding = artifactBinding(); const details = detailMocks();
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); await settle(); tree = render();
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeDefined();
  binding = { ...binding, accountId: '10002' }; render(); tree = render();
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeUndefined();
  expect(details).toHaveLength(1);
  details[0]!(detailFor('r1', '跨账号旧响应')); await settle(); tree = render();
  expect(textContaining(tree, '跨账号旧响应')).toBeUndefined();
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeUndefined();
});

it('keeps a newer detail request busy when an older response arrives late', async () => {
  binding = artifactBinding(); const details = detailMocks();
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); await settle(); tree = render();
  expect(details).toHaveLength(1);
  find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择固定版本').props.onChange({ target: { value: 'r2' } });
  tree = render();
  expect(details).toHaveLength(2);
  details[0]!(detailFor('r1', '一版旧响应')); await settle(); tree = render();
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeDefined();
  expect(textContaining(tree, '一版旧响应')).toBeUndefined();
  details[1]!(detailFor('r2', '二版新响应')); await settle(); tree = render();
  expect(find(tree, n => n.props?.children === '正在读取指定版本…')).toBeUndefined();
  expect(textContaining(tree, '二版新响应')).toBeDefined();
});

it('loads version pages so a 101st revision and a later book stay selectable and saves the fixed ref', async () => {
  const page = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, index) => ({
    id: 'big', revision: `v${String(start + index).padStart(3, '0')}`, name: 'Big', entryCount: 1, enabledEntryCount: 1, fingerprint: `${start + index}`.padEnd(64, 'f')
  }));
  const first = page(1, 100);
  const second = [
    { id: 'big', revision: 'v101', name: 'Big', entryCount: 1, enabledEntryCount: 1, fingerprint: '1'.repeat(64) },
    { id: 'later', revision: 'r1', name: 'Later', entryCount: 1, enabledEntryCount: 1, fingerprint: 'l'.repeat(64) }
  ];
  const selected = { kind: 'artifact' as const, ref: { source: 'public' as const, id: 'big', revision: 'v101' } };
  const fresh = { ...binding, revision: 'binding-r2', worldbook: { enabled: false, scanDepth: 4, budgetChars: 2000 }, worldbookSource: selected,
    worldbookEntryCount: 1, worldbookDefaults: { scanDepth: 4, budgetChars: 2000 },
    effectiveWorldbook: { source: selected, state: 'ready' as const, revision: 'v101', entryCount: 1, enabledEntryCount: 1 } };
  h.api.mockImplementation(async (url: string, init?: any) => {
    if (url === '/worldbooks?limit=100') return { items: first, nextOffset: 100 };
    if (url === '/worldbooks?limit=100&offset=100') return { items: second };
    if (url.startsWith('/worldbooks/big/revisions/')) return { manifest: { id: 'big', kind: 'worldbook', revision: url.split('/').at(-1)!, name: 'Big',
      worldbook: { version: 1, scanDepth: 4, budgetChars: 2000, entries: [{ id: 'e', keys: ['k'], content: 'C' }] } }, fingerprint: '1'.repeat(64) };
    if (url === '/accounts/10001/role-bindings/private/peer%2FA/worldbook' && init?.method === 'PUT') return { binding: fresh };
    if (url === '/accounts/10001/role-bindings') return { bindings: [fresh] };
    throw new Error(`unexpected ${url}`);
  });
  let tree = render(); find(tree, n => n.type === 'Button').props.onClick(); tree = render();
  find(tree, n => n.type === 'Select' && n.props['aria-label'] === '世界书来源').props.onChange({ target: { value: 'artifact' } });
  await settle(); tree = render();
  expect(find(tree, n => n.type === 'Button' && n.props.children === '加载更多版本')).toBeDefined();
  click(tree, '加载更多版本'); await settle(); tree = render();
  expect(h.api).toHaveBeenCalledWith('/worldbooks?limit=100&offset=100');
  expect(find(tree, n => n.type === 'Button' && n.props.children === '加载更多版本')).toBeUndefined();
  find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择世界书').props.onChange({ target: { value: 'big' } });
  await settle(); tree = render();
  find(tree, n => n.type === 'Select' && n.props['aria-label'] === '选择固定版本').props.onChange({ target: { value: 'v101' } });
  await settle(); tree = render();
  click(tree, '保存世界书设置'); await settle();
  const put = h.api.mock.calls.find(call => call[0].endsWith('/worldbook') && call[1]?.method === 'PUT');
  expect(JSON.parse(put![1].body)).toMatchObject({ source: selected, expectedRevision: 'binding-r1' });
  expect(onSaved).toHaveBeenCalledOnce();
});

it('retains local edits when the server binding revision changes and prevents stale save', () => {
  input(render(), 20, '3'); binding = { ...binding, revision: 'binding-r2', worldbook: { enabled: true, scanDepth: 9, budgetChars: 100 } };
  const tree = render(); expect(find(tree, n => n.type === 'Input').props.value).toBe(3);
  click(tree, '保存世界书设置'); expect(h.api).not.toHaveBeenCalled();
});

it('keeps worldbook editors mounted in plugins view and includes their dirty registrations in account switch', async () => {
  const accounts = { accounts: ['10001', '10002'].map(accountId => ({ accountId, state: 'ready', nickname: accountId, dir: '', slots: [] })) } as any;
  h.api.mockImplementation(async (url: string) => url.endsWith('/role-bindings') ? { bindings: [{ ...binding, roleCard: { source: 'public', id: 'card' }, state: 'ready', updatedAt: 0 }] } : { artifacts: [] });
  const pageCells: any[] = []; const editorCells: any[] = [];
  const props: any = { accounts, accountsLoading: false, artifacts: { artifacts: [], current: {} }, artifactsLoading: false, refresh: async () => {}, onRetryArtifacts: async () => {}, onGoSlots() {}, onGoArtifacts() {}, onFocusDisplayHandled() {} };
  let tree = run(() => AccountsPage({ ...props, view: 'roles' }), pageCells);
  tree = run(() => AccountsPage({ ...props, view: 'roles' }), pageCells); await settle(); tree = run(() => AccountsPage({ ...props, view: 'roles' }), pageCells);
  let worldbook = find(tree, n => n.type === WorldbookSettings); expect(worldbook).toBeDefined(); expect(worldbook.props.visible).toBe(true);
  const editor = run(() => WorldbookSettings(worldbook.props), editorCells); input(editor, 20, '3'); run(() => WorldbookSettings(worldbook.props), editorCells);
  tree = run(() => AccountsPage({ ...props, view: 'plugins' }), pageCells); worldbook = find(tree, n => n.type === WorldbookSettings); expect(worldbook).toBeDefined(); expect(worldbook.props.visible).toBe(false);
  tree = run(() => AccountsPage({ ...props, view: 'roles' }), pageCells);
  find(tree, n => n.type === 'Select' && n.props.value === '10001').props.onChange({ target: { value: '10002' } }); await settle(); tree = run(() => AccountsPage({ ...props, view: 'roles' }), pageCells);
  expect(h.protection.requestTransition).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: 'ids', ids: expect.arrayContaining(['worldbook:10001/private/peer/A']) } }));
  expect(find(tree, n => n.type === 'Select' && n.props.value === '10001')).toBeDefined();
  expect(h.protection.registry.snapshot().some((entry: any) => entry.id.startsWith('worldbook:') && entry.dirty)).toBe(true);
});

it('blocks account switching while a worldbook request is in flight and merges raw saves without losing view metadata', async () => {
  const accounts = { accounts: ['10001', '10002'].map(accountId => ({ accountId, state: 'ready', nickname: accountId, dir: '', slots: [] })) } as any;
  const initial = { ...binding, roleCard: { source: 'public', id: 'card' }, cardName: 'Card', resolvedRevision: 'card-v1', state: 'ready', updatedAt: 0 };
  h.api.mockImplementation(async (url: string) => url.endsWith('/role-bindings') ? { bindings: [initial] } : { artifacts: [] });
  const pageCells: any[] = []; const editorCells: any[] = [];
  const props: any = { view: 'roles', accounts, accountsLoading: false, artifacts: { artifacts: [], current: {} }, artifactsLoading: false, refresh: async () => {}, onRetryArtifacts: async () => {}, onGoSlots() {}, onGoArtifacts() {}, onFocusDisplayHandled() {} };
  run(() => AccountsPage(props), pageCells); run(() => AccountsPage(props), pageCells); await settle();
  let page = run(() => AccountsPage(props), pageCells);
  const worldbook = find(page, n => n.type === WorldbookSettings);
  let editor = run(() => WorldbookSettings(worldbook.props), editorCells); input(editor, 20, '3'); editor = run(() => WorldbookSettings(worldbook.props), editorCells);
  let finish!: (result: any) => void; h.api.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  click(editor, '保存世界书设置'); run(() => WorldbookSettings(worldbook.props), editorCells);
  find(page, n => n.type === 'Select' && n.props.value === '10001').props.onChange({ target: { value: '10002' } }); await settle();
  page = run(() => AccountsPage(props), pageCells);
  expect(find(page, n => n.type === 'Select' && n.props.value === '10001')).toBeDefined();
  expect(confirm).not.toHaveBeenCalled();
  finish({ binding: { accountId: '10001', kind: 'private', peerId: 'peer/A', revision: 'binding-r2', updatedAt: 1, worldbook: { enabled: false, scanDepth: 3, budgetChars: 3456 } } }); await settle();
  page = run(() => AccountsPage(props), pageCells);
  expect(find(page, n => n.type === WorldbookSettings).props.binding).toMatchObject({
    revision: 'binding-r2', worldbookEntryCount: 2, worldbookDefaults: { scanDepth: 6, budgetChars: 3456 }, cardName: 'Card', roleCard: { source: 'public', id: 'card' }
  });
});
