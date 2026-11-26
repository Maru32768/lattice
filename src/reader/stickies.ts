import type { Sticky, StickyKind } from "../api";

/** Mirrors stickies.rs: a longer passage is refused. */
export const MAX_QUOTE = 2000;
/** Between a card and what is next to it. */
export const GAP = 10;

/** The style by which a block makes room (px) for the cards under it, and `.blocks` for those above its first block. */
export const ROOM = "--sticky-room";
export const roomOf = (el: HTMLElement) => parseFloat(el.style.getPropertyValue(ROOM)) || 0;

export const STICKY_KINDS = ["question", "detail", "term"] as const satisfies readonly StickyKind[];

/** What the reader selected to ask about. */
export interface Passage {
  /** The block it starts in, or for a passage of an answer that of its card. */
  blockId: number | null;
  /** The message whose answer it is of. */
  parent: number | null;
  quote: string;
}

export type Step = { step: "writing" } | { step: "pending" } | { step: "failed"; error: string };
type Asked = {
  /** Names it in this window. */
  key: number;
  question: string;
} & Step;

/** A passage the reader asked about in this window, while there is no answer. */
export type PassageAsk = Asked & Passage & { kind: StickyKind };
/** A question after the answers of a saved sticky, while there is no answer to it. */
export type FollowUp = Asked & { sticky: number };
export type Ask = PassageAsk | FollowUp;

export const isFollowUp = (ask: Ask): ask is FollowUp => "sticky" in ask;

/** An id alone does not name a sticky: SQLite gives it again. */
export const isSame = (a: Sticky, b: Sticky) => a.id === b.id && a.quote === b.quote && a.messages[0]?.answer === b.messages[0]?.answer;

/** The stickies that are gone. */
export const goneOf = (before: Sticky[], now: Sticky[]) => before.filter((s) => !now.some((n) => isSame(n, s)));

/** The asks then: a follow-up goes with its sticky, and an ask on an answer stays without its parent, as a saved child does. */
export function asksLeft(asks: Ask[], gone: Sticky[]): Ask[] {
  const answers = new Set(gone.flatMap((s) => s.messages.map((m) => m.id)));
  return asks.flatMap((ask): Ask[] => {
    if (isFollowUp(ask)) {
      return gone.some((s) => s.id === ask.sticky) ? [] : [ask];
    }
    return [ask.parent != null && answers.has(ask.parent) ? { ...ask, parent: null } : ask];
  });
}

type Card = {
  key: string;
  /** Its root's. */
  blockId: number | null;
  /** The key of the card that has the answer its passage is of, and how far down from its root that makes it. */
  parent: string | undefined;
  depth: number;
  root: string;
} & ({ sticky: Sticky } | { ask: PassageAsk });

/**
 * The cards down the article, those without a block of it first, each followed by those on its answers. Of one block or one
 * parent: the saved ones, then the asks, each oldest first.
 */
export function cardsOf(saved: Sticky[], asks: Ask[], blocks: { id: number }[]): Card[] {
  const of = new Map<number | null, string>(saved.flatMap((s) => s.messages.map((m) => [m.id, `s${s.id}`] as const)));
  const all = [
    ...saved.map((sticky) => ({ key: `s${sticky.id}`, blockId: sticky.block_id, parent: of.get(sticky.parent), sticky })),
    ...asks.filter((a): a is PassageAsk => !isFollowUp(a)).map((ask) => ({ key: `a${ask.key}`, blockId: ask.blockId, parent: of.get(ask.parent), ask })),
  ];
  const on = Map.groupBy(all, (c) => c.parent);
  const down = (c: (typeof all)[number], root: (typeof all)[number], depth: number): Card[] => [
    { ...c, blockId: root.blockId, root: root.key, depth },
    ...(on.get(c.key) ?? []).flatMap((child) => down(child, root, depth + 1)),
  ];
  const ordinal = (c: { blockId: number | null }) => blocks.findIndex((b) => b.id === c.blockId);
  return (on.get(undefined) ?? []).toSorted((a, b) => ordinal(a) - ordinal(b)).flatMap((c) => down(c, c, 0));
}

/**
 * Where `quote` is in `texts`, the text nodes one after the other, starting in the first `own` of them: as [node, offset] at
 * its start and past its end. A selection gives the text with whitespace as it is laid out, so none counts. Of the same text
 * twice it is the first, unless that starts or ends inside a word and another does not: a term selected is often part of others.
 */
export function findPassage(texts: string[], own: number, quote: string): [[number, number], [number, number]] | null {
  const want = quote.replace(/\s+/g, "");
  const full: [number, number][] = [];
  /** Where in `full` each character of `text` is. */
  const at: number[] = [];
  let text = "";
  texts.forEach((t, i) => {
    for (let j = 0; j < t.length; j++) {
      if (!/\s/.test(t[j]!)) {
        text += t[j];
        at.push(full.length);
      }
      full.push([i, j]);
    }
  });
  const found: number[] = [];
  for (let i = want ? text.indexOf(want) : -1; i >= 0 && full[at[i]!]![0] < own; i = text.indexOf(want, i + 1)) {
    found.push(i);
  }
  const charAt = (k: number) => (full[k] ? texts[full[k][0]]![full[k][1]] : undefined);
  const last = (i: number) => at[i + want.length - 1]!;
  const whole = (i: number) => !(inWord(charAt(at[i]! - 1)) && inWord(want[0])) && !(inWord(want.at(-1)) && inWord(charAt(last(i) + 1)));
  const i = found.find(whole) ?? found[0];
  if (i == null) {
    return null;
  }
  const [node, offset] = full[last(i)]!;
  return [full[at[i]!]!, [node, offset + 1]];
}

/** Japanese is written with no spaces between its words, so there a word's edge cannot be told. */
const inWord = (c: string | undefined) => c != null && /[\p{L}\p{N}_]/u.test(c) && !/[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u.test(c);

/**
 * Where the cards go in the column, in order: each at its block's height, or below the card before where it would cover that.
 * For those at the indexes `anchors` it is the cards before that give way, up the column as far as there is room, or as
 * the anchor before them leaves.
 */
export function stack(cards: { at: number; height: number }[], ...anchors: number[]): number[] {
  const tops: number[] = [];
  let free = 0;
  let highest = 0;
  cards.forEach(({ at, height }, i) => {
    const anchor = anchors.includes(i);
    tops[i] = Math.max(at, anchor ? highest : free);
    free = tops[i] + height + GAP;
    highest += height + GAP;
    if (anchor) {
      for (let j = i - 1; j >= 0; j--) {
        tops[j] = Math.min(tops[j]!, tops[j + 1]! - GAP - cards[j]!.height);
      }
      highest = free;
    }
  });
  return tops;
}
