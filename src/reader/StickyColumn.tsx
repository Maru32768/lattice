import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { Block, Sticky, StickyMessage } from "../api";
import { splitCitations } from "../chat/chat";
import { sendsOn, useSendKey } from "../chat/sendKey";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";
import { useT } from "../i18n";
import { GAP, ROOM, cardsOf, roomOf, stack, type Ask } from "./stickies";
import { deleteSticky, dropAsk, replaceAsk, sendAsk, useStickies } from "./useStickies";
import "./stickies.css";

/** A pane narrower than this has no room for a column beside the text. */
const COLUMN_FROM = 720;
/** Under the last card of a column that goes on below the article. */
const END = 40;

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
  const share = block !== article && block !== reader && r.height ? Math.min(1, (top - r.top) / r.height) : 0;
  return { block, share, past: top - r.top - share * r.height, room: roomOf(block) };
}

/** Where the line is in the pane. */
function offsetOf({ block, share, past, room }: Line, scroller: HTMLElement) {
  const r = block.getBoundingClientRect();
  const now = roomOf(block);
  // Among the cards a card stays, if it can. Else, and past them, it is the text below.
  const down = past <= Math.min(room, now) ? past : Math.max(0, past + now - room);
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

/** The line from before, unless the reader has gone on. Read again, it would go on by what each scroll is rounded by. */
function lineOf(k: Kept | null, scroller: HTMLElement): Line | undefined {
  if (!k?.line.block.isConnected) {
    return undefined;
  }
  const { scrollTop, clientHeight, scrollHeight } = scroller;
  const resized = k.width !== widthOf(scroller);
  if (!resized && Math.abs(offsetOf(k.line, scroller) - k.offset) < 1) {
    return k.line;
  }
  // The text has moved and the reader has not: the browser held none, as in a pane of another width (stickies.css) or where
  // no text is in view. At the end of text that got shorter the view comes up with it.
  const rested = Math.abs(scrollTop - k.top) < 1 || (scrollTop < k.top && scrollTop + clientHeight > scrollHeight - 1);
  const whole = Math.abs(k.line.block.getBoundingClientRect().height - k.height) < 1;
  return rested && (resized || whole) ? k.line : undefined;
}

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
  const cards = (Array.from(column.children) as HTMLElement[]).map((el) => ({ el, block: article.querySelector<HTMLElement>(`#b-${el.dataset.block}`) }));
  const beside = cards.length > 0 && scroller.clientWidth >= COLUMN_FROM;

  // The browser's scroll anchoring lets go of text whose own styles change, as they do here.
  const was = kept.current;
  const before = lineOf(was, scroller);
  const line = before ?? lineAt(scroller);
  const offset = was && before && was.width === widthOf(scroller) ? was.offset : 0;

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
    at: (beside ? (block?.getBoundingClientRect().top ?? top) : under(block)) - top,
    height: el.offsetHeight,
  }));
  const endOf = (tops: number[]) => Math.max(0, ...tops.map((at, i) => at + spots[i]!.height)) + END;
  const tops = stack(spots, beside ? cards.findIndex(({ el }) => el.hasAttribute("data-opened")) : -1);
  // Cards that give way to the opened one do not take a view at the column's end up with them.
  const viewEnd = scroller.getBoundingClientRect().top + scroller.clientHeight - top;
  column.style.setProperty("--sticky-end", `${Math.max(endOf(tops), Math.min(endOf(stack(spots)), viewEnd))}px`);
  cards.forEach(({ el }, i) => (el.style.top = `${tops[i]}px`));

  const moved = offsetOf(line, scroller) - offset;
  // A write of the same value too can end a scroll that is under way.
  if (Math.abs(moved) >= 0.5) {
    scroller.scrollTop += moved;
  }
  kept.current = cards.length > 0 ? keep(scroller, line) : null;
}

/** The article's stickies: a column beside its text, inside its scroller, or each under its block in a narrow pane. */
export function StickyColumn({
  article,
  blocks,
  opened,
  onSource,
}: {
  article: number;
  blocks: Block[];
  /** The ask this Reader opened last, to bring into view and to keep at its block's height, its answer too: the same article may be open in another pane. */
  opened: number | null;
  /** Shows a block that an answer cites. */
  onSource: (block: number) => void;
}) {
  const t = useT();
  const root = useRef<HTMLElement>(null);
  const kept = useRef<Kept | null>(null);
  /** The scrollTop before the last card opened, and with it. */
  const moved = useRef({ from: 0, to: 0 });
  const { saved, asks, answers, error } = useStickies(article);
  const cards = cardsOf(saved, asks, blocks);
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
    return () => {
      around.disconnect();
      own.disconnect();
      cancelAnimationFrame(frame);
    };
  });
  useLayoutEffect(() => {
    const scroller = root.current!.parentElement!;
    const read = () => {
      const k = kept.current;
      // In a pane of another width `place` is yet to come, to tell by the scrollTop.
      if (k?.width === widthOf(scroller)) {
        kept.current = lineOf(k, scroller) ? { ...k, top: scroller.scrollTop } : keep(scroller);
      }
    };
    scroller.addEventListener("scroll", read, { passive: true });
    return () => scroller.removeEventListener("scroll", read);
  }, []);
  useLayoutEffect(() => {
    const scroller = root.current!.parentElement!;
    const from = scroller.scrollTop;
    const card = opened == null ? null : root.current!.querySelector("[data-opened]");
    // Focus by itself would scroll the card to the middle of the view.
    card?.querySelector("textarea")?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest" });
    moved.current = { from, to: scroller.scrollTop };
  }, [opened]);
  /** The view goes back from the card opened last, unless the reader has scrolled on. */
  const goBack = () => {
    const scroller = root.current!.parentElement!;
    if (scroller.scrollTop === moved.current.to) {
      scroller.scrollTop = moved.current.from;
    }
  };
  return (
    // In the DOM without cards too: the text gets back what the last one took by the same way, which keeps the reader's place.
    <aside className="stickies" ref={root} hidden={cards.length === 0 && !error} aria-label={t("stickies.title")}>
      {error && (
        <p className="sticky error-text" role="alert">
          {t("stickies.loadFailed", { error: t.msg(error) })}
        </p>
      )}
      {cards.map((c) =>
        "sticky" in c ? (
          <SavedCard key={c.key} sticky={c.sticky} opened={opened != null && answers.get(opened) === c.sticky.id} blocks={blocks} onSource={onSource} />
        ) : (
          <AskCard key={c.key} article={article} ask={c.ask} opened={c.ask.key === opened} onCancel={goBack} />
        ),
      )}
    </aside>
  );
}

/** The keyboard goes back to the article from a card that loses what had it, or goes. */
const leave = (from: HTMLElement | null) => from?.closest<HTMLElement>(".doc-scroll")?.focus({ preventScroll: true });

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
    <div className="answer">
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

function SavedCard({ sticky, opened, blocks, onSource }: { sticky: Sticky; opened: boolean; blocks: Block[]; onSource: (block: number) => void }) {
  const t = useT();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = useRef<HTMLButtonElement>(null);
  const label = t(`stickies.${sticky.kind}`);
  // At once: the dialog holds the focus while it is there, and leaves it nowhere.
  const close = () => flushSync(() => setDeleting(false));
  return (
    <section className="sticky" aria-label={label} data-block={sticky.block_id ?? undefined} data-opened={opened || undefined}>
      <div className="sticky-h">
        <span className="sticky-kind">{label}</span>
        <button className="ib" ref={remove} onClick={() => setDeleting(true)} aria-label={t("stickies.delete")} title={t("stickies.delete")}>
          <Icon name="x" size="sm" />
        </button>
      </div>
      <Quote text={sticky.quote} />
      {sticky.messages.map((m) => (
        <div key={m.id}>
          {m.question && <p className="sticky-q">{m.question}</p>}
          <Answer m={m} blocks={blocks} onSource={onSource} />
        </div>
      ))}
      {error && (
        <p className="error-text" role="alert">
          {t.msg(error)}
        </p>
      )}
      {deleting && (
        <ConfirmDialog
          title={t("stickies.confirmDelete")}
          confirm={t("common.delete")}
          onConfirm={() => {
            close();
            leave(remove.current);
            deleteSticky(sticky.article_id, sticky.id).catch((e: unknown) => setError(String(e)));
          }}
          onCancel={() => {
            close();
            remove.current?.focus();
          }}
        >
          <p>{t("stickies.deleteDesc")}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** A card without an answer: the question being written, the wait, or what went wrong. */
function AskCard({ article, ask, opened, onCancel }: { article: number; ask: Ask; opened: boolean; onCancel: () => void }) {
  const t = useT();
  const sendKey = useSendKey();
  const label = t(`stickies.${ask.kind}`);
  const failed = ask.step === "failed";
  const writing = ask.kind === "question" && ask.step !== "pending";
  const blank = ask.kind === "question" && !ask.question.trim();
  const send = (from: HTMLElement) => {
    if (!blank) {
      leave(from);
      void sendAsk(article, ask);
    }
  };
  const cancel = (from: HTMLElement) => {
    leave(from);
    if (opened) {
      onCancel();
    }
    dropAsk(article, ask.key);
  };
  return (
    <section className="sticky" aria-label={label} data-block={ask.blockId} data-opened={opened || undefined}>
      <div className="sticky-h">
        <span className="sticky-kind">{label}</span>
      </div>
      <Quote text={ask.quote} />
      {writing ? (
        <textarea
          rows={3}
          value={ask.question}
          aria-label={t("stickies.questionLabel")}
          placeholder={t("stickies.placeholder")}
          onChange={(e) => replaceAsk(article, { ...ask, question: e.target.value })}
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
      ) : (
        ask.question && <p className="sticky-q">{ask.question}</p>
      )}
      {ask.step === "pending" ? (
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
    </section>
  );
}
