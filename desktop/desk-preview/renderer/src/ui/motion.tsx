import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useUiAppearance } from './appearance';

export type MotionPreference = 'system' | 'reduced' | 'full';

export type MotionPolicy = {
  /** 本机保存的偏好；system 跟随系统。 */
  preference: MotionPreference;
  /** 有效结论：reduced 直接终态，full 覆盖系统减少动效。 */
  reduced: boolean;
  /** 强制颜色下装饰材质关闭，但不改写选中、焦点与文字。 */
  forcedColors: boolean;
};

export type MotionPreferenceController = MotionPolicy & {
  select: (preference: MotionPreference) => void;
};

export type MotionScope = ReturnType<typeof createMotionScope>;
export type MotionRunOptions = {
  duration: number;
  easing?: string;
  delay?: number;
  fill?: FillMode;
  /** 同一元素同一用途只保留一个活动动画；新动画取消旧动画。 */
  slot?: string;
};

const STORAGE_KEY = 'nowadays.motion-preference.v1';
const LEGACY_STORAGE_KEY = 'accompany.motion-preference.v1';
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
const FORCED_COLORS_QUERY = '(forced-colors: active)';

export function readMotionPreference(): MotionPreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    return value === 'reduced' || value === 'full' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** 偏好只作用于本机外观；同时写回根节点以让CSS与JS读取同一结论。 */
export function applyMotionPreference(preference: MotionPreference): void {
  if (preference === 'system') document.documentElement.removeAttribute('data-motion');
  else document.documentElement.setAttribute('data-motion', preference);
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 系统偏好仍然生效。
  }
}

export function resolveMotionPolicy(
  preference: MotionPreference,
  systemReduced: boolean,
  forcedColors = false
): MotionPolicy {
  return {
    preference,
    reduced: preference === 'reduced' || (preference === 'system' && systemReduced),
    forcedColors
  };
}

/**
 * 局部 reduced 是不可解除的下限；局部 full 不能覆盖用户/系统已有的 reduced。
 * 仅全局 full 可以覆盖系统 reduce，避免页面局部声明绕过关效偏好。
 */
export function applyScopedMotionPolicy<T extends MotionPolicy>(base: T, local?: 'reduced' | 'full'): T {
  if (local !== 'reduced' || base.reduced) return base;
  return { ...base, reduced: true } as T;
}

/** 读取CSS时间值；生产压缩后可能写作 .4s，WAAPI统一使用毫秒。 */
export function readCssTime(value: string | null | undefined, fallback = 0): number {
  if (!value) return fallback;
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)$/.exec(value.trim());
  if (!match) return fallback;
  const amount = Number.parseFloat(match[1] as string);
  return match[2] === 'ms' ? amount : amount * 1000;
}

export function readMotionValue(element: Element | null | undefined, variable: string, fallback: string): string {
  if (!element || typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(element).getPropertyValue(variable).trim();
  return value || fallback;
}

export function readMotionTime(element: Element | null | undefined, variable: string, fallback: number): number {
  return readCssTime(readMotionValue(element, variable, ''), fallback);
}

export function readMotionPx(element: Element | null | undefined, variable: string, fallback: number): number {
  const value = readMotionValue(element, variable, '');
  const amount = Number.parseFloat(value);
  return Number.isFinite(amount) ? amount : fallback;
}

/**
 * 组件实例持有的动画集合：完成、取消或卸载时统一收束。
 * 不保存到模块顶层；调用方负责把返回值限制在自己的生命周期内。
 */
export function createMotionScope() {
  const running = new Set<Animation>();
  const slots = new Map<Element, Map<string, Animation>>();
  return {
    run(element: Element, frames: Keyframe[] | PropertyIndexedKeyframes, options: MotionRunOptions): Animation {
      const { slot, duration, delay = 0, easing, fill } = options;
      if (slot) {
        const owned = slots.get(element);
        const previous = owned?.get(slot);
        if (previous) {
          previous.cancel();
          running.delete(previous);
          owned?.delete(slot);
        }
      }
      const animation = element.animate(frames, { duration, delay, easing, fill });
      running.add(animation);
      if (slot) {
        let owned = slots.get(element);
        if (!owned) { owned = new Map(); slots.set(element, owned); }
        owned.set(slot, animation);
      }
      void animation.finished.catch(() => undefined).finally(() => {
        running.delete(animation);
        if (slot && slots.get(element)?.get(slot) === animation) slots.get(element)?.delete(slot);
      });
      return animation;
    },
    cancelAll(): void {
      for (const animation of running) animation.cancel();
      running.clear();
      slots.clear();
    },
    get size(): number { return running.size; }
  };
}

const defaultPolicy: MotionPreferenceController = {
  ...resolveMotionPolicy('system', false),
  select() {}
};

const MotionPolicyContext = createContext<MotionPreferenceController>(defaultPolicy);

function readEnvironment(override?: MotionPreference): MotionPolicy {
  if (typeof window === 'undefined' || typeof document === 'undefined') return resolveMotionPolicy(override ?? 'system', false);
  const attribute = document.documentElement.dataset.motion;
  const stored: MotionPreference = attribute === 'reduced' || attribute === 'full' ? attribute : readMotionPreference();
  return resolveMotionPolicy(
    override ?? stored,
    window.matchMedia(REDUCED_QUERY).matches,
    window.matchMedia(FORCED_COLORS_QUERY).matches
  );
}

/**
 * 全局动效策略独立于页面主题作用域；Portal与排队确认继承同一结论。
 * 作用域可追加 reduced（下限），但不能用 full 解除全局/系统 reduce。
 * preference 仅供独立样板显式演示，不写回本机偏好。
 */
export function MotionPolicyProvider({ preference, children }: { preference?: MotionPreference; children: ReactNode }) {
  const [policy, setPolicy] = useState(() => readEnvironment(preference));
  const update = useCallback(() => setPolicy(readEnvironment(preference)), [preference]);
  useEffect(() => {
    const reduced = window.matchMedia(REDUCED_QUERY);
    const forced = window.matchMedia(FORCED_COLORS_QUERY);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    reduced.addEventListener('change', update);
    forced.addEventListener('change', update);
    update();
    return () => {
      observer.disconnect();
      reduced.removeEventListener('change', update);
      forced.removeEventListener('change', update);
    };
  }, [update]);
  const select = useCallback((next: MotionPreference) => {
    applyMotionPreference(next);
    setPolicy(readEnvironment(next));
  }, []);
  const value = useMemo(() => ({ ...policy, select }), [policy, select]);
  return <MotionPolicyContext.Provider value={value}>{children}</MotionPolicyContext.Provider>;
}

export function useMotionPolicy(): MotionPreferenceController {
  const base = useContext(MotionPolicyContext);
  const { motion } = useUiAppearance();
  return useMemo(() => applyScopedMotionPolicy(base, motion), [base, motion]);
}
