import type { Block, SummaryItems } from "../api";

/**
 * `text` in parts, each of `numbers` that stands alone a part of its own to mark: not the 2 inside 2,000 or 12, as
 * the number checked was a whole number in the text.
 */
export function markNumbers(text: string, numbers: string[]): { text: string; mark: boolean }[] {
  if (numbers.length === 0) {
    return [{ text, mark: false }];
  }
  // Longest first, so 8万 is marked whole rather than its 8.
  const alternatives = numbers
    .toSorted((a, b) => b.length - a.length)
    .map((n) => RegExp.escape(n))
    .join("|");
  const re = new RegExp(`(?<![\\d.,])(${alternatives})(?![\\d]|[.,]\\d)`);
  return text
    .split(re)
    .map((part, i) => ({ text: part, mark: i % 2 === 1 }))
    .filter((p) => p.text !== "");
}

/** Each block the items cite that the article still has, numbered from 1 in the order first cited. */
export function citeNumbers(items: SummaryItems, blocks: Block[]): Map<number, number> {
  const have = new Set(blocks.map((b) => b.id));
  const out = new Map<number, number>();
  for (const id of [...items.summary, ...items.key_points].flatMap((i) => i.block_ids)) {
    if (have.has(id) && !out.has(id)) {
      out.set(id, out.size + 1);
    }
  }
  return out;
}
