import { useEffect, useRef } from 'react';

/** 规范 §7.10 与验收 56 都用 `#live` 指这个区域，仓库沿用同一 id。 */
const LIVE_REGION_ID = 'live';

/** 读屏播报（v6 规范 §7.10）：清空后延迟置入，保证同一句在部分读屏上也会重读。 */
export function announceLive(text: string): void {
  const region = document.getElementById(LIVE_REGION_ID);
  if (!region) return;
  region.textContent = '';
  window.setTimeout(() => {
    region.textContent = text;
  }, 40);
}

/**
 * 隐藏的 aria-live 区域，挂在配置工作区内（工作区常驻挂载，跨两页存活）。
 * 只渲染空区域本体；内容由 announceLive 直接写 DOM，避免 React 状态抖动。
 */
export function LiveAnnouncer() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // 复挂载（StrictMode / 分支切换）时保持同一 id，供 announceLive 查找。
    node.id = LIVE_REGION_ID;
    node.textContent = '';
    return () => {
      if (node.id === LIVE_REGION_ID) node.textContent = '';
    };
  }, []);
  return <div ref={ref} className="ui-live" aria-live="polite" aria-atomic="true" />;
}
