// The library's article set is one query: scope ∧ facets (∧ search). All of it is derived
// client-side from the full article list, which the backend returns without a limit.
import type { ArticleFilter, ArticleRow } from "./api.ts";
import { MANUAL, UNCLASSIFIED } from "./groups.ts";

/** NAVIGATION layer: exactly one, chosen in the sidebar; replaces the previous one. */
export type Scope =
  | { kind: "recent" } // saved within the last 7 days
  | { kind: "unread" } | { kind: "favorites" } | { kind: "all" }
  | { kind: "genre"; name: string | null } // null = 未分類
  | { kind: "feed"; id: number | null }; // null = 手動追加

export type ArticleState = "unread" | "read" | "favorite" | "issue";

/** FACETS layer: AND across dimensions, OR within one (tags: tagMode). Empty array = dimension off. */
export interface Facets {
  genres: (string | null)[];
  tags: string[];
  tagMode: "all" | "any";
  feeds: (number | null)[];
  difficulty: (number | null)[]; // null = 未判定
  state: ArticleState[]; // issue = fetch/extraction failed or thin
}

export type Dim = "genres" | "tags" | "feeds" | "difficulty" | "state";
export type DimValue<D extends Dim> = Facets[D][number];

export const DIMS: Dim[] = ["genres", "tags", "feeds", "difficulty", "state"];
export const DIM_LABELS: Record<Dim, string> = { genres: "ジャンル", tags: "タグ", feeds: "ソース", difficulty: "難易度", state: "状態" };
export const NO_FACETS: Facets = { genres: [], tags: [], tagMode: "all", feeds: [], difficulty: [], state: [] };

/** Mirrors classify.rs DIFFICULTIES (1-5), judged for a working software engineer. */
export const DIFFICULTY_LABELS = ["入門", "初級", "中級", "上級", "専門"];
export const STATE_LABELS: Record<ArticleState, string> = { unread: "未読", read: "既読", favorite: "お気に入り", issue: "要対応" };

const RECENT_MS = 7 * 24 * 3600 * 1000;

export const hasIssue = (a: ArticleRow) => a.fetch_status === "failed" || a.extraction_status === "failed" || a.thin;

export function inScope(a: ArticleRow, s: Scope, now: number): boolean {
  switch (s.kind) {
    case "all": return true;
    case "recent": return now - Date.parse(a.saved_at) <= RECENT_MS;
    case "unread": return a.read_status === "unread";
    case "favorites": return a.favorite;
    case "genre": return a.genre === s.name;
    case "feed": return a.feed_id === s.id;
  }
}

/** The values an article has in one dimension (several for tags and state). */
export function valuesOf<D extends Dim>(a: ArticleRow, dim: D): DimValue<D>[] {
  const v = ((): unknown[] => {
    switch (dim as Dim) {
      case "genres": return [a.genre];
      case "tags": return a.tags;
      case "feeds": return [a.feed_id];
      case "difficulty": return [a.difficulty];
      case "state": return [a.read_status, ...(a.favorite ? ["favorite"] : []), ...(hasIssue(a) ? ["issue"] : [])];
    }
  })();
  return v as DimValue<D>[];
}

function matchesDim(a: ArticleRow, f: Facets, dim: Dim): boolean {
  const want = f[dim] as unknown[];
  if (want.length === 0) return true;
  const have = valuesOf(a, dim) as unknown[];
  if (dim === "tags" && f.tagMode === "all") return want.every((t) => have.includes(t));
  return have.some((v) => want.includes(v));
}

export function matches(a: ArticleRow, f: Facets): boolean {
  return DIMS.every((d) => matchesDim(a, f, d));
}

export const isActive = (f: Facets, dim: Dim) => f[dim].length > 0;
export const activeDims = (f: Facets) => DIMS.filter((d) => isActive(f, d));
export const without = (f: Facets, dim: Dim): Facets => ({ ...f, [dim]: [] });

/** Toggles one value in a dimension. */
export function toggle<D extends Dim>(f: Facets, dim: D, v: DimValue<D>): Facets {
  const cur = f[dim] as DimValue<D>[];
  return { ...f, [dim]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] };
}

/** Count of articles in `rows` per value of one dimension. */
export function countBy<D extends Dim>(rows: ArticleRow[], dim: D): Map<DimValue<D>, number> {
  const m = new Map<DimValue<D>, number>();
  for (const a of rows) for (const v of valuesOf(a, dim)) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

/**
 * The rows a dimension's popover counts against ("件数は現在の集合内"): the set with that
 * dimension's own filter removed, so OR choices still show their counts. Tags in "all" mode
 * narrow the set, so each count is what picking that tag would leave.
 */
export function facetBase(scoped: ArticleRow[], f: Facets, dim: Dim): ArticleRow[] {
  const base = dim === "tags" && f.tagMode === "all" ? f : without(f, dim);
  return scoped.filter((a) => matches(a, base));
}

export function scopeLabel(s: Scope, all: ArticleRow[]): string {
  switch (s.kind) {
    case "recent": return "最近追加";
    case "unread": return "未読";
    case "favorites": return "お気に入り";
    case "all": return "すべての記事";
    case "genre": return s.name ?? UNCLASSIFIED;
    case "feed": return valueLabel("feeds", s.id, all);
  }
}

/** Display name of a facet value; feed names come from the articles' feed_title. */
export function valueLabel<D extends Dim>(dim: D, v: DimValue<D>, all: ArticleRow[]): string {
  switch (dim) {
    case "genres": return (v as string | null) ?? UNCLASSIFIED;
    case "tags": return v as string;
    case "feeds": {
      if (v == null) return MANUAL;
      return all.find((a) => a.feed_id === v)?.feed_title ?? `フィード ${v}`;
    }
    case "difficulty": return v == null ? "未判定" : DIFFICULTY_LABELS[(v as number) - 1] ?? String(v);
    default: return STATE_LABELS[v as ArticleState];
  }
}

/** "postgres + mvcc" (all) / "postgres / mvcc" (any). */
export function facetLabel(f: Facets, dim: Dim, all: ArticleRow[]): string {
  const sep = dim === "tags" && f.tagMode === "all" ? " + " : " / ";
  return (f[dim] as DimValue<Dim>[]).map((v) => valueLabel(dim, v, all)).join(sep);
}

export interface Relaxation {
  label: string;
  count: number;
  scope: Scope;
  facets: Facets;
}

/** Empty-state suggestions: for each active facet (and the scope if not "all"), the count if it alone were removed. */
export function relaxations(all: ArticleRow[], s: Scope, f: Facets, now: number): Relaxation[] {
  const count = (scope: Scope, facets: Facets) => all.filter((a) => inScope(a, scope, now) && matches(a, facets)).length;
  const out: Relaxation[] = activeDims(f).map((d) => {
    const facets = without(f, d);
    return { label: `${DIM_LABELS[d]} ${facetLabel(f, d, all)} を外す`, count: count(s, facets), scope: s, facets };
  });
  if (s.kind !== "all") {
    const scope: Scope = { kind: "all" };
    out.push({ label: `${scopeLabel(s, all)} → すべての記事`, count: count(scope, f), scope, facets: f });
  }
  return out;
}

/** Scope → ArticleFilter for the backend (search / chat scope). "recent" → { kind: "all" }. */
export function toFilter(s: Scope): ArticleFilter {
  return s.kind === "recent" ? { kind: "all" } : s;
}

export const sameScope = (a: Scope, b: Scope) => JSON.stringify(a) === JSON.stringify(b);

/** Stable swatch per genre name, from the boards' palette (genres have no stored color). */
export function genreSwatch(name: string | null): string {
  if (name == null) return "var(--line2)";
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return `var(--sw${(h % 6) + 1})`;
}
