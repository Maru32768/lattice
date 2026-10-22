import { useEffect, useEffectEvent, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type ArticleRow, type ArticleSort, type FeedRow, type FolderRow, type GroupRow, type RelevanceStatus } from "../api";

type Count = { name: string; count: number };

/** The library as the backend has it: articles, feeds and their folders, tags, genres, groups, relevance. */
export function useLibrary(fail: (e: unknown) => void) {
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  /** Feed folders (H25), in the user's order. */
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [tags, setTags] = useState<Count[]>([]);
  const [genres, setGenres] = useState<Count[]>([]);
  /** The user's groups (G53). */
  const [groupRows, setGroupRows] = useState<GroupRow[]>([]);
  const [relevance, setRelevance] = useState<RelevanceStatus | null>(null);
  const [sort, setSortState] = useState<ArticleSort>("saved_desc");
  /** For a throttled refresh that fires after the sort changed. */
  const sortRef = useRef(sort);
  const [now, setNow] = useState(() => Date.now());

  const refresh = () =>
    Promise.all([
      api.listArticles({ kind: "all" }, sortRef.current).then((a) => {
        setNow(Date.now());
        setArticles(a);
        setLoaded(true);
      }),
      api.listFeeds().then(setFeeds), api.listFeedFolders().then(setFolders), api.listTags().then(setTags), api.listGenres().then(setGenres), api.listGroups().then(setGroupRows), api.relevanceStatus().then(setRelevance),
    ]).catch(fail);
  const setSort = (s: ArticleSort) => {
    sortRef.current = s;
    setSortState(s);
    void refresh();
  };
  // Background jobs (bulk import fetches) report every article; throttle list reloads to one
  // per 500 ms (a debounce would starve under a steady event stream). The pending call covers later events.
  const refreshTimer = useRef(0);
  const refreshSoon = () => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = 0;
      void refresh();
    }, 500);
  };

  const onStart = useEffectEvent(() => void refresh());
  const onArticleChanged = useEffectEvent(refreshSoon);
  useEffect(() => {
    onStart();
    const sub = listen<number>("article-changed", () => onArticleChanged());
    return () => void sub.then((f) => f());
  }, []);

  return { articles, loaded, feeds, setFeeds, folders, setFolders, tags, genres, groupRows, relevance, sort, setSort, now, refresh, refreshSoon };
}
