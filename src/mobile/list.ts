import type { ArticleRow } from "../bindings/index.ts";
import { NO_FACETS, NO_KEPT, countBy, facetBase, listed, universe, type Dim, type DimValue, type Facets, type Kept, type Scope } from "../library/library.ts";

/** How many rows are added at a time. */
export const PAGE = 100;

/** The PC's fixed scopes. Genre, feed and group scopes are the same as their facets here, so the sheet offers those once. */
export type ListScope = Extract<Scope, { kind: "unread" | "recent" | "favorites" | "all" }>;
export const SCOPES: ListScope[] = [{ kind: "unread" }, { kind: "recent" }, { kind: "favorites" }, { kind: "all" }];

export interface ListView {
  scope: ListScope;
  facets: Facets;
  query: string;
  /** How many rows are drawn: a library of thousands stays quick to open. */
  shown: number;
  /** Articles opened from this view, which stay in it after reading them (as on the PC). */
  kept: Kept;
}
export const FIRST_VIEW: ListView = { scope: { kind: "unread" }, facets: NO_FACETS, query: "", shown: PAGE, kept: NO_KEPT };

/** `base`: scope ∧ search, what the filter counts against. `rows`: what the list shows, in the order they came. */
export function visibleArticles(articles: ArticleRow[], view: ListView, now = Date.now()): { base: ArticleRow[]; rows: ArticleRow[] } {
  const q = view.query.trim().toLowerCase();
  const found = q ? articles.filter((a) => (a.title ?? a.original_url).toLowerCase().includes(q) || a.domain.includes(q)) : articles;
  const { scoped, shown } = listed(found, view.scope, view.facets, now, view.kept);
  return { base: scoped, rows: shown };
}

/** A dimension's values with their counts, as the PC's facet popover counts them: the chosen ones always, the rest when some article has them. */
export function options(dim: Dim, base: ArticleRow[], all: ArticleRow[], facets: Facets): { v: DimValue<Dim>; count: number }[] {
  const counts = countBy(facetBase(base, facets, dim), dim);
  const chosen = facets[dim] as DimValue<Dim>[];
  const values = universe(dim, all).filter((v) => counts.has(v) || chosen.includes(v));
  // Fixed orders (state, difficulty, importance) read best as they are; the others go by size.
  if (dim === "genres" || dim === "tags" || dim === "feeds" || dim === "groups") {
    values.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  }
  return values.map((v) => ({ v, count: counts.get(v) ?? 0 }));
}

/** The list from the PC is fresh; one older than this is a snapshot or a saved copy, and worth saying so. */
const OLD_AFTER_SECS = 120;
export const isOldList = (generatedAt: number, now = Date.now()) => now / 1000 - generatedAt > OLD_AFTER_SECS;
