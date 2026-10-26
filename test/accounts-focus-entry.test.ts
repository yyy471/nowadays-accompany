import { expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], index: 0, effects: [] as Array<() => unknown> }));

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const index = hooks.index++;
    const previous = hooks.cells[index] as unknown[] | undefined;
    if (!previous || deps.some((dependency, i) => !Object.is(dependency, previous[i]))) hooks.effects.push(effect);
    hooks.cells[index] = deps;
  }
}));

import { useAccountEntryFocus } from '../desktop/renderer/src/lib/use-account-entry-focus.js';

interface Harness {
  render: (anchorReady?: boolean) => void;
  request: (accountId: string) => void;
  selected: () => string;
  warning: () => string | undefined;
  scroll: ReturnType<typeof vi.fn>;
  handled: ReturnType<typeof vi.fn>;
}

function createHarness(accountIds: string[], initial: { focus?: string; selected?: string } = {}): Harness {
  hooks.cells = [];
  hooks.index = 0;
  let selected = initial.selected ?? '';
  let warning: string | undefined;
  let focus = initial.focus;
  const scroll = vi.fn();
  const handled = vi.fn(() => { focus = undefined; });
  const anchor: { current: { scrollIntoView: (options: ScrollIntoViewOptions) => void } | null } = { current: null };
  return {
    render: (anchorReady = true) => {
      hooks.index = 0;
      hooks.effects = [];
      useAccountEntryFocus({
        accountIds,
        selectedAccount: selected,
        focusAccountId: focus,
        entryWarning: warning,
        displayRef: anchor,
        selectAccount: (accountId) => { selected = accountId; },
        setEntryWarning: (next) => { warning = next; },
        onHandled: handled
      });
      anchor.current = anchorReady ? { scrollIntoView: scroll } : null;
      for (const effect of hooks.effects) effect();
    },
    request: (accountId: string) => { focus = accountId; },
    selected: () => selected,
    warning: () => warning,
    scroll,
    handled
  };
}

it('selects the entry account before the anchor is ready and consumes only after scrolling', () => {
  const harness = createHarness(['10001', '10002'], { focus: '10002' });

  harness.render(false);
  expect(harness.selected()).toBe('10002');
  expect(harness.scroll).not.toHaveBeenCalled();
  expect(harness.handled).not.toHaveBeenCalled();

  harness.render(true);
  expect(harness.scroll).toHaveBeenCalledOnce();
  expect(harness.scroll).toHaveBeenCalledWith({ block: 'start' });
  expect(harness.handled).toHaveBeenCalledOnce();

  harness.render(true);
  expect(harness.scroll).toHaveBeenCalledOnce();
  expect(harness.handled).toHaveBeenCalledOnce();
});

it('scrolls for repeated B to A to B entries', () => {
  const harness = createHarness(['10001', '10002'], { focus: '10002' });
  harness.render();
  harness.render();

  harness.request('10001');
  harness.render();
  expect(harness.selected()).toBe('10001');
  expect(harness.scroll).toHaveBeenCalledOnce();
  harness.render();
  expect(harness.scroll).toHaveBeenCalledTimes(2);

  harness.request('10002');
  harness.render();
  expect(harness.selected()).toBe('10002');
  expect(harness.scroll).toHaveBeenCalledTimes(2);
  harness.render();
  expect(harness.scroll).toHaveBeenCalledTimes(3);
  expect(harness.handled).toHaveBeenCalledTimes(3);
});

it('warns and consumes a missing entry target without scrolling', () => {
  const harness = createHarness(['10001'], { focus: '10002' });

  harness.render();
  expect(harness.warning()).toBe('请求编辑的账号 10002 不在当前账号列表中，请重新选择账号。');
  expect(harness.selected()).toBe('');
  expect(harness.scroll).not.toHaveBeenCalled();
  expect(harness.handled).toHaveBeenCalledOnce();

  harness.render();
  expect(harness.scroll).not.toHaveBeenCalled();
  expect(harness.handled).toHaveBeenCalledOnce();
});

it('clears a selected target that disappears and does not scroll to its old anchor', () => {
  const harness = createHarness(['10001'], { focus: '10002', selected: '10002' });

  harness.render();
  expect(harness.warning()).toBe('请求编辑的账号 10002 不在当前账号列表中，请重新选择账号。');
  expect(harness.selected()).toBe('');
  expect(harness.scroll).not.toHaveBeenCalled();
  expect(harness.handled).toHaveBeenCalledOnce();
});
