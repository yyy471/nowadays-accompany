export function historyIndex(state: unknown): number | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const value = (state as { __nowadaysIndex?: unknown }).__nowadaysIndex;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export type HistoryPlan =
  | { kind: 'compensate'; delta: number }
  | { kind: 'restore' }
  | { kind: 'none' };

export function planHistoryGuard(currentIndex: number | undefined, targetIndex: number | undefined): HistoryPlan {
  if (currentIndex === undefined || targetIndex === undefined || currentIndex === targetIndex) return { kind: 'restore' };
  return { kind: 'compensate', delta: currentIndex - targetIndex };
}
