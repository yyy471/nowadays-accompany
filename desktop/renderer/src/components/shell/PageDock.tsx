import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ControlButton, Icon, createMotionScope, readMotionPx, readMotionTime, readMotionValue, useMotionPolicy, type IconName } from '../../ui';
import { MoreMenu } from './MoreMenu';
import { PAGES } from '../../lib/navigation';

/** 正式Dock的直达目标；开发样板据此显示同一组标签，不另维护一份导航。 */
export const dockDestinations: Array<{ id: string; label: string; icon: IconName }> = [
  { id: 'home', label: '桌面', icon: 'user' },
  { id: 'roles', label: '关系', icon: 'accounts' },
  { id: 'model-config', label: '模型', icon: 'bolt' },
  { id: 'artifacts', label: '收藏', icon: 'artifacts' }
];

const ITEM_SELECTOR = '.ui-dock-item, .ui-menu-trigger';
const FOLLOW_VARIABLES = ['--dock-follow-x', '--dock-follow-y', '--dock-local-x', '--dock-local-y', '--dock-shadow-x'];

function clearItem(item: HTMLElement): void {
  item.removeAttribute('data-hover');
  for (const variable of FOLLOW_VARIABLES) item.style.removeProperty(variable);
}

function itemFrom(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(ITEM_SELECTOR) : null;
}

/**
 * 全局手账Dock：结构沿用真实导航，只增加共享选中签、项内跟随与按压层。
 * 选中始终跟随已提交路由；草稿准入取消时页面与选中都不移动。
 */
export function PageDock({ page, onNavigate }: { page: string; onNavigate: (page: string) => void }) {
  const policy = useMotionPolicy();
  const reduced = useRef(policy.reduced);
  reduced.current = policy.reduced;
  const navRef = useRef<HTMLElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const [scope] = useState(createMotionScope);
  const pointer = useRef<{ frame?: number; item?: HTMLElement; rect?: DOMRect; point?: { x: number; y: number } }>({});
  const previousKey = useRef<string | undefined>(undefined);
  const previousPage = useRef(page);
  const direct = dockDestinations.some(item => item.id === page);

  const markerTarget = useCallback((): HTMLElement | null => {
    const destination = dockDestinations.find(item => item.id === page);
    if (destination) return itemRefs.current.get(destination.id) ?? null;
    return moreRef.current;
  }, [page]);

  const align = useCallback((animate: boolean) => {
    const nav = navRef.current;
    const marker = markerRef.current;
    if (!nav || !marker) return;
    const target = markerTarget();
    if (!target || !target.isConnected) {
      marker.style.opacity = '0';
      marker.dataset.ready = 'false';
      return;
    }
    const navBox = nav.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    const border = Number.parseFloat(getComputedStyle(nav).borderLeftWidth) || 0;
    const drawnBox = marker.getBoundingClientRect();
    const nextX = targetBox.left - navBox.left - border;
    const nextWidth = targetBox.width;
    const drawnX = drawnBox.left - navBox.left - border;
    const drawnWidth = drawnBox.width;
    const ready = marker.dataset.ready === 'true';
    marker.style.opacity = '1';
    marker.style.width = `${nextWidth}px`;
    marker.dataset.ready = 'true';
    const settle = (): void => {
      scope.cancelAll();
      marker.style.transform = `translateX(${nextX}px)`;
    };
    if (!animate || !ready || reduced.current || drawnWidth <= 0) { settle(); return; }
    const distance = nextX - drawnX;
    if (Math.abs(distance) < 0.5 && Math.abs(drawnWidth - nextWidth) < 0.5) { settle(); return; }
    const overshootMax = readMotionPx(nav, '--nd-component-motion-bookmark-overshoot', 1.5);
    const overshoot = Math.sign(distance) * Math.min(overshootMax, Math.abs(distance) * 0.03);
    marker.style.transform = `translateX(${nextX}px)`;
    // 从当前绘制位置接续；旧动画在读取位置之后取消，旧回调不会清理新选中。
    scope.run(marker, [
      { transform: `translateX(${drawnX}px) scaleX(${drawnWidth / nextWidth})` },
      { transform: `translateX(${nextX + overshoot}px) scaleX(1)`, offset: 0.76 },
      { transform: `translateX(${nextX}px) scaleX(1)` }
    ], {
      duration: readMotionTime(nav, '--nd-component-motion-surface-enter', 220),
      easing: readMotionValue(nav, '--nd-component-motion-surface-ease', 'cubic-bezier(0.22, 0.61, 0.36, 1)'),
      slot: 'dock',
      fill: 'backwards'
    });
  }, [markerTarget, scope]);

  const alignRef = useRef(align);
  alignRef.current = align;

  const resetPointer = useCallback(() => {
    const state = pointer.current;
    if (state.frame !== undefined) cancelAnimationFrame(state.frame);
    if (state.item) clearItem(state.item);
    pointer.current = {};
  }, []);

  const releasePress = useCallback(() => {
    navRef.current?.querySelectorAll<HTMLElement>('[data-pressed]').forEach(item => item.removeAttribute('data-pressed'));
  }, []);

  const follow = (event: PointerEvent<HTMLElement>): void => {
    if (event.pointerType !== 'mouse' || reduced.current) { resetPointer(); return; }
    const item = itemFrom(event.target);
    const nav = navRef.current;
    if (!item || !nav?.contains(item)) { resetPointer(); return; }
    const state = pointer.current;
    if (state.item !== item) {
      releasePress();
      resetPointer();
      pointer.current = { item, rect: item.getBoundingClientRect(), point: { x: event.clientX, y: event.clientY } };
      item.dataset.hover = '';
    } else {
      state.point = { x: event.clientX, y: event.clientY };
    }
    if (pointer.current.frame !== undefined) return;
    pointer.current.frame = requestAnimationFrame(() => {
      const current = pointer.current;
      current.frame = undefined;
      if (!current.item || !current.rect || !current.point || reduced.current) return;
      const host = navRef.current;
      const range = readMotionPx(host, '--nd-component-dock-notebook-follow-range', 1);
      const centerX = Number.parseFloat(readMotionValue(host, '--nd-component-dock-notebook-pointer-center-x', '50%')) || 50;
      const centerY = Number.parseFloat(readMotionValue(host, '--nd-component-dock-notebook-pointer-center-y', '45%')) || 45;
      const rangeX = Number.parseFloat(readMotionValue(host, '--nd-component-dock-notebook-pointer-range-x', '35%')) || 35;
      const rangeY = Number.parseFloat(readMotionValue(host, '--nd-component-dock-notebook-pointer-range-y', '30%')) || 30;
      const x = Math.max(-1, Math.min(1, (current.point.x - current.rect.left) / current.rect.width * 2 - 1));
      const y = Math.max(-1, Math.min(1, (current.point.y - current.rect.top) / current.rect.height * 2 - 1));
      current.item.style.setProperty('--dock-follow-x', `${(x * range).toFixed(2)}px`);
      current.item.style.setProperty('--dock-follow-y', `${(y * range).toFixed(2)}px`);
      current.item.style.setProperty('--dock-local-x', `${(centerX + x * rangeX).toFixed(2)}%`);
      current.item.style.setProperty('--dock-local-y', `${(centerY + y * rangeY).toFixed(2)}%`);
      current.item.style.setProperty('--dock-shadow-x', `${x.toFixed(2)}px`);
    });
  };

  const press = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    const item = itemFrom(event.target);
    if (!item) return;
    releasePress();
    item.dataset.pressed = '';
  };

  const pressKey = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.repeat) { event.preventDefault(); return; }
    const item = itemFrom(event.target);
    if (!item) return;
    releasePress();
    item.dataset.pressed = '';
  };

  useEffect(() => {
    const key = direct ? page : 'more';
    const changed = previousKey.current !== undefined && previousKey.current !== key && previousPage.current !== page;
    previousKey.current = key;
    previousPage.current = page;
    align(changed);
  }, [page, direct, align]);

  // 只在挂载时订阅尺寸与字体；切页不重新订阅，避免首次回调取消刚启动的选中移动。
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const onResize = (): void => { resetPointer(); alignRef.current(false); };
    const observer = new ResizeObserver(onResize);
    observer.observe(nav);
    window.addEventListener('resize', onResize);
    void document.fonts?.ready.then(() => alignRef.current(false)).catch(() => undefined);
    return () => { observer.disconnect(); window.removeEventListener('resize', onResize); };
  }, [resetPointer]);

  useEffect(() => {
    const observer = new MutationObserver(() => { resetPointer(); releasePress(); alignRef.current(false); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-preset'] });
    return () => observer.disconnect();
  }, [releasePress, resetPointer]);

  useEffect(() => {
    const up = (): void => releasePress();
    const keyup = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Enter' || event.key === ' ') releasePress(); };
    const cancel = (): void => { releasePress(); resetPointer(); };
    const blur = (): void => { releasePress(); resetPointer(); };
    const visibility = (): void => { if (document.hidden) { releasePress(); resetPointer(); } };
    const resize = (): void => { releasePress(); resetPointer(); };
    window.addEventListener('pointerup', up);
    window.addEventListener('keyup', keyup);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibility);
      resetPointer();
      releasePress();
    };
  }, [releasePress, resetPointer]);

  useEffect(() => {
    if (!policy.reduced) return;
    resetPointer();
    releasePress();
    alignRef.current(false);
  }, [policy.reduced, releasePress, resetPointer]);

  useEffect(() => () => scope.cancelAll(), [scope]);

  return <nav className="ui-page-dock" aria-label="主导航" ref={navRef}
    onPointerEnter={follow} onPointerMove={follow} onPointerLeave={() => { releasePress(); resetPointer(); }}
    onPointerDown={press} onKeyDown={pressKey}
    onBlur={(event) => {
      const item = itemFrom(event.target);
      item?.removeAttribute('data-pressed');
    }}>
    <span className="ui-dock-marker" aria-hidden="true" ref={markerRef} />
    {dockDestinations.map(item => <ControlButton key={item.id}
      ref={(element) => { if (element) itemRefs.current.set(item.id, element); else itemRefs.current.delete(item.id); }}
      className="ui-dock-item" aria-current={page === item.id ? 'page' : undefined}
      onClick={() => onNavigate(item.id)}>
      <span className="ui-dock-icon" aria-hidden="true"><Icon name={item.icon} size={20} /></span>
      <span className="ui-dock-label">{item.label}</span>
      <span className="ui-dock-surface" aria-hidden="true" />
    </ControlButton>)}
    <MoreMenu label="更多" currentLabel={direct ? undefined : PAGES.find(item => item.id === page)?.title}
      onNavigate={onNavigate} triggerIcon="more" triggerLayout="stacked" triggerClassName="ui-dock-more"
      triggerRef={moreRef} triggerDecoration={<span className="ui-dock-surface" aria-hidden="true" />} />
  </nav>;
}
