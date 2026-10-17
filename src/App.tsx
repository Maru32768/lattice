import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, browser, type ArticleFilter, type Citation, type ArticleRow, type ArticleSort, type ArticleView, type SearchHit, type SearchResult, type TagCount } from "./api";
import { BrowserView, type BrowseTarget, type OverlaySettings, type PageState } from "./BrowserView";
import type { LanguageMode } from "./mixed";
import { Reader } from "./Reader";
import { ImportView } from "./ImportView";
import { SettingsView } from "./SettingsView";
import { ArticleList } from "./ArticleList";
import { FeedsView } from "./FeedsView";
import { SearchResults } from "./SearchResults";
import { ChatPane } from "./ChatPane";
import "./App.css";

type Main = "empty" | "browser" | "reader" | "results" | "import" | "settings" | "feeds";

export default function App() {
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [filter, setFilter] = useState<ArticleFilter>({ kind: "all" });
  const [tags, setTags] = useState<TagCount[]>([]);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const [sort, setSort] = useState<ArticleSort>("saved_desc");
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const [main, setMain] = useState<Main>("empty");
  const [error, setError] = useState<string | null>(null);
  const [dbPath, setDbPath] = useState("");

  // Browser
  const [address, setAddress] = useState("");
  const [target, setTarget] = useState<BrowseTarget | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [saved, setSaved] = useState<ArticleRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [overlay, setOverlay] = useState<OverlaySettings>({ enabled: false, percent: 70 });

  // Reader (extracted text of a saved article)
  const [view, setView] = useState<ArticleView | null>(null);
  const [mode, setMode] = useState<LanguageMode>("mixed");
  const [percent, setPercent] = useState(70);
  const viewId = useRef<number | null>(null);

  // Search
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<{ query: string; result: SearchResult } | null>(null);
  const [chatOpen, setChatOpen] = useState(false);

  const fail = (e: unknown) => setError(String(e));
  const refresh = () =>
    Promise.all([api.listArticles(filterRef.current, sortRef.current).then(setArticles), api.listTags().then(setTags)]).catch(fail);
  const refreshSaved = (url: string) => api.articleForUrl(url).then(setSaved).catch(() => setSaved(null));
  // Background jobs (bulk import fetches) report every article; coalesce list reloads.
  const refreshTimer = useRef(0);
  const refreshSoon = () => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(refresh, 500);
  };
  const loadView = (id: number) => {
    viewId.current = id;
    return api.getArticle(id).then((v) => { if (viewId.current === id) setView(v); }).catch(fail);
  };

  useEffect(() => {
    api.dbPath().then(setDbPath);
    const subs = [
      listen<number>("article-changed", (e) => {
        if (e.payload === viewId.current) loadView(e.payload);
        refreshSoon();
      }),
      listen<{ url: string; loading: boolean }>("browser-page", (e) => {
        setPage((p) => ({ url: e.payload.url, loading: e.payload.loading, title: p?.url === e.payload.url ? p.title : "" }));
        if (!e.payload.loading) refreshSaved(e.payload.url);
      }),
      listen<string>("browser-title", (e) => setPage((p) => (p ? { ...p, title: e.payload } : p))),
    ];
    return () => { subs.forEach((s) => s.then((f) => f())); };
  }, []);

  function openPage(url: string, focus?: string) {
    setError(null);
    setTarget((t) => ({ url, focus, seq: (t?.seq ?? 0) + 1 }));
    setMain("browser");
  }

  function openAddress(e: React.FormEvent) {
    e.preventDefault();
    const raw = address.trim();
    if (!raw) return;
    openPage(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  }

  async function saveCurrent() {
    if (!page) return;
    setSaving(true);
    try {
      await api.saveUrl(page.url);
      await Promise.all([refresh(), refreshSaved(page.url)]);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }

  function changeOverlay(o: OverlaySettings) {
    setOverlay(o);
    browser.setTranslation(o.enabled, o.percent).catch(fail);
  }

  async function showReader(id: number) {
    await loadView(id);
    setMain("reader");
  }

  async function search(q: string) {
    setError(null);
    try {
      setSearched({ query: q, result: await api.search(q) });
      setMain("results");
    } catch (e) {
      fail(e);
    }
  }

  function openHit(hit: SearchHit) {
    const a = articles.find((x) => x.id === hit.article_id);
    if (a) openPage(a.original_url, hit.text);
  }

  /** Chat citation: jump inside the Reader when it shows that article, else open the page at the block. */
  function openCitation(c: Citation) {
    const el = main === "reader" && view?.article.id === c.article_id ? document.getElementById(`b-${c.block_id}`) : null;
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("focused");
      window.setTimeout(() => el.classList.remove("focused"), 2000);
    } else if (c.url) {
      openPage(c.url, c.text);
    } else {
      setError("引用元の記事は削除されています");
    }
  }

  useEffect(() => { refresh(); }, [filter, sort]);

  async function toggleFavorite(a: ArticleRow) {
    try {
      await api.setFavorite(a.id, !a.favorite);
      await Promise.all([refresh(), page && refreshSaved(page.url), viewId.current === a.id && loadView(a.id)]);
    } catch (e) {
      fail(e);
    }
  }

  async function editTag(a: ArticleRow, name: string, add: boolean) {
    try {
      await (add ? api.addTag(a.id, name) : api.removeTag(a.id, name));
      await Promise.all([refresh(), loadView(a.id)]);
    } catch (e) {
      fail(e);
    }
  }

  async function setGenre(name: string) {
    if (!view) return;
    try {
      await api.setGenre(view.article.id, name);
      await Promise.all([refresh(), loadView(view.article.id)]);
    } catch (e) {
      fail(e);
    }
  }

  async function classifyArticle() {
    if (!view) return;
    try {
      await api.classifyArticle(view.article.id);
      await loadView(view.article.id);
    } catch (e) {
      fail(e);
    }
  }

  async function toggleRead() {
    if (!view) return;
    const a = view.article;
    await api.setRead(a.id, a.read_status !== "read");
    await Promise.all([refresh(), loadView(a.id)]);
  }

  async function translateArticle() {
    if (!view) return;
    try {
      await api.translateArticle(view.article.id);
      await loadView(view.article.id);
    } catch (e) {
      fail(e);
    }
  }

  async function summarizeArticle() {
    if (!view) return;
    try {
      await api.summarizeArticle(view.article.id);
      await loadView(view.article.id);
    } catch (e) {
      fail(e);
    }
  }

  async function retryArticle() {
    if (!view) return;
    try {
      await api.saveUrl(view.article.original_url);
      await Promise.all([refresh(), loadView(view.article.id)]);
    } catch (e) {
      fail(e);
    }
  }

  const currentArticleId = main === "reader" ? view?.article.id : saved?.id;
  const chatArticle = main === "reader" && view ? view.article : main === "browser" ? saved : null;
  const filterButton = (f: ArticleFilter, label: string) => (
    <button className={JSON.stringify(f) === JSON.stringify(filter) ? "on" : ""} onClick={() => setFilter(f)}>{label}</button>
  );

  return (
    <div className={`app${chatOpen ? " with-chat" : ""}`}>
      <aside className="sidebar">
        <form onSubmit={openAddress}>
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="URL を開く" aria-label="URL" />
          <button type="submit" disabled={!address.trim()}>開く</button>
        </form>
        <form role="search" onSubmit={(e) => { e.preventDefault(); if (query.trim()) search(query.trim()); }}>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="保存した記事を検索" aria-label="検索語" />
          <button type="submit" disabled={!query.trim()}>検索</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        <nav className="filters" aria-label="記事の絞り込み">
          {filterButton({ kind: "all" }, "最近追加")}
          {filterButton({ kind: "unread" }, "未読")}
          {filterButton({ kind: "favorites" }, "お気に入り")}
          {tags.map((t) => (
            <span key={t.name}>{filterButton({ kind: "tag", name: t.name }, `#${t.name} ${t.count}`)}</span>
          ))}
        </nav>
        <ArticleList articles={articles} sort={sort} onSort={setSort} renderItem={(a) => (
            <li key={a.id}>
              <button className={`item ${currentArticleId === a.id ? "active" : ""} ${a.read_status}`} onClick={() => openPage(a.original_url)}>
                <span className="title">{a.favorite && <span className="star" aria-label="お気に入り">★ </span>}{a.title ?? a.original_url}</span>
                <span className="sub">
                  {a.domain}
                  {a.tags.map((t) => ` #${t}`).join("")}
                  {a.fetch_status === "pending" && " · 取得中…"}
                  {(a.fetch_status === "failed" || a.extraction_status === "failed") && <em> · 失敗</em>}
                </span>
              </button>
            </li>
          )} />
        <button className="import-link" onClick={() => setMain("feeds")}>フィード（RSS）…</button>
        <button className="import-link" onClick={() => setChatOpen((o) => !o)} aria-pressed={chatOpen}>
          {chatOpen ? "対話ペインを閉じる" : "記事に質問する（対話）…"}
        </button>
        <button className="import-link" onClick={() => setMain("import")}>一括インポート…</button>
        <button className="import-link" onClick={() => setMain("settings")}>設定・バックアップ…</button>
        <footer className="dbpath" title={dbPath}>DB: {dbPath}</footer>
      </aside>
      <main className={main === "browser" ? "has-browser" : ""}>
        {main !== "results" && searched && <button className="back" onClick={() => setMain("results")}>← 検索結果に戻る</button>}
        {main === "browser" && target && (
          <BrowserView target={target} page={page} saved={saved} saving={saving} overlay={overlay}
            onOverlay={changeOverlay} onSave={saveCurrent} onReader={() => saved && showReader(saved.id)}
            onFavorite={() => saved && toggleFavorite(saved)} onError={fail} />
        )}
        {main === "reader" && view && (
          <Reader key={view.article.id} view={view} mode={mode} percent={percent} onMode={setMode} onPercent={setPercent}
            onPage={() => openPage(view.article.original_url)} onLink={(href) => openPage(href)}
            onToggleRead={toggleRead} onRetry={retryArticle} onTranslate={translateArticle} onSummarize={summarizeArticle}
            onFavorite={() => toggleFavorite(view.article)} onTag={(name, add) => editTag(view.article, name, add)}
            onGenre={setGenre} onClassify={classifyArticle} />
        )}
        {main === "results" && searched && <SearchResults query={searched.query} result={searched.result} onOpen={openHit} />}
        {main === "import" && <ImportView onImported={refresh} />}
        {main === "settings" && <SettingsView />}
        {main === "feeds" && <FeedsView onChanged={refreshSoon} />}
        {main === "empty" && <p className="empty">URL を開いてページを読み、「このページを翻訳」「Index に追加」で保存できます。</p>}
      </main>
      {chatOpen && (
        <ChatPane article={chatArticle && { id: chatArticle.id, title: chatArticle.title ?? chatArticle.original_url }}
          tags={tags} onCite={openCitation} onClose={() => setChatOpen(false)} />
      )}
    </div>
  );
}
