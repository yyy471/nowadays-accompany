/** 纸线与玻璃刻度的几何配对，供主题转场和测试共用。 */

export function buildFoldMarks(leaf, strip, count = 41) {
  const safeCount = Math.max(2, count);
  const width = Math.max(70, leaf.width - 70);
  const x = leaf.left + 30;
  const target = strip && strip.width > 50 ? strip : { left: leaf.left + 25, top: leaf.top + 3, width: Math.max(80, leaf.width - 50), height: 44 };
  const rows = 6;
  const columns = Math.ceil(safeCount / rows);
  return Array.from({ length: safeCount }, (_, index) => {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const tickH = index % 5 === 0 ? 20 : index % 2 === 0 ? 12 : 8;
    return {
      index,
      lineX: x + column * width / columns,
      lineY: leaf.top + leaf.height * 0.48 + row * 24,
      lineW: width / columns,
      tickX: target.left + 20 + (target.width - 40) * index / (safeCount - 1),
      tickY: target.top + target.height - 12 - tickH,
      tickH
    };
  });
}
