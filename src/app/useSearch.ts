import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { api, type ArticleRow, type SearchResult } from "../api";
import { filterHits, groupHits, type SearchMethod } from "../search/search";

const RECENT_KEY = "lattice.recentSearches";
type Request = { query: string };
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
  const [request, setRequest] = useState<Request | "idle" | null>(null);
  const [response, setResponse] = useState<{ request: Request; articleIds: string; result: SearchResult | null } | null>(null);
  const [method, setMethod] = useState<SearchMethod>("hybrid");
  const [hitSel, setHitSel] = useState(0);
  const [searchFocus, setSearchFocus] = useState(0);
  const [recent, setRecent] = useState<string[]>(loadRecent);

  const articleIds = shown
    .map((a) => a.id)
    .sort((a, b) => a - b)
    .join(",");
  const onError = useEffectEvent(fail);
  const submitted = request && request !== "idle" ? request : null;
  const settled = response?.request === submitted && response.articleIds === articleIds ? response : null;
  const search = useMemo(
    () => (request === null ? null : { query: submitted?.query ?? "", result: settled?.result ?? null, busy: submitted !== null && settled === null }),
    [request, submitted, settled],
  );

  useEffect(() => {
    if (!submitted) {
      return;
    }
    let active = true;
    const { query } = submitted;
    const articles = articleIds ? articleIds.split(",").map(Number) : [];
    void api.search(query, articles).then(
      (result) => {
        if (active) {
          setResponse({ request: submitted, articleIds, result });
        }
      },
      (e: unknown) => {
        if (active) {
          onError(e);
          setResponse({ request: submitted, articleIds, result: null });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [submitted, articleIds]);

  function start(q: string) {
    setHitSel(0);
    setRequest({ query: q });
    const next = [q, ...recent.filter((x) => x !== q)].slice(0, 5);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // Blocked storage: recent searches are simply not kept.
    }
  }

  /** Into search mode, focusing its field. */
  function enter() {
    setRequest((current) => current ?? "idle");
    setSearchFocus((n) => n + 1);
  }

  const hitGroups = useMemo(() => {
    if (!search?.result) {
      return [];
    }
    const ids = new Set(shown.map((a) => a.id));
    return groupHits(filterHits(search.result.hits, method, ids));
  }, [search, method, shown]);
  const flatHits = useMemo(() => hitGroups.flatMap((g) => g.hits), [hitGroups]);

  function exit() {
    setRequest(null);
  }

  return { search, exit, method, setMethod, hitSel, setHitSel, searchFocus, recent, start, enter, hitGroups, flatHits };
}
