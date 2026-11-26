import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type Sticky, type StickyKind } from "../api";
import { asksLeft, goneOf, isFollowUp, isSame, type Ask, type Passage, type Step } from "./stickies";

interface Stickies {
  saved: Sticky[];
  asks: Ask[];
  /** The stickies that have the answers to asks of this window, by the ask's key. */
  answers: ReadonlyMap<number, number>;
  /** Those folded in this window, by `isSame`. */
  folded: Sticky[];
  /** The key of the last ask opened on the article's text, which folds the stickies there before it. */
  latest: number;
  /**
   * For each ask opened on the text, in order, the folded ones it found and those it folded. Closed unsent, it gives them back,
   * unless one has been folded or unfolded since, or to the one opened after it. A sent one's stays, as what it folded does.
   */
  undo: Undo[];
  /** The memo drafts, by sticky id. */
  drafts: ReadonlyMap<number, Draft>;
  /** Why the saved ones could not be read. */
  error: string | null;
}

/** メモに下書き: the model writing it, what went wrong, or its text as the reader has it. */
export type Draft = { step: "pending" } | { step: "failed"; error: string } | { step: "ready"; text: string };

interface Undo {
  ask: number;
  latest: number;
  folded: Sticky[];
  made: Sticky[];
}

const NONE: Stickies = { saved: [], asks: [], answers: new Map(), folded: [], latest: 0, undo: [], drafts: new Map(), error: null };
// The Reader unmounts when another article, tab or screen is shown: what was asked outlives it here, by article id, and an
// answer that comes meanwhile is put here too.
const articles = new Map<number, Stickies>();
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};

const of = (article: number) => articles.get(article) ?? NONE;
function put(article: number, change: Partial<Stickies>) {
  const was = of(article);
  const now = { ...was, ...change };
  const gone = goneOf(was.saved, now.saved);
  articles.set(article, {
    ...now,
    asks: asksLeft(now.asks, gone),
    answers: new Map([...now.answers].filter(([, id]) => !gone.some((s) => s.id === id))),
    drafts: new Map([...now.drafts].filter(([id]) => !gone.some((s) => s.id === id))),
  });
  listeners.forEach((f) => f());
}

/** Grows with each read per article: an older one that lands last must not replace a newer one. */
const reads = new Map<number, number>();
async function load(article: number) {
  const seq = (reads.get(article) ?? 0) + 1;
  reads.set(article, seq);
  const read = await api.listStickies(article).then(
    (saved): Partial<Stickies> => ({ saved, error: null }),
    (e: unknown) => ({ error: String(e) }),
  );
  if (reads.get(article) === seq) {
    put(article, read);
  }
}

/** The article's stickies, read again when this or another window asks or deletes one. */
export function useStickies(article: number): Stickies {
  useEffect(() => {
    void load(article);
    const sub = listen<number>("stickies-changed", (e) => {
      if (e.payload === article) {
        void load(article);
      }
    });
    return () => void sub.then((f) => f());
  }, [article]);
  return useSyncExternalStore(subscribe, () => of(article));
}

export const changeAsk = (article: number, key: number, change: { question: string } | Step) =>
  put(article, { asks: of(article).asks.map((a) => (a.key === key ? { ...a, ...change } : a)) });

export function dropAsk(article: number, key: number) {
  const { asks, folded, undo } = of(article);
  const i = undo.findIndex((u) => u.ask === key);
  const [was, rest] = [undo[i], undo.toSpliced(i, 1)];
  const next = rest[i];
  // Unless the reader has folded or unfolded one, it is as if it had not been opened: one opened since then found them as
  // this one did. Else its folding stays, and so it does for an answer that waited as it opened.
  const back = !was
    ? {}
    : next
      ? { undo: next.folded === was.made ? rest.with(i, { ...next, latest: was.latest, folded: was.folded }) : rest }
      : folded === was.made
        ? { latest: was.latest, undo: rest, folded: was.folded }
        : { undo: rest };
  put(article, { asks: asks.filter((a) => a.key !== key), ...back });
}

function answerTo(article: number, ask: Ask) {
  const { question } = ask;
  if (isFollowUp(ask)) {
    return api.stickyFollowUp({ id: ask.sticky, question });
  }
  const { blockId, parent, kind, quote } = ask;
  return api.stickyAsk({ articleId: article, blockId, parent, kind, quote, question });
}

/** Sends it; the answer takes its place. One that failed can be sent again. */
export async function sendAsk(article: number, ask: Ask) {
  const { key } = ask;
  const { latest } = of(article);
  changeAsk(article, key, { step: "pending" });
  try {
    const sticky = await answerTo(article, ask);
    const { saved, asks, answers, folded, undo } = of(article);
    // One that a list read since it was stored has is as new, or has another window's follow-up already: a sticky only gets
    // more messages.
    const newest = saved.find((s) => isSame(s, sticky) && s.messages.length >= sticky.messages.length) ?? sticky;
    // Had it been here as others were opened on the text, it would have folded then, and unfolds once those still open have
    // closed unsent. A folding the same before is the same after, for the checks of `dropAsk`.
    const late = !isFollowUp(ask) && of(article).latest > latest;
    const added = new Map<Sticky[], Sticky[]>();
    const fold = (some: Sticky[]) => added.get(some) ?? added.set(some, [...some, newest]).get(some)!;
    const since = undo.findIndex((u) => u.ask > latest);
    put(article, {
      saved: [...saved.filter((s) => s.id !== sticky.id), newest].toSorted((a, b) => a.id - b.id),
      asks: asks.filter((a) => a.key !== key),
      answers: new Map(answers).set(key, sticky.id),
      ...(late && {
        folded: fold(folded),
        undo: undo.map((u, j) => (since < 0 || j < since ? u : { ...u, made: fold(u.made), folded: j > since ? fold(u.folded) : u.folded })),
      }),
    });
  } catch (e) {
    changeAsk(article, key, { step: "failed", error: String(e) });
  }
}

let keys = 0;
/** Asks about a passage at once, or opens a card, or in a sticky, to write the question. Returns the ask's key. */
export function openAsk(article: number, about: (Passage & { kind: StickyKind }) | { sticky: number }): number {
  const ask: Ask = { ...about, key: ++keys, question: "", step: "writing" };
  const { asks, saved, folded, latest, undo } = of(article);
  // The stickies there make room for it at its block's height.
  const room = !isFollowUp(ask) && ask.parent == null ? { folded: saved, latest: ask.key, undo: [...undo, { ask: ask.key, latest, folded, made: saved }] } : {};
  put(article, { asks: [...asks, ask], ...room });
  if (!isFollowUp(ask) && ask.kind !== "question") {
    void sendAsk(article, ask);
  }
  return ask.key;
}

function putDraft(article: number, sticky: number, draft: Draft | null) {
  const drafts = new Map(of(article).drafts);
  if (draft) {
    drafts.set(sticky, draft);
  } else {
    drafts.delete(sticky);
  }
  put(article, { drafts });
}

/** Has the model write a memo draft of the sticky, or write it again after it failed. */
export async function draftNote(article: number, sticky: number) {
  const pending: Draft = { step: "pending" };
  putDraft(article, sticky, pending);
  const draft = await api.stickyNoteDraft(sticky).then(
    (text): Draft => ({ step: "ready", text }),
    (e: unknown): Draft => ({ step: "failed", error: String(e) }),
  );
  // Not on a sticky deleted meanwhile, nor on a new one that SQLite gave its id again.
  if (of(article).drafts.get(sticky) === pending) {
    putDraft(article, sticky, draft);
  }
}

export const changeDraft = (article: number, sticky: number, text: string) => putDraft(article, sticky, { step: "ready", text });
export const dropDraft = (article: number, sticky: number) => putDraft(article, sticky, null);

export function foldSticky(article: number, sticky: Sticky, fold: boolean) {
  const others = of(article).folded.filter((s) => !isSame(s, sticky));
  put(article, { folded: fold ? [...others, sticky] : others });
}

export async function deleteSticky(article: number, id: number) {
  await api.deleteSticky(id);
  put(article, { saved: of(article).saved.filter((s) => s.id !== id) });
}
