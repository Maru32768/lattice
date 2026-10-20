import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, browser, type ArticleRow, type ArticleSort, type ArticleView, type Citation, type FeedRow, type SearchHit, type SearchResult } from "./api";
import { BrowserView, overlayOf, type BrowseTarget, type PageLang, type PageState } from "./BrowserView";
import type { LanguageMode } from "./mixed";

import { ImportView } from "./ImportView";
import { SettingsView, type SettingsSection } from "./SettingsView";
import { FeedsView } from "./FeedsView";
import { JobsView } from "./JobsView";
import { ChatPane } from "./ChatPane";
import { filterGroups, filterKey } from "./scopes";
import { groupArticles, type Group } from "./groups";
import { NO_FACETS, activeDims, countBy, facetLabel, inScope, matches, relaxations, scopeLabel, toFilter, type Facets, type Scope } from "./library";
import { filterHits, groupHits, terms, type SearchMethod } from "./search";
import { MATCH_LABEL, SearchPane } from "./SearchPane";
import { Reader, TRANSLATABLE, type Focus } from "./Reader";
import { Nav, NavRail, type NavCounts, type Screen } from "./Nav";
import { ListPane, ListRail, type Grouping } from "./ListPane";
import { CoverContext } from "./Popover";
import { Kbd } from "./Icon";
import { Palette, type PaletteActions } from "./Palette";
import "./App.css";

type Doc = null | { kind: "reader"; id: number; focus?: Focus } | { kind: "page"; target: BrowseTarget };

const RECENT_KEY = "lattice.recentSearches";
function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

type Action = "palette" | "search" | "next" | "prev" | "favorite" | "read" | "focus" | "view" | "less" | "more" | "escape";
const KEYS: Record<string, Action> = {
  "ctrl+k": "palette", "/": "search", j: "next", k: "prev", s: "favorite", m: "read", f: "focus", v: "view", "[": "less", "]": "more", Escape: "escape",
};
/** Actions that still run while focus is in a text field. */
const IN_FIELDS = new Set<Action>(["palette", "escape"]);
const keyOf = (e: KeyboardEvent) => `${e.ctrlKey || e.metaKey ? "ctrl+" : ""}${e.key.length === 1 ? e.key.toLowerCase() : e.key}`;

const JOB_POLL_MS = 10_000;

/** States board #8: an empty library. */
function FirstRun({ onPaste, onFeeds, onImport, onSettings }: { onPaste: () => void; onFeeds: () => void; onImport: () => void; onSettings: () => void }) {
  return (
    <section className="first-run" aria-label="最初の記事を入れる">
      <h1>最初の記事を入れる</h1>
      <div className="first-cards">
        <button className="btn" onClick={onPaste}><span className="h">URL を貼る</span><span className="muted"><Kbd>Ctrl</Kbd><Kbd>K</Kbd> に貼り付けて Index</span></button>
        <button className="btn" onClick={onFeeds}><span className="h">フィードを登録</span><span className="muted">サイト URL か OPML</span></button>
        <button className="btn" onClick={onImport}><span className="h">一括インポート</span><span className="muted">ブックマーク HTML・CSV・JSON・Markdown</span></button>
      </div>
      <p className="muted">翻訳・要約・分類には AI プロバイダが必要です — <button className="linkish" onClick={onSettings}>設定する</button>。取り込みと全文検索はなしで使えます。</p>
    </section>
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
  const [screen, setScreen] = useState<Screen>("library");
  const [doc, setDoc] = useState<Doc>(null);
  const [navOpen, setNavOpen] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
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
  const [feedsUrl, setFeedsUrl] = useState<string | undefined>(undefined);
  const [chatScope, setChatScope] = useState<{ key: string; seq: number } | null>(null);

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
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = 0; refresh(); }, 500);
  };
  const loadView = (id: number) => {
    viewId.current = id;
    return api.getArticle(id).then((v) => { if (viewId.current === id) setView(v); }).catch(fail);
  };
  const loadJobs = () => api.jobOverview()
    .then((o) => setJobFailures(o.counts.filter((c) => c.state === "failed").reduce((n, c) => n + c.count, 0)))
    .catch(() => {});

  useEffect(() => {
    loadJobs();
    const poll = window.setInterval(loadJobs, JOB_POLL_MS);
    let jobTimer = 0;
    const subs = [
      listen<number>("article-changed", (e) => {
        if (e.payload === viewId.current) loadView(e.payload);
        refreshSoon();
        clearTimeout(jobTimer);
        jobTimer = window.setTimeout(loadJobs, 1000);
      }),
      listen<{ url: string; loading: boolean }>("browser-page", (e) => {
        setPage((p) => ({ url: e.payload.url, loading: e.payload.loading, title: p?.url === e.payload.url ? p.title : "" }));
        if (!e.payload.loading) refreshSaved(e.payload.url);
      }),
      listen<string>("browser-title", (e) => setPage((p) => (p ? { ...p, title: e.payload } : p))),
    ];
    return () => {
      clearInterval(poll);
      clearTimeout(jobTimer);
      subs.forEach((s) => s.then((f) => f()));
    };
  }, []);
  useEffect(() => { refresh(); }, [sort]);

  // ---- derived library --------------------------------------------------------------------
  const scoped = useMemo(() => articles.filter((a) => inScope(a, scope, now)), [articles, scope, now]);
  const shown = useMemo(() => scoped.filter((a) => matches(a, facets)), [scoped, facets]);
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

  // ---- navigation -------------------------------------------------------------------------
  function setScope(s: Scope) {
    setScopeState(s);
    setFacets(NO_FACETS);
    setScreen("library");
    if (search?.query) runSearch(search.query, s);
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

  function stepHit(delta: 1 | -1) {
    if (!flatHits.length) return;
    const i = Math.max(0, Math.min(flatHits.length - 1, hitSel + delta));
    setHitSel(i);
    openHit(flatHits[i]);
  }

  /** `article`: the saved article being opened, highlighted right away rather than after the page loads. */
  function openPage(url: string, focus?: string, article?: ArticleRow) {
    setError(null);
    setDoc((d) => ({ kind: "page", target: { url, focus, seq: (d?.kind === "page" ? d.target.seq : 0) + 1 } }));
    setPage({ url, title: article?.title ?? "", loading: true });
    setSaved(article ?? null);
    setScreen("library");
  }

  function openReader(id: number, focus?: Omit<Focus, "seq">) {
    setError(null);
    if (viewId.current !== id || !view) loadView(id);
    setDoc((d) => ({ kind: "reader", id, focus: focus && { ...focus, seq: (d?.kind === "reader" ? d.focus?.seq ?? 0 : 0) + 1 } }));
    setScreen("library");
  }

  /** Opens in the view the current document uses (Reader by default). */
  function openArticle(a: ArticleRow) {
    if (doc?.kind === "page") openPage(a.original_url, undefined, a);
    else openReader(a.id);
  }

  function step(delta: 1 | -1) {
    if (order.length === 0) return;
    const i = order.findIndex((a) => a.id === selectedId);
    const next = order[i < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, i + delta))];
    if (next && next.id !== selectedId) openArticle(next);
    window.setTimeout(() => document.querySelector(`.row[data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" }));
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

  const paletteActions: PaletteActions = {
    scope: setScope,
    facets: (f) => { setFacets(f); setScreen("library"); },
    open: (a) => openReader(a.id),
    page: (url) => openPage(url),
    index: (url) => act(async () => openReader(await api.saveUrl(url))),
    discover: (url) => { setFeedsUrl(url); setScreen("feeds"); },
    search: (q) => runSearch(q),
    screen: setScreen,
    chat: openChat,
    lang: setLang,
    translate: current ? () => act(() => api.translateArticle(current.id), current.id) : null,
  };

  // ---- keyboard -----------------------------------------------------------------------------
  const actions: Record<Action, () => void> = {
    palette: () => setPalette((p) => (p == null ? "" : null)),
    search: enterSearch,
    next: () => (search ? stepHit(1) : step(1)),
    prev: () => (search ? stepHit(-1) : step(-1)),
    favorite: () => current && toggleFavorite(current),
    read: () => current && toggleRead(current),
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
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.isComposing) return;
      const action = KEYS[keyOf(e)];
      if (!action) return;
      const t = e.target as HTMLElement;
      const inField = t.closest("input, textarea, select, [contenteditable='true']");
      if (inField && !IN_FIELDS.has(action)) return;
      // Esc in a field only leaves the field; panes that own an Esc (palette, search) handle it first.
      if (inField && action === "escape") return (t as HTMLElement).blur();
      if ((e.ctrlKey || e.metaKey) && action !== "palette") return;
      // Plain keys on a focused button would also activate it; only Escape is shared.
      if (action !== "escape" || !inField) e.preventDefault();
      actionsRef.current[action]();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
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
  const nav = navOpen
    ? <Nav screen={screen} scope={screen === "library" ? scope : null} counts={counts} feeds={feeds} jobFailures={jobFailures}
        chatOpen={chatOpen} searching={!!search} recentSearches={recent} onScope={setScope} onScreen={setScreen} onPalette={() => setPalette("")}
        onOpenUrl={() => setPalette("")} onChat={() => setChatOpen((o) => !o)} onRecent={(q) => runSearch(q)} onGenres={() => { setSettingsSection("genres"); setScreen("settings"); }}
        onCollapse={() => setNavOpen(false)} />
    : <NavRail scope={screen === "library" ? scope : null} chatOpen={chatOpen} onOpen={() => setNavOpen(true)} onPalette={() => setPalette("")}
        onScope={setScope} onChat={() => setChatOpen((o) => !o)} />;


  return (
    <CoverContext.Provider value={cover}>
      <div className="app">
        {screen === "settings"
          ? <SettingsView initialSection={settingsSection} onBack={() => setScreen("library")} onFeeds={() => setScreen("feeds")} onChanged={refresh} />
          : nav}
        {screen === "import" && <ImportView onImported={refresh} />}
        {screen === "feeds" && <FeedsView key={feedsUrl} articles={articles} onChanged={refreshSoon} initialUrl={feedsUrl}
          onShowFeed={(id) => setScope({ kind: "feed", id })} />}
        {screen === "jobs" && <JobsView />}
        {screen === "library" && search && listOpen && (
          <SearchPane initial={search.query} result={search.result} busy={search.busy} method={method} onMethod={setMethod}
            hits={hitGroups} sel={hitSel} onSel={setHitSel} onSearch={(q) => runSearch(q)} onOpen={openHit} onExit={() => setSearch(null)}
            scope={scope} onScope={setScope} facets={facets} onFacets={setFacets} scoped={scoped} all={articles} articleById={articleById}
            focusSeq={searchFocus} />
        )}
        {screen === "library" && !(search && listOpen) && (listOpen
          ? <ListPane title={title} count={shown.length} total={scoped.length} facets={facets} onFacets={setFacets} scoped={scoped}
              all={articles} groups={groups} sort={sort} onSort={setSort} group={group} onGroup={setGroup} selectedId={selectedId}
              translating={translatingRow} relax={relax} onRelax={(r) => { setScopeState(r.scope); setFacets(r.facets); }} onOpen={openArticle}
              onCollapse={() => setListOpen(false)} />
          : <ListRail label={[title, ...activeDims(facets).map((d) => facetLabel(facets, d, articles))].join(" · ")} index={order.findIndex((a) => a.id === selectedId) + 1}
              count={order.length} onOpen={() => setListOpen(true)} onPrev={() => step(-1)} onNext={() => step(1)} />)}
        {screen === "library" && <main className="main" data-pane="doc">
          {error && (
            <div className="banner" role="alert">
              <span className="grow">{error}</span>
              <button className="ib" onClick={() => setError(null)} aria-label="閉じる">×</button>
            </div>
          )}
          {doc?.kind === "page" && (
            <BrowserView target={doc.target} page={page} saved={saved} saving={saving} lang={pageLang} overlays={overlays}
              onLang={setPageLang} onSave={saveCurrent} onReader={() => saved && openReader(saved.id)}
              onFavorite={() => saved && toggleFavorite(saved)} onError={fail} />
          )}
          {doc?.kind === "reader" && view && (
            <Reader key={view.article.id} view={view} focus={doc.focus} matches={readerMatches} mode={mode} percent={percent} onLang={(m, p) => { setMode(m); setPercent(p); }}
              focusMode={!navOpen && !listOpen} onFocusMode={actions.focus}
              onAsk={() => openChat("article")}
              onPage={() => openPage(view.article.original_url, undefined, view.article)} onLink={(href) => openPage(href)}
              onToggleRead={() => toggleRead(view.article)} onRetry={viewAct(() => api.saveUrl(view.article.original_url))}
              onReextract={viewAct(api.reextractArticle)} onRender={viewAct(api.renderArticle)} onTranslate={viewAct(api.translateArticle)}
              onSummarize={viewAct(api.summarizeArticle)} onFavorite={() => toggleFavorite(view.article)}
              onTag={(name, add) => act(() => (add ? api.addTag(view.article.id, name) : api.removeTag(view.article.id, name)), view.article.id)}
              onGenre={(name) => act(() => api.setGenre(view.article.id, name), view.article.id)}
              onDifficulty={(level) => act(() => api.setDifficulty(view.article.id, level), view.article.id)}
              onClassify={viewAct(api.classifyArticle)} />
          )}
          {!doc && loaded && (articles.length ? <p className="doc-empty muted">記事を選んでください</p>
            : <FirstRun onPaste={() => setPalette("")} onFeeds={() => setScreen("feeds")} onImport={() => setScreen("import")}
                onSettings={() => { setSettingsSection("provider"); setScreen("settings"); }} />)}
        </main>}
        {palette != null && (
          <Palette initial={palette} all={articles} shown={shown} feeds={feeds} scope={scope} facets={facets} actions={paletteActions}
            onClose={() => setPalette(null)} />
        )}
        {chatOpen && (
          <ChatPane article={chatArticle} groups={chatGroups} request={chatScope} onCite={openCitation} onClose={() => setChatOpen(false)}
            current={scope.kind === "all" || scope.kind === "recent" ? null : { key: filterKey(toFilter(scope)), label: title }} />
        )}
      </div>
    </CoverContext.Provider>
  );
}
