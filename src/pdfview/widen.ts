/**
 * How far a single line's box grows to each side to hold `need` more width, within the room beside it.
 * A centred line (as much room on one side as on the other) stays centred; any other keeps its left edge.
 */
export function widen(need: number, left: number, right: number): { left: number; right: number } {
  if (Math.abs(left - right) <= 0.1 * (left + right)) {
    const each = Math.min(need / 2, left, right);
    return { left: each, right: each };
  }
  return { left: 0, right: Math.min(need, right) };
}
