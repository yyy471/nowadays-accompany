import type { ThemePreset } from './presets';

export interface ThemeTransitionInvocation {
  readonly from: ThemePreset;
  readonly to: ThemePreset;
  readonly commit: (preset: ThemePreset) => void;
  readonly startViewTransition?: (update: () => void) => ViewTransition;
  readonly finish: () => void;
  readonly isCurrent: () => boolean;
}

/** 页面可以临时接管主题过渡的表现；预置状态仍由 ThemePresetProvider 唯一持有。 */
export type ThemeTransitionStrategy = (invocation: ThemeTransitionInvocation) => (() => void) | undefined;

/** 每个主题宿主持有自己的过渡；快照只负责绘制，真实编辑器保持挂载。 */
export function createThemeTransition(
  initial: ThemePreset,
  commit: (preset: ThemePreset, weather?: ThemePreset) => void,
  initialStrategy?: ThemeTransitionStrategy
) {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const colors = window.matchMedia('(forced-colors: active)');
  let desired = initial;
  let current = initial;
  let generation = 0;
  let active: ViewTransition | undefined;
  let activeStrategyCleanup: (() => void) | undefined;
  let strategy = initialStrategy;
  let animations: Animation[] = [];
  let disposed = false;
  const reduced = () => root.dataset.motion === 'reduced'
    || (root.dataset.motion !== 'full' && media.matches) || colors.matches;
  const stop = (skipTransition = true) => {
    const transition = active;
    active = undefined;
    if (transition && skipTransition) transition.skipTransition();
    activeStrategyCleanup?.();
    activeStrategyCleanup = undefined;
    for (const animation of animations) animation.cancel();
    animations = [];
    delete root.dataset.themeTransition;
    delete root.dataset.themeTransitionLive;
  };
  const commitPreset = (preset: ThemePreset, weather?: ThemePreset) => {
    current = preset;
    commit(preset, weather);
  };
  const settle = () => {
    ++generation;
    stop();
    if (!disposed) commitPreset(desired);
  };
  const hasActiveTransition = () => !!active || !!activeStrategyCleanup;
  const preferenceChanged = () => { if (hasActiveTransition() && reduced()) settle(); };
  const visibilityChanged = () => { if (document.hidden && hasActiveTransition()) settle(); };
  const observer = new MutationObserver(preferenceChanged);
  observer.observe(root, { attributes: true, attributeFilter: ['data-motion'] });
  media.addEventListener('change', preferenceChanged);
  colors.addEventListener('change', preferenceChanged);
  document.addEventListener('visibilitychange', visibilityChanged);

  return {
    setStrategy(next: ThemeTransitionStrategy | undefined) {
      if (strategy === next) return;
      strategy = next;
      // 路由切换到/离开专属页面时收束旧快照，禁止两套表现并行。
      if (hasActiveTransition()) {
        ++generation;
        stop();
        const id = generation;
        // 策略卸载发生在 React layout 清理期间，延后提交以免在生命周期内 flushSync。
        queueMicrotask(() => { if (!disposed && id === generation) commitPreset(desired); });
      }
    },
    select(next: ThemePreset) {
      if (disposed || next === desired) return;
      desired = next;
      const id = ++generation;
      stop();
      try { window.localStorage.setItem('nowadays.theme-preset.v1', next); } catch { /* 当次切换仍生效。 */ }
      if (reduced() || document.hidden) {
        commitPreset(next);
        return;
      }
      // 快速反向选择回到当前已绘制预置时，只取消在途表现并保留当前 DOM。
      if (next === current) {
        commitPreset(next);
        return;
      }
      const finish = () => {
        if (disposed || id !== generation) return;
        ++generation;
        stop(false);
        commitPreset(desired);
      };
      if (strategy) {
        try {
          const cleanup = strategy({
            from: current,
            to: next,
            commit: (preset) => { if (!disposed && id === generation) commitPreset(preset); },
            startViewTransition: typeof document.startViewTransition === 'function' ? (update) => {
              const transition = document.startViewTransition(update);
              active = transition;
              return transition;
            } : undefined,
            finish,
            isCurrent: () => !disposed && id === generation
          });
          if (cleanup) {
            if (id === generation) activeStrategyCleanup = cleanup;
            else cleanup();
            return;
          }
          // 注册页面的策略不适用时直接切换，不能退回全局天气动画。
          if (active) { settle(); return; }
          commitPreset(next);
          return;
        } catch {
          if (hasActiveTransition()) settle();
          else commitPreset(next);
          return;
        }
      }
      if (typeof document.startViewTransition !== 'function') {
        commitPreset(next);
        return;
      }
      root.dataset.themeTransition = next;
      const update = () => {
        if (!disposed && id === generation) {
          // 只保留旧页快照；新页留在真实DOM，避免整页捕获屏蔽鼠标命中。
          root.dataset.themeTransitionLive = '';
          commitPreset(next, next);
        }
      };
      try {
        const transition = document.startViewTransition(update);
        active = transition;
        // 即使浏览器因窗口隐藏/快照冲突跳过动画，也完成最后一次外观选择。
        void transition.updateCallbackDone.catch(() => { if (!disposed && id === generation) settle(); });
        void transition.ready.then(() => {
          if (disposed || id !== generation) return;
          if (reduced()) { settle(); return; }
          const scope = document.querySelector<HTMLElement>('.ui-theme-weather');
          if (!scope) { settle(); return; }
          const tokens = getComputedStyle(scope);
          const duration = (name: string) => {
            // 生产CSS压缩会将400ms改写为.4s，WAAPI始终接收毫秒。
            const value = tokens.getPropertyValue(name).trim();
            return Number.parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
          };
          const reveal = duration('--nd-component-theme-transition-reveal');
          const total = duration('--nd-component-theme-transition-total');
          const ease = tokens.getPropertyValue('--nd-semantic-motion-ease').trim();
          const animate = (name: string, frames: Keyframe[], ms: number, easing = ease, side = 'new') => {
            const animation = root.animate(frames, { duration: ms, easing, fill: 'both', pseudoElement: `::view-transition-${side}(${name})` });
            animations.push(animation);
            return animation;
          };
          animate('root', [{ '--theme-weather-reveal': '0%' }, { '--theme-weather-reveal': '110%' }], reveal, ease, 'old');
          if (next === 'nightwave') {
            for (let index = 1; index <= 3; index++) {
              animate(`theme-leaf-${index}`, [
                { transform: `translate(8vw, -8vh) rotate(${-25 + index * 12}deg)`, opacity: 0, offset: 0 },
                { transform: `translate(-12vw, ${index * 3}vh) rotate(${index * 22}deg)`, opacity: .85, offset: .18 },
                { transform: `translate(-54vw, ${20 + index * 7}vh) rotate(${60 + index * 25}deg)`, opacity: .7, offset: .63 },
                { transform: `translate(-110vw, ${65 + index * 8}vh) rotate(${125 + index * 35}deg)`, opacity: 0, offset: 1 }
              ], total, 'linear');
            }
          } else {
            animate('theme-dawn', [
              { opacity: 0, transform: 'scale(.8)', offset: 0 },
              { opacity: .55, transform: 'scale(1)', offset: .3 },
              { opacity: 0, transform: 'scale(1.25)', offset: 1 }
            ], total);
          }
          // finished也在skipTransition时结束，动画失败/取消不会留下装饰层。
        }).catch(() => { /* 不支持快照或被后续选择打断时，走finished收尾。 */ });
        void transition.finished.catch(() => {}).then(() => {
          if (!disposed && id === generation) {
            ++generation;
            stop(false);
            commitPreset(desired);
          }
        });
      } catch {
        settle();
      }
    },
    dispose() {
      disposed = true;
      ++generation;
      stop();
      observer.disconnect();
      media.removeEventListener('change', preferenceChanged);
      colors.removeEventListener('change', preferenceChanged);
      document.removeEventListener('visibilitychange', visibilityChanged);
    }
  };
}
