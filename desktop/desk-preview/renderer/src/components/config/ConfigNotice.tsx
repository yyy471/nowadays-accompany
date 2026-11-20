import { useEffect, useRef } from 'react';
import { readMotionTime, readMotionValue, useMotionPolicy } from '../../ui';

/** 结果提示的可见层。调用方同步写入统一的读屏播报区。 */
export function ConfigNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const { reduced } = useMotionPolicy();
  useEffect(() => {
    const element = ref.current;
    if (!element || !message) return;
    const duration = readMotionTime(element, '--nd-semantic-motion-component', 220);
    const exitDuration = readMotionTime(element, '--nd-semantic-motion-component-exit', 160);
    const outside = { opacity: 0, transform: 'translateY(6px)' };
    const inside = { opacity: 1, transform: 'none' };
    const enter = !reduced && duration > 0 ? element.animate([outside, inside], {
      duration, easing: readMotionValue(element, '--nd-semantic-motion-ease-out', 'ease-out'),
    }) : null;
    let exit: Animation | undefined;
    const timer = window.setTimeout(() => {
      if (reduced || exitDuration <= 0) { dismiss.current(); return; }
      exit = element.animate([inside, outside], {
        duration: exitDuration, easing: readMotionValue(element, '--nd-semantic-motion-ease-in', 'ease-in'), fill: 'forwards',
      });
      void exit.finished.then(() => dismiss.current(), () => {});
    }, 2600);
    return () => { window.clearTimeout(timer); enter?.cancel(); exit?.cancel(); };
  }, [message, reduced]);

  return message ? <aside className="config-result-notice" ref={ref} aria-hidden="true">{message}</aside> : null;
}
