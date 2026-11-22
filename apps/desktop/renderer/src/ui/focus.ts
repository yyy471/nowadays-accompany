const FOCUSABLE = 'button,a[href],input,select,textarea,[tabindex]';

/** Shared eligibility for initial focus and Tab trapping, including hidden settings sections. */
export function canReceiveFocus(element: HTMLElement): boolean {
  return !element.closest('[hidden],[inert],[aria-hidden="true"]') && !element.matches(':disabled')
    && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}

export function focusableControls(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter(element => element.tabIndex >= 0 && canReceiveFocus(element))
    .sort((left, right) => (left.tabIndex > 0 ? left.tabIndex : Infinity) - (right.tabIndex > 0 ? right.tabIndex : Infinity));
}
