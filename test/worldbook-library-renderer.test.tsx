import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';

vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());

const h = vi.hoisted(() => ({ cells: [] as any[], index: 0, effects: [] as Array<() => any>, cleanups: [] as Array<() => void>, api: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => { const i = h.index++; const cells = h.cells; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
    return [cells[i], (value: any) => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }]; },
  useRef: (value: any) => { const i = h.index++; return h.cells[i] ??= { current: value }; },
  useCallback: (fn: any) => { const i = h.index++; return h.cells[i] ??= fn; },
  useEffect: (effect: () => any, deps: unknown[]) => { const i = h.index++; const before = h.cells[i];
    if (!before || deps.some((dep, index) => !Object.is(dep, before[index]))) h.effects.push(effect); h.cells[i] = deps; }
}));
vi.mock('../desktop/renderer/src/api', () => ({ api: (...args: any[]) => h.api(...args) }));
vi.mock('../desktop/renderer/src/hooks', () => ({ errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock('../desktop/renderer/src/components/WorldbookEditor', () => ({ WorldbookEditor: 'WorldbookEditor' }));
vi.mock('../desktop/renderer/src/ui', () => ({ Button: 'Button', Card: 'Card', Empty: 'Empty', ErrorNote: 'ErrorNote', LoadingNote: 'LoadingNote', Modal: 'Modal', Tag: 'Tag' }));

import { WorldbookLibrary } from '../desktop/renderer/src/components/WorldbookLibrary';

function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) { const result = find(child, predicate); if (result) return result; }
  if (!Array.isArray(node) && node.props) for (const [key, value] of Object.entries(node.props)) {
    if (key === 'children') continue;
    const result = find(value, predicate); if (result) return result;
  }
}
function findAll(node: any, predicate: (node: any) => boolean, found: any[] = []): any[] {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  const children = Array.isArray(node) ? node : node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) findAll(child, predicate, found);
  if (!Array.isArray(node) && node.props) for (const [key, value] of Object.entries(node.props)) {
    if (key === 'children') continue;
    findAll(value, predicate, found);
  }
  return found;
}
function run<T>(fn: () => T) { h.cells = h.cells; h.index = 0; h.effects = []; const tree = fn();
  for (const effect of h.effects) { const cleanup = effect(); if (typeof cleanup === 'function') h.cleanups.push(cleanup); } return tree; }
function unmount() { for (const cleanup of h.cleanups.splice(0)) cleanup(); }
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
function click(tree: any, label: string) { return find(tree, n => n.props?.children === label).props.onClick(); }
function text(tree: any): string {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  const children = Array.isArray(tree) ? tree : tree.props?.children;
  return (Array.isArray(children) ? children : [children]).map(text).join('');
}

const summary = (id: string, revision: string, name: string, entryCount = 2) => ({ id, revision, name, entryCount, enabledEntryCount: 1, fingerprint: `${revision}-${id}`.padEnd(64, 'f') });
const detail = (id: string, revision: string) => ({ manifest: { id, kind: 'worldbook', revision, name: `${id} 名称`, worldbook: { version: 1, scanDepth: 5, budgetChars: 1200,
  entries: [{ id: 'e1', keys: ['k'], content: 'DETAIL_BODY', enabled: true, constant: false, caseSensitive: false, priority: 0, position: 'after-role' }] } }, fingerprint: 'd'.repeat(64) });

beforeEach(() => { unmount(); h.cells = []; h.api.mockReset(); });

it('lists bounded version summaries and only reads body after selecting a version', async () => {
  h.api.mockImplementation(async (url: string) => {
    if (url === '/worldbooks?limit=50') return { items: [summary('book', 'r2', '花园'), summary('book', 'r1', '花园')], nextOffset: 2 };
    if (url === '/worldbooks/book/revisions/r2') return detail('book', 'r2');
    if (url === '/worldbooks?limit=50&offset=2') return { items: [summary('other', 'r1', '另一本')] };
    throw new Error(`unexpected ${url}`);
  });
  let tree = run(() => WorldbookLibrary({})); await settle(); tree = run(() => WorldbookLibrary({}));
  expect(text(tree)).toContain('花园'); expect(text(tree)).toContain('r2'); expect(text(tree)).not.toContain('另一本');
  expect(h.api).toHaveBeenCalledOnce();
  click(tree, '查看版本'); await settle(); tree = run(() => WorldbookLibrary({}));
  expect(h.api.mock.calls.some(call => call[0] === '/worldbooks/book/revisions/r2')).toBe(true);
  expect(text(tree)).toContain('DETAIL_BODY'); expect(text(tree)).toContain('查看不会启用');
  click(tree, '关闭'); tree = run(() => WorldbookLibrary({}));
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(false);
  click(tree, '加载更多版本'); await settle(); tree = run(() => WorldbookLibrary({}));
  expect(h.api.mock.calls.some(call => call[0] === '/worldbooks?limit=50&offset=2')).toBe(true);
  expect(text(tree)).toContain('另一本'); expect(text(tree)).toContain('已加载 3 个版本');
});

it('keeps the list and prior selection when a requested version fails', async () => {
  h.api.mockImplementation(async (url: string) => {
    if (url === '/worldbooks?limit=50') return { items: [summary('book', 'r1', '花园'), summary('book', 'r2', '花园')] };
    if (url === '/worldbooks/book/revisions/r1') return detail('book', 'r1');
    if (url === '/worldbooks/book/revisions/r2') throw new Error('指定版本暂时不可读');
    throw new Error(`unexpected ${url}`);
  });
  let tree = run(() => WorldbookLibrary({})); await settle(); tree = run(() => WorldbookLibrary({}));
  let rows = findAll(tree, n => n.type === 'Button' && n.props.children === '查看版本');
  rows[1].props.onClick(); await settle(); tree = run(() => WorldbookLibrary({}));
  expect(text(tree)).toContain('DETAIL_BODY');
  click(tree, '关闭'); tree = run(() => WorldbookLibrary({}));
  rows = findAll(tree, n => n.type === 'Button' && n.props.children === '查看版本');
  rows[0].props.onClick(); await settle(); tree = run(() => WorldbookLibrary({}));
  expect(find(tree, n => n.type === 'ErrorNote' && String(n.props.message).includes('指定版本暂时不可读'))).toBeDefined();
  expect(text(tree)).toContain('列表和其他版本未被清空');
  expect(text(tree)).toContain('花园');
});

it('creates, derives with the next revision and copies into a new identity', async () => {
  h.api.mockImplementation(async (url: string) => {
    if (url === '/worldbooks?limit=50') return { items: [summary('book', 'r1', '花园'), summary('book', 'r2', '花园')] };
    if (url === '/worldbooks/book/revisions/r2') return detail('book', 'r2');
    throw new Error(`unexpected ${url}`);
  });
  let tree = run(() => WorldbookLibrary({})); await settle(); tree = run(() => WorldbookLibrary({}));
  click(tree, '新建世界书'); tree = run(() => WorldbookLibrary({}));
  expect(find(tree, n => n.type === 'WorldbookEditor').props.seed).toMatchObject({ mode: 'create', id: '', revision: 'r1' });
  find(tree, n => n.type === 'WorldbookEditor').props.onClose(); tree = run(() => WorldbookLibrary({}));
  click(tree, '查看版本'); await settle(); tree = run(() => WorldbookLibrary({}));
  click(tree, '从此版本编辑'); tree = run(() => WorldbookLibrary({}));
  expect(find(tree, n => n.type === 'WorldbookEditor').props.seed).toMatchObject({ mode: 'derive', id: 'book', revision: 'r3', base: { id: 'book', revision: 'r2' } });
  find(tree, n => n.type === 'WorldbookEditor').props.onClose(); tree = run(() => WorldbookLibrary({}));
  click(tree, '查看版本'); await settle(); tree = run(() => WorldbookLibrary({}));
  click(tree, '复制为新书'); tree = run(() => WorldbookLibrary({}));
  expect(find(tree, n => n.type === 'WorldbookEditor').props.seed).toMatchObject({ mode: 'copy', id: 'book-copy', revision: 'r1' });
  expect(find(tree, n => n.type === 'WorldbookEditor').props.seed.base).toBeUndefined();
});
