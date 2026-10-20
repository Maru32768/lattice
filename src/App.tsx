import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, browser, isLocal, type ArticleRow, type ArticleSort, type ArticleView, type Citation, type FeedRow, type SearchHit, type SearchResult } from "./api";
import { BrowserView, overlayOf, type BrowseTarget, type PageLang, type PageState } from "./BrowserView";
import type { LanguageMode } from "./mixed";

import { ImportView, type ImportTab } from "./ImportView";
import { SettingsView, type SettingsSection } from "./SettingsView";
import { FeedsView } from "./FeedsView";
import { JobsView } from "./JobsView";
import { ChatPane } from "./ChatPane";
import { filterGroups, filterKey } from "./scopes";
import { groupArticles, type Group } from "./groups";
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
import "./App.css";

type Doc = null | { kind: "reader"; id: number; focus?: Focus } | { kind: "page"; target: BrowseTarget };

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
const LEAVES_PAGE = new Set<ActionId>(["palette", "search", "view"]);

/** States board #8: an empty library. */
function FirstRun({ onPaste, onFeeds, onImport, onMarkdown, onSettings }: {
  onPaste: () => void; onFeeds: () => void; onImport: () => void; onMarkdown: () => void; onSettings: () => void;
}) {
  return (
    <section className="first-run" aria-label="最初の記事を入れる">
      <h1>最初の記事を入れる</h1>
      <div className="first-cards">
        <button className="btn" onClick={onPaste}><span className="h">URL を貼る</span><span className="muted"><Kbd>Ctrl</Kbd><Kbd>K</Kbd> に貼り付けて Index</span></button>
        <button className="btn" onClick={onFeeds}><span className="h">フィードを登録</span><span className="muted">サイト URL か OPML</span></button>
        <button className="btn" onClick={onImport}><span className="h">一括インポート</span><span className="muted">ブックマーク HTML・CSV・JSON</span></button>
        <button className="btn" onClick={onMarkdown}><span className="h">Markdown を取り込む</span><span className="muted">ファイルか貼り付け</span></button>
      </div>
      <p className="muted">翻訳・要約・分類には AI プロバイダが必要です — <button className="linkish" onClick={onSettings}>設定する</button>。取り込みと全文検索はなしで使えます。</p>
    </section>
  );
}

/** Shown while the pane prefix is armed. */
function PrefixHint({ prefix }: { prefix: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useCover(ref, true);
  return (
    <div ref={ref} className="prefix-hint" role="status">
      <Kbd>{prefix}</Kbd>
      <span><Kbd>←</Kbd><Kbd>→</Kbd> <Kbd>h</Kbd><Kbd>l</Kbd> ペイン移動</span>
      <span><Kbd>o</Kbd> 次のペイン</span>
      <span><Kbd>z</Kbd> フォーカスモード</span>
    </div>
  );
}

export default function App() {
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);
  const [genres, setGenres] = useState<{ name: string; count: number }[]>([]);
  const [sort, setSort] = useState<ArticleSort>("saved_desc");
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const [group, setGroup] = useState<Grouping>("none");
  const [scope, setScopeState] = useState<Scope>({ kind: "all" });
  const [facets, setFacets] = useState<Facets>(NO_FACETS);
  const [kept, setKept] = useState<Kept>(NO_KEPT);
  const [screen, setScreen] = useState<Screen>("library");
  const [doc, setDoc] = useState<Doc>(null);
  const [navOpen, setNavOpen] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [widths, setWidths] = useState<PaneWidths>(loadWidths);
  useEffect(() => saveWidths(widths), [widths]);
  const [jobFailures, setJobFailures] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Rectangles of open overlays (popovers, menus, palette); the page webview hides under them. */
  const [overlays, setOverlays] = useState<DOMRect[]>([]);
  const cover = useCallback((r: DOMRect) => {
    setOverlays((o) => [...o, r]);
    return () => setOverlays((o) => o.filter((x) => x !== r));
  }, []);
  const [now, setNow] = useState(() => Date.now());
  /** Open palette's initial query. */
  const [palette, setPalette] = useState<string | null>(null);
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

  // Page (in-app browser)
  const [page, setPage] = useState<PageState | null>(null);
  const [saved, setSaved] = useState<ArticleRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [pageLang, setPageLangState] = useState<PageLang>({ mode: "original", percent: 70 });

  // Reader
  const [view, setView] = useState<ArticleView | null>(null);
  const [mode, setMode] = useState<LanguageMode>("mixed");
  const [percent, setPercent] = useState(70);
  const viewId = useRef<number | null>(null);

  const fail = (e: unknown) => setError(String(e));
  const refresh = () => {
    setNow(Date.now());
    return Promise.all([
      api.listArticles({ kind: "all" }, sortRef.current).then((a) => { setArticles(a); setLoaded(true); }),
      api.listFeeds().then(setFeeds), api.listTags().then(setTags), api.listGenres().then(setGenres),
    ]).catch(fail);
  };
  const refreshSaved = (url: string) => api.articleForUrl(url).then(setSaved).catch(() => setSaved(null));
  // Background jobs (bulk import fetches) report every article; throttle list reloads to one
  // per 500 ms (a debounce would starve under a steady event stream). The pending call covers later events.
  const refreshTimer = useRef(0);
  const refreshSoon = () => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = 0; void refresh(); }, 500);
  };
  const loadView = (id: number) => {
    viewId.current = id;
    return api.getArticle(id).then((v) => { if (viewId.current === id) setView(v); }).catch(fail);
  };
  const loadJobs = () => api.jobOverview()
    .then((o) => setJobFailures(o.counts.filter((c) => c.state === "failed").reduce((n, c) => n + c.count, 0)))
    .catch(() => {});

  useEffect(() => {
    void loadJobs();
    const poll = window.setInterval(loadJobs, JOB_POLL_MS);
    let jobTimer = 0;
    const subs = [
      listen<number>("article-changed", (e) => {
        if (e.payload === viewId.current) void loadView(e.payload);
        refreshSoon();
        clearTimeout(jobTimer);
        jobTimer = window.setTimeout(loadJobs, 1000);
      }),
      listen<{ url: string; loading: boolean; can_go_back: boolean; can_go_forward: boolean }>("browser-page", (e) => {
        const { url, loading, can_go_back: canGoBack, can_go_forward: canGoForward } = e.payload;
        setPage((p) => ({ url, loading, canGoBack, canGoForward, title: p?.url === url ? p.title : "" }));
        if (!e.payload.loading) void refreshSaved(e.payload.url);
      }),
      listen<string>("browser-title", (e) => setPage((p) => (p ? { ...p, title: e.payload } : p))),
    ];
    return () => {
      clearInterval(poll);
      clearTimeout(jobTimer);
      subs.forEach((s) => void s.then((f) => f()));
    };
  }, []);
  useEffect(() => { void refresh(); }, [sort]);

  // ---- derived library --------------------------------------------------------------------
  const { scoped, shown } = useMemo(() => listed(articles, scope, facets, now, kept), [articles, scope, facets, now, kept]);
  const groups: Group<ArticleRow>[] = useMemo(
    () => (group === "none" ? [{ key: "all", label: "", articles: shown }] : groupArticles(shown, group)), [shown, group]);
  const order = useMemo(() => {
    const flat = (g: Group<ArticleRow>): ArticleRow[] => (g.children ? g.children.flatMap(flat) : g.articles);
    return groups.flatMap(flat);
  }, [groups]);
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
  const relax = useMemo(() => (shown.length === 0 && articles.length > 0 ? relaxations(articles, scope, facets, now) : []),
    [shown.length, articles, scope, facets, now]);
  const articleById = useMemo(() => new Map(articles.map((a) => [a.id, a])), [articles]);
  const hitGroups = useMemo(() => {
    if (!search?.result) return [];
    const ids = new Set(shown.map((a) => a.id));
    return groupHits(filterHits(search.result.hits, method, ids));
  }, [search, method, shown]);
  const flatHits = useMemo(() => hitGroups.flatMap((g) => g.hits), [hitGroups]);
  const chatGroups = useMemo(() => filterGroups(genres, feeds, tags), [genres, feeds, tags]);

  const current: ArticleRow | null = doc?.kind === "reader" ? view?.article ?? null : doc?.kind === "page" ? saved : null;
  const selectedId = current?.id ?? null;

  // Opening an article reads it; a row it had in the list stays there (kept) until the view changes.
  const listView = viewKey(scope, facets);
  useEffect(() => setKept(NO_KEPT), [listView, screen]);
  const openId = doc?.kind === "reader" ? doc.id : doc?.kind === "page" ? saved?.id ?? null : null;
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

  function openHit(h: SearchHit, page = false) {
    const a = articleById.get(h.article_id);
    if (page && a) return openPage(a.original_url, h.text, a);
    openReader(h.article_id, { block: h.block_id, label: `検索一致 · ${MATCH_LABEL[h.source]}`, terms: terms(search?.query ?? ""), tone: "hit" });
  }

  /** `article`: the saved article being opened, highlighted right away rather than after the page loads. */
  function openPage(url: string, focus?: string, article?: ArticleRow) {
    // Imported Markdown has no page: it stays in the Reader.
    if (isLocal(url)) return article ? openReader(article.id) : setError("取り込んだ Markdown にはページがありません");
    setError(null);
    setScreen("library");
    // The page already showing (also after a redirect, by its saved article): navigating again would only reload it.
    if (doc?.kind === "page" && !focus && (page?.url === url || (article && saved?.id === article.id))) return;
    setDoc((d) => ({ kind: "page", target: { url, focus, seq: (d?.kind === "page" ? d.target.seq : 0) + 1 } }));
    setPage({ url, title: article?.title ?? "", loading: true });
    setSaved(article ?? null);
  }

  function openReader(id: number, focus?: Omit<Focus, "seq">) {
    setError(null);
    setScreen("library");
    if (doc?.kind === "reader" && doc.id === id && !focus) return;
    if (viewId.current !== id || !view) void loadView(id);
    setDoc((d) => ({ kind: "reader", id, focus: focus && { ...focus, seq: (d?.kind === "reader" ? d.focus?.seq ?? 0 : 0) + 1 } }));
  }

  /** Opens in the view the current document uses (Reader by default). */
  function openArticle(a: ArticleRow) {
    if (doc?.kind === "page") openPage(a.original_url, undefined, a);
    else openReader(a.id);
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
    if (doc?.kind === "reader" && view) openPage(view.article.original_url, undefined, view.article);
    else if (doc?.kind === "page" && saved) openReader(saved.id);
  }

  /** Chat citation: the cited block in the Reader; the page when the article is no longer in the library. */
  function openCitation(c: Citation) {
    if (articleById.has(c.article_id)) openReader(c.article_id, { block: c.block_id, label: `[${c.n}] 引用元`, terms: [], tone: "cite" });
    else if (c.url) openPage(c.url, c.text);
    else setError("引用元の記事は削除されています");
  }

  // ---- article actions ----------------------------------------------------------------------
  async function act(task: () => Promise<unknown>, id?: number) {
    try {
      await task();
      await Promise.all([refresh(), id != null && viewId.current === id && loadView(id), page && refreshSaved(page.url)]);
    } catch (e) {
      fail(e);
    }
  }
  const toggleFavorite = (a: ArticleRow) => act(() => api.setFavorite(a.id, !a.favorite), a.id);
  const toggleRead = (a: ArticleRow) => act(() => api.setRead(a.id, a.read_status !== "read"), a.id);
  const viewAct = (task: (id: number) => Promise<unknown>) => () => view && act(() => task(view.article.id), view.article.id);

  async function deleteArticle(a: ArticleRow) {
    setDeleting(null);
    try {
      await api.deleteArticle(a.id);
      viewId.current = null;
      setView(null);
      setSaved(null);
      setDoc(null);
      await refresh();
    } catch (e) {
      fail(e);
    }
  }

  async function saveCurrent() {
    if (!page) return;
    setSaving(true);
    try {
      await api.savePage();
      await Promise.all([refresh(), refreshSaved(page.url)]);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }

  function setPageLang(l: PageLang) {
    setPageLangState(l);
    const o = overlayOf(l);
    browser.setTranslation(o.enabled, o.percent).catch(fail);
  }

  function nudgeRatio(delta: number) {
    if (doc?.kind === "page") setPageLang({ mode: "mixed", percent: Math.max(0, Math.min(100, pageLang.percent + delta)) });
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
    if (doc?.kind === "page") setPageLang({ mode: m, percent: p ?? pageLang.percent });
    else {
      setMode(m);
      if (p != null) setPercent(p);
    }
  }

  function importMarkdown() {
    setImportTab("markdown");
    setScreen("import");
  }

  const paletteActions: PaletteActions = {
    scope: setScope,
    facets: (f) => { setFacets(f); setScreen("library"); },
    open: (a) => openReader(a.id),
    page: (url) => openPage(url),
    index: (url) => void act(async () => openReader(await api.saveUrl(url))),
    discover: (url) => { setFeedsUrl(url); setScreen("feeds"); },
    search: (q) => void runSearch(q),
    screen: setScreen,
    importMarkdown,
    chat: openChat,
    lang: setLang,
    translate: current ? () => void act(() => api.translateArticle(current.id), current.id) : null,
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
      pointerPane.current = paneOf(e.target as Element)?.dataset.pane ?? null;
    };
    window.addEventListener("focusin", focusin);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("focusin", focusin);
      window.removeEventListener("pointerdown", pointer, true);
    };
  }, []);

  /** True when focus moved to another pane. */
  function paneKey(key: string, from = paneOf(document.activeElement)): boolean {
    clearTimeout(prefixTimer.current);
    setPrefix(false);
    if (key === "Z") {
      actions.focus();
      return false;
    }
    const p = paneAfter(key, from);
    if (!p) return false;
    focusPane(p);
    setKbPane(p.dataset.pane!);
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
    // A shortcut the page overlay forwarded: keyboard focus is in the page, in the doc pane.
    const fromPage = (key: string) => {
      const s = keyState.current;
      const focusApp = () => getCurrentWebview().setFocus().catch(() => {});
      // What the app focused last is stale (j / k in the nav would step the nav).
      (document.activeElement as HTMLElement | null)?.blur();
      if (s.prefix) {
        if (s.paneKey(key, document.querySelector<HTMLElement>("[data-pane='doc']"))) void focusApp();
        return;
      }
      const action = actionFor(getBindings(), key);
      if (!action || (s.overlays && action.id !== "palette")) return;
      if (LEAVES_PAGE.has(action.id)) void focusApp();
      s.actions[action.id]();
    };
    window.addEventListener("keydown", down);
    const unlisten = listen<string>("browser-key", (e) => fromPage(e.payload));
    return () => {
      window.removeEventListener("keydown", down);
      void unlisten.then((f) => f());
    };
  }, []);

  // ---- render ---------------------------------------------------------------------------------
  const title = scopeLabel(scope, articles);
  // Only the open article's job progress is known to the UI (the list has no per-article job data).
  const tjob = view?.jobs.find((j) => j.type === "translate");
  const translatingRow = view && tjob && (tjob.status === "running" || (tjob.status === "pending" && !tjob.last_error)) ? {
    id: view.article.id,
    label: `翻訳中 ${view.blocks.filter((b) => b.translation != null).length}/${view.blocks.filter((b) => TRANSLATABLE.has(b.kind)).length}`,
  } : null;
  const docHits = search && doc?.kind === "reader" ? flatHits.filter((h) => h.article_id === doc.id) : [];
  const readerMatches = docHits.length > 0 && doc?.kind === "reader" ? {
    i: docHits.findIndex((h) => h.block_id === doc.focus?.block),
    n: docHits.length,
    onStep: (d: 1 | -1) => {
      const at = docHits.findIndex((h) => h.block_id === doc.focus?.block);
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
    ? <><Nav screen={screen} scope={screen === "library" ? scope : null} counts={counts} feeds={feeds} jobFailures={jobFailures}
        chatOpen={chatOpen} searching={!!search} recentSearches={recent} onScope={setScope} onScreen={setScreen} onPalette={() => setPalette("")}
        onOpenUrl={() => setPalette("")} onMarkdown={importMarkdown} onChat={() => setChatOpen((o) => !o)} onRecent={(q) => runSearch(q)} onGenres={() => { setSettingsSection("genres"); setScreen("settings"); }}
        onCollapse={() => setNavOpen(false)} />{splitter("nav")}</>
    : <NavRail scope={screen === "library" ? scope : null} chatOpen={chatOpen} onOpen={() => setNavOpen(true)} onPalette={() => setPalette("")}
        onScope={setScope} onChat={() => setChatOpen((o) => !o)} />;


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
          {(screen === "import" || screen === "feeds" || screen === "jobs") && (
            <main className="main" data-pane="doc">
              {screen === "import" && <ImportView tab={importTab} onTab={setImportTab} onImported={refresh} onOpen={(id) => { void refresh(); openReader(id); }} />}
              {screen === "feeds" && <FeedsView key={feedsUrl} articles={articles} onChanged={refreshSoon} initialUrl={feedsUrl}
                onShowFeed={(id) => setScope({ kind: "feed", id })} />}
              {screen === "jobs" && <JobsView />}
            </main>
          )}
          {screen === "library" && search && listOpen && (
            <SearchPane initial={search.query} result={search.result} busy={search.busy} method={method} onMethod={setMethod}
              hits={hitGroups} sel={hitSel} onSel={setHitSel} open={doc?.kind === "reader" && doc.focus?.tone === "hit" ? { id: doc.id, block: doc.focus.block } : null} onSearch={(q) => runSearch(q)} onOpen={openHit} onExit={() => setSearch(null)}
              scope={scope} onScope={setScope} facets={facets} onFacets={setFacets} scoped={scoped} all={articles} articleById={articleById}
              focusSeq={searchFocus} />
          )}
          {screen === "library" && search && listOpen && splitter("search")}
          {screen === "library" && !(search && listOpen) && (listOpen
            ? <ListPane title={title} count={shown.length} total={scoped.length} facets={facets} onFacets={setFacets} scoped={scoped}
                all={articles} groups={groups} sort={sort} onSort={setSort} group={group} onGroup={setGroup} selectedId={selectedId} cursorId={cursor} onCursor={setCursor}
                translating={translatingRow} relax={relax} onRelax={(r) => { setScopeState(r.scope); setFacets(r.facets); }} onOpen={openArticle}
                onCollapse={() => setListOpen(false)} />
            : <ListRail label={[title, ...activeDims(facets).map((d) => facetLabel(facets, d, articles))].join(" · ")} index={order.findIndex((a) => a.id === (cursor ?? selectedId)) + 1}
                count={order.length} onOpen={() => setListOpen(true)} onPrev={() => moveCursor(-1)} onNext={() => moveCursor(1)} />)}
          {screen === "library" && !search && listOpen && splitter("list")}
          {screen === "library" && <main className="main" data-pane="doc">
            {error && (
              <div className="banner" role="alert">
                <span className="grow">{error}</span>
                <button className="ib" onClick={() => setError(null)} aria-label="閉じる">×</button>
              </div>
            )}
            {doc?.kind === "page" && (
              <BrowserView target={doc.target} page={page} saved={saved} saving={saving} lang={pageLang} overlays={overlays}
                onNavigate={(url) => openPage(url)} onLang={setPageLang} onSave={saveCurrent} onReader={() => saved && openReader(saved.id)}
                onFavorite={() => saved && toggleFavorite(saved)} onDelete={() => saved && setDeleting({ article: saved, page: true })} onError={fail} />
            )}
            {doc?.kind === "reader" && view && (
              <Reader key={view.article.id} view={view} focus={doc.focus} matches={readerMatches} mode={mode} percent={percent} onLang={(m, p) => { setMode(m); setPercent(p); }}
                focusMode={!navOpen && !listOpen} onFocusMode={actions.focus}
                onAsk={() => openChat("article")}
                onPage={() => openPage(view.article.original_url, undefined, view.article)} onLink={(href) => openPage(href)}
                onToggleRead={() => toggleRead(view.article)} onRetry={viewAct(() => api.saveUrl(view.article.original_url))}
                onReextract={viewAct(api.reextractArticle)} onRender={viewAct(api.renderArticle)} onTranslate={viewAct(api.translateArticle)}
                onRetranslate={viewAct(api.retranslateArticle)}
                onSummarize={viewAct(api.summarizeArticle)} onFavorite={() => toggleFavorite(view.article)}
                onTag={(name, add) => act(() => (add ? api.addTag(view.article.id, name) : api.removeTag(view.article.id, name)), view.article.id)}
                onGenre={(name) => act(() => api.setGenre(view.article.id, name), view.article.id)}
                onDifficulty={(level) => act(() => api.setDifficulty(view.article.id, level), view.article.id)}
                onClassify={viewAct(api.classifyArticle)} onDelete={() => setDeleting({ article: view.article, page: false })} />
            )}
            {!doc && loaded && (articles.length ? <p className="doc-empty muted">記事を選んでください</p>
              : <FirstRun onPaste={() => setPalette("")} onFeeds={() => setScreen("feeds")} onImport={() => { setImportTab("urls"); setScreen("import"); }} onMarkdown={importMarkdown}
                  onSettings={() => { setSettingsSection("provider"); setScreen("settings"); }} />)}
          </main>}
          {palette != null && (
            <Palette initial={palette} all={articles} shown={shown} feeds={feeds} scope={scope} facets={facets} actions={paletteActions}
              onClose={() => setPalette(null)} />
          )}
          {deleting && (
            <ConfirmDialog title={deleting.page ? "Index から削除しますか？" : "記事を削除しますか？"} confirm="削除"
              onConfirm={() => deleteArticle(deleting.article)} onCancel={() => setDeleting(null)}>
              <p>「{deleting.article.title ?? deleting.article.original_url}」を削除します。</p>
              <p>保存した HTML・本文・この記事だけの訳文・要約・タグ付け・画像・検索 index も削除され、元に戻せません。対話の回答に残る引用は消えません。</p>
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
