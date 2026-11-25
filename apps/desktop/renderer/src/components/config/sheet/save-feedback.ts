import { readMotionPx, readMotionTime, readMotionValue } from '../../../ui/motion';

const SAVE_ANIMATION = 'config-saved-summary';

export function finishSavedFeedback(workspace?: HTMLElement | null) {
  if (!workspace) return;
  for (const animation of workspace.getAnimations({ subtree: true })) {
    if (animation.id === SAVE_ANIMATION) animation.cancel();
  }
  workspace.querySelectorAll('.config-save-sweep,.config-old-value').forEach(node => node.remove());
  workspace.querySelectorAll<HTMLElement>('[data-config-feedback-pending]').forEach(node => { delete node.dataset.configFeedbackPending; });
}

export function sweepSavedElement(element?: HTMLElement | null) {
  if (!element) return;
  const duration = readMotionTime(element, '--nd-semantic-motion-linger', 600);
  if (duration <= 0) return;
  const sweep = document.createElement('span');
  sweep.className = 'config-save-sweep';
  sweep.setAttribute('aria-hidden', 'true');
  element.appendChild(sweep);
  const animation = sweep.animate([
    { transform: 'translateX(-100%)', opacity: 0 },
    { opacity: 1, offset: .2 },
    { opacity: 1, offset: .75 },
    { transform: 'translateX(260%)', opacity: 0 },
  ], { duration, easing: readMotionValue(element, '--nd-semantic-motion-ease-standard', 'ease'), fill: 'both' });
  animation.id = SAVE_ANIMATION;
  void animation.finished.then(() => sweep.remove(), () => sweep.remove());
}

function rowStatus(row: HTMLElement) {
  const dot = row.querySelector<HTMLElement>(':scope > .config-sum-end .ui-dot');
  return `${dot?.dataset.s || ''}:${dot?.getAttribute('aria-label') || dot?.textContent || ''}`;
}

function attachOldValue(row: HTMLElement, previous: HTMLElement, next: HTMLElement) {
  const rowBox = row.getBoundingClientRect();
  const valueBox = next.getBoundingClientRect();
  previous.classList.add('config-old-value');
  previous.setAttribute('aria-hidden', 'true');
  previous.inert = true;
  Object.assign(previous.style, { left: `${valueBox.left - rowBox.left}px`, top: `${valueBox.top - rowBox.top}px`, width: `${valueBox.width}px` });
  if (!previous.isConnected) row.appendChild(previous);
}

function crossFade(row: HTMLElement, previous: HTMLElement, next: HTMLElement) {
  const duration = readMotionTime(row, '--nd-semantic-motion-page', 360);
  delete next.dataset.configFeedbackPending;
  if (duration <= 0) { previous.remove(); return; }
  attachOldValue(row, previous, next);
  const easing = readMotionValue(row, '--nd-semantic-motion-ease-out', 'ease-out');
  const offset = readMotionPx(row, '--nd-semantic-motion-detail-page-offset', 4);
  const leaving = previous.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing, fill: 'both' });
  const entering = next.animate([{ opacity: 0, transform: `translateY(${offset}px)` }, { opacity: 1, transform: 'none' }], { duration, delay: duration / 4, easing, fill: 'both' });
  leaving.id = entering.id = SAVE_ANIMATION;
  void leaving.finished.then(() => previous.remove(), () => previous.remove());
  void entering.finished.then(() => entering.cancel(), () => {});
}

/** 保存前取真实可见摘要，成功后只反馈值或状态实际改变的行。 */
export function captureSavedSummary() {
  const host = document.querySelector<HTMLElement>('.config-leaf-body');
  const summary = [...(host?.querySelectorAll<HTMLElement>('.config-sum') ?? [])].map(row => ({
    row, valueSelector: ':scope > .config-sum-val:not(.config-old-value)', status: () => rowStatus(row),
  }));
  const titles = [...document.querySelectorAll<HTMLElement>('.config-service-head, .config-index-item[aria-current]')].map(row => ({
    row, valueSelector: row.matches('.config-service-head') ? 'h2:not(.config-old-value)' : 'strong:not(.config-old-value)',
    status: () => '',
  }));
  const previous = [...summary, ...titles].flatMap(target => {
    const value = target.row.querySelector<HTMLElement>(target.valueSelector);
    return target.row.offsetParent && value ? [{ ...target, value: value.cloneNode(true) as HTMLElement, initialStatus: target.status() }] : [];
  });
  const apply = (operation: 'hold' | 'animate') => {
    for (const old of previous) {
      if (!old.row.isConnected || !old.row.offsetParent) continue;
      const current = old.row.querySelector<HTMLElement>(old.valueSelector);
      if (!current) continue;
      if (old.value.textContent === current.textContent && old.initialStatus === old.status()) {
        delete current.dataset.configFeedbackPending;
        old.value.remove();
        continue;
      }
      if (operation === 'hold') {
        if (!readMotionTime(old.row, '--nd-semantic-motion-page', 360)) continue;
        attachOldValue(old.row, old.value, current);
        current.dataset.configFeedbackPending = '';
      } else {
        crossFade(old.row, old.value, current);
        sweepSavedElement(old.row);
      }
    }
  };
  return Object.assign(() => requestAnimationFrame(() => apply('animate')), { hold: () => apply('hold') });
}
