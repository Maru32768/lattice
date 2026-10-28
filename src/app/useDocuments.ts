import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, browser, type ArticleView } from "../api";
import { forgetOpened } from "../browser/BrowserView";
import {
  activeTab,
  allTabs,
  closeWhere,
  load as loadLayout,
  navigated,
  pageByKey,
  panes,
  save as saveLayout,
  update,
  type Id,
  type Layout,
  type PageTab,
  type Tab,
} from "../layout/layout";
import { useLatest } from "../lib/useLatest";
import { HOST, STORAGE } from "./host";

/** The documents: the pane tree with its tabs, the article views its Reader and saved Page tabs show, and the pages' webviews. */
export function useDocuments(fail: (e: unknown) => void) {
  const [layout, setLayout] = useState<Layout>(() => loadLayout(STORAGE));
  useEffect(() => {
    if (HOST.kind !== "chat") {
      saveLayout(layout, STORAGE);
    }
  }, [layout]);
  const layoutRef = useLatest(layout);
  /** Article views of the open Reader tabs, by article id. */
  const [views, setViews] = useState<Map<number, ArticleView>>(() => new Map());
  const viewsRef = useLatest(views);

  const loadView = (id: number) =>
    api
      .getArticle(id)
      .then((v) => {
        if (v) {
          setViews((m) => new Map(m).set(id, v));
        }
        // Gone from the library (deleted elsewhere): its tabs go too.
        else {
          setLayout((l) => closeWhere(l, (t) => t.kind === "reader" && t.articleId === id));
        }
      })
      .catch(fail);
  /** Whether the page a tab shows is in the Index. */
  const refreshSaved = (tab: Id, url: string) =>
    api
      .articleForUrl(url)
      .then((a) => setLayout((l) => update(l, tab, { saved: a?.id ?? null })))
      .catch(() => {});
  /** A page event names its tab by webview key; the layout op takes the tab id. */
  const onPage = (key: string, f: (l: Layout, tab: PageTab) => Layout) =>
    setLayout((l) => {
      const t = pageByKey(l, key);
      return t ? f(l, t) : l;
    });

  // A translate job reports every saved batch: reload an open article at most once per 500 ms, as the
  // library throttles its list (user actions reload their article directly).
  const reloadTimers = useRef(new Map<number, number>());
  const onArticleChanged = useEffectEvent((id: number) => {
    if (!views.has(id) || reloadTimers.current.has(id)) {
      return;
    }
    reloadTimers.current.set(
      id,
      window.setTimeout(() => {
        reloadTimers.current.delete(id);
        if (viewsRef.current.has(id)) {
          void loadView(id);
        }
      }, 500),
    );
  });
  const onBrowserPage = useEffectEvent((p: { tab: string; url: string; loading: boolean; can_go_back: boolean; can_go_forward: boolean }) => {
    const { tab, url, loading, can_go_back: canGoBack, can_go_forward: canGoForward } = p;
    onPage(tab, (l, t) => navigated(l, t.id, { url, loading, canGoBack, canGoForward }));
    const t = pageByKey(layout, tab);
    if (!loading && t) {
      void refreshSaved(t.id, url);
    }
  });
  useEffect(() => {
    const subs = [
      listen<number>("article-changed", (e) => onArticleChanged(e.payload)),
      listen<{ tab: string; url: string; loading: boolean; can_go_back: boolean; can_go_forward: boolean }>("browser-page", (e) => onBrowserPage(e.payload)),
      listen<{ tab: string; done: number; total: number }>("browser-translate", ({ payload: p }) =>
        setLayout((l) => {
          const t = pageByKey(l, p.tab);
          return t ? update(l, t.id, { translating: p.done < p.total ? { done: p.done, total: p.total } : undefined }) : l;
        }),
      ),
      listen<{ tab: string; title: string }>("browser-title", (e) =>
        setLayout((l) => {
          const t = pageByKey(l, e.payload.tab);
          return t ? update(l, t.id, { title: e.payload.title }) : l;
        }),
      ),
    ];
    return () => subs.forEach((s) => void s.then((f) => f()));
  }, []);

  // Reader tabs and saved Page tabs (their summary, H13) need their article views; views of closed tabs are dropped.
  const readerIds = useMemo(
    () => [...new Set(allTabs(layout).flatMap((t) => (t.kind === "reader" ? [t.articleId] : t.saved != null ? [t.saved] : [])))],
    [layout],
  );
  const readerKey = readerIds.join(",");
  const [viewsFor, setViewsFor] = useState(readerKey);
  if (viewsFor !== readerKey) {
    setViewsFor(readerKey);
    setViews((m) => ([...m.keys()].every((id) => readerIds.includes(id)) ? m : new Map([...m].filter(([id]) => readerIds.includes(id)))));
  }
  const loadMissing = useEffectEvent((ids: number[]) => {
    for (const id of ids) {
      if (!views.has(id)) {
        void loadView(id);
      }
    }
  });
  useEffect(() => loadMissing(readerKey ? readerKey.split(",").map(Number) : []), [readerKey]);

  // The article in front in each pane: the backend's reserved job slot translates it before the queue.
  const onScreenKey = [
    ...new Set(
      panes(layout.root).flatMap((p) => {
        const t = activeTab(p);
        return t?.kind === "reader" ? [t.articleId] : t?.kind === "page" && t.saved != null ? [t.saved] : [];
      }),
    ),
  ]
    .sort((a, b) => a - b)
    .join(",");
  useEffect(() => {
    api.setArticlesOnScreen(onScreenKey ? onScreenKey.split(",").map(Number) : []).catch(() => {});
  }, [onScreenKey]);

  // Page tabs that closed (or show a Reader now) give up their webview.
  const pageKey = useMemo(
    () =>
      allTabs(layout)
        .filter((t) => t.kind === "page")
        .map((t) => t.key),
    [layout],
  ).join(",");
  const prevPages = useRef<string[]>([]);
  useEffect(() => {
    const ids = pageKey ? pageKey.split(",") : [];
    for (const id of prevPages.current) {
      if (!ids.includes(id)) {
        browser.close(id).catch(() => {});
      }
    }
    prevPages.current = ids;
  }, [pageKey]);

  /** The tab leaves this window with its webview, which is not closed: the next window attaches it. */
  function forgetPage(t: Tab) {
    if (t.kind !== "page") {
      return;
    }
    prevPages.current = prevPages.current.filter((k) => k !== t.key);
    forgetOpened(t.key);
  }

  return { layout, setLayout, layoutRef, views, setViews, viewsRef, loadView, refreshSaved, forgetPage };
}
