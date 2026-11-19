import type { Block, SummaryItem, SummaryItems } from "../api";

/** `item`'s text in parts, the numbers the article lacks (`unverified`, ranges in order) parts of their own to mark. */
export function markNumbers(item: SummaryItem): { text: string; mark: boolean }[] {
  const parts = [];
  let at = 0;
  for (const [start, end] of item.unverified) {
    parts.push({ text: item.text.slice(at, start), mark: false }, { text: item.text.slice(start, end), mark: true });
    at = end;
  }
  parts.push({ text: item.text.slice(at), mark: false });
  return parts.filter((p) => p.text !== "");
}

/**
 * What goes before a summary sentence that follows `prev` (`undefined` for the first): a space unless `prev` ends in
 * 。！？, as `format_summary` joins them.
 */
export function gapAfter(prev: string | undefined): string {
  return prev === undefined || /[。！？]$/.test(prev) ? "" : " ";
}

/** The numbers the article lacks, as the items write them, each once. */
export function unverifiedNumbers(items: SummaryItems): string[] {
  return [...new Set([...items.summary, ...items.key_points].flatMap((i) => i.unverified.map(([start, end]) => i.text.slice(start, end))))];
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
