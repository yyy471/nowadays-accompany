import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());
const h = vi.hoisted(() => ({ cells: [] as any[], index: 0, effects: [] as Array<() => any> }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => { const index = h.index++; const cells = h.cells; if (!(index in cells)) cells[index] = initial;
    return [cells[index], (next: any) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }]; },
  useRef: (initial: any) => { const index = h.index++; return h.cells[index] ??= { current: initial }; },
  useEffect: (effect: () => any) => { h.index++; h.effects.push(effect); }
}));
vi.mock('../desktop/renderer/src/ui', () => ({ AsyncBoundary: 'AsyncBoundary', Button: 'Button', Card: 'Card', ControlButton: 'ControlButton', ErrorNote: 'ErrorNote', Icon: 'Icon' }));
vi.mock('../desktop/renderer/src/components/AccountAvatar', () => ({ AccountAvatar: 'AccountAvatar' }));
import { HomePage } from '../desktop/renderer/src/pages/Home';
const ids = ['10001', '10002', '10003'];
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, predicate); if (found) return found; }
}
function render(accountIds = ids) {
  h.index = 0; h.effects = [];
  const tree = HomePage({ accounts: { accounts: accountIds.map(accountId => ({ accountId, nickname: `昵称${accountId}` })) } as any,
    loading: false, onRetry: async () => {}, onGoConnections() {}, onEditProfile() {} });
  h.effects.forEach(effect => effect());
  const dock = find(tree, node => node.props?.role === 'toolbar');
  return dock.props.children as React.ReactElement<any>[];
}
function key(button: React.ReactElement<any>, value: string, extra = {}) {
  const event = { key: value, preventDefault: vi.fn(), ...extra }; button.props.onKeyDown(event); return event;
}
beforeEach(() => { h.cells = []; });
it('has one tab stop and switches selection with arrow wrap and Home/End', () => {
  render(); let buttons = render();
  const focus = vi.fn(), scrollIntoView = vi.fn();
  buttons.forEach(button => button.props.ref({ focus, scrollIntoView }));
  expect(buttons.map(button => button.props.tabIndex)).toEqual([0, -1, -1]);
  expect(key(buttons[0]!, 'ArrowLeft').preventDefault).toHaveBeenCalledOnce();
  buttons = render(); expect(buttons[2]!.props['aria-pressed']).toBe(true);
  key(buttons[2]!, 'Home'); buttons = render(); expect(buttons[0]!.props.tabIndex).toBe(0);
  key(buttons[0]!, 'End'); buttons = render(); expect(buttons[2]!.props.tabIndex).toBe(0);
  key(buttons[2]!, 'ArrowRight'); buttons = render(); expect(buttons[0]!.props['aria-pressed']).toBe(true);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
});
it('leaves activation and system shortcuts native, and recovers when the selected account disappears', () => {
  render(); let buttons = render();
  expect(key(buttons[0]!, 'Enter').preventDefault).not.toHaveBeenCalled();
  expect(key(buttons[0]!, 'ArrowRight', { ctrlKey: true }).preventDefault).not.toHaveBeenCalled();
  buttons[2]!.props.onClick(); render(['10001']); buttons = render(['10001']);
  expect(buttons[0]!.props.tabIndex).toBe(0);
  expect(buttons[0]!.props.title).toContain('QQ 10001');
});
