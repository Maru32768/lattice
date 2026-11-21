import type { ArticleRow, GroupRow } from "../bindings/index.ts";
import {
  NO_FACETS,
  NO_KEPT,
  countBy,
  facetBase,
  isFacets,
  listed,
  universe,
  type Dim,
  type DimValue,
  type Facets,
  type Kept,
  type Scope,
} from "../library/library.ts";
import { placeStore } from "../lib/places.ts";

/** How many rows are added at a time. */
export const PAGE = 100;

/**
 * The PC's fixed scopes, and its groups. A genre or feed scope is its facet over All articles here, so the sheet offers
 * those once. A group is a scope, as in the PC's sidebar: as a facet it met 未読, and a group's articles are mostly read.
 */
export type ListScope = Extract<Scope, { kind: "unread" | "recent" | "favorites" | "all" | "group" }>;
export const SCOPES: ListScope[] = [{ kind: "unread" }, { kind: "recent" }, { kind: "favorites" }, { kind: "all" }];

function storedScope(s: Record<string, unknown>): ListScope | undefined {
  if (s.kind === "group") {
    return Number.isInteger(s.id) ? { kind: "group", id: s.id as number } : undefined;
  }
  return SCOPES.find((x) => x.kind === s.kind);
}

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

const VIEW_KEY = "lattice.mobile.view";
/** What a reload keeps. Not the articles kept in the view after reading them: as on the PC, they last until the page goes. */
type Stored = Omit<ListView, "kept">;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
function isStored(v: unknown): v is Stored {
  if (!isObj(v) || !isObj(v.scope)) {
    return false;
  }
  return storedScope(v.scope) !== undefined && isFacets(v.facets) && typeof v.query === "string" && Number.isInteger(v.shown);
}

/** The list last shown on this phone, which a phone that dropped the page in the background shows again; else the first. */
export function storedView(): ListView {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
    if (isStored(v)) {
      // The sheet offers groups as scopes only, so a group chosen as a facet could not be taken off there.
      const facets = { ...v.facets, groups: [] };
      return { scope: storedScope(v.scope)!, facets, query: v.query, shown: Math.max(PAGE, v.shown), kept: NO_KEPT };
    }
  } catch {
    // Blocked storage, or a view an older version wrote.
  }
  return FIRST_VIEW;
}

export function storeView(v: ListView) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ scope: v.scope, facets: v.facets, query: v.query, shown: v.shown } satisfies Stored));
  } catch {
    // The view lasts until the page is loaded again.
  }
}

/**
 * Where the list was left: the article at the top of the screen and how far down the screen its row's top was, else how
 * far down the page was (that row gone since).
 */
interface ListPlace {
  id: number;
  top: number;
  y: number;
}
const isListPlace = (v: unknown): v is ListPlace => isObj(v) && Number.isInteger(v.id) && Number.isFinite(v.top) && Number.isFinite(v.y);
const listPlaces = placeStore<ListPlace>("lattice.mobile.listPlace", 1, isListPlace);

/** Keeps where the list on screen is; at its top it keeps nothing. */
export function keepListPlace() {
  const row = [...document.querySelectorAll<HTMLElement>("li[data-id]")].find((r) => r.getBoundingClientRect().bottom > 0);
  listPlaces.set("list", scrollY > 0 && row ? { id: Number(row.dataset.id), top: row.getBoundingClientRect().top, y: scrollY } : null);
}

export function showListPlace() {
  const p = listPlaces.get("list");
  const row = p && document.querySelector(`li[data-id='${p.id}']`);
  if (row) {
    window.scrollBy(0, row.getBoundingClientRect().top - p.top);
  } else {
    window.scrollTo(0, p?.y ?? 0);
  }
}

export const forgetListPlace = () => {
  listPlaces.clear();
  try {
    localStorage.removeItem(VIEW_KEY);
  } catch {
    // Blocked storage holds nothing.
  }
};

/**
 * The view to show: all articles while its group is not in the list, as the PC goes back when the group is deleted.
 * The chosen group stays: an older snapshot, read while the PC is off, may not have it yet.
 */
export function withoutGoneGroup(v: ListView, groups: GroupRow[]): ListView {
  const s = v.scope;
  return s.kind !== "group" || groups.some((g) => g.id === s.id) ? v : { ...v, scope: { kind: "all" }, shown: PAGE, kept: NO_KEPT };
}

/** `base`: scope ∧ search, what the filter counts against. `rows`: what the list shows, in the order they came. */
export function visibleArticles(articles: ArticleRow[], view: ListView, now = Date.now()): { base: ArticleRow[]; rows: ArticleRow[] } {
  const q = view.query.trim().toLowerCase();
  // The site as the row names it (its feed, its site name) or its domain.
  const found = q
    ? articles.filter((a) => [a.title ?? a.original_url, a.feed_title, a.site_name, a.domain].some((s) => s?.toLowerCase().includes(q)))
    : articles;
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
