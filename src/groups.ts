// List grouping (グループ: ソース / ジャンル). Articles arrive already filtered and sorted; grouping keeps that order.
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

/** By label, with the group `special` first or last. */
function ordered<A>(groups: Group<A>[], special: string, first: boolean): Group<A>[] {
  const rank = (g: Group<A>) => (g.key === special ? (first ? -1 : 1) : 0);
  return groups.sort((x, y) => rank(x) - rank(y) || x.label.localeCompare(y.label));
}

const byGenre = <A extends Groupable>(articles: A[], t: T) =>
  ordered(groupBy(articles, (a) => [`g:${a.genre?.toLowerCase() ?? ""}`, a.genre ?? t("common.unclassified")]), "g:", false);

/** "feed": feeds (manual additions first) → genres → articles. "genre": genres → articles. */
export function groupArticles<A extends Groupable>(articles: A[], mode: "feed" | "genre", t: T): Group<A>[] {
  if (mode === "genre") return byGenre(articles, t);
  const feeds = groupBy(articles, (a) => [`f:${a.feed_id ?? ""}`, a.feed_title ?? t("common.manual")]);
  return ordered(feeds, "f:", true).map((f) => ({ ...f, children: byGenre(f.articles, t) }));
}
