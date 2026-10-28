// Picking list rows for a bulk action (グループに追加): a click toggles one row; Shift+click adds
// the rows from the last clicked one through this one, in list order.

export function pick(order: number[], picked: number[], anchor: number | null, id: number, range: boolean): number[] {
  const from = anchor == null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  if (!range || from < 0 || to < 0) {
    return picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
  }
  const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  const has = new Set(picked);
  return [...picked, ...span.filter((x) => !has.has(x))];
}
