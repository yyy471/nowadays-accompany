import type { ThemePreset } from './presets';
import { featherThemeTransition } from './theme-feather';

export interface ThemeTransitionInvocation {
  readonly startedAt: number;
  readonly from: ThemePreset;
  readonly to: ThemePreset;
  readonly commit: (preset: ThemePreset) => void;
  readonly finish: () => void;
  readonly isCurrent: () => boolean;
}

export type ThemeTransitionStrategy = ((invocation: ThemeTransitionInvocation) => (() => void) | undefined) & {
  queueChanges?: boolean;
  onSettled?: (preset: ThemePreset) => void;
};

/** 每个主题宿主持有自己的过渡；快照只负责绘制，真实编辑器保持挂载。 */
export function createThemeTransition(initial: ThemePreset, commit: (preset: ThemePreset) => void, initialStrategy?: ThemeTransitionStrategy) {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const colors = window.matchMedia('(forced-colors: active)');
  let desired = initial;
  let selectedAt = 0;
  let current = initial;
  let generation = 0;
  let activeStrategyCleanup: (() => void) | undefined;
  let strategy = initialStrategy ?? featherThemeTransition;
  let disposed = false;
  const reduced = () => root.dataset.motion === 'reduced'
    || (root.dataset.motion !== 'full' && media.matches) || colors.matches;
  const stop = () => {
    activeStrategyCleanup?.();
    activeStrategyCleanup = undefined;
  };
  const commitPreset = (preset: ThemePreset) => {
    current = preset;
    commit(preset);
  };
  const settle = () => {
    ++generation;
    stop();
    if (!disposed) {
      commitPreset(desired);
      strategy?.onSettled?.(desired);
    }
  };
  const hasActiveTransition = () => !!activeStrategyCleanup;
  const preferenceChanged = () => { if (hasActiveTransition() && reduced()) settle(); };
  const visibilityChanged = () => { if (document.hidden && hasActiveTransition()) settle(); };
  const observer = new MutationObserver(preferenceChanged);
  observer.observe(root, { attributes: true, attributeFilter: ['data-motion'] });
  media.addEventListener('change', preferenceChanged);
  colors.addEventListener('change', preferenceChanged);
  document.addEventListener('visibilitychange', visibilityChanged);

  const start = (next: ThemePreset) => {
    const id = ++generation;
    stop();
    if (reduced() || document.hidden || root.hasAttribute('data-feed-transition')) {
      commitPreset(next);
      strategy?.onSettled?.(next);
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
      stop();
      if (strategy?.queueChanges) {
        strategy.onSettled?.(current);
        if (desired !== current) start(desired);
      } else commitPreset(desired);
    };
    try {
      const cleanup = strategy({
        startedAt: selectedAt, from: current, to: next,
        commit: preset => { if (!disposed && id === generation) commitPreset(preset); },
        finish,
        isCurrent: () => !disposed && id === generation
      });
      if (!cleanup) { settle(); return; }
      if (id === generation) activeStrategyCleanup = cleanup;
      else cleanup();
    } catch {
      settle();
    }
  };

  return {
    setStrategy(next: ThemeTransitionStrategy | undefined) {
      const resolved = next ?? featherThemeTransition;
      if (strategy === resolved) return;
      strategy = resolved;
      // 页面切换收束旧快照，避免两套过渡并行。
      if (hasActiveTransition()) {
        ++generation;
        stop();
        const id = generation;
        queueMicrotask(() => { if (!disposed && id === generation) commitPreset(desired); });
      }
    },
    select(next: ThemePreset) {
      if (disposed || next === desired) return;
      selectedAt = performance.now();
      desired = next;
      try { window.localStorage.setItem('nowadays.theme-preset.v1', next); } catch { /* 当次切换仍生效。 */ }
      if (strategy?.queueChanges && hasActiveTransition()) return;
      start(next);
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
