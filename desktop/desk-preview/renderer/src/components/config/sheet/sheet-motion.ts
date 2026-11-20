import { createMotionScope, readMotionTime, readMotionValue } from '../../../ui/motion';

export function sheetKeyframe(frame: HTMLElement): Keyframe {
  const transform = window.matchMedia('(max-width: 900px)').matches
    ? 'translateY(100%)'
    : 'translate(calc(100% + 32px), 10px)';
  return { transform, boxShadow: readMotionValue(frame, '--nd-semantic-shadow-rest', 'none') };
}

type SheetMotion = ReturnType<typeof createMotionScope>;

export function animateSheetExit(frame: HTMLElement, scope: SheetMotion): Animation | null {
  const duration = readMotionTime(frame, '--nd-semantic-motion-page-exit', 260);
  if (duration <= 0) return null;
  const drawn = getComputedStyle(frame);
  return scope.run(frame, [{ transform: drawn.transform, boxShadow: drawn.boxShadow }, sheetKeyframe(frame)], {
    duration, easing: readMotionValue(frame, '--nd-semantic-motion-ease-in', 'ease-in'), fill: 'forwards',
  });
}
