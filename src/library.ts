// The library's article set is one query: scope ∧ facets (∧ search). All of it is derived
// client-side from the full article list, which the backend returns without a limit.
import type { ArticleFilter, ArticleRow, FolderRow, GroupRow } from "./api.ts";
import type { PlainKey, T } from "./i18n/index.ts";

/** NAVIGATION layer: exactly one, chosen in the sidebar; replaces the previous one. */
export type Scope =
  | { kind: "recent" } // saved within the last 7 days
  | { kind: "unread" } | { kind: "favorites" } | { kind: "all" }
  | { kind: "genre"; name: string | null } // null = 未分類
  | { kind: "feed"; id: number | null } // null = 手動追加
  | { kind: "group"; id: number }
  | { kind: "folder"; id: number } // a feed folder's feeds
  | { kind: "important"; min: number }; // importance at least min (Settings › 重要度)

export type ArticleState = "unread" | "read" | "favorite" | "issue";

/** FACETS layer: AND across dimensions, OR within one (tags: tagMode). Empty array = dimension off. */
export interface Facets {
  genres: (string | null)[];
  tags: string[];
  tagMode: "all" | "any";
  feeds: (number | null)[];
  groups: number[];
  difficulty: (number | null)[]; // null = 未判定
  relevance: (number | null)[]; // importance 1-5; null = 未判定
  state: ArticleState[]; // issue = fetch/extraction failed or thin
}

export type Dim = "genres" | "tags" | "groups" | "feeds" | "difficulty" | "relevance" | "state";
export type DimValue<D extends Dim> = Facets[D][number];

export const DIMS: Dim[] = ["genres", "tags", "groups", "feeds", "difficulty", "relevance", "state"];
export const DIM_LABELS: Record<Dim, PlainKey> = {
  genres: "common.genre", tags: "common.tag", groups: "common.group", feeds: "common.source", difficulty: "common.difficulty",
  relevance: "common.relevance", state: "library.state",
};
export const NO_FACETS: Facets = { genres: [], tags: [], tagMode: "all", feeds: [], groups: [], difficulty: [], relevance: [], state: [] };

/** Mirrors classify.rs DIFFICULTIES (1-5), judged for a working software engineer. */
export const DIFFICULTY_LABELS: PlainKey[] = ["library.difficulty1", "library.difficulty2", "library.difficulty3", "library.difficulty4", "library.difficulty5"];
/** Mirrors relevance.rs SCORES (1-5), judged against the 「自分について」 profile. */
export const RELEVANCE_LABELS: PlainKey[] = ["library.relevance1", "library.relevance2", "library.relevance3", "library.relevance4", "library.relevance5"];
export const STATE_LABELS: Record<ArticleState, PlainKey> = { unread: "common.unread", read: "library.read", favorite: "common.favorites", issue: "library.issue" };

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
    case "group": return a.groups.includes(s.id);
    case "folder": return a.folder_id === s.id;
    case "important": return (a.relevance ?? 0) >= s.min;
  }
}

/** The values an article has in one dimension (several for tags and state). */
export function valuesOf<D extends Dim>(a: ArticleRow, dim: D): DimValue<D>[] {
  const v = ((): unknown[] => {
    switch (dim) {
      case "genres": return [a.genre];
      case "tags": return a.tags;
      case "groups": return a.groups;
      case "feeds": return [a.feed_id];
      case "difficulty": return [a.difficulty];
      case "relevance": return [a.relevance];
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

/**
 * Articles opened (and so marked read) while a list view was showing them stay in that view, so
 * 未読 does not lose the row under the reader. `view` is the scope ∧ facets they were kept for;
 * the shell starts over whenever the view or the screen changes.
 */
export interface Kept {
  view: string;
  ids: ReadonlySet<number>;
}

export const NO_KEPT: Kept = { view: "", ids: new Set() };
export const viewKey = (s: Scope, f: Facets) => JSON.stringify([s, f]);
export const keep = (k: Kept, view: string, id: number): Kept => ({ view, ids: new Set(k.view === view ? [...k.ids, id] : [id]) });

/** The list's rows: scope ∧ facets, plus the articles kept for this view. */
export function listed(all: ArticleRow[], s: Scope, f: Facets, now: number, k: Kept): { scoped: ArticleRow[]; shown: ArticleRow[] } {
  const kept = k.view === viewKey(s, f) ? k.ids : NO_KEPT.ids;
  const scoped = all.filter((a) => kept.has(a.id) || inScope(a, s, now));
  return { scoped, shown: scoped.filter((a) => kept.has(a.id) || matches(a, f)) };
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

export const groupName = (id: number, groups: GroupRow[], t: T) => groups.find((g) => g.id === id)?.name ?? t("common.group");

export function scopeLabel(s: Scope, all: ArticleRow[], groups: GroupRow[], t: T, folders: FolderRow[] = []): string {
  switch (s.kind) {
    case "recent": return t("library.recent");
    case "unread": return t("common.unread");
    case "favorites": return t("common.favorites");
    case "all": return t("common.allArticles");
    case "genre": return s.name ?? t("common.unclassified");
    case "feed": return valueLabel("feeds", s.id, all, groups, t);
    case "group": return groupName(s.id, groups, t);
    case "folder": return folders.find((f) => f.id === s.id)?.name ?? t("common.folder");
    case "important": return t("library.important");
  }
}

/** Display name of a facet value; feed names come from the articles' feed_title. */
export function valueLabel<D extends Dim>(dim: D, v: DimValue<D>, all: ArticleRow[], groups: GroupRow[], t: T): string {
  switch (dim) {
    case "genres": return (v as string | null) ?? t("common.unclassified");
    case "tags": return v as string;
    case "groups": return groupName(v as number, groups, t);
    case "feeds": {
      if (v == null) return t("common.manual");
      return all.find((a) => a.feed_id === v)?.feed_title ?? t("library.feedN", { id: String(v) });
    }
    case "difficulty": {
      const label = v == null ? "library.difficultyNone" : DIFFICULTY_LABELS[(v as number) - 1];
      return label ? t(label) : String(v);
    }
    case "relevance": {
      const label = v == null ? "library.relevanceNone" : RELEVANCE_LABELS[(v as number) - 1];
      return label ? t(label) : String(v);
    }
    default: return t(STATE_LABELS[v as ArticleState]);
  }
}

/** "postgres + mvcc" (all) / "postgres / mvcc" (any). */
export function facetLabel(f: Facets, dim: Dim, all: ArticleRow[], groups: GroupRow[], t: T): string {
  const sep = dim === "tags" && f.tagMode === "all" ? " + " : " / ";
  return (f[dim] as DimValue<Dim>[]).map((v) => valueLabel(dim, v, all, groups, t)).join(sep);
}

export interface Relaxation {
  label: string;
  count: number;
  scope: Scope;
  facets: Facets;
}

/** Empty-state suggestions: for each active facet (and the scope if not "all"), the count if it alone were removed. */
export function relaxations(all: ArticleRow[], groups: GroupRow[], s: Scope, f: Facets, now: number, t: T, folders: FolderRow[] = []): Relaxation[] {
  const count = (scope: Scope, facets: Facets) => all.filter((a) => inScope(a, scope, now) && matches(a, facets)).length;
  const out: Relaxation[] = activeDims(f).map((d) => {
    const facets = without(f, d);
    return { label: t("library.dropFacet", { dim: t(DIM_LABELS[d]), value: facetLabel(f, d, all, groups, t) }), count: count(s, facets), scope: s, facets };
  });
  if (s.kind !== "all") {
    const scope: Scope = { kind: "all" };
    out.push({ label: t("library.toAll", { scope: scopeLabel(s, all, groups, t, folders) }), count: count(scope, f), scope, facets: f });
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
