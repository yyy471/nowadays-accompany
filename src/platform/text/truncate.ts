/** Fit text to an exact, monotonic size predicate without splitting Unicode code points.
 * Truncated output always carries its marker; undefined means even the marker cannot fit.
 */
export function truncateTextToFit(
  text: string,
  fits: (candidate: string) => boolean,
  marker = '\n[结果已截断]'
): string | undefined {
  if (fits(text)) return text;
  if (!fits(marker)) return undefined;
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(characters.slice(0, middle).join('') + marker)) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join('') + marker;
}
