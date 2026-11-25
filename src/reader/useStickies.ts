import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type Sticky } from "../api";
import type { Ask } from "./stickies";

interface Stickies {
  saved: Sticky[];
  asks: Ask[];
  /** The stickies that asks of this window became, by the ask's key. */
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
  articles.set(article, { ...of(article), ...change });
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

export const replaceAsk = (article: number, ask: Ask) => put(article, { asks: of(article).asks.map((a) => (a.key === ask.key ? ask : a)) });

export function dropAsk(article: number, key: number) {
  put(article, { asks: of(article).asks.filter((a) => a.key !== key) });
}

/** Sends it; the answer takes its place. One that failed can be sent again. */
export async function sendAsk(article: number, ask: Ask) {
  const { key, blockId, kind, quote, question } = ask;
  replaceAsk(article, { ...ask, step: "pending" });
  try {
    const sticky = await api.stickyAsk({ articleId: article, blockId, parent: null, kind, quote, question });
    const { saved, asks, answers } = of(article);
    put(article, {
      saved: [...saved.filter((s) => s.id !== sticky.id), sticky],
      asks: asks.filter((a) => a.key !== key),
      answers: new Map(answers).set(key, sticky.id),
    });
  } catch (e) {
    replaceAsk(article, { ...ask, step: "failed", error: String(e) });
  }
}

let keys = 0;
/** Asks about a passage at once, or opens a card to write the question on. Returns the ask's key. */
export function openAsk(article: number, passage: Pick<Ask, "blockId" | "kind" | "quote">): number {
  const ask: Ask = { ...passage, key: ++keys, question: "", step: "writing" };
  put(article, { asks: [...of(article).asks, ask] });
  if (ask.kind !== "question") {
    void sendAsk(article, ask);
  }
  return ask.key;
}

export async function deleteSticky(article: number, id: number) {
  await api.deleteSticky(id);
  put(article, { saved: of(article).saved.filter((s) => s.id !== id) });
}
