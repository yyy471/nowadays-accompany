import { afterEach, expect, it, vi } from 'vitest';
import { canReceiveFocus, focusableControls } from '../desktop/renderer/src/ui/focus.js';

afterEach(() => vi.unstubAllGlobals());
function control(options: { tabIndex?: number; ancestorHidden?: boolean; disabled?: boolean; visible?: boolean; visibility?: string } = {}) {
  const element = { tabIndex: options.tabIndex ?? 0, closest: () => options.ancestorHidden ? {} : null,
    matches: () => Boolean(options.disabled), getClientRects: () => options.visible === false ? [] : [{}] } as unknown as HTMLElement;
  return { element, visibility: options.visibility ?? 'visible' };
}
it('excludes hidden sections, disabled controls, inert ancestors and negative tab stops', () => {
  const controls = [control(), control({ ancestorHidden: true }), control({ disabled: true }), control({ visible: false }), control({ visibility: 'hidden' }), control({ tabIndex: -1 })];
  vi.stubGlobal('getComputedStyle', (element: HTMLElement) => ({ visibility: controls.find(item => item.element === element)!.visibility }));
  const panel = { querySelectorAll: () => controls.map(item => item.element) } as unknown as HTMLElement;
  expect(focusableControls(panel)).toEqual([controls[0]!.element]);
  expect(canReceiveFocus(controls[1]!.element)).toBe(false);
});
it('keeps native positive tabindex order before document-order zero controls', () => {
  const controls = [control(), control({ tabIndex: 2 }), control({ tabIndex: 1 }), control()];
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
  expect(focusableControls({ querySelectorAll: () => controls.map(item => item.element) } as unknown as HTMLElement))
    .toEqual([controls[2]!.element, controls[1]!.element, controls[0]!.element, controls[3]!.element]);
});
