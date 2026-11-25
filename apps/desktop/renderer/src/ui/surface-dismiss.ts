import { useLayoutEffect, useRef, useState } from 'react';
import './floating-surface.css';

/** 等实际退场过渡结束再卸载。减少动效、窗口隐藏或 CSS 过渡被取消时立即收尾。 */
export function useSurfaceDismiss<T extends HTMLElement>(onDismiss: () => void) {
  const surface = useRef<T>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const [closing, setClosing] = useState(false);
  useLayoutEffect(() => {
    if (!closing) return;
    const element = surface.current;
    if (element) void getComputedStyle(element).opacity;
    const fade = element?.getAnimations().find(animation =>
      animation instanceof CSSTransition && animation.transitionProperty === 'opacity');
    if (!fade || document.hidden) { dismiss.current(); return; }
    let active = true;
    const finish = () => {
      if (!active) return;
      active = false;
      dismiss.current();
    };
    void fade.finished.then(finish, finish);
    const onVisibility = () => { if (document.hidden) finish(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; document.removeEventListener('visibilitychange', onVisibility); };
  }, [closing]);
  return { surface, closing, close: () => setClosing(true) };
}
