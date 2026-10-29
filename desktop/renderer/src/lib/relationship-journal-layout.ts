export interface JournalTabLayoutInput {
  stripWidth: number;
  centers: readonly number[];
  widths: readonly number[];
  minWidths: readonly number[];
  activeIndex: number;
  priorityIndices?: readonly number[];
  gap?: number;
}

export interface JournalTabPlacement {
  index: number;
  center: number;
  width: number;
  hidden: boolean;
}

export interface JournalTabLayout {
  placements: JournalTabPlacement[];
  needleCenter: number;
  mode: 'spread' | 'index';
}

const finitePositive = (value: number, fallback: number) => Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * 将页签压进真实 strip 几何范围。空间不足时优先保留当前页与结构页，
 * 其余会话转由完整名册访问；所有返回的可见项均不越界且互不相交。
 */
export function layoutJournalTabs(input: JournalTabLayoutInput): JournalTabLayout {
  const count = Math.min(input.centers.length, input.widths.length, input.minWidths.length);
  const stripWidth = finitePositive(input.stripWidth, 1);
  const gap = Math.max(0, Number.isFinite(input.gap) ? input.gap! : 4);
  if (!count) return { placements: [], needleCenter: stripWidth / 2, mode: 'spread' };

  const activeIndex = Math.max(0, Math.min(count - 1, Math.floor(input.activeIndex)));
  const centers = Array.from({ length: count }, (_, index) => {
    const value = input.centers[index] ?? stripWidth / 2;
    return Math.max(0, Math.min(stripWidth, Number.isFinite(value) ? value : stripWidth / 2));
  });
  const widths = Array.from({ length: count }, (_, index) => Math.max(1, input.widths[index] ?? 1));
  const minimums = Array.from({ length: count }, (_, index) => Math.min(widths[index]!, Math.max(1, input.minWidths[index] ?? 1)));
  const protectedIndices = [...new Set([activeIndex, ...(input.priorityIndices ?? [])])]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < count);
  const minRequired = (indices: readonly number[]) => indices.reduce((sum, index) => sum + minimums[index]!, 0)
    + Math.max(0, indices.length - 1) * gap;
  const selected = new Set<number>();
  for (const index of protectedIndices) {
    const candidate = [...selected, index];
    if (index === activeIndex || minRequired(candidate) <= stripWidth) selected.add(index);
  }

  const candidates = Array.from({ length: count }, (_, index) => index)
    .filter((index) => !selected.has(index))
    .sort((a, b) => Math.abs(centers[a]! - centers[activeIndex]!) - Math.abs(centers[b]! - centers[activeIndex]!) || a - b);
  for (const index of candidates) {
    const candidate = [...selected, index];
    if (minRequired(candidate) <= stripWidth) selected.add(index);
  }

  const ordered = [...selected].sort((a, b) => centers[a]! - centers[b]! || a - b);
  const packedWidths = ordered.map((index) => widths[index]!);
  const packedMinimums = ordered.map((index) => minimums[index]!);
  let total = packedWidths.reduce((sum, value) => sum + value, 0) + Math.max(0, ordered.length - 1) * gap;
  let excess = Math.max(0, total - stripWidth);
  while (excess > 0.01) {
    const flexible = packedWidths.map((width, position) => width - packedMinimums[position]!)
      .reduce((sum, value) => sum + Math.max(0, value), 0);
    if (flexible <= 0) break;
    const excessBeforePass = excess;
    for (let position = 0; position < packedWidths.length; position++) {
      const available = Math.max(0, packedWidths[position]! - packedMinimums[position]!);
      if (!available) continue;
      const reduction = Math.min(available, excessBeforePass * available / flexible);
      packedWidths[position]! -= reduction;
    }
    total = packedWidths.reduce((sum, value) => sum + value, 0) + Math.max(0, ordered.length - 1) * gap;
    excess = Math.max(0, total - stripWidth);
  }

  const activePosition = ordered.indexOf(activeIndex);
  const distance = (leftPosition: number, rightPosition: number) =>
    (packedWidths[leftPosition]! + packedWidths[rightPosition]!) / 2 + gap;
  const offsets = [0];
  for (let position = 1; position < ordered.length; position++) offsets[position] = offsets[position - 1]! + distance(position - 1, position);
  const lowerOffset = packedWidths[0]! / 2;
  const upperOffset = stripWidth - packedWidths[packedWidths.length - 1]! / 2 - offsets[offsets.length - 1]!;
  const activeMin = lowerOffset + offsets[activePosition]!;
  const activeMax = upperOffset + offsets[activePosition]!;
  if (activeMin > activeMax + 0.01) {
    // 极窄窗口只能保留当前页签，避免裁掉它的命中区。
    const activeWidth = Math.min(stripWidth, Math.max(1, widths[activeIndex]!));
    const center = Math.max(activeWidth / 2, Math.min(stripWidth - activeWidth / 2, centers[activeIndex]!));
    return {
      placements: Array.from({ length: count }, (_, index) => ({ index, center: index === activeIndex ? center : centers[index]!, width: index === activeIndex ? activeWidth : widths[index]!, hidden: index !== activeIndex })),
      needleCenter: center,
      mode: 'index'
    };
  }
  const activeCenter = Math.max(activeMin, Math.min(activeMax, centers[activeIndex]!));
  const activeZ = activeCenter - offsets[activePosition]!;
  const packedZ = Array<number>(ordered.length);
  for (let position = 0; position < activePosition; position++) {
    const desired = centers[ordered[position]!]! - offsets[position]!;
    const bounded = Math.max(lowerOffset, Math.min(activeZ, desired));
    packedZ[position] = position === 0 ? bounded : Math.max(packedZ[position - 1]!, bounded);
  }
  packedZ[activePosition] = activeZ;
  for (let position = activePosition + 1; position < ordered.length; position++) {
    const desired = centers[ordered[position]!]! - offsets[position]!;
    const bounded = Math.max(activeZ, Math.min(upperOffset, desired));
    packedZ[position] = Math.max(packedZ[position - 1]!, bounded);
  }
  const packedCenters = packedZ.map((value, position) => value + offsets[position]!);

  const placements = Array.from({ length: count }, (_, index) => ({
    index,
    center: centers[index]!,
    width: widths[index]!,
    hidden: !selected.has(index)
  }));
  ordered.forEach((index, position) => {
    placements[index] = { index, center: packedCenters[position]!, width: packedWidths[position]!, hidden: false };
  });
  return { placements, needleCenter: activeCenter, mode: selected.size === count ? 'spread' : 'index' };
}
