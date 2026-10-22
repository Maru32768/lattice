/** Each item with where its run starts when the runs (`length` of each item) are laid end to end from `from`. */
export function withStarts<T>(items: readonly T[], length: (item: T) => number, from = 0): { item: T; start: number }[] {
  const out: { item: T; start: number }[] = [];
  let start = from;
  for (const item of items) {
    out.push({ item, start });
    start += length(item);
  }
  return out;
}
