/** 从同一次选择计时，为克隆、提交和最后一次绘制留在同一预算内。 */
export function remainingThemeTime(startedAt: number, duration: number, now = performance.now()) {
  return Math.max(0, startedAt + duration - now);
}
