import type { ArticleRow } from "../bindings";

/** How many rows are added at a time. */
export const PAGE = 100;

export type ListFilter = "unread" | "all" | "favorites";
export interface ListView {
  filter: ListFilter;
  query: string;
  /** How many rows are drawn: a library of thousands stays quick to open. */
  shown: number;
}

/** The articles a view lists, in the order they came. */
export function visibleArticles(articles: ArticleRow[], { filter, query }: Pick<ListView, "filter" | "query">): ArticleRow[] {
  const q = query.trim().toLowerCase();
  return articles.filter(
    (a) =>
      (filter === "all" || (filter === "unread" ? a.read_status === "unread" : a.favorite)) &&
      (!q || (a.title ?? a.original_url).toLowerCase().includes(q) || a.domain.includes(q)),
  );
}
