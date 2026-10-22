import { useMemo, useState } from "react";
import { api, type ArticleRow, type SearchResult } from "../api";
import { toFilter, type Scope } from "../library/library";
import { filterHits, groupHits, type SearchMethod } from "../search/search";

const RECENT_KEY = "lattice.recentSearches";
function loadRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The list pane's search mode: the query and its hits among the `shown` articles, the selected hit, recent queries. */
export function useSearch(shown: ArticleRow[], fail: (e: unknown) => void) {
  const [search, setSearch] = useState<{ query: string; result: SearchResult | null; busy: boolean } | null>(null);
  const [method, setMethod] = useState<SearchMethod>("hybrid");
  const [hitSel, setHitSel] = useState(0);
  const [searchFocus, setSearchFocus] = useState(0);
  const [recent, setRecent] = useState<string[]>(loadRecent);

  async function start(q: string, scope: Scope) {
    setHitSel(0);
    setSearch({ query: q, result: null, busy: true });
    const next = [q, ...recent.filter((x) => x !== q)].slice(0, 5);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // Blocked storage: recent searches are simply not kept.
    }
    try {
      const result = await api.search(q, toFilter(scope));
      setSearch((cur) => (cur?.query === q ? { query: q, result, busy: false } : cur));
    } catch (e) {
      fail(e);
      setSearch((cur) => cur && { ...cur, busy: false });
    }
  }

  /** Into search mode, focusing its field. */
  function enter() {
    setSearch((s) => s ?? { query: "", result: null, busy: false });
    setSearchFocus((n) => n + 1);
  }

  const hitGroups = useMemo(() => {
    if (!search?.result) return [];
    const ids = new Set(shown.map((a) => a.id));
    return groupHits(filterHits(search.result.hits, method, ids));
  }, [search, method, shown]);
  const flatHits = useMemo(() => hitGroups.flatMap((g) => g.hits), [hitGroups]);

  return { search, exit: () => setSearch(null), method, setMethod, hitSel, setHitSel, searchFocus, recent, start, enter, hitGroups, flatHits };
}
