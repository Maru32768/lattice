import type { Sticky, StickyKind } from "../api";

/** Mirrors stickies.rs: a longer passage is refused. */
export const MAX_QUOTE = 2000;
/** Between a card and what is next to it. */
export const GAP = 10;

/** The style by which a block makes room (px) for the cards under it, and `.blocks` for those above its first block. */
export const ROOM = "--sticky-room";
export const roomOf = (el: HTMLElement) => parseFloat(el.style.getPropertyValue(ROOM)) || 0;

export const STICKY_KINDS = ["question", "detail", "term"] as const satisfies readonly StickyKind[];

/** A passage the reader asked about in this window, while there is no answer. */
export type Ask = {
  /** Names it in this window. */
  key: number;
  blockId: number | null;
  kind: StickyKind;
  quote: string;
  question: string;
} & ({ step: "writing" } | { step: "pending" } | { step: "failed"; error: string });

export type Card = { key: string; blockId: number | null } & ({ sticky: Sticky } | { ask: Ask });

/** The cards down the article, those without a block of it first. On one block: the saved ones, then the asks, each oldest first. */
export function cardsOf(saved: Sticky[], asks: Ask[], blocks: { id: number }[]): Card[] {
  const ordinals = new Map(blocks.map((b, i) => [b.id, i]));
  const ordinal = (c: Card) => (c.blockId == null ? undefined : ordinals.get(c.blockId)) ?? -1;
  const cards: Card[] = [
    ...saved.map((sticky) => ({ key: `s${sticky.id}`, blockId: sticky.block_id, sticky })),
    ...asks.map((ask) => ({ key: `a${ask.key}`, blockId: ask.blockId, ask })),
  ];
  return cards.toSorted((a, b) => ordinal(a) - ordinal(b));
}

/**
 * Where the cards go in the column, in order: each at its block's height, or below the card before where it would cover that.
 * For the card at index `opened` it is the cards before that give way, up the column as far as there is room.
 */
export function stack(cards: { at: number; height: number }[], opened = -1): number[] {
  let free = 0;
  let heights = 0;
  const tops = cards.map(({ at, height }, i) => {
    const top = Math.max(at, i === opened ? heights : free);
    free = top + height + GAP;
    heights += height + GAP;
    return top;
  });
  for (let i = opened - 1; i >= 0; i--) {
    tops[i] = Math.min(tops[i]!, tops[i + 1]! - GAP - cards[i]!.height);
  }
  return tops;
}
