import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { Block, Sticky, StickyMessage, VocabAdded, VocabCapture } from "../api";
import { splitCitations } from "../chat/chat";
import { sendsOn, useSendKey } from "../chat/sendKey";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";
import { useT } from "../i18n";
import { GAP, ROOM, cardsOf, findPassage, isFollowUp, isSame, roomOf, stack, type Ask, type FollowUp, type PassageAsk } from "./stickies";
import { deleteSticky, changeAsk, changeDraft, draftNote, dropAsk, dropDraft, foldSticky, openAsk, sendAsk, useStickies, type Draft } from "./useStickies";
import "./stickies.css";

/** A pane narrower than this has no room for a column beside the text. */
const COLUMN_FROM = 720;
/** Under the last card of a column that goes on below the article. */
const END = 40;
/** How far a child is set in from its parent, down to a depth. */
const INDENT = 12;
const DEEPEST = 3;

/**
 * The text at the view's top: how much of a block, or of a part of the header, is above it, and the px from its end down to
 * it, where a block makes `room`. Among the cards above the first block it is `.blocks` itself, from its top, and above the
 * header `.reader`.
 */
interface Line {
  block: HTMLElement;
  share: number;
  past: number;
  room: number;
}

/** The last of `els`, one below the other, that starts above `y`. */
function lastFrom(els: HTMLCollection, y: number) {
  let [from, to] = [0, els.length];
  while (from < to) {
    const mid = (from + to) >> 1;
    if (els[mid]!.getBoundingClientRect().top <= y) {
      from = mid + 1;
    } else {
      to = mid;
    }
  }
  return els[from - 1] as HTMLElement | undefined;
}

function lineAt(scroller: HTMLElement): Line {
  const top = scroller.getBoundingClientRect().top;
  const reader = scroller.querySelector<HTMLElement>(".reader")!;
  const article = reader.querySelector<HTMLElement>(".blocks")!;
  const block = lastFrom(article.children, top) ?? lastFrom(reader.children, top) ?? reader;
  const r = block.getBoundingClientRect();
  const room = roomOf(block);
  if (block === article || block === reader) {
    return { block, share: 0, past: top - r.top, room };
  }
  // None in the block itself: the least of it, as by rounding, would be past cards that come there.
  return { block, share: r.height ? Math.min(1, (top - r.top) / r.height) : 0, past: Math.max(0, top - r.bottom), room };
}

/** Where the line is in the pane. */
function offsetOf({ block, share, past, room }: Line, scroller: HTMLElement) {
  const r = block.getBoundingClientRect();
  const now = roomOf(block);
  // Among the cards a card stays, if it can. Else it is the text below, up into the block if the cards have folded under
  // the view's top.
  const down = past <= Math.min(room, now) ? past : past + now - room;
  return r.top + share * r.height + down - scroller.getBoundingClientRect().top;
}

/** `clientWidth` is in whole pixels, and half a pixel can take a line. */
const widthOf = (scroller: HTMLElement) => scroller.getBoundingClientRect().width;

/**
 * The line in the pane as `place` or the reader's last scroll left it: at the view's top but for a part of a pixel, or below
 * it at the end of the text.
 */
interface Kept {
  width: number;
  top: number;
  line: Line;
  /** Of the line's block. */
  height: number;
  offset: number;
}

const keep = (scroller: HTMLElement, line = lineAt(scroller)): Kept => ({
  width: widthOf(scroller),
  top: scroller.scrollTop,
  line,
  height: line.block.getBoundingClientRect().height,
  offset: offsetOf(line, scroller),
});

/** How far the view has been scrolled since. At the end of text that got shorter it comes up with it, which is no scroll. */
function scrolled(k: Kept, { scrollTop, clientHeight, scrollHeight }: HTMLElement) {
  const by = scrollTop - k.top;
  return Math.abs(by) < 1 || (by < 0 && scrollTop + clientHeight > scrollHeight - 1) ? 0 : by;
}

const still = ({ line, offset }: Kept, scroller: HTMLElement) => Math.abs(offsetOf(line, scroller) - offset) < 1;

/**
 * The line from before and where in the pane it is to be, unless the reader has gone on. Read again, it would go on by what
 * each scroll is rounded by.
 */
function lineOf(k: Kept | null, scroller: HTMLElement): Pick<Kept, "line" | "offset"> | undefined {
  if (!k?.line.block.isConnected) {
    return undefined;
  }
  const { line, offset } = k;
  const by = scrolled(k, scroller);
  if (k.width !== widthOf(scroller)) {
    // The browser has held no text (stickies.css), so this is all the reader's: a scroll that goes on, as a key's or a
    // wheel's does over some frames. More than a view of it is a jump to a place of this width.
    return Math.abs(by) < scroller.clientHeight ? { line, offset: -by } : undefined;
  }
  // The text has moved and the reader has not: the browser held none, as where no text is in view.
  const whole = Math.abs(line.block.getBoundingClientRect().height - k.height) < 1;
  return still(k, scroller) || (by === 0 && whole) ? { line, offset } : undefined;
}

/**
 * How far below its block's height a root was placed last, beside the text, and a held one as it came to be held. Below 0: it
 * gave way to the pinned one.
 */
const offs = new WeakMap<Element, number>();
/** The pin (the column's `data-pin`) that a card came to be held under: it stays held under it as what was asked on it closes. */
const holds = new WeakMap<Element, string>();
/** How tall a card was when it was last placed unfolded. */
const talls = new WeakMap<Element, number>();

/**
 * Puts the cards beside their blocks, or under them in a narrow pane, where the text makes room. The text at the view's top
 * stays there. `room` is false to leave the text's layout as it is.
 */
function place(column: HTMLElement, kept: RefObject<Kept | null>, room = true) {
  const scroller = column.parentElement!;
  // An article without stickies is left alone, once the last one's room is gone. Hidden (under a zoomed pane) there is
  // nothing to measure, and coming back is a resize.
  if ((column.children.length === 0 && !column.hasAttribute("data-placed")) || scroller.clientWidth === 0) {
    return;
  }
  const article = scroller.querySelector<HTMLElement>(".blocks")!;
  const cards = cardsIn(column, article);
  const beside = cards.length > 0 && scroller.clientWidth >= COLUMN_FROM;

  // The browser's scroll anchoring lets go of text whose own styles change, as they do here.
  const was = kept.current;
  const { line, offset } = lineOf(was, scroller) ?? { line: lineAt(scroller), offset: 0 };
  const scrolledOn = was?.width !== widthOf(scroller) && offset !== 0;

  if (room) {
    column.toggleAttribute("data-placed", cards.length > 0);
    column.toggleAttribute("data-beside", beside);
    const rooms = new Map<HTMLElement, number>();
    for (const { el, block } of beside ? [] : cards) {
      const host = block ?? article;
      rooms.set(host, (rooms.get(host) ?? (block ? 0 : GAP)) + el.offsetHeight + GAP);
    }
    for (const el of scroller.querySelectorAll<HTMLElement>(`[style*="${ROOM}"]`)) {
      if (!rooms.has(el)) {
        el.style.removeProperty(ROOM);
      }
    }
    rooms.forEach((px, el) => el.style.setProperty(ROOM, `${px}px`));
  }
  const top = column.getBoundingClientRect().top;
  const under = (block: HTMLElement | null) => (block ? block.getBoundingClientRect().bottom : article.getBoundingClientRect().top) + GAP;
  const spots = cards.map(({ el, block }) => ({
    // A child has no height of its own: right below the card before it.
    at: el.hasAttribute("data-child") ? 0 : (beside ? (block?.getBoundingClientRect().top ?? top) : under(block)) - top,
    height: el.offsetHeight,
  }));
  const endOf = (tops: number[], of = spots) => Math.max(0, ...tops.map((at, i) => at + of[i]!.height)) + END;
  const pin = column.dataset.pin ?? "";
  const held = (el: HTMLElement) => offs.has(el) && (el.hasAttribute("data-held") || holds.get(el) === pin);
  const tops = beside ? topsBeside(cards, spots, held) : stack(spots);
  // Cards that give way to the pinned one, or fold, do not take a view at the column's end up with them, where it will be.
  const viewEnd = scroller.getBoundingClientRect().top + scroller.clientHeight + offsetOf(line, scroller) - offset - top;
  const unfolded = spots.map((s, i) => {
    const { el } = cards[i]!;
    if (!el.hasAttribute("data-folded")) {
      talls.set(el, s.height);
      return s;
    }
    return { ...s, height: talls.get(el) ?? s.height };
  });
  // Under the blocks, what a card folds by comes off the text's end. Not that of one above the view: the view went up with the text.
  const viewTop = viewEnd - scroller.clientHeight;
  const folds = unfolded.reduce((px, u, i) => (tops[i]! + spots[i]!.height > viewTop ? px + u.height - spots[i]!.height : px), 0);
  const end = beside
    ? Math.max(endOf(tops), Math.min(endOf(stack(unfolded), unfolded), viewEnd))
    : Math.min(column.previousElementSibling!.getBoundingClientRect().bottom - top + folds, viewEnd);
  column.style.setProperty("--sticky-end", `${end}px`);
  cards.forEach(({ el }, i) => {
    el.style.top = `${tops[i]}px`;
    if (held(el)) {
      holds.set(el, pin);
      return;
    }
    if (beside && !el.hasAttribute("data-child")) {
      offs.set(el, tops[i]! - spots[i]!.at);
    } else {
      offs.delete(el);
    }
  });

  const moved = offsetOf(line, scroller) - offset;
  // A write of the same value too can end a scroll that is under way.
  if (Math.abs(moved) >= 0.5) {
    scroller.scrollTop += moved;
  }
  mark(column, cards, beside, article);
  kept.current = cards.length > 0 ? keep(scroller, scrolledOn ? lineAt(scroller) : line) : null;
}

const cardsIn = (column: HTMLElement, article: HTMLElement) =>
  (Array.from(column.children) as HTMLElement[]).map((el) => ({ el, block: article.querySelector<HTMLElement>(`#b-${el.dataset.block}`) }));

/** What is not the text that a passage was selected from. */
const NOT_SELECTED = "button, textarea, .blk-label, .pop";

/** The passage in `within`'s text that starts in `from`'s, as the reader selected it. */
function passageIn(from: Element, within: Element, quote: string) {
  const want = quote.replace(/\s+/g, "").length;
  const nodes: Text[] = [];
  let own = 0;
  let after = 0;
  const walk = document.createTreeWalker(within, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n instanceof Element ? (n.matches(NOT_SELECTED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT),
  });
  walk.currentNode = from;
  for (let n = walk.nextNode() as Text | null; n && after < want; n = walk.nextNode() as Text | null) {
    if (from.contains(n)) {
      own++;
    } else {
      after += n.data.replace(/\s+/g, "").length;
    }
    nodes.push(n);
  }
  const boxes = nodes.map(boxOf);
  const found = findPassage(
    nodes.map((n) => n.data),
    own,
    quote,
    boxes.map((box, i) => i > 0 && box !== boxes[i - 1]),
  );
  if (!found) {
    return null;
  }
  const [[start, startAt], [end, endAt]] = found;
  const range = document.createRange();
  range.setStart(nodes[start]!, startAt);
  range.setEnd(nodes[end]!, endAt);
  return range;
}

/** The nearest element of `node`'s that is not laid out in a line with the text around it. */
function boxOf(node: Node) {
  let el = node.parentElement!;
  while (el.parentElement && getComputedStyle(el).display.startsWith("inline")) {
    el = el.parentElement;
  }
  return el;
}

/** The passages of each column's cards. Every Reader's are in the one highlight the page has. */
const marks = new Map<Element, Range[]>();
function paint() {
  CSS.highlights.set("sticky", new Highlight(...[...marks.values()].flat()));
}

/**
 * Marks each card's passage, in the text or in the answer it is of. Beside the text a line goes from the text's edge, at the
 * passage, to the card's: under its block the card is by it.
 */
function mark(column: HTMLElement, cards: { el: HTMLElement; block: HTMLElement | null }[], beside: boolean, article: HTMLElement) {
  const lines = column.nextElementSibling!;
  const origin = lines.getBoundingClientRect();
  const ranges: Range[] = [];
  const paths: string[] = [];
  const edge = article.getBoundingClientRect().right - origin.left;
  for (const { el, block } of cards) {
    const quote = el.querySelector(".sticky-quote")?.textContent ?? "";
    const message = el.dataset.child;
    // A child's is in its parent's answer only: folded, that has none.
    const answer = message ? column.querySelector(`.answer[data-message="${message}"]`) : null;
    const range = message ? answer && passageIn(answer, answer, quote) : block && passageIn(block, article, quote);
    if (range) {
      ranges.push(range);
    }
    if (!beside || !block || message) {
      continue;
    }
    // At its first line, as a card is at its block's first.
    const from = [...(range?.getClientRects() ?? [])].find((r) => r.width > 0) ?? block.getBoundingClientRect();
    const head = el.querySelector(".sticky-h")!.getBoundingClientRect();
    const y1 = from.top + Math.min(from.height, 24) / 2 - origin.top;
    const [x2, y2] = [el.getBoundingClientRect().left - origin.left, (head.top + head.bottom) / 2 - origin.top];
    const mid = (edge + x2) / 2;
    paths.push(`M${edge} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`);
  }
  marks.set(column, ranges);
  paint();
  lines.firstElementChild!.setAttribute("d", paths.join(""));
}

/**
 * The pinned card is at its block's height. Those before it that the reader has asked on since stay where they were then: the
 * pinned one gives way to them. With the pinned one gone they all stay. To hold a card where it is moves no other.
 */
function topsBeside(cards: { el: HTMLElement }[], spots: { at: number; height: number }[], isHeld: (el: HTMLElement) => boolean) {
  const pinned = cards.findIndex(({ el }) => el.hasAttribute("data-pinned"));
  const held = cards.flatMap(({ el }, i) => ((pinned < 0 || i < pinned) && isHeld(el) ? [i] : []));
  return stack(
    spots.map((s, i) => (held.includes(i) ? { ...s, at: s.at + offs.get(cards[i]!.el)! } : s)),
    ...held,
    pinned,
  );
}

/** Asks opened in a Reader: the same article may be open in another pane. */
export interface Opened {
  /** The last on the article's text, to keep at its block's height, its answer too. */
  pinned: number | null;
  /** Those on stickies since, in order. The last of all comes into view. */
  on: number[];
}

/** The article's stickies: a column beside its text, inside its scroller, or each under its block in a narrow pane. */
export function StickyColumn({
  article,
  blocks,
  opened: { pinned, on },
  onOpen,
  onSource,
  onNote,
  wordOf,
  onWord,
}: {
  article: number;
  blocks: Block[];
  opened: Opened;
  onOpen: (ask: number) => void;
  /** Shows a block that an answer cites. */
  onSource: (block: number) => void;
  /** Adds text to the article's memo; resolves to the error of saving it, or null. */
  onNote: (text: string) => Promise<string | null>;
  /** The word of a 用語 sticky to save, in its sentence; null where it has none. */
  wordOf: (sticky: Sticky) => VocabCapture | null;
  onWord: (word: VocabCapture) => Promise<VocabAdded>;
}) {
  const t = useT();
  const opened = on.at(-1) ?? pinned;
  const root = useRef<HTMLElement>(null);
  const kept = useRef<Kept | null>(null);
  /** The line before the last card opened, and with it. */
  const moved = useRef<{ from: Kept | null; to: Line | undefined }>(null);
  const { saved, asks, answers, folded, drafts, error } = useStickies(article);
  const cards = cardsOf(saved, asks, blocks);
  const followUps = new Map(asks.filter(isFollowUp).map((f) => [f.sticky, f]));
  /** The card that the ask, or the answer to it, is on. */
  const cardOf = (ask: number) =>
    cards.find((c) => ("ask" in c ? c.ask.key === ask : answers.get(ask) === c.sticky.id || followUps.get(c.sticky.id)?.key === ask));
  const pinnedCard = pinned == null ? undefined : cardOf(pinned)?.key;
  const held = new Set(on.map((ask) => cardOf(ask)?.root));
  // On each render, as any may add a card or move a block.
  useLayoutEffect(() => {
    const column = root.current!;
    place(column, kept);
    if (column.children.length === 0) {
      return;
    }
    const scroller = column.parentElement!;
    // Text that makes room in answer to its own size, or to a card's inside it, would be reported again in the same round
    // of the observers, which is an error: a card waits for the next frame, and the pane around them does not.
    const around = new ResizeObserver((sizes) =>
      place(
        column,
        kept,
        sizes.some((s) => s.target === scroller),
      ),
    );
    around.observe(scroller);
    around.observe(column.previousElementSibling!);
    let frame = 0;
    const own = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => place(column, kept));
    });
    for (const card of column.children) {
      own.observe(card);
    }
    // Text put in place of other text of the same size, as a sentence shown in translation and back, leaves a mark's range
    // empty and moves nothing that would place the cards again.
    const text = new MutationObserver(() => {
      const article = scroller.querySelector<HTMLElement>(".blocks")!;
      mark(column, cardsIn(column, article), column.hasAttribute("data-beside"), article);
    });
    text.observe(column.previousElementSibling!, { childList: true, characterData: true, subtree: true });
    return () => {
      around.disconnect();
      own.disconnect();
      text.disconnect();
      cancelAnimationFrame(frame);
    };
  });
  useLayoutEffect(() => {
    const column = root.current!;
    return () => {
      marks.delete(column);
      paint();
    };
  }, []);
  useLayoutEffect(() => {
    const scroller = root.current!.parentElement!;
    const read = () => {
      const k = kept.current;
      // In a pane of another width `place` is yet to come, to tell by the scrollTop.
      if (k?.width === widthOf(scroller)) {
        if (!lineOf(k, scroller)) {
          kept.current = keep(scroller);
        } else if (still(k, scroller)) {
          // Not with a line that has moved: a slow scroll, by parts of a pixel, would never add up to one.
          kept.current = { ...k, top: scroller.scrollTop };
        }
      }
    };
    scroller.addEventListener("scroll", read, { passive: true });
    return () => scroller.removeEventListener("scroll", read);
  }, []);
  useLayoutEffect(() => {
    const scroller = root.current!.parentElement!;
    const from = kept.current;
    const card = opened == null ? null : root.current!.querySelector("[data-opened]");
    // Focus by itself would scroll the card to the middle of the view.
    card?.querySelector("textarea")?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest" });
    if (from && scroller.scrollTop !== from.top) {
      kept.current = keep(scroller);
    }
    moved.current = { from, to: kept.current?.line };
  }, [opened]);
  /** Drops an ask. The view goes back from the one opened last, unless the reader has scrolled on. */
  const cancel = (ask: number) => {
    const scroller = root.current!.parentElement!;
    const { from, to } = moved.current ?? {};
    // The column keeps the same line through other widths, and another as the reader goes on.
    const goneOn = kept.current?.line !== to;
    flushSync(() => dropAsk(article, ask));
    if (ask === opened && from?.line.block.isConnected && !goneOn) {
      scroller.scrollTop += offsetOf(from.line, scroller) - from.offset;
    }
  };
  const fold = (sticky: Sticky, folds: boolean, card: HTMLElement) => {
    // From what the reader sees, as a scroll does: the line kept from before a card folded under the view's top would
    // take the view back into it. As with the folding, an ask closed unsent does not give the view back then.
    kept.current = keep(root.current!.parentElement!);
    // Held, as one asked on is: one that gave way to the pinned card would grow up and out of the view.
    // A child sits under its root, which is what the column places.
    const { pin } = root.current!.dataset;
    let rootCard = card;
    while (rootCard.hasAttribute("data-child")) {
      rootCard = rootCard.previousElementSibling as HTMLElement;
    }
    if (pin != null) {
      holds.set(rootCard, pin);
    }
    foldSticky(article, sticky, folds);
  };
  return (
    // In the DOM without cards too: the text gets back what the last one took by the same way, which keeps the reader's place.
    <>
      <aside className="stickies" ref={root} hidden={cards.length === 0 && !error} aria-label={t("stickies.title")} data-pin={pinned ?? undefined}>
        {error && (
          <p className="sticky error-text" role="alert">
            {t("stickies.loadFailed", { error: t.msg(error) })}
          </p>
        )}
        {cards.map((c) => {
          const spot: Spot = {
            "data-block": c.blockId ?? undefined,
            "data-child": c.parent ? (("sticky" in c ? c.sticky.parent : c.ask.parent) ?? undefined) : undefined,
            "data-pinned": c.key === pinnedCard || undefined,
            "data-held": held.has(c.key) || undefined,
            style: { left: INDENT * Math.min(c.depth, DEEPEST) },
          };
          return "sticky" in c ? (
            <SavedCard
              key={c.key}
              spot={spot}
              article={article}
              sticky={c.sticky}
              hasChildren={cards.some((child) => child.parent === c.key)}
              folded={folded.some((s) => isSame(s, c.sticky))}
              followUp={followUps.get(c.sticky.id)}
              draft={drafts.get(c.sticky.id)}
              word={wordOf(c.sticky)}
              opened={opened}
              blocks={blocks}
              onOpen={onOpen}
              onCancel={cancel}
              onFold={fold}
              onSource={onSource}
              onNote={onNote}
              onWord={onWord}
            />
          ) : (
            <AskCard key={c.key} spot={spot} article={article} ask={c.ask} opened={c.ask.key === opened} onCancel={cancel} />
          );
        })}
      </aside>
      <svg className="sticky-lines" aria-hidden="true">
        <path />
      </svg>
    </>
  );
}

/** Where a card is to be, for `place`. */
interface Spot {
  "data-block": number | undefined;
  /** The message whose answer its passage is of. */
  "data-child": number | undefined;
  "data-pinned": true | undefined;
  "data-held": true | undefined;
  style: { left: number };
}

/** The keyboard goes back to the article from a card that loses what had it, or goes. */
const leave = (from: HTMLElement | null) => from?.closest<HTMLElement>(".doc-scroll")?.focus({ preventScroll: true });

function useLabel({ kind, parent }: { kind: Sticky["kind"]; parent: number | null }) {
  const t = useT();
  const label = t(`stickies.${kind}`);
  return parent == null ? label : t("stickies.ofAnswer", { kind: label });
}

function Quote({ text }: { text: string }) {
  return (
    <blockquote className="sticky-quote" title={text}>
      {text}
    </blockquote>
  );
}

// The answer is model output over an untrusted page: rendered as text nodes only, never as HTML.
function Answer({ m, blocks, onSource }: { m: StickyMessage; blocks: Block[]; onSource: (block: number) => void }) {
  const t = useT();
  // By its text too: the id of a block that is gone can be another block's by now.
  const byN = new Map(m.citations.filter((c) => blocks.some((b) => b.id === c.block_id && b.text === c.text)).map((c) => [c.n, c]));
  return (
    <div className="answer" data-message={m.id}>
      <p>
        {splitCitations(m.answer, new Set(byN.keys())).map((p, i) => {
          if (typeof p === "string") {
            return p;
          }
          const c = byN.get(p.n)!;
          return (
            <button
              key={i}
              className="cite"
              onClick={() => onSource(c.block_id)}
              title={c.text.slice(0, 200)}
              aria-label={t("chatPane.cite", { n: c.n, where: c.heading ?? c.title })}
            >
              {c.n}
            </button>
          );
        })}
      </p>
    </div>
  );
}

function SavedCard({
  spot,
  article,
  sticky,
  hasChildren,
  folded,
  followUp,
  draft,
  word,
  opened,
  blocks,
  onOpen,
  onCancel,
  onFold,
  onSource,
  onNote,
  onWord,
}: {
  spot: Spot;
  article: number;
  sticky: Sticky;
  hasChildren: boolean;
  /** To its quote's first line, beside its label. */
  folded: boolean;
  followUp: FollowUp | undefined;
  draft: Draft | undefined;
  word: VocabCapture | null;
  opened: number | null;
  blocks: Block[];
  onOpen: (ask: number) => void;
  onCancel: (ask: number) => void;
  onFold: (sticky: Sticky, folds: boolean, card: HTMLElement) => void;
  onSource: (block: number) => void;
  onNote: (text: string) => Promise<string | null>;
  onWord: (word: VocabCapture) => Promise<VocabAdded>;
}) {
  const t = useT();
  const [deleting, setDeleting] = useState(false);
  const [said, setSaid] = useState<{ status: string } | { error: string } | null>(null);
  const remove = useRef<HTMLButtonElement>(null);
  const label = useLabel(sticky);
  // At once: the dialog holds the focus while it is there, and leaves it nowhere.
  const close = () => flushSync(() => setDeleting(false));
  const addToNote = async (text: string) => {
    // The text is in the memo whether or not it is saved: the memo saves it again as it opens.
    dropDraft(article, sticky.id);
    const failed = await onNote(text);
    setSaid(failed ? { error: failed } : { status: t("stickies.addedToNote") });
  };
  const saveWord = (word: VocabCapture) =>
    onWord(word).then(
      (r) => setSaid({ status: t(r.new ? "vocab.saved" : "vocab.added", { word: word.surface }) }),
      (e: unknown) => setSaid({ error: String(e) }),
    );
  return (
    <section className="sticky" aria-label={label} data-folded={folded || undefined} {...spot}>
      <div className="sticky-h">
        <span className="sticky-kind">{label}</span>
        {folded && <Quote text={sticky.quote} />}
        <button
          className="ib fold"
          onClick={(e) => onFold(sticky, !folded, e.currentTarget.closest<HTMLElement>(".sticky")!)}
          aria-expanded={!folded}
          aria-label={t(folded ? "stickies.unfold" : "stickies.fold")}
          title={t(folded ? "stickies.unfold" : "stickies.fold")}
        >
          <Icon name={folded ? "down" : "up"} size="sm" />
        </button>
        <button className="ib" ref={remove} onClick={() => setDeleting(true)} aria-label={t("stickies.delete")} title={t("stickies.delete")}>
          <Icon name="x" size="sm" />
        </button>
      </div>
      {!folded && (
        <>
          <Quote text={sticky.quote} />
          {sticky.messages.map((m) => (
            <div key={m.id}>
              {m.question && <p className="sticky-q">{m.question}</p>}
              <Answer m={m} blocks={blocks} onSource={onSource} />
            </div>
          ))}
          {followUp ? (
            <div className="sticky-ask" data-opened={followUp.key === opened || undefined}>
              <AskBody article={article} ask={followUp} onCancel={onCancel} />
            </div>
          ) : draft ? (
            <DraftBody article={article} sticky={sticky.id} draft={draft} onAdd={(text) => void addToNote(text)} />
          ) : (
            <div className="sticky-acts">
              {word && (
                <button className="btn sm" onClick={() => void saveWord(word)}>
                  {t("vocab.save")}
                </button>
              )}
              <button
                className="btn sm"
                onClick={() => {
                  setSaid(null);
                  void draftNote(article, sticky.id);
                }}
              >
                {t("stickies.draftNote")}
              </button>
              <button className="btn sm" onClick={() => onOpen(openAsk(article, { sticky: sticky.id }))}>
                {t("stickies.followUp")}
              </button>
            </div>
          )}
        </>
      )}
      {said && "status" in said && (
        <p className="sticky-status" role="status">
          {said.status}
        </p>
      )}
      {said && "error" in said && (
        <p className="error-text" role="alert">
          {t.msg(said.error)}
        </p>
      )}
      {deleting && (
        <ConfirmDialog
          title={t("stickies.confirmDelete")}
          confirm={t("common.delete")}
          onConfirm={() => {
            close();
            leave(remove.current);
            deleteSticky(sticky.article_id, sticky.id).catch((e: unknown) => setSaid({ error: String(e) }));
          }}
          onCancel={() => {
            close();
            remove.current?.focus();
          }}
        >
          <p>{t("stickies.deleteDesc")}</p>
          {hasChildren && <p>{t("stickies.deleteKeeps")}</p>}
        </ConfirmDialog>
      )}
    </section>
  );
}

/** メモに下書き: the wait, the draft to change and add to the memo, or what went wrong. */
function DraftBody({ article, sticky, draft, onAdd }: { article: number; sticky: number; draft: Draft; onAdd: (text: string) => void }) {
  const t = useT();
  if (draft.step === "pending") {
    return (
      <p className="pending" role="status">
        <span className="dot" />
        {t("stickies.drafting")}
      </p>
    );
  }
  const cancel = (from: HTMLElement) => {
    leave(from);
    dropDraft(article, sticky);
  };
  return (
    <div className="sticky-ask">
      {draft.step === "failed" ? (
        <p className="error-text" role="alert">
          {t.msg(draft.error)}
        </p>
      ) : (
        <textarea
          rows={5}
          value={draft.text}
          aria-label={t("stickies.draftLabel")}
          onChange={(e) => changeDraft(article, sticky, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              cancel(e.currentTarget);
            }
          }}
        />
      )}
      <div className="sticky-acts">
        <button className="btn sm" onClick={(e) => cancel(e.currentTarget)}>
          {t("common.cancel")}
        </button>
        {draft.step === "failed" ? (
          <button className="btn sm pri" onClick={() => void draftNote(article, sticky)}>
            {t("common.retry")}
          </button>
        ) : (
          <button
            className="btn sm pri"
            disabled={!draft.text.trim()}
            onClick={(e) => {
              leave(e.currentTarget);
              onAdd(draft.text.trim());
            }}
          >
            {t("stickies.addToNote")}
          </button>
        )}
      </div>
    </div>
  );
}

interface AskProps<A extends Ask> {
  article: number;
  ask: A;
  onCancel: (ask: number) => void;
}

/** A card without an answer. */
function AskCard({ spot, opened, ...props }: AskProps<PassageAsk> & { spot: Spot; opened: boolean }) {
  const { ask } = props;
  const label = useLabel(ask);
  return (
    <section className="sticky" aria-label={label} data-opened={opened || undefined} {...spot}>
      <div className="sticky-h">
        <span className="sticky-kind">{label}</span>
      </div>
      <Quote text={ask.quote} />
      <AskBody {...props} />
    </section>
  );
}

/** The question being written, the wait, or what went wrong. */
function AskBody({ article, ask, onCancel }: AskProps<Ask>) {
  const t = useT();
  const sendKey = useSendKey();
  const failed = ask.step === "failed";
  const pending = ask.step === "pending";
  const typed = isFollowUp(ask) || ask.kind === "question";
  const blank = typed && !ask.question.trim();
  const send = (from: HTMLElement) => {
    if (!blank) {
      leave(from);
      void sendAsk(article, ask);
    }
  };
  const cancel = (from: HTMLElement) => {
    leave(from);
    onCancel(ask.key);
  };
  return (
    <>
      {typed && (
        // Here while it waits too: a card that got shorter would take a view at the article's end up with it.
        <textarea
          rows={3}
          value={ask.question}
          disabled={pending}
          aria-label={t(isFollowUp(ask) ? "stickies.followUpLabel" : "stickies.questionLabel")}
          placeholder={t(isFollowUp(ask) ? "stickies.followUpPlaceholder" : "stickies.placeholder")}
          onChange={(e) => changeAsk(article, ask.key, { question: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              cancel(e.currentTarget);
            } else if (sendsOn(sendKey, ask.question, e.nativeEvent)) {
              e.preventDefault();
              send(e.currentTarget);
            }
          }}
        />
      )}
      {pending ? (
        <p className="pending" role="status">
          <span className="dot" />
          {t("chatPane.answering")}
        </p>
      ) : (
        <>
          {failed && (
            <p className="error-text" role="alert">
              {t.msg(ask.error)}
            </p>
          )}
          <div className="sticky-acts">
            <button className="btn sm" onClick={(e) => cancel(e.currentTarget)}>
              {t("common.cancel")}
            </button>
            <button className="btn sm pri" disabled={blank} onClick={(e) => send(e.currentTarget)}>
              {failed ? t("common.retry") : t("chatPane.send")}
            </button>
          </div>
        </>
      )}
    </>
  );
}
