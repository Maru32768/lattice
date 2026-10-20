import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, browser, isLocal, type ArticleRow, type ArticleSort, type ArticleView, type Citation, type FeedRow, type GroupRow, type SearchHit, type SearchResult } from "./api";
import { BrowserView, overlayLabels, overlayOf, type PageLang } from "./BrowserView";
import type { LanguageMode } from "./mixed";

import { ImportView, type ImportTab } from "./ImportView";
import { SettingsView, type SettingsSection } from "./SettingsView";
import { FeedsView } from "./FeedsView";
import { JobsView } from "./JobsView";
import { QuizReview } from "./QuizReview";
import { ChatPane } from "./ChatPane";
import { filterGroups, filterKey } from "./scopes";
import { flatten, groupArticles, type Group } from "./groups";
import { NO_FACETS, NO_KEPT, activeDims, countBy, facetLabel, inScope, keep, listed, relaxations, scopeLabel, toFilter, viewKey, type Facets, type Kept, type Scope } from "./library";
import { filterHits, groupHits, terms, type SearchMethod } from "./search";
import { MATCH_LABEL, SearchPane } from "./SearchPane";
import { Reader, TRANSLATABLE, type Focus } from "./Reader";
import { Nav, NavRail, type NavCounts, type Screen } from "./Nav";
import { ListPane, ListRail, type Grouping } from "./ListPane";
import { CoverContext, useCover } from "./Popover";
import { UpdateNotice } from "./Update";
import { Kbd } from "./Icon";
import { PREFIX_MS, actionFor, getBindings, keyLabel, pageKeys, useBindings, type ActionId } from "./keys";
import { keyOf } from "./keyname";
import { focusPane, paneAfter, paneOf, stepNav } from "./panes";
import { Palette, type PaletteActions } from "./Palette";
import { ConfirmDialog } from "./ConfirmDialog";
import { TitleBar } from "./TitleBar";
import { Splitter, loadWidths, saveWidths, type PaneWidths, type Resizable } from "./Splitter";
import { DocArea } from "./DocArea";
import { hostOf } from "./Favicon";
import {
  activeTab, allTabs, close, closePane, closeWhere, cycle, focus as focusLayout, focusedPane, load as loadLayout, navigated, open, save as saveLayout, split,
  tabById, update, type Id, type Layout, type Pane, type PageTab, type Tab,
} from "./layout";
import type { TabLabel } from "./TabStrip";
import { displayLang, isLang, setDisplayLang, useT } from "./i18n";
import "./App.css";

/** Where a document opens: the focused pane's active tab, or a new tab (Ctrl / middle click, Ctrl+T). */
type Where = "active" | "new";

const RECENT_KEY = "lattice.recentSearches";
function loadRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const JOB_POLL_MS = 10_000;
/** Shortcuts that, pressed in the page, move on to the app: the page's webview gives up the keyboard. */
const LEAVES_PAGE = new Set<ActionId>(["palette", "search", "view", "newTab", "closeTab", "nextTab", "prevTab", "splitRight", "splitDown"]);

/** States board #8: an empty library. */
function FirstRun({ onPaste, onFeeds, onImport, onMarkdown, onSettings }: {
  onPaste: () => void; onFeeds: () => void; onImport: () => void; onMarkdown: () => void; onSettings: () => void;
}) {
  const t = useT();
  return (
    <section className="first-run" aria-label={t("app.firstRun")}>
      <h1>{t("app.firstRun")}</h1>
      <div className="first-cards">
        <button className="btn" onClick={onPaste}><span className="h">{t("app.pasteUrl")}</span><span className="muted"><Kbd>Ctrl</Kbd><Kbd>K</Kbd>{t("app.pasteHint")}</span></button>
        <button className="btn" onClick={onFeeds}><span className="h">{t("common.addFeed")}</span><span className="muted">{t("app.feedHint")}</span></button>
        <button className="btn" onClick={onImport}><span className="h">{t("common.bulkImport")}</span><span className="muted">{t("app.bulkHint")}</span></button>
        <button className="btn" onClick={onMarkdown}><span className="h">{t("common.importMarkdown")}</span><span className="muted">{t("app.markdownHint")}</span></button>
      </div>
      <p className="muted">{t.rich("app.needsProvider", { link: <button className="linkish" onClick={onSettings}>{t("app.setUp")}</button> })}</p>
    </section>
  );
}

/** Shown while the pane prefix is armed. */
function PrefixHint({ prefix }: { prefix: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useCover(ref, true);
  return (
    <div ref={ref} className="prefix-hint" role="status">
      <Kbd>{prefix}</Kbd>
      <span><Kbd>←</Kbd><Kbd>→</Kbd><Kbd>↑</Kbd><Kbd>↓</Kbd> <Kbd>h</Kbd><Kbd>j</Kbd><Kbd>k</Kbd><Kbd>l</Kbd>{t("app.prefixMove")}</span>
      <span><Kbd>o</Kbd>{t("app.prefixNext")}</span>
      <span><Kbd>%</Kbd>{t("app.prefixSplitRight")}</span>
      <span><Kbd>"</Kbd>{t("app.prefixSplitDown")}</span>
      <span><Kbd>x</Kbd>{t("app.prefixClose")}</span>
      <span><Kbd>c</Kbd><Kbd>n</Kbd><Kbd>p</Kbd>{t("app.prefixTabs")}</span>
      <span><Kbd>z</Kbd>{t("app.prefixFocus")}</span>
    </div>
  );
}

export default function App() {
  // Also subscribes the whole tree to the display language: a switch re-renders everything below.
  const t = useT();
  useEffect(() => {
    // The backend's choice wins over the cached one; the first start stores the detected language.
    api.uiLanguage().then((l) => (isLang(l) ? setDisplayLang(l) : api.setUiLanguage(displayLang()))).catch(() => {});
  }, []);
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);
  const [genres, setGenres] = useState<{ name: string; count: number }[]>([]);
  /** The user's groups (G53); `groups` below is the list's grouping. */
  const [groupRows, setGroupRows] = useState<GroupRow[]>([]);
  /** The palette asked this Reader tab to open its group picker; `seq` grows with each ask. */
  const [groupRequest, setGroupRequest] = useState<{ tab: Id; seq: number } | null>(null);
  const [sort, setSort] = useState<ArticleSort>("saved_desc");
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const [group, setGroup] = useState<Grouping>("none");
  const [scope, setScopeState] = useState<Scope>({ kind: "all" });
  const [facets, setFacets] = useState<Facets>(NO_FACETS);
  const [kept, setKept] = useState<Kept>(NO_KEPT);
  const [screen, setScreen] = useState<Screen>("library");
  const [navOpen, setNavOpen] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [widths, setWidths] = useState<PaneWidths>(loadWidths);
  useEffect(() => saveWidths(widths), [widths]);
  const [jobFailures, setJobFailures] = useState(0);
  const [reviewDue, setReviewDue] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Rectangles of open overlays (popovers, menus, palette); the page webviews hide under them. */
  const [overlays, setOverlays] = useState<DOMRect[]>([]);
  const cover = useCallback((r: DOMRect) => {
    setOverlays((o) => [...o, r]);
    return () => setOverlays((o) => o.filter((x) => x !== r));
  }, []);
  const [now, setNow] = useState(() => Date.now());
  /** Open palette's initial query. */
  const [palette, setPalette] = useState<string | null>(null);
  /** The palette was opened for a new tab (Ctrl+T, the strip's +): its pick opens in one. Cleared once it has closed (its pick runs first). */
  const paletteNew = useRef(false);
  useEffect(() => { if (palette == null) paletteNew.current = false; }, [palette]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("provider");
  const [importTab, setImportTab] = useState<ImportTab>("urls");
  const [feedsUrl, setFeedsUrl] = useState<string | undefined>(undefined);
  const [chatScope, setChatScope] = useState<{ key: string; seq: number } | null>(null);
  /** The article waiting for delete confirmation, and the view that asked. */
  const [deleting, setDeleting] = useState<{ article: ArticleRow; page: boolean } | null>(null);

  // Search mode of the list pane
  const [search, setSearch] = useState<{ query: string; result: SearchResult | null; busy: boolean } | null>(null);
  const [method, setMethod] = useState<SearchMethod>("hybrid");
  const [hitSel, setHitSel] = useState(0);
  const [searchFocus, setSearchFocus] = useState(0);
  const [recent, setRecent] = useState<string[]>(loadRecent);

  // Documents: the pane tree with its tabs, the loaded article views, the pages' state
  const [layout, setLayout] = useState<Layout>(loadLayout);
  useEffect(() => saveLayout(layout), [layout]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  /** Article views of the open Reader tabs, by article id. */
  const [views, setViews] = useState<Map<number, ArticleView>>(() => new Map());
  const viewsRef = useRef(views);
  viewsRef.current = views;
  /** The page tab being added to the Index. */
  const [saving, setSaving] = useState<Id | null>(null);
  const [pageLang, setPageLang] = useState<PageLang>({ mode: "original", percent: 70 });
  // Every page's overlay follows the Page language choice, its tooltips the display language.
  useEffect(() => {
    const o = overlayOf(pageLang);
    browser.setTranslation(o.enabled, o.percent, overlayLabels(t)).catch((e) => setError(String(e)));
  }, [pageLang, t]);
  const [mode, setMode] = useState<LanguageMode>("mixed");
  const [percent, setPercent] = useState(70);

  const fail = (e: unknown) => setError(String(e));
  const refresh = () => {
    setNow(Date.now());
    return Promise.all([
      api.listArticles({ kind: "all" }, sortRef.current).then((a) => { setArticles(a); setLoaded(true); }),
      api.listFeeds().then(setFeeds), api.listTags().then(setTags), api.listGenres().then(setGenres), api.listGroups().then(setGroupRows),
    ]).catch(fail);
  };
  /** Whether the page a tab shows is in the Index. */
  const refreshSaved = (tab: Id, url: string) =>
    api.articleForUrl(url).then((a) => setLayout((l) => update(l, tab, { saved: a?.id ?? null }))).catch(() => {});
  // Background jobs (bulk import fetches) report every article; throttle list reloads to one
  // per 500 ms (a debounce would starve under a steady event stream). The pending call covers later events.
  const refreshTimer = useRef(0);
  const refreshSoon = () => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = 0; void refresh(); }, 500);
  };
  const loadView = (id: number) => api.getArticle(id).then((v) => {
    if (v) setViews((m) => new Map(m).set(id, v));
    // Gone from the library (deleted elsewhere): its tabs go too.
    else setLayout((l) => closeWhere(l, (t) => t.kind === "reader" && t.articleId === id));
  }).catch(fail);
  const loadJobs = () => api.jobOverview()
    .then((o) => setJobFailures(o.counts.filter((c) => c.state === "failed").reduce((n, c) => n + c.count, 0)))
    .catch(() => {});

  useEffect(() => {
    void loadJobs();
    const poll = window.setInterval(loadJobs, JOB_POLL_MS);
    let jobTimer = 0;
    const subs = [
      listen<number>("article-changed", (e) => {
        if (viewsRef.current.has(e.payload)) void loadView(e.payload);
        refreshSoon();
        clearTimeout(jobTimer);
        jobTimer = window.setTimeout(loadJobs, 1000);
      }),
      listen<{ tab: Id; url: string; loading: boolean; can_go_back: boolean; can_go_forward: boolean }>("browser-page", (e) => {
        const { tab, url, loading, can_go_back: canGoBack, can_go_forward: canGoForward } = e.payload;
        setLayout((l) => navigated(l, tab, { url, loading, canGoBack, canGoForward }));
        if (!loading) void refreshSaved(tab, url);
      }),
      listen<{ tab: Id; title: string }>("browser-title", (e) => setLayout((l) => update(l, e.payload.tab, { title: e.payload.title }))),
      // A click in a page focuses its pane, as a click in a Reader does through pointerdown.
      listen<{ tab: Id }>("browser-focus", (e) => {
        const hit = tabById(layoutRef.current, e.payload.tab);
        if (!hit) return;
        setLayout((l) => focusLayout(l, hit.pane.id));
        setKbPane(null);
        pointerPane.current = "doc";
      }),
    ];
    return () => {
      clearInterval(poll);
      clearTimeout(jobTimer);
      subs.forEach((s) => void s.then((f) => f()));
    };
  }, []);
  useEffect(() => { void refresh(); }, [sort]);
  const loadReview = () => api.reviewOverview().then((o) => setReviewDue(o.due)).catch(() => {});
  useEffect(() => {
    void loadReview();
    const poll = window.setInterval(loadReview, JOB_POLL_MS);
    return () => clearInterval(poll);
  }, []);

  // Reader tabs need their article views; views of closed tabs are dropped.
  const readerIds = useMemo(() => [...new Set(allTabs(layout).filter((t) => t.kind === "reader").map((t) => t.articleId))], [layout]);
  const readerKey = readerIds.join(",");
  useEffect(() => {
    for (const id of readerIds) if (!viewsRef.current.has(id)) void loadView(id);
    setViews((m) => ([...m.keys()].every((id) => readerIds.includes(id)) ? m : new Map([...m].filter(([id]) => readerIds.includes(id)))));
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per change of the set of open articles
  }, [readerKey]);
  // Page tabs that closed (or show a Reader now) give up their webview.
  const pageIds = useMemo(() => allTabs(layout).filter((t) => t.kind === "page").map((t) => t.id), [layout]);
  const pageKey = pageIds.join(",");
  const prevPages = useRef<Id[]>([]);
  useEffect(() => {
    for (const id of prevPages.current) if (!pageIds.includes(id)) browser.close(id).catch(() => {});
    prevPages.current = pageIds;
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per change of the set of page tabs
  }, [pageKey]);

  // ---- derived library --------------------------------------------------------------------
  const { scoped, shown } = useMemo(() => listed(articles, scope, facets, now, kept), [articles, scope, facets, now, kept]);
  const groups: Group<ArticleRow>[] = useMemo(
    () => (group === "none" ? [{ key: "all", label: "", articles: shown }] : groupArticles(shown, group, t)), [shown, group, t]);
  const order = useMemo(() => flatten(groups), [groups]);
  const counts: NavCounts = useMemo(() => {
    const unread = articles.filter((a) => a.read_status === "unread");
    return {
      recent: articles.filter((a) => inScope(a, { kind: "recent" }, now)).length,
      unread: unread.length,
      favorites: articles.filter((a) => a.favorite).length,
      all: articles.length,
      manual: articles.filter((a) => a.feed_id == null).length,
      genres: [...countBy(articles, "genres")].sort((a, b) => (a[0] == null ? 1 : b[0] == null ? -1 : b[1] - a[1])),
      feedUnread: countBy(unread, "feeds"),
    };
  }, [articles, now]);
  // The taskbar badge follows the unread count; reading through a list changes it in bursts.
  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => api.setUnreadBadge(counts.unread).catch(() => {}), 500);
    return () => window.clearTimeout(t);
  }, [counts.unread, loaded]);
  const relax = useMemo(() => (shown.length === 0 && articles.length > 0 ? relaxations(articles, groupRows, scope, facets, now, t) : []),
    [shown.length, articles, groupRows, scope, facets, now, t]);
  const articleById = useMemo(() => new Map(articles.map((a) => [a.id, a])), [articles]);
  const hitGroups = useMemo(() => {
    if (!search?.result) return [];
    const ids = new Set(shown.map((a) => a.id));
    return groupHits(filterHits(search.result.hits, method, ids));
  }, [search, method, shown]);
  const flatHits = useMemo(() => hitGroups.flatMap((g) => g.hits), [hitGroups]);
  const chatGroups = useMemo(() => filterGroups(groupRows, genres, feeds, tags, t), [groupRows, genres, feeds, tags, t]);

  // The focused pane's active tab is what shortcuts, the chat and the list selection refer to.
  const cur = activeTab(focusedPane(layout));
  const curView = cur?.kind === "reader" ? views.get(cur.articleId) : undefined;
  const savedOf = (t: PageTab) => (t.saved == null ? null : articleById.get(t.saved) ?? null);
  const current: ArticleRow | null = cur?.kind === "reader" ? curView?.article ?? articleById.get(cur.articleId) ?? null : cur?.kind === "page" ? savedOf(cur) : null;
  const selectedId = current?.id ?? null;

  // Opening an article reads it; a row it had in the list stays there (kept) until the view changes.
  const listView = viewKey(scope, facets);
  useEffect(() => setKept(NO_KEPT), [listView, screen]);
  const openId = selectedId;
  const [cursor, setCursor] = useState<number | null>(null);
  useEffect(() => { if (openId != null) setCursor(openId); }, [openId]);
  useEffect(() => {
    const a = openId == null ? undefined : articleById.get(openId);
    if (a?.read_status !== "unread") return;
    if (shown.some((x) => x.id === a.id)) setKept((k) => keep(k, listView, a.id));
    void act(() => api.setRead(a.id, true), a.id);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- mark read once per opened article
  }, [openId]);

  // ---- navigation -------------------------------------------------------------------------
  function setScope(s: Scope) {
    setScopeState(s);
    setFacets(NO_FACETS);
    setScreen("library");
    if (search?.query) void runSearch(search.query, s);
  }

  async function runSearch(q: string, s: Scope = scope) {
    setScreen("library");
    setListOpen(true);
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
      const result = await api.search(q, toFilter(s));
      setSearch((cur) => (cur?.query === q ? { query: q, result, busy: false } : cur));
    } catch (e) {
      fail(e);
      setSearch((cur) => cur && { ...cur, busy: false });
    }
  }

  function enterSearch() {
    setScreen("library");
    setListOpen(true);
    setSearch((s) => s ?? { query: "", result: null, busy: false });
    setSearchFocus((n) => n + 1);
  }

  function openHit(h: SearchHit, page = false, newTab = false) {
    const a = articleById.get(h.article_id);
    const where: Where = newTab ? "new" : "active";
    if (page && a) return openPage(a.original_url, h.text, a, where);
    openReader(h.article_id, { block: h.block_id, label: t("app.searchHit", { label: t(MATCH_LABEL[h.source]) }), terms: terms(search?.query ?? ""), tone: "hit" }, where);
  }

  /** `article`: the saved article being opened, highlighted right away rather than after the page loads. `pane`: not the focused one. */
  function openPage(url: string, focus?: string, article?: ArticleRow, where: Where = "active", pane?: Id) {
    // An imported file has no page: it stays in the Reader.
    if (isLocal(url)) return article ? openReader(article.id, undefined, where, pane) : setError(t("reader.pageDisabled"));
    setError(null);
    setScreen("library");
    setLayout((l) => open(l, { kind: "page", url, focus, title: article?.title ?? "", saved: article?.id ?? null }, where, pane));
  }

  function openReader(id: number, focus?: Omit<Focus, "seq">, where: Where = "active", pane?: Id) {
    setError(null);
    setScreen("library");
    setLayout((l) => open(l, { kind: "reader", articleId: id, focus }, where, pane));
  }

  /** Opens in the view the focused document uses (Reader by default). */
  function openArticle(a: ArticleRow, newTab = false) {
    const where: Where = newTab ? "new" : "active";
    if (cur?.kind === "page") openPage(a.original_url, undefined, a, where);
    else openReader(a.id, undefined, where);
  }

  // ---- cursor: j / k move it through the list (or the search hits) without opening; Enter opens it.
  /** After the cursor moves: keep it in view, and keep DOM focus on it while the list pane has focus. */
  function revealCursor() {
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(".row.cur, .hit.cur");
      el?.scrollIntoView({ block: "nearest" });
      if (el && paneOf(document.activeElement)?.dataset.pane === "list") el.focus({ preventScroll: true });
    });
  }

  function moveCursor(d: 1 | -1) {
    if (search) {
      if (flatHits.length) setHitSel(Math.max(0, Math.min(flatHits.length - 1, hitSel + d)));
    } else if (order.length) {
      const i = order.findIndex((a) => a.id === (cursor ?? selectedId));
      setCursor(order[i < 0 ? (d > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, i + d))].id);
    }
    revealCursor();
  }

  function openCursor(asPage: boolean) {
    if (search) return flatHits[hitSel] && openHit(flatHits[hitSel], asPage);
    const a = cursor == null ? undefined : articleById.get(cursor);
    if (a && asPage) openPage(a.original_url, undefined, a);
    else if (a) openArticle(a);
  }

  function toggleView() {
    if (cur?.kind === "reader" && curView) openPage(curView.article.original_url, undefined, curView.article);
    else if (cur?.kind === "page" && current) openReader(current.id);
  }

  /** Chat citation: the cited block in the Reader; the page when the article is no longer in the library. */
  function openCitation(c: Citation) {
    if (articleById.has(c.article_id)) openReader(c.article_id, { block: c.block_id, label: t("app.citation", { n: c.n }), terms: [], tone: "cite" });
    else if (c.url) openPage(c.url, c.text);
    else setError(t("app.citationDeleted"));
  }

  // ---- article actions ----------------------------------------------------------------------
  async function act(task: () => Promise<unknown>, id?: number) {
    try {
      await task();
      const pages = allTabs(layoutRef.current).filter((t): t is PageTab => t.kind === "page");
      await Promise.all([refresh(), id != null && viewsRef.current.has(id) && loadView(id), ...pages.map((t) => refreshSaved(t.id, t.url))]);
    } catch (e) {
      fail(e);
    }
  }
  const toggleFavorite = (a: ArticleRow) => act(() => api.setFavorite(a.id, !a.favorite), a.id);
  const toggleRead = (a: ArticleRow) => act(() => api.setRead(a.id, a.read_status !== "read"), a.id);

  // ---- groups (G53) -------------------------------------------------------------------------
  async function createGroup(name: string) {
    const id = await api.createGroup(name);
    await refresh();
    return id;
  }
  async function groupMembers(group: number, ids: number[], add: boolean) {
    await act(() => (add ? api.groupAdd(group, ids) : api.groupRemove(group, ids)));
    for (const id of ids) if (viewsRef.current.has(id)) void loadView(id);
  }
  async function deleteGroup(id: number) {
    await act(() => api.deleteGroup(id));
    if (scope.kind === "group" && scope.id === id) setScope({ kind: "all" });
    setFacets((f) => ({ ...f, groups: f.groups.filter((g) => g !== id) }));
  }

  async function deleteArticle(a: ArticleRow) {
    setDeleting(null);
    try {
      await api.deleteArticle(a.id);
      setViews((m) => { const n = new Map(m); n.delete(a.id); return n; });
      setLayout((l) => {
        const kept = closeWhere(l, (t) => t.kind === "reader" && t.articleId === a.id);
        return allTabs(kept).filter((t) => t.kind === "page" && t.saved === a.id).reduce((acc, t) => update(acc, t.id, { saved: null }), kept);
      });
      await refresh();
    } catch (e) {
      fail(e);
    }
  }

  async function savePage(t: PageTab) {
    setSaving(t.id);
    try {
      await api.savePage(t.id);
      await Promise.all([refresh(), refreshSaved(t.id, t.url)]);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(null);
    }
  }


  function nudgeRatio(delta: number) {
    if (cur?.kind === "page") setPageLang({ mode: "mixed", percent: Math.max(0, Math.min(100, pageLang.percent + delta)) });
    else {
      setMode("mixed");
      setPercent((p) => Math.max(0, Math.min(100, p + delta)));
    }
  }

  function openChat(key?: string) {
    setChatOpen(true);
    if (key) setChatScope((c) => ({ key, seq: (c?.seq ?? 0) + 1 }));
  }

  function setLang(m: LanguageMode, p?: number) {
    if (cur?.kind === "page") setPageLang({ mode: m, percent: p ?? pageLang.percent });
    else {
      setMode(m);
      if (p != null) setPercent(p);
    }
  }

  function importMarkdown() {
    setImportTab("markdown");
    setScreen("import");
  }

  function importPdf() {
    setImportTab("pdf");
    setScreen("import");
  }

  /** The palette for a new tab in `pane`: what it opens goes into a new tab there. */
  function newTab(pane?: Id) {
    if (pane != null) setLayout((l) => focusLayout(l, pane));
    paletteNew.current = true;
    setPalette("");
  }
  const whereFromPalette = (newTab?: boolean): Where => (newTab || paletteNew.current ? "new" : "active");

  const paletteActions: PaletteActions = {
    scope: setScope,
    facets: (f) => { setFacets(f); setScreen("library"); },
    open: (a, t) => openReader(a.id, undefined, whereFromPalette(t)),
    page: (url, t) => openPage(url, undefined, undefined, whereFromPalette(t)),
    index: (url, group) => {
      const where = whereFromPalette();
      void act(async () => {
        const id = await api.saveUrl(url);
        if (group != null) await api.groupAdd(group, [id]);
        openReader(id, undefined, where);
      });
    },
    discover: (url) => { setFeedsUrl(url); setScreen("feeds"); },
    search: (q) => void runSearch(q),
    screen: setScreen,
    importMarkdown,
    importPdf,
    chat: openChat,
    lang: setLang,
    translate: current ? () => void act(() => api.translateArticle(current.id), current.id) : null,
    addToGroup: cur?.kind === "reader" ? () => setGroupRequest((r) => ({ tab: cur.id, seq: (r?.seq ?? 0) + 1 })) : null,
  };

  // ---- keyboard -----------------------------------------------------------------------------
  const bindings = useBindings();
  useEffect(() => { browser.setKeys(pageKeys(bindings)).catch(() => {}); }, [bindings]);
  /** tmux-style prefix (Ctrl+B): armed until the next key or PREFIX_MS. */
  const [prefix, setPrefix] = useState(false);
  const prefixTimer = useRef(0);
  /** The pane keyboard focus was moved to, outlined until the pointer is used. */
  const [kbPane, setKbPane] = useState<string | null>(null);
  /** The pane last clicked; arrows scroll there instead of moving the list cursor when it is the document or chat. */
  const pointerPane = useRef<string | null>(null);
  useEffect(() => {
    const focusin = (e: FocusEvent) => setKbPane((p) => p && (paneOf(e.target as Element)?.dataset.pane ?? null));
    const pointer = (e: PointerEvent) => {
      setKbPane(null);
      const p = paneOf(e.target as Element);
      pointerPane.current = p?.dataset.pane ?? null;
      // A click in a document pane focuses it: that is where the next document opens.
      if (p?.dataset.paneId) setLayout((l) => focusLayout(l, Number(p.dataset.paneId)));
    };
    window.addEventListener("focusin", focusin);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("focusin", focusin);
      window.removeEventListener("pointerdown", pointer, true);
    };
  }, []);

  /** tmux keys after the prefix that act on panes and tabs rather than move. */
  const PREFIXED: Record<string, ActionId | "closePane"> = { '"': "splitDown", "%": "splitRight", X: "closePane", C: "newTab", N: "nextTab", P: "prevTab", Z: "focus" };

  /** True when focus moved to another pane. */
  function paneKey(key: string, from = paneOf(document.activeElement)): boolean {
    clearTimeout(prefixTimer.current);
    setPrefix(false);
    const act = PREFIXED[key];
    if (act === "closePane") {
      setLayout((l) => closePane(l, l.focused));
      return false;
    }
    if (act) {
      actions[act]();
      return false;
    }
    const p = paneAfter(key, from);
    if (!p) return false;
    focusPane(p);
    setKbPane(p.dataset.pane!);
    if (p.dataset.paneId) setLayout((l) => focusLayout(l, Number(p.dataset.paneId)));
    return true;
  }

  const step = (d: 1 | -1) => {
    const nav = paneOf(document.activeElement);
    if (nav?.dataset.pane === "nav") {
      stepNav(nav, d);
      setKbPane("nav");
    } else moveCursor(d);
  };

  const actions: Record<ActionId, () => void> = {
    palette: () => setPalette((p) => (p == null ? "" : null)),
    search: enterSearch,
    next: () => step(1),
    prev: () => step(-1),
    open: () => openCursor(false),
    openPage: () => openCursor(true),
    pane: () => {
      setPrefix(true);
      clearTimeout(prefixTimer.current);
      prefixTimer.current = window.setTimeout(() => setPrefix(false), PREFIX_MS);
    },
    favorite: () => void (current && toggleFavorite(current)),
    read: () => void (current && toggleRead(current)),
    focus: () => {
      const collapse = navOpen || listOpen;
      setNavOpen(!collapse);
      setListOpen(!collapse);
    },
    view: toggleView,
    less: () => nudgeRatio(-10),
    more: () => nudgeRatio(10),
    escape: () => {
      if (screen !== "library") setScreen("library");
      else if (search) setSearch(null);
      else setFacets((f) => (activeDims(f).length ? NO_FACETS : f));
    },
    newTab: () => newTab(),
    closeTab: () => setLayout((l) => {
      const t = activeTab(focusedPane(l));
      return t ? close(l, t.id) : l;
    }),
    nextTab: () => setLayout((l) => cycle(l, 1)),
    prevTab: () => setLayout((l) => cycle(l, -1)),
    splitRight: () => { setScreen("library"); setLayout((l) => split(l, l.focused, "row")); },
    splitDown: () => { setScreen("library"); setLayout((l) => split(l, l.focused, "column")); },
  };
  const keyState = useRef({ actions, paneKey, prefix, overlays: overlays.length });
  keyState.current = { actions, paneKey, prefix, overlays: overlays.length };
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const key = keyOf(e);
      if (!key) return;
      const s = keyState.current;
      if (s.prefix) {
        e.preventDefault();
        s.paneKey(key);
        return;
      }
      const action = actionFor(getBindings(), key);
      if (!action) return;
      // An open popover, menu or the palette owns the keys (j / k move inside it); Ctrl+K still toggles the palette.
      if (s.overlays && action.id !== "palette") return;
      const t = e.target as HTMLElement;
      // A drag handle being moved with the keyboard owns the arrows, Space and Enter.
      if (t.closest("[aria-roledescription='sortable']")) return;
      const inField = t.closest("input, textarea, select, [contenteditable='true']");
      if (inField && !action.inFields) return;
      const focused = document.activeElement !== document.body ? paneOf(document.activeElement)?.dataset.pane : pointerPane.current;
      if (key.startsWith("Arrow") && (focused === "doc" || focused === "chat")) return;
      // Esc in a field only leaves the field; panes that own an Esc (palette, search) handle it first.
      if (inField && action.id === "escape") return t.blur();
      // Enter on a control activates it; on a list row or search hit it opens the cursor.
      if ((action.id === "open" || action.id === "openPage") && t.closest("button, a, [role='button']") && !t.closest(".row, .hit")) return;
      // Plain keys on a focused button would also activate it.
      e.preventDefault();
      s.actions[action.id]();
    };
    // A shortcut the page overlay forwarded: keyboard focus is in that page's pane.
    const fromPage = ({ tab, key }: { tab: Id; key: string }) => {
      const s = keyState.current;
      const focusApp = () => getCurrentWebview().setFocus().catch(() => {});
      // What the app focused last is stale (j / k in the nav would step the nav).
      (document.activeElement as HTMLElement | null)?.blur();
      const pane = tabById(layoutRef.current, tab)?.pane.id;
      if (pane != null) setLayout((l) => focusLayout(l, pane));
      if (s.prefix) {
        if (s.paneKey(key, document.querySelector<HTMLElement>(`[data-pane-id='${pane}']`))) void focusApp();
        return;
      }
      const action = actionFor(getBindings(), key);
      if (!action || (s.overlays && action.id !== "palette")) return;
      if (LEAVES_PAGE.has(action.id)) void focusApp();
      s.actions[action.id]();
    };
    window.addEventListener("keydown", down);
    const unlisten = listen<{ tab: Id; key: string }>("browser-key", (e) => fromPage(e.payload));
    return () => {
      window.removeEventListener("keydown", down);
      void unlisten.then((f) => f());
    };
  }, []);

  // ---- render ---------------------------------------------------------------------------------
  const title = scopeLabel(scope, articles, groupRows, t);
  // Only the open article's job progress is known to the UI (the list has no per-article job data).
  const tjob = curView?.jobs.find((j) => j.type === "translate");
  const translatingRow = curView && tjob && (tjob.status === "running" || (tjob.status === "pending" && !tjob.last_error)) ? {
    id: curView.article.id,
    label: t("app.translating", { length: curView.blocks.filter((b) => b.translation != null).length, length2: curView.blocks.filter((b) => TRANSLATABLE.has(b.kind)).length }),
  } : null;
  const docHits = search && cur?.kind === "reader" ? flatHits.filter((h) => h.article_id === cur.articleId) : [];
  const readerMatches = docHits.length > 0 && cur?.kind === "reader" ? {
    i: docHits.findIndex((h) => h.block_id === cur.focus?.block),
    n: docHits.length,
    onStep: (d: 1 | -1) => {
      const at = docHits.findIndex((h) => h.block_id === cur.focus?.block);
      const h = docHits[Math.max(0, Math.min(docHits.length - 1, at + d))];
      setHitSel(flatHits.indexOf(h));
      openHit(h);
    },
  } : undefined;
  const chatArticle = current && { id: current.id, title: current.title ?? current.original_url };
  const splitter = (pane: Resizable, side: "left" | "right" = "left") => (
    <Splitter pane={pane} side={side} width={widths[pane]} onWidth={(w) => setWidths((ws) => ({ ...ws, [pane]: w }))} />
  );
  const nav = navOpen
    ? <><Nav screen={screen} scope={screen === "library" ? scope : null} counts={counts} feeds={feeds} groups={groupRows} jobFailures={jobFailures} reviewDue={reviewDue}
        chatOpen={chatOpen} searching={!!search} recentSearches={recent} onScope={setScope} onScreen={setScreen} onPalette={() => setPalette("")}
        onOpenUrl={() => setPalette("")} onMarkdown={importMarkdown} onChat={() => setChatOpen((o) => !o)} onRecent={(q) => runSearch(q)} onGenres={() => { setSettingsSection("genres"); setScreen("settings"); }}
        onCreateGroup={(name) => createGroup(name).then((id) => setScope({ kind: "group", id })).catch(fail)}
        onRenameGroup={(id, name) => act(() => api.renameGroup(id, name))} onDeleteGroup={deleteGroup}
        onCollapse={() => setNavOpen(false)} />{splitter("nav")}</>
    : <NavRail scope={screen === "library" ? scope : null} chatOpen={chatOpen} onOpen={() => setNavOpen(true)} onPalette={() => setPalette("")}
        onScope={setScope} onChat={() => setChatOpen((o) => !o)} />;

  const labelOf = (t: Tab): TabLabel => {
    if (t.kind === "page") return { title: t.title || hostOf(t.url) || t.url, domain: hostOf(t.url) };
    const a = views.get(t.articleId)?.article ?? articleById.get(t.articleId);
    return { title: a?.title ?? a?.original_url ?? "…", domain: a?.domain ?? "", feed: a?.feed_id };
  };

  const renderPane = (pane: Pane) => {
    const tab = activeTab(pane);
    if (!tab) {
      if (!loaded) return null;
      if (articles.length || layout.root.kind === "split") return <p className="doc-empty muted">{t("app.pickArticle")}</p>;
      return <FirstRun onPaste={() => setPalette("")} onFeeds={() => setScreen("feeds")} onImport={() => { setImportTab("urls"); setScreen("import"); }} onMarkdown={importMarkdown}
        onSettings={() => { setSettingsSection("provider"); setScreen("settings"); }} />;
    }
    if (tab.kind === "page") {
      const saved = savedOf(tab);
      return (
        <BrowserView key={tab.id} tab={tab} saved={saved} saving={saving === tab.id} lang={pageLang} overlays={overlays}
          onNavigate={(url) => openPage(url, undefined, undefined, "active", pane.id)} onLang={setPageLang} onSave={() => savePage(tab)}
          onReader={() => saved && openReader(saved.id, undefined, "active", pane.id)}
          onFavorite={() => saved && toggleFavorite(saved)} onDelete={() => saved && setDeleting({ article: saved, page: true })} onError={fail} />
      );
    }
    const v = views.get(tab.articleId);
    if (!v) return null;
    const a = v.article;
    const vAct = (task: (id: number) => Promise<unknown>) => () => act(() => task(a.id), a.id);
    return (
      <Reader key={a.id} view={v} focus={tab.focus} matches={tab === cur ? readerMatches : undefined} mode={mode} percent={percent} onLang={(m, p) => { setMode(m); setPercent(p); }}
        focusMode={!navOpen && !listOpen} onFocusMode={actions.focus}
        onAsk={() => openChat("article")}
        onPage={() => openPage(a.original_url, undefined, a, "active", pane.id)} onLink={(href, nt) => openPage(href, undefined, undefined, nt ? "new" : "active", pane.id)}
        onToggleRead={() => toggleRead(a)} onRetry={vAct(() => api.saveUrl(a.original_url))}
        onReextract={vAct(api.reextractArticle)} onRender={vAct(api.renderArticle)} onTranslate={vAct(api.translateArticle)}
        onRetranslate={vAct(api.retranslateArticle)}
        onSummarize={vAct(api.summarizeArticle)} onFavorite={() => toggleFavorite(a)}
        onTag={(name, add) => act(() => (add ? api.addTag(a.id, name) : api.removeTag(a.id, name)), a.id)}
        onGenre={(name) => act(() => api.setGenre(a.id, name), a.id)}
        onDifficulty={(level) => act(() => api.setDifficulty(a.id, level), a.id)}
        onClassify={vAct(api.classifyArticle)} onDelete={() => setDeleting({ article: a, page: false })}
        onFocusBlock={(block, label) => openReader(a.id, { block, label, terms: [], tone: "cite" }, "active", pane.id)} onReviewChanged={loadReview}
        groups={groupRows} onGroup={(id, add) => groupMembers(id, [a.id], add)} onCreateGroup={createGroup} groupRequest={groupRequest?.tab === tab.id ? groupRequest.seq : 0} />
    );
  };

  return (
    <CoverContext.Provider value={cover}>
      <div className="shell">
        <TitleBar />
        <UpdateNotice onOpenUrl={(url) => openPage(url)} />
        <div className="app" data-kb-pane={kbPane ?? undefined} style={{ "--nav-w": `${widths.nav}px`, "--list-w": `${widths.list}px`, "--search-w": `${widths.search}px`, "--chat-w": `${widths.chat}px` } as React.CSSProperties}>
          {screen === "settings"
            ? <SettingsView initialSection={settingsSection} onBack={() => setScreen("library")} onFeeds={() => setScreen("feeds")} onChanged={refresh}
                onOpenUrl={(url) => openPage(url)} />
            : nav}
          {(screen === "import" || screen === "feeds" || screen === "jobs" || screen === "review") && (
            <main className="main" data-pane="doc">
              {screen === "import" && <ImportView tab={importTab} onTab={setImportTab} onImported={refresh} onOpen={(id) => { void refresh(); openReader(id); }}
                groups={groupRows} initialGroups={scope.kind === "group" ? [scope.id] : []} onCreateGroup={createGroup} />}
              {screen === "feeds" && <FeedsView key={feedsUrl} articles={articles} onChanged={refreshSoon} initialUrl={feedsUrl}
                onShowFeed={(id) => setScope({ kind: "feed", id })} />}
              {screen === "jobs" && <JobsView />}
              {screen === "review" && <QuizReview onChanged={loadReview}
                onOpen={(id, block) => openReader(id, block == null ? undefined : { block, label: t("reader.quizSource"), terms: [], tone: "cite" })} />}
            </main>
          )}
          {screen === "library" && search && listOpen && (
            <SearchPane initial={search.query} result={search.result} busy={search.busy} method={method} onMethod={setMethod}
              hits={hitGroups} sel={hitSel} onSel={setHitSel} open={cur?.kind === "reader" && cur.focus?.tone === "hit" ? { id: cur.articleId, block: cur.focus.block } : null} onSearch={(q) => runSearch(q)} onOpen={openHit} onExit={() => setSearch(null)}
              scope={scope} onScope={setScope} facets={facets} onFacets={setFacets} scoped={scoped} all={articles} groups={groupRows} articleById={articleById}
              focusSeq={searchFocus} />
          )}
          {screen === "library" && search && listOpen && splitter("search")}
          {screen === "library" && !(search && listOpen) && (listOpen
            ? <ListPane title={title} count={shown.length} total={scoped.length} facets={facets} onFacets={setFacets} scoped={scoped}
                all={articles} groups={groups} groupRows={groupRows} sort={sort} onSort={setSort} group={group} onGroup={setGroup} selectedId={selectedId} cursorId={cursor} onCursor={setCursor}
                translating={translatingRow} relax={relax} onRelax={(r) => { setScopeState(r.scope); setFacets(r.facets); }} onOpen={openArticle}
                onGroupMembers={groupMembers} onCreateGroup={createGroup} onCollapse={() => setListOpen(false)} />
            : <ListRail label={[title, ...activeDims(facets).map((d) => facetLabel(facets, d, articles, groupRows, t))].join(" · ")} index={order.findIndex((a) => a.id === (cursor ?? selectedId)) + 1}
                count={order.length} onOpen={() => setListOpen(true)} onPrev={() => moveCursor(-1)} onNext={() => moveCursor(1)} />)}
          {screen === "library" && !search && listOpen && splitter("list")}
          {screen === "library" && <div className="doc-area-wrap">
            {error && (
              <div className="banner" role="alert">
                <span className="grow">{t.msg(error)}</span>
                <button className="ib" onClick={() => setError(null)} aria-label={t("common.close")}>×</button>
              </div>
            )}
            <DocArea layout={layout} onLayout={setLayout} labelOf={labelOf} renderPane={renderPane} onNew={newTab} />
          </div>}
          {palette != null && (
            <Palette initial={palette} all={articles} shown={shown} feeds={feeds} groups={groupRows} scope={scope} facets={facets} actions={paletteActions}
              onClose={() => setPalette(null)} />
          )}
          {deleting && (
            <ConfirmDialog title={deleting.page ? t("app.confirmRemove") : t("app.confirmDelete")} confirm={t("common.delete")}
              onConfirm={() => deleteArticle(deleting.article)} onCancel={() => setDeleting(null)}>
              <p>{t.rich("app.deleteWhat", { x: deleting.article.title ?? deleting.article.original_url })}</p>
              <p>{t("app.deleteDesc")}</p>
            </ConfirmDialog>
          )}
          {prefix && <PrefixHint prefix={keyLabel(bindings.pane[0] ?? "Ctrl+B")} />}
          {chatOpen && splitter("chat", "right")}
          {chatOpen && (
            <ChatPane article={chatArticle} groups={chatGroups} request={chatScope} onCite={openCitation} onClose={() => setChatOpen(false)}
              current={scope.kind === "all" || scope.kind === "recent" ? null : { key: filterKey(toFilter(scope)), label: title }} />
          )}
        </div>
      </div>
    </CoverContext.Provider>
  );
}
