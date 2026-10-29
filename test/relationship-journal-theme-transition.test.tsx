import { afterEach, describe, expect, it, vi } from 'vitest';
import { createThemeTransition, type ThemeTransitionStrategy } from '../desktop/renderer/src/ui/theme-transition';
import { relationshipJournalThemeTransition } from '../desktop/renderer/src/ui/relationship-journal-transition';

function installBrowser(reduced = false) {
  const root = { dataset: {} as Record<string, string>, style: {}, animate: vi.fn() };
  const never = new Promise<void>(() => {});
  const transitions: Array<{ skipTransition: ReturnType<typeof vi.fn> }> = [];
  const documentMock = {
    documentElement: root,
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
    startViewTransition: vi.fn((update: () => void) => {
      update();
      const transition = { updateCallbackDone: never, ready: never, finished: never, skipTransition: vi.fn() };
      transitions.push(transition);
      return transition;
    })
  };
  const media = { matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const forcedColors = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const windowMock = {
    matchMedia: vi.fn((query: string) => query.includes('forced-colors') ? forcedColors : media),
    localStorage: { setItem: vi.fn() }
  };
  class Observer {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(_callback: MutationCallback) {}
  }
  vi.stubGlobal('document', documentMock as unknown as Document);
  vi.stubGlobal('window', windowMock as unknown as Window);
  vi.stubGlobal('MutationObserver', Observer);
  return { root, documentMock, transitions };
}

function installJournalBrowser(preset: 'daylight' | 'nightwave', overview = false) {
  const style = () => {
    const values = new Map<string, string>();
    return {
      cssText: '', transform: '', backgroundColor: '',
      getPropertyValue: (name: string) => values.get(name) ?? '',
      getPropertyPriority: () => '',
      setProperty: (name: string, value: string) => values.set(name, value),
      removeProperty: (name: string) => { values.delete(name); }
    };
  };
  const animationCalls: Array<{ frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
  const makeAnimation = () => ({ finished: Promise.resolve(), cancel: vi.fn() });
  const makeElement = (initialRect = { left: 0, top: 0, width: 1, height: 1 }) => {
    const rect = { ...initialRect };
    return {
      rect,
      setRect(next: Partial<typeof rect>) { Object.assign(rect, next); },
      style: style(), dataset: {} as Record<string, string>, children: [] as any[],
      className: '', isConnected: true,
      getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON() {} }),
      setAttribute: vi.fn(),
      append(...nodes: any[]) { this.children.push(...nodes); nodes.forEach((node) => { node.parent = this; }); },
      remove() { const parent = (this as any).parent; if (parent) parent.children = parent.children.filter((node: any) => node !== this); this.isConnected = false; },
      animate(frames: Keyframe[], options: KeyframeAnimationOptions) { animationCalls.push({ frames, options }); return makeAnimation(); }
    };
  };
  const page = makeElement() as ReturnType<typeof makeElement> & {
    querySelector: (selector: string) => any;
    querySelectorAll: (selector: string) => any[];
  };
  page.dataset.uiPreset = preset;
  const book = { classList: { contains: () => false } };
  const strip = makeElement({ left: 400, top: 100, width: 450, height: 96 });
  const leaf = makeElement({ left: 100, top: 100, width: 240, height: 120 }) as ReturnType<typeof makeElement> & { closest: (selector: string) => any };
  leaf.closest = () => book;
  const marks = Array.from({ length: 4 }, (_, index) => {
    const tick = makeElement({ left: 130 + index * 24, top: 240, width: 1, height: 8 });
    (tick as any).color = `rgb(${20 + index}, 40, 60)`;
    return tick;
  });
  page.querySelector = (selector: string) => selector === '.ov' ? (overview ? {} : null) : selector === '.leaf.right' ? leaf : selector === '.strip' ? strip : selector === '.book' ? book : null;
  page.querySelectorAll = (selector: string) => selector === '.strip .tk' ? marks : [];
  leaf.append = vi.fn();

  const root = makeElement() as ReturnType<typeof makeElement> & { animate: (frames: Keyframe[], options: KeyframeAnimationOptions) => any };
  const body = { children: [] as any[], append(element: any) { this.children.push(element); element.parent = this; } };
  const documentMock = {
    documentElement: root,
    body,
    hidden: false,
    querySelector: vi.fn((selector: string) => selector === '.wj-journal' ? page : null),
    createElement: vi.fn(() => makeElement()),
    startViewTransition: vi.fn((update: () => void) => {
      update();
      return { updateCallbackDone: Promise.resolve(), ready: Promise.resolve(), finished: Promise.resolve(), skipTransition: vi.fn() };
    })
  };
  const observers: Array<{ callback: MutationCallback; targets: Array<{ target: Node; options?: MutationObserverInit }>; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  class Observer {
    targets: Array<{ target: Node; options?: MutationObserverInit }> = [];
    observe = vi.fn((target: Node, options?: MutationObserverInit) => { this.targets.push({ target, options }); });
    disconnect = vi.fn();
    constructor(readonly callback: MutationCallback) { observers.push(this); }
  }
  const resizeObservers: Array<{ callback: ResizeObserverCallback; targets: Element[]; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  class LayoutObserver {
    targets: Element[] = [];
    observe = vi.fn((target: Element) => { this.targets.push(target); });
    disconnect = vi.fn();
    constructor(readonly callback: ResizeObserverCallback) { resizeObservers.push(this); }
  }
  const resizeListeners = new Set<EventListenerOrEventListenerObject>();
  const windowMock = {
    matchMedia: vi.fn(() => ({ matches: false })),
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => { if (type === 'resize') resizeListeners.add(listener); }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => { if (type === 'resize') resizeListeners.delete(listener); })
  };
  vi.stubGlobal('window', windowMock as unknown as Window);
  vi.stubGlobal('MutationObserver', Observer);
  vi.stubGlobal('ResizeObserver', LayoutObserver);
  const computed = (element: any, pseudo?: string) => {
    if (element === leaf && pseudo === '::before') return {
      backgroundImage: 'repeating-linear-gradient(180deg, transparent 0px calc(round(nearest, 30px, var(--px, 1px)) - var(--hp, 1px)), rgb(80, 70, 60) 29px 30px)',
      top: '10px', right: '10px', bottom: '10px', left: '20px'
    };
    if (element === leaf) return { getPropertyValue: (name: string) => name === '--hp' ? '1px' : '' };
    if (element === page) return { getPropertyValue: (name: string) => ({
      '--nd-component-relationship-journal-duration1500': '1500ms',
      '--nd-component-relationship-journal-duration900': '900ms',
      '--nd-component-relationship-journal-duration180': '180ms',
      '--nd-component-relationship-journal-duration380': '380ms'
    } as Record<string, string>)[name] ?? '' };
    if (marks.includes(element)) return { backgroundColor: element.color };
    return { backgroundColor: 'rgb(80, 70, 60)' };
  };
  vi.stubGlobal('document', documentMock as unknown as Document);
  vi.stubGlobal('getComputedStyle', computed as unknown as typeof getComputedStyle);
  return { page, root, body, marks, animationCalls, documentMock, observers, resizeObservers, resizeListeners, windowMock, leaf, strip };
}

afterEach(() => vi.unstubAllGlobals());

describe('关系页昼夜过渡策略', () => {
  it('把关系页策略交给唯一主题控制器，并在快速反向时清理上一段', () => {
    const { root, transitions } = installBrowser();
    const commits: unknown[][] = [];
    const cleanups = [vi.fn(), vi.fn()];
    let strategyIndex = 0;
    const strategy = vi.fn<ThemeTransitionStrategy>(({ to, commit, startViewTransition }) => {
      startViewTransition!(() => commit(to));
      return cleanups[Math.min(strategyIndex++, 1)];
    });
    const controller = createThemeTransition('daylight', (...args) => commits.push(args), strategy);

    controller.select('nightwave');
    expect(commits).toEqual([['nightwave', undefined]]);
    expect(root.dataset.themeTransition).toBeUndefined();
    expect(cleanups[0]).not.toHaveBeenCalled();

    controller.select('daylight');
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(commits.at(-1)).toEqual(['daylight', undefined]);
    expect(transitions[0]?.skipTransition).toHaveBeenCalledOnce();
    controller.dispose();
    expect(cleanups[1]).toHaveBeenCalledOnce();
  });

  it('减少动效时直接提交最终预置，不启动关系页形变', () => {
    const { documentMock } = installBrowser(true);
    const strategy = vi.fn<ThemeTransitionStrategy>(() => vi.fn());
    const commits: unknown[][] = [];
    const controller = createThemeTransition('daylight', (...args) => commits.push(args), strategy);

    controller.select('nightwave');

    expect(strategy).not.toHaveBeenCalled();
    expect(documentMock.startViewTransition).not.toHaveBeenCalled();
    expect(commits).toEqual([['nightwave', undefined]]);
    controller.dispose();
  });

  it('策略切入时先收束正在播放的全局天气快照', async () => {
    const { root, transitions } = installBrowser();
    const commits: unknown[][] = [];
    const controller = createThemeTransition('daylight', (...args) => commits.push(args));
    controller.select('nightwave');
    expect(root.dataset.themeTransition).toBe('nightwave');

    const strategy = vi.fn<ThemeTransitionStrategy>(({ to, commit, startViewTransition }) => {
      startViewTransition!(() => commit(to));
      return vi.fn();
    });
    controller.setStrategy(strategy);
    await Promise.resolve();

    expect(transitions[0]?.skipTransition).toHaveBeenCalledOnce();
    expect(root.dataset.themeTransition).toBeUndefined();
    expect(commits.at(-1)).toEqual(['nightwave', undefined]);
    controller.dispose();
  });

  it('取消不使用 View Transition 的页面策略，并丢弃迟到的主题提交', async () => {
    const { root, documentMock } = installBrowser();
    const commits: unknown[][] = [];
    const cleanup = vi.fn();
    const strategy = vi.fn<ThemeTransitionStrategy>(() => {
      root.dataset.themeTransition = 'relationship-journal';
      return cleanup;
    });
    const controller = createThemeTransition('daylight', (...args) => commits.push(args), strategy);

    controller.select('nightwave');
    expect(documentMock.startViewTransition).not.toHaveBeenCalled();
    expect(root.dataset.themeTransition).toBe('relationship-journal');
    controller.setStrategy(undefined);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(root.dataset.themeTransition).toBeUndefined();
    controller.select('daylight');
    await Promise.resolve();

    expect(commits.at(-1)).toEqual(['daylight', undefined]);
    expect(commits.some(([preset]) => preset === 'nightwave')).toBe(false);
    controller.dispose();
  });

  it('没有页面策略时仍沿用全局天气换场默认行为', () => {
    const { root } = installBrowser();
    const commits: unknown[][] = [];
    const controller = createThemeTransition('daylight', (...args) => commits.push(args));

    controller.select('nightwave');

    expect(root.dataset.themeTransition).toBe('nightwave');
    expect(commits).toEqual([['nightwave', 'nightwave']]);
    controller.dispose();
    expect(root.dataset.themeTransition).toBeUndefined();
  });

  it.each([
    ['daylight', 'nightwave', 'to-night'],
    ['nightwave', 'daylight', 'to-day']
  ] as const)('用当前版面几何执行 %s → %s 的纸线/刻度形变', async (from, to, direction) => {
    const { page, root, body, marks, animationCalls } = installJournalBrowser(from);
    const invocation = {
      from, to,
      commit: (next: 'daylight' | 'nightwave') => { page.dataset.uiPreset = next; },
      startViewTransition: (update: () => void) => document.startViewTransition(update),
      finish: vi.fn(),
      isCurrent: () => true
    };

    const cleanup = relationshipJournalThemeTransition(invocation);
    expect(page.dataset.journalThemeTransition).toBe(direction);
    expect(body.children).toHaveLength(1);
    expect(body.children[0].children).toHaveLength(marks.length);
    expect(body.children[0].children[0].style.transform).toContain(from === 'daylight' ? 'translate(120px,139px)' : 'translate(130px,240px)');
    await Promise.resolve();
    await Promise.resolve();
    expect(animationCalls.some((call) => call.frames.some((keyframe) => typeof keyframe.filter === 'string'))).toBe(true);
    const barAnimations = animationCalls.filter((call) => call.frames.length > 1 && call.frames.every((keyframe) => typeof keyframe.transform === 'string'));
    expect(barAnimations).toHaveLength(marks.length);
    expect(barAnimations[0]?.frames.at(-1)?.transform).toContain(from === 'daylight' ? 'translate(130px,240px)' : 'translate(120px,139px)');
    expect((document as any).startViewTransition).not.toHaveBeenCalled();
    cleanup?.();
    expect(page.dataset.journalThemeTransition).toBeUndefined();
    expect(root.style.getPropertyValue('view-transition-name')).toBe('');
    expect(body.children).toHaveLength(0);
  });

  it('总览只处理关系页材质快照，不创建横线与刻度浮层', async () => {
    const { body, animationCalls } = installJournalBrowser('daylight', true);
    const invocation = {
      from: 'daylight' as const,
      to: 'nightwave' as const,
      commit: vi.fn(),
      startViewTransition: (update: () => void) => document.startViewTransition(update),
      finish: vi.fn(),
      isCurrent: () => true
    };

    const cleanup = relationshipJournalThemeTransition(invocation);
    expect(body.children).toHaveLength(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(animationCalls).toHaveLength(1);
    expect(animationCalls[0]?.frames.some((keyframe) => typeof keyframe.filter === 'string')).toBe(true);
    cleanup?.();
  });

  it('在途时响应关系页自己的 reduced 偏好，并移除局部观察器', () => {
    const { page, observers, resizeListeners, windowMock } = installJournalBrowser('daylight');
    const finish = vi.fn();
    const cleanup = relationshipJournalThemeTransition({
      from: 'daylight', to: 'nightwave', commit: vi.fn(), finish, isCurrent: () => true
    });
    const observer = observers.find((item) => item.targets.some(({ target, options }) => target === (page as unknown as Node) && options?.attributeFilter?.includes('data-motion')));
    expect(observer).toBeDefined();

    page.dataset.motion = 'reduced';
    observer?.callback([], observer as unknown as MutationObserver);

    expect(finish).toHaveBeenCalledOnce();
    cleanup?.();
    expect(observers).toHaveLength(2);
    observers.forEach((item) => expect(item.disconnect).toHaveBeenCalledOnce());
    expect(resizeListeners.size).toBe(0);
    expect(windowMock.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('窗口尺寸变化或关系页卸载时收束旧几何动画', () => {
    const first = installJournalBrowser('daylight');
    const finish = vi.fn();
    const cleanup = relationshipJournalThemeTransition({
      from: 'daylight', to: 'nightwave', commit: vi.fn(), finish, isCurrent: () => true
    });
    [...first.resizeListeners].forEach((listener) => {
      if (typeof listener === 'function') listener(new Event('resize'));
      else listener.handleEvent(new Event('resize'));
    });
    expect(finish).toHaveBeenCalledOnce();
    cleanup?.();

    const second = installJournalBrowser('daylight');
    const finishAfterDetach = vi.fn();
    const cleanupAfterDetach = relationshipJournalThemeTransition({
      from: 'daylight', to: 'nightwave', commit: vi.fn(), finish: finishAfterDetach, isCurrent: () => true
    });
    const detachment = second.observers.find((item) => item.targets.some(({ target, options }) => target === (second.documentMock.documentElement as unknown as Node) && options?.subtree));
    second.page.isConnected = false;
    detachment?.callback([], detachment as unknown as MutationObserver);
    expect(finishAfterDetach).toHaveBeenCalledOnce();
    cleanupAfterDetach?.();
  });

  it('测量的横线页尺寸改变时立即收束旧形变', () => {
    const current = installJournalBrowser('daylight');
    const finish = vi.fn();
    const cleanup = relationshipJournalThemeTransition({
      from: 'daylight', to: 'nightwave', commit: vi.fn(), finish, isCurrent: () => true
    });
    const observer = current.resizeObservers.find((item) => item.targets.includes(current.leaf as unknown as Element));
    expect(observer).toBeDefined();

    current.leaf.setRect({ left: 114, width: 228 });
    observer?.callback([], observer as unknown as ResizeObserver);

    expect(finish).toHaveBeenCalledOnce();
    cleanup?.();
    expect(observer?.disconnect).toHaveBeenCalledOnce();
  });
});
