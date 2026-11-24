import { useLayoutEffect, useRef, useState } from "react";
import type { Block, Sticky, StickyKind, StickyMessage } from "../api";
import { splitCitations } from "../chat/chat";
import { sendsOn, useSendKey } from "../chat/sendKey";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";
import { useT, type PlainKey } from "../i18n";
import { cardsOf, stack, type Ask } from "./stickies";
import { deleteSticky, dropAsk, sendAsk, setQuestion } from "./useStickies";
import "./stickies.css";

export const STICKY_LABELS = {
  question: "stickies.question",
  detail: "stickies.detail",
  term: "stickies.term",
} as const satisfies Record<StickyKind, PlainKey>;

/** A pane narrower than this has no room for a column beside the text. */
const COLUMN_FROM = 560;

/** Puts the cards beside their blocks, or leaves them one after another below the article where there is no room. */
function place(column: HTMLElement) {
  const scroller = column.parentElement!;
  // Hidden (under a zoomed pane): nothing to measure, and coming back is a resize.
  if (scroller.clientWidth === 0) {
    return;
  }
  const beside = scroller.clientWidth >= COLUMN_FROM;
  column.toggleAttribute("data-beside", beside);
  const cards = Array.from(column.children) as HTMLElement[];
  const top = column.getBoundingClientRect().top;
  const tops = stack(
    cards.map((c) => ({
      at: (scroller.querySelector(`#b-${c.dataset.block}`)?.getBoundingClientRect().top ?? top) - top,
      height: c.offsetHeight,
    })),
  );
  cards.forEach((c, i) => (c.style.top = beside ? `${tops[i]}px` : ""));
}

/** The article's stickies: a column beside its text, inside its scroller, or below it in a narrow pane. */
export function StickyColumn({
  article,
  blocks,
  saved,
  asks,
  error,
  opened,
  onSource,
}: {
  article: number;
  blocks: Block[];
  saved: Sticky[];
  asks: Ask[];
  error: string | null;
  /** The ask this Reader opened last, to bring into view: the same article may be open in another pane. */
  opened: number | null;
  /** Shows a block that an answer cites. */
  onSource: (block: number) => void;
}) {
  const t = useT();
  const root = useRef<HTMLElement>(null);
  const cards = cardsOf(saved, asks, blocks);
  // On each render, as any may add a card or move a block.
  useLayoutEffect(() => {
    const column = root.current;
    if (!column) {
      return;
    }
    place(column);
    const sizes = new ResizeObserver(() => place(column));
    for (const el of [column.parentElement!, column.previousElementSibling!, ...column.children]) {
      sizes.observe(el);
    }
    return () => sizes.disconnect();
  });
  useLayoutEffect(() => {
    const card = opened == null ? null : root.current?.querySelector(`[data-ask="${opened}"]`);
    // Focus by itself would scroll the card to the middle of the view.
    card?.querySelector("textarea")?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest" });
  }, [opened]);
  if (cards.length === 0 && !error) {
    return null;
  }
  return (
    <aside className="stickies" ref={root} aria-label={t("stickies.title")}>
      {error && (
        <p className="sticky error-text" role="alert">
          {t("stickies.loadFailed", { error: t.msg(error) })}
        </p>
      )}
      {cards.map((c) =>
        "sticky" in c ? <SavedCard key={c.key} sticky={c.sticky} blocks={blocks} onSource={onSource} /> : <AskCard key={c.key} article={article} ask={c.ask} />,
      )}
    </aside>
  );
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

function SavedCard({ sticky, blocks, onSource }: { sticky: Sticky; blocks: Block[]; onSource: (block: number) => void }) {
  const t = useT();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = t(STICKY_LABELS[sticky.kind]);
  return (
    <section className="sticky" aria-label={label} data-block={sticky.block_id ?? undefined}>
      <div className="sticky-h">
        <span className="sticky-kind">{label}</span>
        <button className="ib" onClick={() => setDeleting(true)} aria-label={t("stickies.delete")} title={t("stickies.delete")}>
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
            setDeleting(false);
            deleteSticky(sticky.article_id, sticky.id).catch((e: unknown) => setError(String(e)));
          }}
          onCancel={() => setDeleting(false)}
        >
          <p>{t("stickies.deleteDesc")}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** A card without an answer: the question being written, the wait, or what went wrong. */
function AskCard({ article, ask }: { article: number; ask: Ask }) {
  const t = useT();
  const sendKey = useSendKey();
  const label = t(STICKY_LABELS[ask.kind]);
  const failed = ask.step === "failed";
  const writing = ask.kind === "question" && ask.step !== "pending";
  const blank = ask.kind === "question" && !ask.question.trim();
  // A card that loses its field, or goes, gives the keyboard back to the article.
  const leave = (from: HTMLElement) => from.closest<HTMLElement>(".doc-scroll")?.focus({ preventScroll: true });
  const send = (from: HTMLElement) => {
    if (!blank) {
      leave(from);
      void sendAsk(article, ask);
    }
  };
  const cancel = (from: HTMLElement) => {
    leave(from);
    dropAsk(article, ask.key);
  };
  return (
    <section className="sticky" aria-label={label} data-block={ask.blockId ?? undefined} data-ask={ask.key}>
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
          onChange={(e) => setQuestion(article, ask, e.target.value)}
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
