import { afterAll, expect, it, vi } from 'vitest';
import * as React from 'react';
vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());
const h = vi.hoisted(() => ({ decision: undefined as Promise<any> | undefined, stateListener: null as any, cells: [] as any[], index: 0, effects: [] as Array<() => any>, listener: null as any, response: false as boolean | Error, listeners: new Map<string, any>() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = h.index++;
    if (!(index in h.cells)) h.cells[index] = typeof initial === 'function' ? initial() : initial;
    return [h.cells[index], (next: any) => { h.cells[index] = typeof next === 'function' ? next(h.cells[index]) : next; }];
  },
  useRef: (initial: any) => { const index = h.index++; return h.cells[index] ??= { current: initial }; },
  useCallback: (fn: any) => { h.index++; return fn; },
  useEffect: (effect: () => any, deps: unknown[]) => {
    const index = h.index++; const previous = h.cells[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) h.effects.push(effect);
    h.cells[index] = deps;
  }
}));
vi.mock('../desktop/renderer/src/api', () => ({ api: async () => ({}), apiBaseUrl: 'http://fixture.invalid', appVersion: 'fixture', hasToken: true, subscribeEvents() {} }));
vi.mock('../desktop/renderer/src/hooks', () => ({ errorMessage: String, usePoll: () => ({ data: undefined, loading: false, refresh: async () => {} }) }));
vi.mock('../desktop/renderer/src/ui/presets', () => ({ useThemePreset: () => ({ preset: 'daylight', select() {} }) }));
vi.mock('../desktop/renderer/src/components/DraftProtectionProvider', () => ({ useDraftProtection: () => ({
  registry: { hasPending: () => true }, requestTransition: async () => h.decision ?? { ok: true }, transitionPending: () => false
}) }));
vi.mock('../desktop/renderer/src/ui', () => ({ BrandMark:'BrandMark',UiThemeScope:'UiThemeScope',UiThemeProvider:'UiThemeProvider', CancelButton: 'CancelButton', ControlButton: 'ControlButton', Icon: 'Icon', Modal: 'Modal',
  useMotionPolicy: () => ({ preference: 'system', reduced: false, forcedColors: false, select() {} }),
  createMotionScope: () => ({ run: () => ({ finished: Promise.resolve(), cancel() {} }), cancelAll() {}, size: 0 }),
  readMotionPx: (_element: unknown, _variable: string, fallback: number) => fallback,
  readMotionTime: (_element: unknown, _variable: string, fallback: number) => fallback,
  readMotionValue: (_element: unknown, _variable: string, fallback: string) => fallback }));
vi.mock('../desktop/renderer/src/pages/Accounts', () => ({ AccountsPage: 'AccountsPage' }));
vi.mock('../desktop/renderer/src/pages/Activity', () => ({ ActivityPage: 'ActivityPage' }));
vi.mock('../desktop/renderer/src/pages/Artifacts', () => ({ ArtifactsPage: 'ArtifactsPage' }));
vi.mock('../desktop/renderer/src/pages/Extensions', () => ({ ExtensionsPage: 'ExtensionsPage' }));
vi.mock('../desktop/renderer/src/pages/Overview', () => ({ OverviewPage: 'OverviewPage' }));
vi.mock('../desktop/renderer/src/pages/Policy', () => ({ PolicyPage: 'PolicyPage' }));
vi.mock('../desktop/renderer/src/pages/Slots', () => ({ SlotsPage: 'SlotsPage' }));
vi.mock('../desktop/renderer/src/pages/Home', () => ({ HomePage: 'HomePage' }));
vi.mock('../desktop/renderer/src/components/SettingsDialog', () => ({ SettingsDialog: 'SettingsDialog' }));
import { App } from '../desktop/renderer/src/App';
import { ConfirmProvider } from '../desktop/renderer/src/ui/confirm';
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) { const result = find(child, predicate); if (result) return result; }
}
function render() {
  h.index = 0; h.effects = [];
  const tree = App();
  for (const effect of h.effects) effect();
  return tree;
}
function setup(response: boolean) {
  h.cells = []; h.listeners.clear(); h.response = response; h.decision = undefined;
  vi.stubGlobal('document', { title: '' });
  vi.stubGlobal('window', {
    location: { hash: '#/settings', href: 'http://fixture.invalid/#/settings' },
    history: { state: null, replaceState() {}, pushState() {} },
    addEventListener: (name: string, listener: any) => h.listeners.set(name, listener), removeEventListener() {},
    nowadays: {
      onQuitCheck: (callback: any) => { h.listener = callback; return () => {}; },
      ackQuit: async () => true, keepQuitAlive: async () => true, onQuitState: (callback: any) => { h.stateListener = callback; return () => {}; }, respondQuit: async () => { if (h.response instanceof Error) throw h.response; return h.response; }
    }
  });
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
it.each([false, new Error('fixture IPC failure')])('unlocks when main rejects or cannot receive the final decision (%s)', async response => {
  setup(false); h.response = response; render();
  h.listener({ requestId: 'rejected' }); await settle();
  const tree = render();
  expect(find(tree, n => n.props?.className === 'studio-shell').props.inert).toBeUndefined();
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(false);
  expect(find(tree, n => n.type === 'SettingsDialog').props.locked).toBe(false);
});
it('keeps the settings portal locked and uses a non-dismissible top modal during slow shutdown', async () => {
  setup(true); render(); h.listener({ requestId: 'approved' }); await settle();
  const tree = render();
  expect(find(tree, n => n.props?.className === 'studio-shell').props.inert).toBe(true);
  expect(find(tree, n => n.type === 'SettingsDialog').props.locked).toBe(true);
  expect(find(tree, n => n.type === 'Modal').props).toMatchObject({ open: true, closeDisabled: true });
});
it('still guards reload during checking and cancels a stale request without an approved lock', async () => {
  setup(true); h.decision = new Promise(() => {}); render();
  h.listener({ requestId: 'pending' }); await settle(); render();
  const event = { preventDefault: vi.fn(), returnValue: undefined };
  h.listeners.get('beforeunload')(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  h.stateListener({ requestId: 'pending', state: 'cancelled' });
  const tree = render();
  expect(find(tree, n => n.type === 'SettingsDialog').props.locked).toBe(false);
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(false);
});
it('trusts the main shutdown notification even if its IPC response is lost', async () => {
  setup(true); h.decision = new Promise(() => {}); render();
  h.listener({ requestId: 'pending' }); await settle();
  h.stateListener({ requestId: 'pending', state: 'cancelled' });
  h.stateListener({ requestId: 'pending', state: 'shuttingDown' });
  const tree = render();
  expect(find(tree, n => n.type === 'Modal').props.open).toBe(true);
});
it('locks the resource import page during quit checking and unlocks it on cancellation', async () => {
  setup(true);
  window.location.hash = '#/artifacts'; window.location.href = 'http://fixture.invalid/#/artifacts';
  h.decision = new Promise(() => {});
  expect(find(render(), n => n.type === 'ArtifactsPage').props.locked).toBe(false);
  h.listener({ requestId: 'resource-preview' }); await settle();
  expect(find(render(), n => n.type === 'ArtifactsPage').props.locked).toBe(true);
  h.stateListener({ requestId: 'resource-preview', state: 'cancelled' });
  expect(find(render(), n => n.type === 'ArtifactsPage').props.locked).toBe(false);
  h.stateListener({ requestId: 'resource-preview', state: 'shuttingDown' });
  expect(find(render(), n => n.type === 'ArtifactsPage').props.locked).toBe(true);
});
it('aborts a stale confirmation, resolves its promise and preserves the next queued confirmation', async () => {
  h.cells = [];
  const renderConfirm = () => {
    h.index = 0; h.effects = [];
    const tree = ConfirmProvider({ children: null });
    for (const effect of h.effects) effect();
    return tree;
  };
  const provider = renderConfirm();
  const confirm = provider.props.value;
  const first = new AbortController(); const second = new AbortController();
  const p1 = confirm({ title: 'first', description: 'fixture', signal: first.signal });
  const p2 = confirm({ title: 'second', description: 'fixture', signal: second.signal });
  first.abort(); await expect(p1).resolves.toBe(false);
  expect(find(renderConfirm(), n => n.type?.name === 'Modal').props).toMatchObject({ open: true, title: 'second' });
  second.abort(); await expect(p2).resolves.toBe(false);
  expect(find(renderConfirm(), n => n.type?.name === 'Modal').props.open).toBe(false);
});
