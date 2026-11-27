/** 用户滚动和程序定位共用实际偏移，不改变阅读位置。 */
export function syncMessageFeather(scroller: Pick<HTMLElement, 'scrollTop' | 'toggleAttribute'>) {
  scroller.toggleAttribute('data-scrolled', scroller.scrollTop > 0);
}
