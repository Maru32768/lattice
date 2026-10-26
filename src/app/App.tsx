import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { emit, emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, isLocal, windows, type ArticleRow, type ArticleView, type Citation, type SearchHit, type VocabContext } from "../api";
import { BrowserView } from "../browser/BrowserView";
import { autoTranslates, translateOnSwitch, translationProgress, type LanguageMode } from "../reader/mixed";

import { ImportView, type ImportTab } from "../import/ImportView";
import { SettingsView, type SettingsSection } from "../settings/SettingsView";
import { FeedsView } from "../feeds/FeedsView";
import { JobsView } from "../jobs/JobsView";
import { QuizReview } from "../quiz/QuizReview";
import { VocabView } from "../vocab/VocabView";
import { replayWord } from "../vocab/speech";
import { ChatPane } from "../chat/ChatPane";
import { openDocs } from "../chat/chat";
import { filterGroups, filterKey } from "../library/scopes";
import { NO_FACETS, NO_KEPT, activeDims, keep, scopeLabel, toFilter, viewKey, type Facets, type Kept, type Scope } from "../library/library";
import { terms } from "../search/search";
import { MATCH_LABEL, SearchPane } from "../search/SearchPane";
import { Reader, WordMarksContext, type DocActions, type Focus } from "../reader/Reader";
import { Nav, NavRail, type Screen } from "../library/Nav";
import { ListPane, ListRail, type Grouping } from "../library/ListPane";
import { getEngine, homeOf } from "../browser/engines";
import { ContextMenu, CoverContext, coverRect, type MenuItem } from "../ui/Popover";
import { articleMenu, type ArticleActions } from "../library/articleMenu";
import { GroupPicker } from "../library/GroupPicker";
import { UpdateNotice } from "./Update";
import { placeFeeds, type FeedOrder } from "../feeds/feedFolders";
import { keyLabel, type ActionId } from "../lib/keys";
import { paneOf, stepNav } from "../layout/panes";
import { Palette, type PaletteActions } from "./Palette";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { TitleBar } from "./TitleBar";
import { Splitter, loadWidths, saveWidths, type PaneWidths, type Resizable } from "../layout/Splitter";
import { DocArea } from "../layout/DocArea";
import { hostOf as siteOf } from "../ui/Favicon";
import {
  activate,
  activeTab,
  allTabs,
  close,
  closeWhere,
  cycle,
  focusedPane,
  open,
  split,
  tabById,
  update,
  type Id,
  type Pane,
  type PageTab,
  type Tab,
} from "../layout/layout";
import type { TabLabel } from "../layout/TabStrip";
import { CHAT, MAIN_REQUEST, openWindows, storageKeys, toMain, type MainRequest } from "./windows";
import { displayLang, isLang, setDisplayLang, useT } from "../i18n";
import { placeDoc, type Place } from "./history";
import { HOST, IS_MAIN, type Where } from "./host";
import { FirstRun, PrefixHint } from "./FirstRun";
import { useLibrary } from "./useLibrary";
import { importantMinOf, useLibraryView } from "./useLibraryView";
import { useActivity, useUnreadBadge } from "./useActivity";
import { useVocab } from "./useVocab";
import { useSearch } from "./useSearch";
import { useDocuments } from "./useDocuments";
import { usePageLang } from "./usePageLang";
import { useChatBridge } from "./useChatBridge";
import { dockChat, useWindows } from "./useWindows";
import { useHistory } from "./useHistory";
import { MENU_TARGETS, usePaneFocus, usePrefix, useShortcuts } from "./useKeyboard";
import "./App.css";

export default function App() {
  // Also subscribes the whole tree to the display language: a switch re-renders everything below.
  const t = useT();
  useEffect(() => {
    // The backend's choice wins over the cached one; the first start stores the detected language.
    api
      .uiLanguage()
      .then((l) => (isLang(l) ? setDisplayLang(l) : api.setUiLanguage(displayLang())))
      .catch(() => {});
  }, []);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(String(e));

  const { articles, loaded, feeds, setFeeds, folders, setFolders, tags, genres, groupRows, relevance, sort, setSort, now, refresh, refreshSoon } =
    useLibrary(fail);
  const { jobFailures, reviewDue, loadReview } = useActivity();
  const { vocab, marksOn, setMarks, marks, loadVocab, saveWordSeq, saveWord } = useVocab(() => void loadReview());
  const { layout, setLayout, layoutRef, views, setViews, viewsRef, loadView, refreshSaved, forgetPage } = useDocuments(fail);
  const [pageLang, setPageLang] = usePageLang(t, fail);

  /** The palette asked this Reader tab to open its group picker; `seq` grows with each ask. */
  const [groupRequest, setGroupRequest] = useState<{ tab: Id; seq: number } | null>(null);
  const [group, setGroup] = useState<Grouping>("none");
  const [scopeState, setScopeState] = useState<Scope>({ kind: "all" });
  const importantMin = importantMinOf(relevance);
  // 重要 always uses the current threshold, also when it was picked under an earlier one.
  const scope: Scope =
    scopeState.kind === "important" && importantMin != null && scopeState.min !== importantMin ? { kind: "important", min: importantMin } : scopeState;
  const [facets, setFacets] = useState<Facets>(NO_FACETS);
  const [kept, setKept] = useState<Kept>(NO_KEPT);
  const [screen, setScreenState] = useState<Screen>("library");
  /** The screens (settings, feeds, import, …) live in the main window; a pop-out asks it. */
  const setScreen = (s: Screen) => {
    if (IS_MAIN) {
      setScreenState(s);
    } else if (s !== "library") {
      void toMain({ kind: "screen", screen: s });
    }
  };
  const [navOpen, setNavOpen] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [widths, setWidths] = useState<PaneWidths>(loadWidths);
  const setWidth = (pane: Resizable, w: number) => {
    const next = { ...widths, [pane]: w };
    setWidths(next);
    saveWidths(next);
  };
  /** The open palette's initial query, and whether it was opened for a new tab (Ctrl+T): its pick opens in one. */
  const [palette, setPalette] = useState<{ initial: string; newTab: boolean } | null>(null);
  const openPalette = () => setPalette({ initial: "", newTab: false });
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("provider");
  const [importTab, setImportTab] = useState<ImportTab>("urls");
  const [feedsUrl, setFeedsUrl] = useState<string | undefined>(undefined);
  /** The article waiting for delete confirmation, and the view that asked. */
  const [deleting, setDeleting] = useState<{ article: ArticleRow; page: boolean } | null>(null);
  /** The items of the right-click menu, set by the row or tab it opens on. */
  const [ctxItems, setCtxItems] = useState<(MenuItem | string)[]>([]);
  /** グループに追加… from a context menu: the picker under the row or tab. */
  const [groupPick, setGroupPick] = useState<{ el: HTMLElement; ids: number[] } | null>(null);
  /** The page tab being added to the Index. */
  const [saving, setSaving] = useState<Id | null>(null);
  const [mode, setMode] = useState<LanguageMode>("mixed");
  const [percent, setPercent] = useState(70);

  const { scoped, shown, groups, order, counts, relax, articleById } = useLibraryView({
    articles,
    feeds,
    folders,
    groupRows,
    scope,
    facets,
    kept,
    group,
    importantMin,
    now,
    t,
  });
  useUnreadBadge(counts.unread, loaded && IS_MAIN);
  const {
    search,
    exit: exitSearch,
    method,
    setMethod,
    hitSel,
    setHitSel,
    searchFocus,
    recent,
    start: startSearch,
    enter,
    hitGroups,
    flatHits,
  } = useSearch(shown, fail);
  const chatGroups = useMemo(() => filterGroups(groupRows, genres, feeds, tags, t, folders), [groupRows, genres, feeds, tags, t, folders]);
  const searchGroups = useMemo(() => filterGroups(groupRows, genres, feeds, [], t, folders), [groupRows, genres, feeds, t, folders]);

  // The focused pane's active tab is what shortcuts, the chat and the list selection refer to.
  const cur = activeTab(focusedPane(layout));
  const curView = cur?.kind === "reader" ? views.get(cur.articleId) : undefined;
  const savedOf = (t: PageTab) => (t.saved == null ? null : (articleById.get(t.saved) ?? null));
  const current: ArticleRow | null =
    cur?.kind === "reader" ? (curView?.article ?? articleById.get(cur.articleId) ?? null) : cur?.kind === "page" ? savedOf(cur) : null;
  const selectedId = current?.id ?? null;
  const ownOpen = useMemo(
    () =>
      openDocs(allTabs(layout), (id) => {
        const a = views.get(id)?.article ?? articleById.get(id);
        return a ? (a.title ?? a.original_url) : null;
      }),
    [layout, views, articleById],
  );
  const chat = useChatBridge({ article: current && { id: current.id, title: current.title ?? current.original_url }, docs: ownOpen });
  const win = useWindows({ layout, setLayout, forgetPage, fail });

  // Opening an article reads it; a row it had in the list stays there (kept) until the view or the screen changes.
  const listView = viewKey(scope, facets);
  const keptFor = `${screen}\n${listView}`;
  const [keptKey, setKeptKey] = useState(keptFor);
  if (keptKey !== keptFor) {
    setKeptKey(keptFor);
    setKept(NO_KEPT);
  }
  const [cursor, setCursor] = useState<number | null>(null);
  const [openedId, setOpenedId] = useState<number | null>(null);
  if (openedId !== selectedId) {
    setOpenedId(selectedId);
    const a = selectedId == null ? undefined : articleById.get(selectedId);
    if (selectedId != null) {
      setCursor(selectedId);
    }
    if (a?.read_status === "unread" && shown.some((x) => x.id === a.id)) {
      setKept((k) => keep(k, listView, a.id));
    }
  }

  // ---- navigation -------------------------------------------------------------------------
  function setScope(s: Scope) {
    if (!IS_MAIN) {
      return void toMain({ kind: "scope", scope: s });
    }
    setScopeState(s);
    setFacets(NO_FACETS);
    setScreen("library");
    if (search?.query) {
      runSearch(search.query);
    }
  }

  function runSearch(q: string) {
    if (!IS_MAIN) {
      return void toMain({ kind: "search", query: q });
    }
    setScreen("library");
    setListOpen(true);
    startSearch(q);
  }

  function enterSearch() {
    if (!IS_MAIN) {
      return void toMain({ kind: "search" });
    }
    setScreen("library");
    setListOpen(true);
    enter();
  }

  function openHit(h: SearchHit, page = false, newTab = false) {
    const a = articleById.get(h.article_id);
    const where: Where = newTab ? "new" : "active";
    if (page && a) {
      return openPage(a.original_url, h.text, a, where);
    }
    openReader(
      h.article_id,
      { block: h.block_id, label: t("app.searchHit", { label: t(MATCH_LABEL[h.source]) }), terms: terms(search?.query ?? ""), tone: "hit" },
      where,
    );
  }

  /** `article`: the saved article being opened, highlighted right away rather than after the page loads. `pane`: not the focused one. */
  function openPage(url: string, focus?: string, article?: ArticleRow, where: Where = "active", pane?: Id) {
    // An imported file has no page: it stays in the Reader.
    if (isLocal(url)) {
      return article ? openReader(article.id, undefined, where, pane) : setError(t("reader.pageDisabled"));
    }
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
    if (cur?.kind === "page") {
      openPage(a.original_url, undefined, a, where);
    } else {
      openReader(a.id, undefined, where);
    }
  }

  const openContext = (c: VocabContext) => {
    if (c.article_id != null) {
      openReader(c.article_id, c.block_id == null ? undefined : { block: c.block_id, label: t("vocabCard.sourceLabel"), terms: [], tone: "cite" });
    } else if (c.url) {
      openPage(c.url, c.sentence);
    }
  };

  // ---- cursor: j / k move it through the list (or the search hits) without opening; Enter opens it.
  /** After the cursor moves: keep it in view, and keep DOM focus on it while the list pane has focus. */
  function revealCursor() {
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(".row.cur, .hit.cur");
      el?.scrollIntoView({ block: "nearest" });
      if (el && paneOf(document.activeElement)?.dataset.pane === "list") {
        el.focus({ preventScroll: true });
      }
    });
  }

  function moveCursor(d: 1 | -1) {
    if (search) {
      if (flatHits.length) {
        setHitSel(Math.max(0, Math.min(flatHits.length - 1, hitSel + d)));
      }
    } else if (order.length) {
      const i = order.findIndex((a) => a.id === (cursor ?? selectedId));
      const next = order[i < 0 ? (d > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, i + d))];
      if (next) {
        setCursor(next.id);
      }
    }
    revealCursor();
  }

  function openCursor(asPage: boolean) {
    if (search) {
      return flatHits[hitSel] && openHit(flatHits[hitSel], asPage);
    }
    const a = cursor == null ? undefined : articleById.get(cursor);
    if (a && asPage) {
      openPage(a.original_url, undefined, a);
    } else if (a) {
      openArticle(a);
    }
  }

  function toggleView() {
    if (cur?.kind === "reader" && curView) {
      openPage(curView.article.original_url, undefined, curView.article);
    } else if (cur?.kind === "page" && current) {
      openReader(current.id);
    }
  }

  /** Chat citation: the cited block in the Reader; the page when the article is no longer in the library. */
  function openCitation(c: Citation, newTab = false) {
    if (!IS_MAIN) {
      return void toMain({ kind: "cite", citation: c, newTab });
    }
    const where: Where = newTab ? "new" : "active";
    if (articleById.has(c.article_id)) {
      openReader(c.article_id, { block: c.block_id, label: t("app.citation", { n: c.n }), terms: [], tone: "cite" }, where);
    } else if (c.url) {
      openPage(c.url, c.text, undefined, where);
    } else {
      setError(t("app.citationDeleted"));
    }
  }

  // ---- article actions ----------------------------------------------------------------------
  async function act(task: () => Promise<unknown>, id?: number) {
    await task()
      .then(() => {
        const pages = allTabs(layoutRef.current).filter((t): t is PageTab => t.kind === "page");
        return Promise.all([refresh(), id != null && viewsRef.current.has(id) && loadView(id), ...pages.map((t) => refreshSaved(t.id, t.url))]);
      })
      .catch(fail);
  }
  // Opening an article reads it.
  const markRead = useEffectEvent((id: number) => {
    if (articleById.get(id)?.read_status === "unread") {
      void act(() => api.setRead(id, true), id);
    }
  });
  useEffect(() => {
    if (selectedId != null) {
      markRead(selectedId);
    }
  }, [selectedId]);
  const toggleFavorite = (a: ArticleRow) => act(() => api.setFavorite(a.id, !a.favorite), a.id);
  const toggleRead = (a: ArticleRow) => act(() => api.setRead(a.id, a.read_status !== "read"), a.id);
  /** A bulk change from a context menu; the open Readers of those articles reload too. */
  const actOn = (ids: number[], task: (id: number) => Promise<unknown>) =>
    act(() => Promise.all(ids.map(task))).then(() => ids.forEach((id) => viewsRef.current.has(id) && void loadView(id)));
  const copyUrl = (url: string) => void navigator.clipboard.writeText(url).catch(fail);

  /** What an article's context menu does; `from` is the row or tab it opened on. */
  const articleActions = (from: HTMLElement): ArticleActions => ({
    favorite: (ids, on) => void actOn(ids, (id) => api.setFavorite(id, on)),
    read: (ids, read) => void actOn(ids, (id) => api.setRead(id, read)),
    group: (ids) => setGroupPick({ el: from, ids }),
    openNew: (a) => openArticle(a, true),
    popOut: IS_MAIN ? (a) => void win.popOutDoc({ kind: "reader", articleId: a.id }) : undefined,
    page: (a) => openPage(a.original_url, undefined, a),
    copyUrl: (a) => copyUrl(a.original_url),
    remove: (a) => setDeleting({ article: a, page: false }),
  });
  const openRowMenu = (rows: ArticleRow[], from: HTMLElement) => setCtxItems(articleMenu(rows, articleActions(from), t));

  /** Right-click (or the menu key) on a tab: its article's menu, or for an unsaved page what applies to a URL. */
  function tabMenu(e: React.MouseEvent) {
    const el = (e.target as Element).closest<HTMLElement>("[role='tab'][data-tab]");
    const hit = el && tabById(layout, Number(el.dataset.tab));
    // Not a tab of this window's layout: no menu at all.
    if (!el || !hit) {
      return e.preventDefault();
    }
    const tab = hit.tab;
    const a = tab.kind === "reader" ? (views.get(tab.articleId)?.article ?? articleById.get(tab.articleId)) : savedOf(tab);
    const again = () =>
      tab.kind === "page" ? openPage(tab.url, undefined, a ?? undefined, "new", hit.pane.id) : openReader(tab.articleId, undefined, "new", hit.pane.id);
    const items: (MenuItem | string)[] = a
      ? articleMenu([a], { ...articleActions(el), openNew: again, popOut: IS_MAIN ? () => win.popOutTab(tab.id) : undefined }, t)
      : [
          { label: t("articleMenu.openNewTab"), onSelect: again },
          ...(IS_MAIN ? [{ label: t("tabStrip.popOut"), onSelect: () => win.popOutTab(tab.id) }] : []),
          ...(tab.kind === "page" ? [{ label: t("articleMenu.copyUrl"), onSelect: () => copyUrl(tab.url) }] : []),
        ];
    setCtxItems(items);
  }

  // ---- groups (G53) -------------------------------------------------------------------------
  async function createGroup(name: string) {
    const id = await api.createGroup(name);
    await refresh();
    return id;
  }
  async function groupMembers(group: number, ids: number[], add: boolean) {
    await act(() => (add ? api.groupAdd(group, ids) : api.groupRemove(group, ids)));
    for (const id of ids) {
      if (viewsRef.current.has(id)) {
        void loadView(id);
      }
    }
  }
  async function deleteGroup(id: number) {
    await act(() => api.deleteGroup(id));
    if (scope.kind === "group" && scope.id === id) {
      setScope({ kind: "all" });
    }
    setFacets((f) => ({ ...f, groups: f.groups.filter((g) => g !== id) }));
  }

  // ---- feed folders (H25) --------------------------------------------------------------------
  /** A feed or folder moved in the sidebar (H26): shown at once, then stored. */
  function reorderFeeds(order: FeedOrder) {
    setFeeds((fs) => placeFeeds(fs, order));
    void act(() => api.reorderFeeds(order.folder, order.ids));
  }
  function reorderFolders(ids: number[]) {
    setFolders((fs) => ids.flatMap((id) => fs.filter((f) => f.id === id)));
    void act(() => api.reorderFeedFolders(ids));
  }
  async function deleteFolder(id: number) {
    await act(() => api.deleteFeedFolder(id));
    if (scope.kind === "folder" && scope.id === id) {
      setScope({ kind: "all" });
    }
  }

  async function deleteArticle(a: ArticleRow) {
    setDeleting(null);
    await api
      .deleteArticle(a.id)
      .then(() => {
        setViews((m) => {
          const n = new Map(m);
          n.delete(a.id);
          return n;
        });
        setLayout((l) => {
          const kept = closeWhere(l, (t) => t.kind === "reader" && t.articleId === a.id);
          return allTabs(kept)
            .filter((t) => t.kind === "page" && t.saved === a.id)
            .reduce((acc, t) => update(acc, t.id, { saved: null }), kept);
        });
        return refresh();
      })
      .catch(fail);
  }

  async function savePage(t: PageTab) {
    setSaving(t.id);
    await api
      .savePage(t.key)
      .then(() => Promise.all([refresh(), refreshSaved(t.id, t.url)]))
      .catch(fail);
    setSaving(null);
  }

  function nudgeRatio(delta: number) {
    if (cur?.kind === "page") {
      setPageLang({ mode: "mixed", percent: Math.max(0, Math.min(100, pageLang.percent + delta)) });
    } else {
      setMode("mixed");
      setPercent((p) => Math.max(0, Math.min(100, p + delta)));
      translateOnPick(curView, "mixed");
    }
  }

  /** Picking 混在 / 訳文 on an article nobody has translated yet starts its translation (setting, default on). */
  function translateOnPick(v: ArticleView | undefined, m: LanguageMode) {
    if (
      v &&
      translateOnSwitch() &&
      autoTranslates(
        m,
        v.blocks,
        v.jobs.find((j) => j.type === "translate"),
      )
    ) {
      void act(() => api.translateArticle(v.article.id), v.article.id);
    }
  }

  function openChat(key?: string) {
    if (!IS_MAIN) {
      return void toMain({ kind: "chat", scopeKey: key });
    }
    if (win.chatWindow) {
      if (key) {
        void emitTo(CHAT, "chat-request", { key });
      }
      windows.open(CHAT).catch(fail);
      return;
    }
    win.setChatOpen(true);
    if (key) {
      chat.askScope(key);
    }
  }

  function setLang(m: LanguageMode, p?: number) {
    if (cur?.kind === "page") {
      setPageLang({ mode: m, percent: p ?? pageLang.percent });
    } else {
      setMode(m);
      if (p != null) {
        setPercent(p);
      }
      translateOnPick(curView, m);
    }
  }

  function importMarkdown() {
    if (!IS_MAIN) {
      return void toMain({ kind: "import", tab: "markdown" });
    }
    setImportTab("markdown");
    setScreen("import");
  }

  function importPdf() {
    if (!IS_MAIN) {
      return void toMain({ kind: "import", tab: "pdf" });
    }
    setImportTab("pdf");
    setScreen("import");
  }

  // ---- windows (G52) ------------------------------------------------------------------------
  /** What another window asked this one to do (only `open` reaches a document window); it comes to the front for it. */
  function onRequest(r: MainRequest) {
    if (!IS_MAIN && r.kind !== "open") {
      return;
    }
    switch (r.kind) {
      case "open":
        setScreen("library");
        setLayout((l) => r.docs.reduce((acc, d, i) => open(acc, d, "new", r.at?.pane, r.at && r.at.index + i), l));
        break;
      case "chat":
        openChat(r.scopeKey);
        return;
      case "chatDocked":
        win.setChatWindow(false);
        win.setChatOpen(true);
        break;
      // Closed, not docked: the next 対話 opens the dock, as after a restart.
      case "chatClosed":
        win.setChatWindow(false);
        return;
      case "chatReady":
        chat.resend();
        return;
      case "openDocs":
        chat.docWindowOpen(r.label, r.docs);
        return;
      case "pageLang":
        void emit("page-lang", pageLang);
        return;
      case "cite":
        openCitation(r.citation, r.newTab);
        break;
      case "screen":
        setScreen(r.screen);
        break;
      case "import":
        setImportTab(r.tab);
        setScreen("import");
        break;
      case "discover":
        setFeedsUrl(r.url);
        setScreen("feeds");
        break;
      case "scope":
        setScope(r.scope);
        break;
      case "facets":
        setFacets(r.facets);
        setScreen("library");
        break;
      case "search":
        if (r.query) {
          runSearch(r.query);
        } else {
          enterSearch();
        }
        break;
    }
    getCurrentWindow()
      .setFocus()
      .catch(() => {});
  }
  const onMainRequest = useEffectEvent(onRequest);
  const onStartError = useEffectEvent(fail);
  useEffect(() => {
    const sub = getCurrentWindow().listen<MainRequest>(MAIN_REQUEST, (e) => onMainRequest(e.payload));
    // The pop-outs that were open last time come back; the chat window is restored from its key too.
    if (IS_MAIN) {
      for (const label of openWindows(storageKeys())) {
        windows.open(label).catch(onStartError);
      }
    } else {
      windows.ready().catch(() => {});
    }
    return () => void sub.then((f) => f());
  }, []);

  const whereFromPalette = (newTab?: boolean): Where => (newTab || palette?.newTab ? "new" : "active");
  const paletteActions: PaletteActions = {
    scope: setScope,
    facets: (f) => {
      if (!IS_MAIN) {
        return void toMain({ kind: "facets", facets: f });
      }
      setFacets(f);
      setScreen("library");
    },
    open: (a, t) => openReader(a.id, undefined, whereFromPalette(t)),
    page: (url, t) => openPage(url, undefined, undefined, whereFromPalette(t)),
    index: (url, group) => {
      const where = whereFromPalette();
      void act(async () => {
        const id = await api.saveUrl(url);
        if (group != null) {
          await api.groupAdd(group, [id]);
        }
        openReader(id, undefined, where);
      });
    },
    discover: (url) => {
      if (!IS_MAIN) {
        return void toMain({ kind: "discover", url });
      }
      setFeedsUrl(url);
      setScreen("feeds");
    },
    search: (q) => runSearch(q),
    screen: setScreen,
    importMarkdown,
    importPdf,
    chat: openChat,
    lang: setLang,
    translate: current ? () => void act(() => api.translateArticle(current.id), current.id) : null,
    addToGroup: cur?.kind === "reader" ? () => setGroupRequest((r) => ({ tab: cur.id, seq: (r?.seq ?? 0) + 1 })) : null,
  };

  // ---- in-app history (H4) ------------------------------------------------------------------
  // Every change of screen, settings section, scope, facets or the focused tab's document is a
  // visit; back / forward restore one. The chat window has nothing to go back to.
  const place: Place = { screen, section: screen === "settings" ? settingsSection : undefined, scope, facets, doc: cur && placeDoc(cur) };
  const history = useHistory(
    place,
    (p) => {
      setScreenState(p.screen);
      if (p.section) {
        setSettingsSection(p.section);
      }
      setScopeState(p.scope);
      setFacets(p.facets);
      const doc = p.doc;
      // Back to the tab that showed it if it still does, else the document opens in the focused tab.
      if (doc) {
        setLayout((l) => {
          const hit = tabById(l, doc.tab);
          return hit && placeDoc(hit.tab).key === doc.key ? activate(l, doc.tab) : open(l, doc.doc, "active");
        });
      }
    },
    HOST.kind !== "chat",
  );

  // ---- keyboard -----------------------------------------------------------------------------
  const paneFocus = usePaneFocus(layout, setLayout);
  const prefix = usePrefix();

  const step = (d: 1 | -1) => {
    const nav = paneOf(document.activeElement);
    if (nav?.dataset.pane === "nav") {
      stepNav(nav, d);
      paneFocus.setKbPane("nav");
    } else {
      moveCursor(d);
    }
  };

  const actions: Record<ActionId, () => void> = {
    palette: () => setPalette((p) => (p == null ? { initial: "", newTab: false } : null)),
    search: enterSearch,
    next: () => step(1),
    prev: () => step(-1),
    open: () => openCursor(false),
    openPage: () => openCursor(true),
    pane: prefix.arm,
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
      if (screen !== "library") {
        setScreen("library");
      } else if (search) {
        exitSearch();
      } else {
        setFacets((f) => (activeDims(f).length ? NO_FACETS : f));
      }
    },
    // The palette for a new tab (Ctrl+T): what it opens goes into a new tab in the focused pane.
    newTab: () => setPalette({ initial: "", newTab: true }),
    closeTab: () =>
      setLayout((l) => {
        const t = activeTab(focusedPane(l));
        return t ? close(l, t.id) : l;
      }),
    nextTab: () => setLayout((l) => cycle(l, 1)),
    prevTab: () => setLayout((l) => cycle(l, -1)),
    splitRight: () => {
      setScreen("library");
      setLayout((l) => split(l, l.focused, "row"));
    },
    splitDown: () => {
      setScreen("library");
      setLayout((l) => split(l, l.focused, "column"));
    },
    saveWord,
    speak: replayWord,
    popOut: () => {
      const t = activeTab(focusedPane(layout));
      if (t) {
        (IS_MAIN ? win.popOutTab : win.returnTab)(t.id);
      }
    },
    back: () => history.step(-1),
    forward: () => history.step(1),
    // The focused sidebar row moves itself (NavFolders); nowhere else has rows to move.
    moveUp: () => {},
    moveDown: () => {},
  };
  const bindings = useShortcuts({ actions, prefix, layout, setLayout, focus: paneFocus });

  // ---- render ---------------------------------------------------------------------------------
  const title = scopeLabel(scope, articles, groupRows, t, folders, feeds);
  // Only the open article's job progress is known to the UI (the list has no per-article job data).
  const tjob = curView?.jobs.find((j) => j.type === "translate");
  const tprog = curView ? translationProgress(curView.blocks, curView.target_language) : { done: 0, total: 0 };
  const translatingRow =
    curView && tjob && (tjob.status === "running" || (tjob.status === "pending" && !tjob.last_error))
      ? {
          id: curView.article.id,
          label: t("app.translating", { length: tprog.done, length2: tprog.total }),
        }
      : null;
  const docHits = search && cur?.kind === "reader" ? flatHits.filter((h) => h.article_id === cur.articleId) : [];
  const readerMatches =
    docHits.length > 0 && cur?.kind === "reader"
      ? {
          i: docHits.findIndex((h) => h.block_id === cur.focus?.block),
          n: docHits.length,
          onStep: (d: 1 | -1) => {
            const at = docHits.findIndex((h) => h.block_id === cur.focus?.block);
            const h = docHits[Math.max(0, Math.min(docHits.length - 1, at + d))];
            if (!h) {
              return;
            }
            setHitSel(flatHits.indexOf(h));
            openHit(h);
          },
        }
      : undefined;
  const splitter = (pane: Resizable, side: "left" | "right" = "left") => (
    <Splitter pane={pane} side={side} width={widths[pane]} onWidth={(w) => setWidth(pane, w)} />
  );
  const chatShown = win.chatOpen || win.chatWindow;
  const nav = navOpen ? (
    <>
      <Nav
        screen={screen}
        scope={screen === "library" ? scope : null}
        counts={counts}
        feeds={feeds}
        folders={folders}
        groups={groupRows}
        jobFailures={jobFailures}
        reviewDue={reviewDue}
        chatOpen={chatShown}
        searching={!!search}
        recentSearches={recent}
        onScope={setScope}
        onScreen={setScreen}
        onChat={win.toggleChat}
        onRecent={(q) => runSearch(q)}
        onGenres={() => {
          setSettingsSection("genres");
          setScreen("settings");
        }}
        onCreateGroup={(name) =>
          createGroup(name)
            .then((id) => setScope({ kind: "group", id }))
            .catch(fail)
        }
        onRenameGroup={(id, name) => act(() => api.renameGroup(id, name))}
        onDeleteGroup={deleteGroup}
        onRenameFolder={(id, name) => act(() => api.renameFeedFolder(id, name))}
        onDeleteFolder={deleteFolder}
        onReorderFeeds={reorderFeeds}
        onReorderFolders={reorderFolders}
        onMenu={setCtxItems}
        onCollapse={() => setNavOpen(false)}
        importantMin={importantMin}
      />
      {splitter("nav")}
    </>
  ) : (
    <NavRail scope={screen === "library" ? scope : null} chatOpen={chatShown} onOpen={() => setNavOpen(true)} onScope={setScope} onChat={win.toggleChat} />
  );

  const labelOf = (t: Tab): TabLabel => {
    if (t.kind === "page") {
      return { title: t.title || siteOf(t.url) || t.url, domain: siteOf(t.url) };
    }
    const a = views.get(t.articleId)?.article ?? articleById.get(t.articleId);
    return { title: a?.title ?? a?.original_url ?? "…", domain: a?.domain ?? "", feed: a?.feed_id };
  };
  // A document window is named after its tab on the taskbar and in Alt+Tab.
  const windowTitle = HOST.kind === "doc" && cur ? labelOf(cur).title : "";
  useEffect(() => {
    if (HOST.kind === "doc") {
      getCurrentWindow()
        .setTitle(windowTitle ? `${windowTitle} - Lattice` : "Lattice")
        .catch(() => {});
    }
  }, [windowTitle]);
  const windowAction = IS_MAIN
    ? { label: t("tabStrip.popOut"), hint: t("tabStrip.popOutHint"), icon: "popout" as const, onSelect: win.popOutTab }
    : { label: t("tabStrip.popIn"), hint: t("tabStrip.popInHint"), icon: "popin" as const, onSelect: win.returnTab };

  const renderPane = (pane: Pane) => {
    const tab = activeTab(pane);
    if (!tab) {
      if (!loaded) {
        return null;
      }
      if (articles.length || layout.root.kind === "split") {
        return <p className="doc-empty muted">{t("app.pickArticle")}</p>;
      }
      return (
        <FirstRun
          onPaste={openPalette}
          onFeeds={() => setScreen("feeds")}
          onImport={() => {
            setImportTab("urls");
            setScreen("import");
          }}
          onMarkdown={importMarkdown}
          onSettings={() => {
            setSettingsSection("provider");
            setScreen("settings");
          }}
        />
      );
    }
    /** What both toolbars do with the article `a` (H14); `page`: asked from the Page view. */
    const articleActs = (a: ArticleRow, page: boolean): DocActions => {
      const vAct = (task: (id: number) => Promise<unknown>) => () => void act(() => task(a.id), a.id);
      return {
        focusMode: !navOpen && !listOpen,
        onFocusMode: actions.focus,
        onFavorite: () => void toggleFavorite(a),
        onToggleRead: () => void toggleRead(a),
        onAsk: () => openChat("article"),
        onReextract: vAct(api.reextractArticle),
        onRender: vAct(api.renderArticle),
        onClassify: vAct(api.classifyArticle),
        onRetranslate: vAct(api.retranslateArticle),
        onSummarize: vAct(api.summarizeArticle),
        onCopyUrl: () => copyUrl(a.original_url),
        onDelete: () => setDeleting({ article: a, page }),
        onReviewChanged: () => void loadReview(),
        onFocusBlock: (block, label) => openReader(a.id, { block, label, terms: [], tone: "cite" }, "active", pane.id),
      };
    };
    if (tab.kind === "page") {
      const saved = savedOf(tab);
      return (
        <BrowserView
          key={tab.id}
          tab={tab}
          saved={saved}
          view={saved && (views.get(saved.id) ?? null)}
          act={saved && articleActs(saved, true)}
          saving={saving === tab.id}
          lang={pageLang}
          onNavigate={(url) => openPage(url, undefined, undefined, "active", pane.id)}
          onLang={setPageLang}
          onSave={() => savePage(tab)}
          onReader={() => saved && openReader(saved.id, undefined, "active", pane.id)}
          onError={fail}
        />
      );
    }
    const v = views.get(tab.articleId);
    if (!v) {
      return null;
    }
    const a = v.article;
    const vAct = (task: (id: number) => Promise<unknown>) => () => act(() => task(a.id), a.id);
    return (
      <Reader
        key={a.id}
        view={v}
        act={articleActs(a, false)}
        focus={tab.focus}
        matches={tab === cur ? readerMatches : undefined}
        mode={mode}
        percent={percent}
        onLang={(m, p) => {
          setMode(m);
          setPercent(p);
          translateOnPick(v, m);
        }}
        onPage={() => openPage(a.original_url, undefined, a, "active", pane.id)}
        onLink={(href, nt) => openPage(href, undefined, undefined, nt ? "new" : "active", pane.id)}
        onRetry={vAct(() => api.saveUrl(a.original_url))}
        onTranslate={vAct(api.translateArticle)}
        onTag={(name, add) => act(() => (add ? api.addTag(a.id, name) : api.removeTag(a.id, name)), a.id)}
        onGenre={(name) => act(() => api.setGenre(a.id, name), a.id)}
        onDifficulty={(level) => act(() => api.setDifficulty(a.id, level), a.id)}
        saveWordSeq={saveWordSeq}
        onVocabChanged={loadVocab}
        groups={groupRows}
        onGroup={(id, add) => groupMembers(id, [a.id], add)}
        onCreateGroup={createGroup}
        groupRequest={groupRequest?.tab === tab.id ? groupRequest.seq : 0}
      />
    );
  };

  if (HOST.kind === "chat") {
    return (
      <CoverContext.Provider value={coverRect}>
        <div className="shell">
          <TitleBar />
          <div className="app solo" data-kb-pane={paneFocus.kbPane ?? undefined}>
            <ChatPane
              article={chat.article}
              open={chat.docs}
              groups={chatGroups}
              request={chat.chatScope}
              onCite={openCitation}
              onClose={win.closeRequested}
              onPopIn={dockChat}
              current={null}
            />
          </div>
        </div>
      </CoverContext.Provider>
    );
  }
  return (
    <CoverContext.Provider value={coverRect}>
      <div className="shell">
        {/* A pop-out's top tab strips are its title bar (H19, DocArea). */}
        {HOST.kind !== "doc" && <TitleBar history={{ back: history.back, forward: history.forward, onGo: history.step }} onPalette={openPalette} />}
        {IS_MAIN && <UpdateNotice onOpenUrl={(url) => openPage(url)} />}
        <ContextMenu label={t("articleMenu.label")} items={ctxItems} targets={MENU_TARGETS}>
          <div
            className="app"
            data-kb-pane={paneFocus.kbPane ?? undefined}
            style={
              {
                "--nav-w": `${widths.nav}px`,
                "--list-w": `${widths.list}px`,
                "--search-w": `${widths.search}px`,
                "--chat-w": `${widths.chat}px`,
              } as React.CSSProperties
            }
          >
            {IS_MAIN &&
              (screen === "settings" ? (
                <SettingsView
                  section={settingsSection}
                  onSection={setSettingsSection}
                  onBack={() => setScreen("library")}
                  onFeeds={() => setScreen("feeds")}
                  onChanged={refresh}
                  onOpenUrl={(url) => openPage(url)}
                />
              ) : (
                nav
              ))}
            {(screen === "import" || screen === "feeds" || screen === "jobs" || screen === "review" || screen === "vocab") && (
              <main className="main" data-pane="doc">
                {screen === "import" && (
                  <ImportView
                    tab={importTab}
                    onTab={setImportTab}
                    onImported={refresh}
                    onOpen={(id) => {
                      void refresh();
                      openReader(id);
                    }}
                    groups={groupRows}
                    initialGroups={scope.kind === "group" ? [scope.id] : []}
                    onCreateGroup={createGroup}
                  />
                )}
                {screen === "feeds" && (
                  <FeedsView
                    key={feedsUrl}
                    articles={articles}
                    navFeeds={feeds}
                    onChanged={refreshSoon}
                    initialUrl={feedsUrl}
                    onShowFeed={(id) => setScope({ kind: "feed", id })}
                  />
                )}
                {screen === "jobs" && <JobsView />}
                {screen === "review" && (
                  <QuizReview
                    onChanged={loadVocab}
                    onOpenPage={(url, text) => openPage(url, text)}
                    onOpen={(id, block, label) =>
                      openReader(id, block == null ? undefined : { block, label: label ?? t("reader.quizSource"), terms: [], tone: "cite" })
                    }
                  />
                )}
                {screen === "vocab" && <VocabView entries={vocab} marks={marksOn} onMarks={setMarks} onChanged={loadVocab} onSource={openContext} />}
              </main>
            )}
            {IS_MAIN && screen === "library" && search && listOpen && (
              <SearchPane
                initial={search.query}
                result={search.result}
                busy={search.busy}
                method={method}
                onMethod={setMethod}
                hits={hitGroups}
                sel={hitSel}
                onSel={setHitSel}
                open={cur?.kind === "reader" && cur.focus?.tone === "hit" ? { id: cur.articleId, block: cur.focus.block } : null}
                onSearch={(q) => runSearch(q)}
                onOpen={openHit}
                onExit={exitSearch}
                scope={scope}
                onScope={setScope}
                filters={searchGroups}
                importantMin={importantMin}
                facets={facets}
                onFacets={setFacets}
                scoped={scoped}
                all={articles}
                groups={groupRows}
                articleById={articleById}
                focusSeq={searchFocus}
              />
            )}
            {IS_MAIN && screen === "library" && search && listOpen && splitter("search")}
            {IS_MAIN &&
              screen === "library" &&
              !(search && listOpen) &&
              (listOpen ? (
                <ListPane
                  title={title}
                  count={shown.length}
                  total={scoped.length}
                  facets={facets}
                  onFacets={setFacets}
                  scoped={scoped}
                  all={articles}
                  groups={groups}
                  groupRows={groupRows}
                  sort={sort}
                  onSort={setSort}
                  group={group}
                  onGroup={setGroup}
                  selectedId={selectedId}
                  cursorId={cursor}
                  onCursor={setCursor}
                  translating={translatingRow}
                  relax={relax}
                  onRelax={(r) => {
                    setScopeState(r.scope);
                    setFacets(r.facets);
                  }}
                  onOpen={openArticle}
                  onGroupMembers={groupMembers}
                  onCreateGroup={createGroup}
                  onRowMenu={openRowMenu}
                  onCollapse={() => setListOpen(false)}
                  onRescore={
                    relevance?.has_profile && (sort === "relevance_desc" || scope.kind === "important" || facets.relevance.length > 0)
                      ? () => api.rescoreRelevance(shown.map((a) => a.id))
                      : undefined
                  }
                  noProfile={relevance != null && !relevance.has_profile}
                />
              ) : (
                <ListRail onOpen={() => setListOpen(true)} />
              ))}
            {IS_MAIN && screen === "library" && !search && listOpen && splitter("list")}
            {screen === "library" && (
              <div className="doc-area-wrap" onContextMenu={tabMenu}>
                {error && (
                  <div className="banner" role="alert">
                    <span className="grow">{t.msg(error)}</span>
                    <button className="ib" onClick={() => setError(null)} aria-label={t("common.close")}>
                      ×
                    </button>
                  </div>
                )}
                <WordMarksContext.Provider value={marks}>
                  <DocArea
                    layout={layout}
                    onLayout={setLayout}
                    labelOf={labelOf}
                    renderPane={renderPane}
                    onNew={(pane) => openPage(homeOf(getEngine()), undefined, undefined, "new", pane)}
                    windowAction={windowAction}
                    movable={HOST.kind === "doc"}
                    onSend={win.sendTab}
                    onTear={(tab) => win.popOutTab(tab, true)}
                  />
                </WordMarksContext.Provider>
              </div>
            )}
            {palette != null && (
              <Palette
                initial={palette.initial}
                all={articles}
                shown={shown}
                feeds={feeds}
                folders={folders}
                groups={groupRows}
                scope={scope}
                facets={facets}
                actions={paletteActions}
                onClose={() => setPalette(null)}
              />
            )}
            {deleting && (
              <ConfirmDialog
                title={deleting.page ? t("app.confirmRemove") : t("app.confirmDelete")}
                confirm={t("common.delete")}
                onConfirm={() => deleteArticle(deleting.article)}
                onCancel={() => setDeleting(null)}
              >
                <p>{t.rich("app.deleteWhat", { x: deleting.article.title ?? deleting.article.original_url })}</p>
                <p>{t("app.deleteDesc")}</p>
              </ConfirmDialog>
            )}
            {prefix.prefix && <PrefixHint prefix={keyLabel(bindings.pane[0] ?? "Ctrl+B")} />}
            {groupPick && (
              <GroupPicker
                groups={groupRows}
                anchor={groupPick.el}
                onCreate={createGroup}
                onClose={() => setGroupPick(null)}
                selected={groupRows.filter((g) => groupPick.ids.every((id) => articleById.get(id)?.groups.includes(g.id))).map((g) => g.id)}
                onToggle={(g, on) => void groupMembers(g, groupPick.ids, on)}
              />
            )}
            {win.chatOpen && splitter("chat", "right")}
            {win.chatOpen && (
              <ChatPane
                article={chat.article}
                open={chat.docs}
                groups={chatGroups}
                request={chat.chatScope}
                onCite={openCitation}
                onClose={() => win.setChatOpen(false)}
                onPopOut={win.popOutChat}
                current={scope.kind === "all" || scope.kind === "recent" ? null : { key: filterKey(toFilter(scope)), label: title }}
              />
            )}
          </div>
        </ContextMenu>
      </div>
    </CoverContext.Provider>
  );
}
