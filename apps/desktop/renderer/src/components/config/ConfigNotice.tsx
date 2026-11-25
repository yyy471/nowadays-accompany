import { useLayoutEffect, useRef } from 'react';
import { Icon, readMotionTime, readMotionValue, useMotionPolicy } from '../../ui';

export type ConfigNoticeTone = 'neutral' | 'success' | 'warning' | 'error';

/** 结果提示的可见层。调用方同步写入统一的读屏播报区。 */
export function ConfigNotice({ message, noticeKey, tone = 'neutral', onDismiss }: { message: string; noticeKey?: number; tone?: ConfigNoticeTone; onDismiss: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const { reduced } = useMotionPolicy();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const finishMotion = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !message) return;
    const duration = readMotionTime(element, '--nd-semantic-motion-component', 220);
    const outside = { opacity: 0, transform: 'translateY(6px)' };
    const inside = { opacity: 1, transform: 'none' };
    const enter = !reducedRef.current && duration > 0 ? element.animate([outside, inside], {
      duration, easing: readMotionValue(element, '--nd-semantic-motion-ease-out', 'ease-out'),
    }) : null;
    let exit: Animation | undefined;
    let timer: number | null = null;
    let remaining = 2600;
    let started = Date.now();
    const schedule = () => {
      started = Date.now();
      timer = window.setTimeout(() => {
        timer = null;
        const exitDuration = readMotionTime(element, '--nd-semantic-motion-component-exit', 160);
        if (reducedRef.current || exitDuration <= 0) { dismiss.current(); return; }
        exit = element.animate([inside, outside], {
          duration: exitDuration, easing: readMotionValue(element, '--nd-semantic-motion-ease-in', 'ease-in'), fill: 'forwards',
        });
        void exit.finished.then(() => dismiss.current(), () => {});
      }, remaining);
    };
    const stopTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const pause = () => {
      if (timer !== null) remaining = Math.max(0, remaining - (Date.now() - started));
      stopTimer();
      exit?.pause();
    };
    const resume = () => { if (exit) exit.play(); else schedule(); };
    const close = () => { stopTimer(); exit?.cancel(); dismiss.current(); };
    finishMotion.current = () => {
      enter?.cancel();
      if (exit) close();
    };
    element.addEventListener('mouseenter', pause); element.addEventListener('mouseleave', resume); element.addEventListener('click', close);
    if (!element.matches(':hover')) schedule();
    return () => { finishMotion.current = null; stopTimer(); enter?.cancel(); exit?.cancel(); element.removeEventListener('mouseenter', pause); element.removeEventListener('mouseleave', resume); element.removeEventListener('click', close); };
  }, [message, noticeKey]);
  useLayoutEffect(() => { if (reduced) finishMotion.current?.(); }, [reduced]);

  return message ? <aside className="config-result-notice" data-tone={tone} ref={ref} aria-hidden="true">
    {tone === 'success' && <span className="config-result-seal" key={noticeKey ?? message}><Icon name="check" size={12}/></span>}{message}
  </aside> : null;
}
