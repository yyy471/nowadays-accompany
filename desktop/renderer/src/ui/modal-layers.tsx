import { createContext, useContext, useState, type ReactNode } from 'react';

export type ModalLayer = { backdrop: HTMLElement; panel: HTMLElement; restoreFocus?: HTMLElement };

/**
 * 模态层的存在状态由应用级实例持有；背景隔离、滚动锁和层级随栈顶收敛。
 * 不存在模块级可变状态，多个应用实例（含样板）互不串扰。
 */
export function createModalLayerManager() {
  const layers: ModalLayer[] = [];
  const backgroundState = new Map<HTMLElement, { inert: boolean; hidden: string | null }>();
  let previousBodyOverflow: string | undefined;
  const isolate = (): void => {
    for (const [element, previous] of backgroundState) {
      element.inert = previous.inert;
      if (previous.hidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', previous.hidden);
    }
    backgroundState.clear();
    const top = layers.at(-1);
    if (!top) {
      if (previousBodyOverflow !== undefined) {
        document.body.style.overflow = previousBodyOverflow;
        previousBodyOverflow = undefined;
      }
      return;
    }
    if (previousBodyOverflow === undefined) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    layers.forEach((layer, index) => { layer.backdrop.style.zIndex = String(1000 + index * 10); });
    for (const child of document.body.children) {
      if (!(child instanceof HTMLElement) || child === top.backdrop || ['SCRIPT', 'STYLE'].includes(child.tagName)) continue;
      backgroundState.set(child, { inert: child.inert, hidden: child.getAttribute('aria-hidden') });
      child.inert = true;
      child.setAttribute('aria-hidden', 'true');
    }
  };
  return {
    push(layer: ModalLayer): void { layers.push(layer); isolate(); },
    remove(layer: ModalLayer): void {
      const index = layers.indexOf(layer);
      if (index !== -1) layers.splice(index, 1);
      isolate();
    },
    isTop(layer: ModalLayer): boolean { return layers.at(-1) === layer; },
    top(): ModalLayer | undefined { return layers.at(-1); },
    get size(): number { return layers.length; }
  };
}

export type ModalLayerManager = ReturnType<typeof createModalLayerManager>;

const ModalLayerContext = createContext<ModalLayerManager | undefined>(undefined);

/** 应用根与独立样板各持有一个实例；公共Modal不创建模块级单例。 */
export function ModalLayerProvider({ manager, children }: { manager?: ModalLayerManager; children: ReactNode }) {
  const [owned] = useState(createModalLayerManager);
  return <ModalLayerContext.Provider value={manager ?? owned}>{children}</ModalLayerContext.Provider>;
}

export function useModalLayerManager(): ModalLayerManager | undefined {
  return useContext(ModalLayerContext);
}
