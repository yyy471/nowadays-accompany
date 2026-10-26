import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { DraftRegistry } from '../desktop/renderer/src/lib/drafts/registry';
import { TransitionController } from '../desktop/renderer/src/lib/drafts/transition-controller';

vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());
const h = vi.hoisted(() => ({ cells: [] as any[], index: 0, effects: [] as Array<() => any>, protection: null as any, listeners: new Map<string, any>() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = h.index++; const cells = h.cells;
    if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
    return [cells[index], (value: any) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }];
  },
  useRef: (initial: any) => { const index = h.index++; return h.cells[index] ??= { current: initial }; },
  useCallback: (fn: any) => { h.index++; return fn; },
  useEffect: (effect: () => any, deps: unknown[]) => {
    const index = h.index++; const previous = h.cells[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) h.effects.push(effect);
    h.cells[index] = deps;
  }
}));
vi.mock('../desktop/renderer/src/components/DraftProtectionProvider', () => ({ useDraftProtection: () => h.protection }));
vi.mock('../desktop/renderer/src/api', () => ({ api: async () => ({}), apiBaseUrl: 'http://fixture.invalid', appVersion: 'fixture', appPlatform: 'fixture', hasToken: true, subscribeEvents() {} }));
vi.mock('../desktop/renderer/src/hooks', () => ({ errorMessage: String, usePoll: () => ({ data: undefined, loading: false, refresh: async () => {} }) }));
vi.mock('../desktop/renderer/src/ui', () => ({ Button: 'Button', CancelButton: 'CancelButton', ConfirmButton: 'ConfirmButton', ControlButton: 'ControlButton', Icon: 'Icon', Modal: 'Modal', Card: 'Card', Checkbox: 'Checkbox', ErrorNote: 'ErrorNote', Field: 'Field', Input: 'Input', Select: 'Select', Tag: 'Tag', IconButton: 'IconButton', copyText: async () => true, formatDateTime: String, useConfirm: () => async () => true }));
vi.mock('../desktop/renderer/src/pages/Accounts', () => ({ AccountsPage: 'AccountsPage' }));
vi.mock('../desktop/renderer/src/pages/Activity', () => ({ ActivityPage: 'ActivityPage' }));
vi.mock('../desktop/renderer/src/pages/Artifacts', () => ({ ArtifactsPage: 'ArtifactsPage' }));
vi.mock('../desktop/renderer/src/pages/Overview', () => ({ OverviewPage: 'OverviewPage' }));
vi.mock('../desktop/renderer/src/pages/Policy', () => ({ PolicyPage: 'PolicyPage' }));
vi.mock('../desktop/renderer/src/pages/Slots', () => ({ SlotsPage: 'SlotsPage' }));
vi.mock('../desktop/renderer/src/pages/Home', () => ({ HomePage: 'HomePage' }));
vi.mock('../desktop/renderer/src/pages/Models', () => ({ ModelsPage: 'ModelsPage' }));
vi.mock('../desktop/renderer/src/pages/Settings', () => ({ SettingsPage: 'SettingsPage' }));
import { App } from '../desktop/renderer/src/App';
import { SettingsDialog, type SettingsTab } from '../desktop/renderer/src/components/SettingsDialog';
import { SnowLumaSetup } from '../desktop/renderer/src/components/SnowLumaSetup';

function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) { const result = find(child, predicate); if (result) return result; }
}
function all(node: any, predicate: (node: any) => boolean): any[] {
  if (!node || typeof node !== 'object') return [];
  const children = Array.isArray(node) ? node : node.props?.children;
  return [...(predicate(node) ? [node] : []), ...(Array.isArray(children) ? children : [children]).flatMap(child => all(child, predicate))];
}
function render<T>(fn: () => T, cells = h.cells): T {
  h.cells = cells; h.index = 0; h.effects = [];
  const tree = fn(); for (const effect of h.effects) effect(); return tree;
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
let registry: DraftRegistry;
let confirm: ReturnType<typeof vi.fn>;
beforeEach(() => {
  h.cells = []; h.listeners.clear(); registry = new DraftRegistry(); confirm = vi.fn(async () => false);
  const controller = new TransitionController(registry);
  h.protection = { registry, requestTransition: vi.fn((options: any) => controller.request({ ...options, confirm })), transitionPending: () => controller.pending };
  vi.stubGlobal('document', { title: '' });
  const location = { hash: '#/model-config', href: 'http://fixture.invalid/#/model-config' };
  vi.stubGlobal('window', { location, history: { state: null, replaceState: vi.fn(), pushState: vi.fn() }, addEventListener: (name: string, callback: any) => h.listeners.set(name, callback), removeEventListener() {} });
});

it('remembers the session tab while connection and model entry points override it', async () => {
  let tree = render(App);
  const dialog = () => find(tree, n => n.type === SettingsDialog).props;
  dialog().onTabChange('diagnostics'); tree = render(App);
  find(tree, n => n.props?.className === 'global-settings-launcher').props.onClick(); tree = render(App);
  expect(dialog()).toMatchObject({ open: true, initialTab: 'diagnostics' });
  dialog().onRequestClose(); tree = render(App);
  find(tree, n => n.type === 'PolicyPage').props.onGoModels(); tree = render(App);
  expect(dialog().initialTab).toBe('models');
  dialog().onRequestClose(); tree = render(App);
  await find(tree, n => n.type === 'PolicyPage').props.onGoConnections(); tree = render(App);
  find(tree, n => n.type === 'SlotsPage').props.onSettings(); tree = render(App);
  expect(dialog().initialTab).toBe('snowluma');
  dialog().onRequestClose(); tree = render(App);
  find(tree, n => n.props?.className === 'global-settings-launcher').props.onClick(); tree = render(App);
  expect(dialog().initialTab).toBe('snowluma');
});

it.each(['#/settings', '#/models'])('keeps the legacy %s model service entry', hash => {
  window.location.hash = hash; window.location.href = `http://fixture.invalid/${hash}`;
  const tree = render(App);
  expect(find(tree, n => n.type === SettingsDialog).props).toMatchObject({ open: true, initialTab: 'models' });
});

it('checks all drafts before returning to account models even when already on that page', async () => {
  let draft = 'unsaved account policy';
  registry.register({ id: 'policy', owner: 'page', getSnapshot: () => ({ label: '账号模型', dirty: Boolean(draft), busy: false, revision: 1, discard: () => { draft = ''; } }) });
  let tree = render(App);
  find(tree, n => n.type === 'PolicyPage').props.onGoModels(); tree = render(App);
  find(tree, n => n.type === SettingsDialog).props.onGoAccountModels(); await settle(); tree = render(App);
  expect(h.protection.requestTransition).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: 'all' } }));
  expect(draft).toBe('unsaved account policy');
  expect(find(tree, n => n.type === SettingsDialog).props.open).toBe(true);
  confirm.mockResolvedValue(true);
  find(tree, n => n.type === SettingsDialog).props.onGoAccountModels(); await settle(); tree = render(App);
  expect(draft).toBe(''); expect(find(tree, n => n.type === SettingsDialog).props.open).toBe(false);
  expect(find(tree, n => n.type === 'PolicyPage')).toBeDefined();
});

it('retains a real connection editor draft across hidden tabs and a cancelled close', async () => {
  const editorCells: any[] = []; const dialogCells: any[] = [];
  let closed = false; let tab: SettingsTab = 'snowluma';
  const props = () => ({ open: true, initialTab: tab, onTabChange: (next: SettingsTab) => { tab = next; }, onRequestClose: () => { closed = true; }, refreshProviders: async () => {} });
  let editor = render(SnowLumaSetup, editorCells);
  find(editor, n => n.type === 'Button' && n.props.children === '下一步').props.onClick(); editor = render(SnowLumaSetup, editorCells);
  find(editor, n => n.type === 'Input' && n.props.type === 'password').props.onChange({ target: { value: 'draft secret' } });
  editor = render(SnowLumaSetup, editorCells);
  expect(registry.snapshot({ kind: 'settings' }).some(entry => entry.dirty)).toBe(true);
  let dialog = render(() => SettingsDialog(props()), dialogCells);
  const pageBefore = find(dialog, n => n.type === 'SettingsPage');
  find(dialog, n => n.type === 'ControlButton' && n.props.children[0].props.children === '诊断').props.onClick();
  dialog = render(() => SettingsDialog(props()), dialogCells);
  expect(find(dialog, n => n.type === 'SettingsPage').type).toBe(pageBefore.type);
  expect(find(dialog, n => n.type === 'SettingsPage').props.section).toBe('diagnostics');
  find(dialog, n => n.type === 'Modal').props.onClose(); await settle();
  expect(closed).toBe(false); expect(confirm).toHaveBeenCalledOnce();
  editor = render(SnowLumaSetup, editorCells);
  expect(find(editor, n => n.type === 'Input' && n.props.type === 'password').props.value).toBe('draft secret');
  confirm.mockResolvedValue(true);
  dialog = render(() => SettingsDialog(props()), dialogCells);
  find(dialog, n => n.type === 'Modal').props.onClose(); await settle();
  expect(closed).toBe(true);
  editor = render(SnowLumaSetup, editorCells);
  expect(find(editor, n => n.type === 'Input' && n.props.type === 'password').props.value).toBe('');
});

it('keeps one connection editor and one diagnostic presentation in separate sections', async () => {
  Object.assign(window, { matchMedia: () => ({ matches: false }) });
  const { SettingsPage } = await vi.importActual<typeof import('../desktop/renderer/src/pages/Settings')>('../desktop/renderer/src/pages/Settings');
  let tree = render(() => SettingsPage({ section: 'snowluma' }));
  const sections = all(tree, n => n.type === 'section');
  const connection = sections.find(n => n.props['aria-labelledby'] === 'connection-settings-heading');
  const diagnostics = sections.find(n => n.props['aria-labelledby'] === 'runtime-settings-heading');
  expect(connection.props.hidden).toBe(false); expect(diagnostics.props.hidden).toBe(true);
  expect(all(connection, n => n.type === SnowLumaSetup)).toHaveLength(1);
  expect(all(connection, n => n.type === 'Card')).toHaveLength(0);
  expect(all(diagnostics, n => n.type === SnowLumaSetup)).toHaveLength(0);
  expect(all(tree, n => n.props?.title === '运行信息')).toHaveLength(1);
  expect(all(tree, n => n.props?.title === '诊断快照')).toHaveLength(1);
  tree = render(() => SettingsPage({ section: 'diagnostics' }));
  expect(find(tree, n => n.props?.['aria-labelledby'] === 'connection-settings-heading').props.hidden).toBe(true);
  expect(find(tree, n => n.props?.['aria-labelledby'] === 'runtime-settings-heading').props.hidden).toBe(false);
});
