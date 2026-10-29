import { describe, expect, it } from 'vitest';
import { layoutJournalTabs } from '../desktop/renderer/src/lib/relationship-journal-layout';

function expectBoundAndSeparated(result: ReturnType<typeof layoutJournalTabs>, stripWidth: number, gap: number) {
  const visible = result.placements.filter((placement) => !placement.hidden).sort((a, b) => a.center - b.center);
  for (const placement of visible) {
    expect(placement.center - placement.width / 2).toBeGreaterThanOrEqual(-0.01);
    expect(placement.center + placement.width / 2).toBeLessThanOrEqual(stripWidth + 0.01);
  }
  for (let index = 1; index < visible.length; index++) {
    const left = visible[index - 1]!;
    const right = visible[index]!;
    expect(left.center + left.width / 2 + gap).toBeLessThanOrEqual(right.center - right.width / 2 + 0.01);
  }
}

describe('relationship journal tab layout', () => {
  it('keeps the current page and structural tabs in bounds, without overlap, and moves the needle with it', () => {
    const result = layoutJournalTabs({
      stripWidth: 520,
      centers: [52, 92, 136, 184, 232, 280, 328, 376, 424, 472],
      widths: [68, 76, 76, 86, 12, 12, 12, 12, 12, 12],
      minWidths: [44, 44, 44, 56, 12, 12, 12, 12, 12, 12],
      activeIndex: 0,
      priorityIndices: [0, 1, 2],
      gap: 4
    });

    expect(result.placements[0]?.center).toBe(result.needleCenter);
    expect(result.placements.slice(0, 3).every((placement) => !placement.hidden)).toBe(true);
    expectBoundAndSeparated(result, 520, 4);
  });

  it('uses an explicit roster fallback when the session index cannot fit', () => {
    const count = 80;
    const result = layoutJournalTabs({
      stripWidth: 360,
      centers: Array.from({ length: count }, (_, index) => index * 4.5),
      widths: Array.from({ length: count }, (_, index) => index < 3 ? 76 : 12),
      minWidths: Array.from({ length: count }, (_, index) => index < 3 ? 44 : 12),
      activeIndex: 44,
      priorityIndices: [0, 1, 2],
      gap: 4
    });

    expect(result.mode).toBe('index');
    expect(result.placements[44]?.hidden).toBe(false);
    expect(result.placements[0]?.hidden).toBe(false);
    expect(result.placements[1]?.hidden).toBe(false);
    expect(result.placements[2]?.hidden).toBe(false);
    expect(result.placements.some((placement) => placement.hidden)).toBe(true);
    expect(result.placements[44]?.center).toBe(result.needleCenter);
    expectBoundAndSeparated(result, 360, 4);
  });

  it('clamps a single active tab to an extremely narrow strip instead of clipping it', () => {
    const result = layoutJournalTabs({
      stripWidth: 28,
      centers: [3, 100],
      widths: [72, 12],
      minWidths: [56, 12],
      activeIndex: 0,
      gap: 4
    });

    expect(result.mode).toBe('index');
    expect(result.placements[0]?.width).toBe(28);
    expect(result.placements[0]?.center).toBe(14);
    expect(result.placements[0]?.center).toBe(result.needleCenter);
    expectBoundAndSeparated(result, 28, 0);
  });
});
