import type { ChatScope } from "./api";
import { parseFilterKey } from "./scopes.ts";

/** Splits an answer into text and `[n]` markers; only numbers in `cited` become markers. */
export function splitCitations(answer: string, cited: Set<number>): ({ n: number } | string)[] {
  return answer.split(/(\[\d+\])/)
    .map((p) => {
      const n = Number(/^\[(\d+)\]$/.exec(p)?.[1]);
      return cited.has(n) ? { n } : p;
    })
    .filter((p) => p !== "");
}

/** A saved article open in a tab, as a chat scope option. */
export interface OpenDoc { id: number; title: string }

/**
 * The saved articles in `tabs`, once each, in tab order. A page tab counts by the article it was
 * saved as; a page not in the Index has no stored text for the chat to answer from, so it is left out.
 */
export function openDocs(tabs: ({ kind: "reader"; articleId: number } | { kind: "page"; saved: number | null })[], titleOf: (id: number) => string | null): OpenDoc[] {
  const out = new Map<number, OpenDoc>();
  for (const t of tabs) {
    const id = t.kind === "reader" ? t.articleId : t.saved;
    const title = id == null || out.has(id) ? null : titleOf(id);
    if (id != null && title != null) out.set(id, { id, title });
  }
  return [...out.values()];
}

/** Several windows' open articles as one list, each article once. */
export const mergeDocs = (lists: OpenDoc[][]): OpenDoc[] => [...new Map(lists.flat().map((d) => [d.id, d])).values()];

/** Scope keys for the open articles: all of them, or one by id (the other keys are `article`, `all` and filter keys). */
export const OPEN_ALL = "open";
export const openKey = (id: number) => `open:${id}`;

/** What a scope key asks over; null while it names nothing (no article open, no tab open). */
export function scopeOf(key: string, article: { id: number } | null, open: OpenDoc[]): ChatScope | null {
  if (key === "article") return article && { kind: "article", id: article.id };
  if (key === OPEN_ALL) return open.length ? { kind: "articles", ids: open.map((d) => d.id) } : null;
  if (key.startsWith("open:")) return { kind: "article", id: Number(key.slice(5)) };
  return { kind: "filter", filter: key === "all" ? { kind: "all" } : parseFilterKey(key) };
}
