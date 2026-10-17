// Sidebar grouping. Articles arrive already filtered and sorted; grouping keeps that order.

export type ListMode = "list" | "feed" | "genre";

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

export const UNCLASSIFIED = "未分類";
export const MANUAL = "手動追加";

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

const byGenre = <A extends Groupable>(articles: A[]) =>
  ordered(groupBy(articles, (a) => [`g:${a.genre?.toLowerCase() ?? ""}`, a.genre ?? UNCLASSIFIED]), "g:", false);

/** "feed": feeds (manual additions first) → genres → articles. "genre": genres → articles. */
export function groupArticles<A extends Groupable>(articles: A[], mode: Exclude<ListMode, "list">): Group<A>[] {
  if (mode === "genre") return byGenre(articles);
  const feeds = groupBy(articles, (a) => [`f:${a.feed_id ?? ""}`, a.feed_title ?? MANUAL]);
  return ordered(feeds, "f:", true).map((f) => ({ ...f, children: byGenre(f.articles) }));
}
