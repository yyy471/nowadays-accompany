import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftRegistry } from '../desktop/renderer/src/lib/drafts/registry';
vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());
const h = vi.hoisted(() => ({ cells: [] as any[], index: 0, effects: [] as Array<() => any>, cleanups: [] as Array<() => void>, registry: null as any }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = h.index++; const cells = h.cells;
    if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
    return [cells[index], (value: any) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }];
  },
  useRef: (initial: any) => { const index = h.index++; return h.cells[index] ??= { current: initial }; },
  useEffect: (effect: () => any, deps: unknown[]) => {
    const index = h.index++; const previous = h.cells[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) h.effects.push(effect);
    h.cells[index] = deps;
  }
}));
vi.mock('../desktop/renderer/src/components/DraftProtectionProvider', () => ({ useDraftProtection: () => ({ registry: h.registry }) }));
vi.mock('../desktop/renderer/src/hooks', () => ({ errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) }));
vi.mock('../desktop/renderer/src/ui', () => ({ Button: 'Button', CancelButton: 'CancelButton', ConfirmButton: 'ConfirmButton', Modal: 'Modal', ErrorNote: 'ErrorNote' }));
import { ArtifactImport } from '../desktop/renderer/src/components/ArtifactImport';
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) { const result = find(child, predicate); if (result) return result; }
}
const preview = { token: 'opaque-preview', kind: 'role-card' as const, id: 'friend', revision: 'v1', name: '好友', fileCount: 2, totalBytes: 256, targetPath: 'fixture/public/artifacts/role-card/friend/v1' };
let bridge: { openArtifactsDirectory: ReturnType<typeof vi.fn>; previewArtifactImport: ReturnType<typeof vi.fn>; commitArtifactImport: ReturnType<typeof vi.fn> };
let refresh: ReturnType<typeof vi.fn>;
function render(disabled = false, locked = false) {
  h.index = 0; h.effects = [];
  const tree = ArtifactImport({ refresh, disabled, locked });
  for (const effect of h.effects) { const cleanup = effect(); if (typeof cleanup === 'function') h.cleanups.push(cleanup); }
  return tree;
}
function click(tree: any, label: string) { find(tree, n => n.props?.children === label).props.onClick(); }
function unmount() { for (const cleanup of h.cleanups.splice(0)) cleanup(); }
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
beforeEach(() => {
  unmount(); h.cells = []; h.registry = new DraftRegistry();
  bridge = { openArtifactsDirectory: vi.fn(async () => {}), previewArtifactImport: vi.fn(async () => preview), commitArtifactImport: vi.fn(async () => ({ kind: 'role-card', id: 'friend', revision: 'v1' })) };
  refresh = vi.fn(async () => {});
  vi.stubGlobal('window', { nowadays: bridge });
});

it.each([['导入资源', 'directory'], ['导入酒馆角色卡', 'tavern-card']])('%s previews without writing and cancellation does not commit or refresh', async (label, mode) => {
  let tree = render(); click(tree, label); await settle(); tree = render();
  expect(bridge.previewArtifactImport).toHaveBeenCalledWith(mode);
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(true);
  expect(find(tree, n => n.type === 'code').props.children).toBe(preview.targetPath);
  expect(bridge.commitArtifactImport).not.toHaveBeenCalled();
  click(tree, '取消'); tree = render();
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
});
it.each(['导入资源', '导入酒馆角色卡'])('treats native %s chooser cancellation as no import', async label => {
  bridge.previewArtifactImport.mockResolvedValue(undefined);
  click(render(), label); await settle();
  expect(find(render(), n => n.type === 'Modal').props.open).toBe(false);
  expect(bridge.commitArtifactImport).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
});
it.each(['导入资源', '导入酒馆角色卡'])('%s commits only the preview token once, registers busy and refreshes without deploying', async label => {
  let finish!: (value: any) => void;
  bridge.commitArtifactImport.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let tree = render(); click(tree, label); await settle(); tree = render();
  click(tree, '确认导入'); click(tree, '确认导入'); tree = render();
  expect(bridge.commitArtifactImport).toHaveBeenCalledOnce();
  expect(bridge.commitArtifactImport).toHaveBeenCalledWith('opaque-preview');
  expect(h.registry.snapshot()[0].busy).toBe(true);
  expect(find(tree, n => n.type === 'Modal').props.closeDisabled).toBe(true);
  finish({ kind: 'role-card', id: 'friend', revision: 'v1' }); await settle(); tree = render();
  expect(refresh).toHaveBeenCalledOnce(); expect(h.registry.snapshot()[0].busy).toBe(false);
  expect(find(tree, n => n.props?.role === 'status').props.children).toContain('尚未部署');
});
it('shows preview and commit errors, clears consumed preview and allows selecting again', async () => {
  bridge.previewArtifactImport.mockRejectedValueOnce(new Error('invalid manifest'));
  click(render(), '导入资源'); await settle();
  expect(find(render(), n => n.type === 'ErrorNote').props.message).toBe('invalid manifest');
  click(render(), '导入资源'); await settle();
  bridge.commitArtifactImport.mockRejectedValueOnce(new Error('revision already exists'));
  click(render(), '确认导入'); await settle(); const tree = render();
  expect(find(tree, n => n.type === 'ErrorNote').props.message).toContain('revision already exists');
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
});
it('imports a worldbook JSON preview as a fixed version and states that no session changed', async () => {
  const worldbook = { ...preview, kind: 'worldbook' as const, id: 'book', revision: 'i-abc', name: '花园书', sourceFormat: 'tavern-array' as const, warnings: ['已转换为关键词触发'] };
  bridge.previewArtifactImport.mockResolvedValue(worldbook);
  bridge.commitArtifactImport.mockResolvedValue({ kind: 'worldbook', id: 'book', revision: 'i-abc' });
  let tree = render(); click(tree, '导入世界书 JSON'); await settle(); tree = render();
  expect(bridge.previewArtifactImport).toHaveBeenCalledWith('worldbook');
  expect(find(tree, n => n.props?.children === '世界书')).toBeDefined();
  expect(find(tree, n => n.props?.children === '酒馆世界书（数组格式）')).toBeDefined();
  expect(find(tree, n => n.props?.children === '已转换为关键词触发')).toBeDefined();
  click(tree, '确认导入'); await settle(); tree = render();
  expect(bridge.commitArtifactImport).toHaveBeenCalledWith('opaque-preview');
  const status = find(tree, n => n.props?.role === 'status');
  expect(renderToStaticMarkup(status)).toContain('尚未在任何会话启用');
  expect(refresh).toHaveBeenCalledOnce();
});

it('opens only the controlled directory and reports bridge errors', async () => {
  bridge.openArtifactsDirectory.mockRejectedValueOnce(new Error('open failed'));
  click(render(), '打开资源目录'); await settle();
  expect(bridge.openArtifactsDirectory).toHaveBeenCalledOnce();
  expect(find(render(), n => n.type === 'ErrorNote').props.message).toBe('open failed');
});
it('ignores chooser completion after unmount and rejects a stale confirm callback', async () => {
  let finish!: (value: any) => void;
  bridge.previewArtifactImport.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const initial = render(); click(initial, '导入资源'); click(initial, '导入资源'); render();
  expect(bridge.previewArtifactImport).toHaveBeenCalledOnce();
  expect(h.registry.snapshot()[0].busy).toBe(true);
  unmount(); finish(preview); await settle();
  expect(bridge.commitArtifactImport).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  h.cells = []; let tree = render(); bridge.previewArtifactImport.mockResolvedValue(preview);
  click(tree, '导入资源'); await settle(); tree = render(); const staleConfirm = find(tree, n => n.type === 'ConfirmButton').props.onClick;
  unmount(); staleConfirm(); await settle();
  expect(bridge.commitArtifactImport).not.toHaveBeenCalled();
});
it('does not refresh or update after an already submitted import completes during unmount', async () => {
  let finish!: (value: any) => void;
  bridge.commitArtifactImport.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  click(render(), '导入资源'); await settle(); click(render(), '确认导入'); render(); unmount();
  finish({ kind: 'role-card', id: 'friend', revision: 'v1' }); await settle();
  expect(refresh).not.toHaveBeenCalled(); expect(h.registry.snapshot()).toHaveLength(0);
});
it('disables desktop actions in a browser and respects an external busy lock', () => {
  vi.stubGlobal('window', {}); let tree = render();
  expect(find(tree, n => n.type === 'Button').props.disabled).toBe(true);
  click(tree, '导入资源'); expect(bridge.previewArtifactImport).not.toHaveBeenCalled();
  expect(find(tree, n => n.props?.children === '导入酒馆角色卡').props.disabled).toBe(true);
  click(tree, '导入酒馆角色卡'); expect(bridge.previewArtifactImport).not.toHaveBeenCalled();
  vi.stubGlobal('window', { accompany: bridge }); tree = render(true); click(tree, '打开资源目录');
  expect(bridge.openArtifactsDirectory).not.toHaveBeenCalled();
});

it('keeps successful import feedback if refreshing the list fails', async () => {
  refresh.mockRejectedValueOnce(new Error('refresh offline'));
  click(render(), '导入资源'); await settle(); click(render(), '确认导入'); await settle(); const tree = render();
  expect(find(tree, n => n.props?.role === 'status').props.children).toContain('已导入');
  expect(find(tree, n => n.type === 'ErrorNote').props.message).toContain('资源已导入，但列表刷新失败');
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(false);
});

it.each(['导入资源', '导入酒馆角色卡'])('locks an open %s preview and rejects old portal callbacks until quit checking is cancelled', async label => {
  let tree = render(); const oldChoose = find(tree, n => n.props?.children === '导入资源').props.onClick;
  const oldTavernChoose = find(tree, n => n.props?.children === '导入酒馆角色卡').props.onClick;
  const oldDirectory = find(tree, n => n.props?.children === '打开资源目录').props.onClick;
  click(tree, label); await settle(); tree = render();
  const oldCommit = find(tree, n => n.type === 'ConfirmButton').props.onClick;
  const oldClose = find(tree, n => n.type === 'Modal').props.onClose;
  tree = render(false, true);
  expect(find(tree, n => n.type === 'Modal').props.closeDisabled).toBe(true);
  expect(find(tree, n => n.type === 'CancelButton').props.disabled).toBe(true);
  oldCommit(); oldClose(); oldChoose(); oldTavernChoose(); oldDirectory(); await settle(); tree = render(false, true);
  expect(bridge.commitArtifactImport).not.toHaveBeenCalled();
  expect(bridge.openArtifactsDirectory).not.toHaveBeenCalled();
  expect(bridge.previewArtifactImport).toHaveBeenCalledOnce();
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(true);
  tree = render(false, false); click(tree, '确认导入'); await settle();
  expect(bridge.commitArtifactImport).toHaveBeenCalledOnce();
});

it.each(['tavern-v1', 'tavern-v2'])('renders %s text and every warning as escaped plain text with bounded preview', async sourceFormat => {
  const contentPreview = '<img src=x onerror=alert(1)>' + 'a'.repeat(2200);
  const warnings = ['first_mes 不会自动发送', '<script>世界书不会启用</script>'];
  bridge.previewArtifactImport.mockResolvedValueOnce({ ...preview, sourceFormat, warnings, contentPreview, contentLength: 2500 });
  click(render(), '导入酒馆角色卡'); await settle(); const tree = render();
  const excerpt = find(tree, n => n.type === 'pre');
  expect(excerpt.props.children).toBe(contentPreview.slice(0, 2000));
  expect(excerpt.props.dangerouslySetInnerHTML).toBeUndefined();
  const html = renderToStaticMarkup(excerpt);
  expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
  const warningList = find(tree, n => n.type === 'ul');
  expect(warningList.props.children.map((node: any) => node.props.children)).toEqual(warnings);
  expect(renderToStaticMarkup(warningList)).toContain('&lt;script&gt;');
  expect(find(tree, n => n.type === 'dd' && n.props.children === `酒馆角色卡 ${sourceFormat === 'tavern-v1' ? 'V1' : 'V2'}（JSON/PNG）`)).toBeDefined();
  expect(find(tree, n => n.type === 'dd' && n.props.children?.[0] === (2500).toLocaleString())).toBeDefined();
  expect(bridge.commitArtifactImport).not.toHaveBeenCalled();
});

it('prevents double choosing across both import modes while the native picker is pending', async () => {
  let finish!: (value: any) => void;
  bridge.previewArtifactImport.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const tree = render(); click(tree, '导入酒馆角色卡'); click(tree, '导入酒馆角色卡'); click(tree, '导入资源'); render();
  expect(bridge.previewArtifactImport).toHaveBeenCalledOnce();
  expect(bridge.previewArtifactImport).toHaveBeenCalledWith('tavern-card');
  expect(h.registry.snapshot()[0].busy).toBe(true);
  unmount(); finish({ ...preview, sourceFormat: 'tavern-v2' }); await settle();
  expect(bridge.commitArtifactImport).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
});
