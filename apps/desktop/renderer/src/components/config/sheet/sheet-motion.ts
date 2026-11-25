import { createMotionScope, readMotionTime, readMotionValue } from '../../../ui/motion';

export function sheetKeyframe(): Keyframe {
  const transform = window.matchMedia('(max-width: 900px)').matches
    ? 'translateY(100%)'
    : 'translate(calc(100% + 32px), 10px)';
  return { transform };
}

type SheetMotion = ReturnType<typeof createMotionScope>;

export function animateSheetExit(frame: HTMLElement, scope: SheetMotion): Animation | null {
  const duration = readMotionTime(frame, '--nd-semantic-motion-page-exit', 260);
  if (duration <= 0) return null;
  return scope.run(frame, [{ transform: getComputedStyle(frame).transform }, sheetKeyframe()], {
    duration, easing: readMotionValue(frame, '--nd-semantic-motion-ease-in', 'ease-in'), fill: 'forwards',
  });
}
