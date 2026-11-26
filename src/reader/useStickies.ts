import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type Sticky, type StickyKind } from "../api";
import { asksLeft, goneOf, isFollowUp, isSame, type Ask, type Passage, type Step } from "./stickies";

interface Stickies {
  saved: Sticky[];
  asks: Ask[];
  /** The stickies that have the answers to asks of this window, by the ask's key. */
  answers: ReadonlyMap<number, number>;
  /** Why the saved ones could not be read. */
  error: string | null;
}

const NONE: Stickies = { saved: [], asks: [], answers: new Map(), error: null };
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
  put(article, { asks: of(article).asks.filter((a) => a.key !== key) });
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
  changeAsk(article, key, { step: "pending" });
  try {
    const sticky = await answerTo(article, ask);
    const { saved, asks, answers } = of(article);
    // One that a list read since it was stored has is as new, or has another window's follow-up already: a sticky only gets
    // more messages.
    const newest = saved.find((s) => isSame(s, sticky) && s.messages.length >= sticky.messages.length) ?? sticky;
    put(article, {
      saved: [...saved.filter((s) => s.id !== sticky.id), newest].toSorted((a, b) => a.id - b.id),
      asks: asks.filter((a) => a.key !== key),
      answers: new Map(answers).set(key, sticky.id),
    });
  } catch (e) {
    changeAsk(article, key, { step: "failed", error: String(e) });
  }
}

let keys = 0;
/** Asks about a passage at once, or opens a card, or in a sticky, to write the question. Returns the ask's key. */
export function openAsk(article: number, about: (Passage & { kind: StickyKind }) | { sticky: number }): number {
  const ask: Ask = { ...about, key: ++keys, question: "", step: "writing" };
  put(article, { asks: [...of(article).asks, ask] });
  if (!isFollowUp(ask) && ask.kind !== "question") {
    void sendAsk(article, ask);
  }
  return ask.key;
}

export async function deleteSticky(article: number, id: number) {
  await api.deleteSticky(id);
  put(article, { saved: of(article).saved.filter((s) => s.id !== id) });
}
