import { describe, expect, it } from 'vitest';
import { historyIndex, planHistoryGuard } from '../desktop/renderer/src/lib/drafts/navigation-history.js';

describe('history guard planning', () => {
  it('reads only integer application indexes from history state', () => {
    expect(historyIndex({ __nowadaysIndex: 3 })).toBe(3);
    expect(historyIndex({ __nowadaysIndex: '3' })).toBeUndefined();
    expect(historyIndex({ __nowadaysIndex: 1.5 })).toBeUndefined();
    expect(historyIndex(undefined)).toBeUndefined();
  });

  it('compensates by the delta between known application entries', () => {
    expect(planHistoryGuard(4, 2)).toEqual({ kind: 'compensate', delta: 2 });
    expect(planHistoryGuard(2, 4)).toEqual({ kind: 'compensate', delta: -2 });
  });

  it('restores the canonical URL without guessing when an index is missing or unchanged', () => {
    expect(planHistoryGuard(4, undefined)).toEqual({ kind: 'restore' });
    expect(planHistoryGuard(undefined, 2)).toEqual({ kind: 'restore' });
    expect(planHistoryGuard(4, 4)).toEqual({ kind: 'restore' });
  });
});
