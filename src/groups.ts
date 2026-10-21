// List grouping (まとめ方: ソース / ジャンル). Articles arrive already filtered and sorted; grouping keeps that order.
import type { T } from "./i18n/index.ts";

interface Groupable {
  genre: string | null;
  feed_id: number | null;
  feed_title: string | null;
}

export interface Group<A> {
  key: string;
  label: string;
  articles: A[];
  children?: Group<A>[];
}


/** What the UI calls a feed: the user's name for it, else its own title, else its URL. */
export const feedName = (f: { custom_title: string | null; title: string | null; url: string }) => f.custom_title ?? f.title ?? f.url;

function groupBy<A>(articles: A[], keyOf: (a: A) => [string, string]): Group<A>[] {
  const m = new Map<string, Group<A>>();
  for (const a of articles) {
    const [key, label] = keyOf(a);
    let g = m.get(key);
    if (!g) m.set(key, (g = { key, label, articles: [] }));
    g.articles.push(a);
  }
  return [...m.values()];
}

/** By label, 未分類 last. */
const byGenre = <A extends Groupable>(articles: A[], t: T) =>
  groupBy(articles, (a) => [`g:${a.genre?.toLowerCase() ?? ""}`, a.genre ?? t("common.unclassified")])
    .sort((x, y) => Number(x.key === "g:") - Number(y.key === "g:") || x.label.localeCompare(y.label));

/**
 * "feed": feeds (manual additions first, then in `feedOrder`, the user's order; a feed not in it by name, last)
 * → genres → articles. "genre": genres → articles.
 */
export function groupArticles<A extends Groupable>(articles: A[], mode: "feed" | "genre", t: T, feedOrder: number[] = []): Group<A>[] {
  if (mode === "genre") return byGenre(articles, t);
  const rank = (id: number | null) => (id == null ? -1 : feedOrder.indexOf(id) + 1 || feedOrder.length + 1);
  return groupBy(articles, (a) => [`f:${a.feed_id ?? ""}`, a.feed_title ?? t("common.manual")])
    .sort((x, y) => rank(x.articles[0].feed_id) - rank(y.articles[0].feed_id) || x.label.localeCompare(y.label))
    .map((f) => ({ ...f, children: byGenre(f.articles, t) }));
}

/** The articles of `groups` in display order. */
export const flatten = <A>(groups: Group<A>[]): A[] => groups.flatMap((g) => (g.children ? flatten(g.children) : g.articles));
