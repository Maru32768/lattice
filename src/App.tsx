import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, browser, type ArticleFilter, type ArticleRow, type ArticleView, type SearchHit, type SearchResult, type TagCount } from "./api";
import { BrowserView, type BrowseTarget, type OverlaySettings, type PageState } from "./BrowserView";
import type { LanguageMode } from "./mixed";
import { Reader } from "./Reader";
import { ImportView } from "./ImportView";
import { SettingsView } from "./SettingsView";
import { SearchResults } from "./SearchResults";
import "./App.css";

type Main = "empty" | "browser" | "reader" | "results" | "import" | "settings";

export default function App() {
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [filter, setFilter] = useState<ArticleFilter>({ kind: "all" });
  const [tags, setTags] = useState<TagCount[]>([]);
  const filterRef = useRef(filter);
  filterRef.current = filter;
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

  const fail = (e: unknown) => setError(String(e));
  const refresh = () =>
    Promise.all([api.listArticles(filterRef.current).then(setArticles), api.listTags().then(setTags)]).catch(fail);
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

  /** `article`: the saved article being opened, highlighted right away rather than after the page loads. */
  function openPage(url: string, focus?: string, article?: ArticleRow) {
    setError(null);
    setTarget((t) => ({ url, focus, seq: (t?.seq ?? 0) + 1 }));
    setPage({ url, title: article?.title ?? "", loading: true });
    setSaved(article ?? null);
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
      await api.savePage();
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
    if (a) openPage(a.original_url, hit.text, a);
  }

  useEffect(() => { refresh(); }, [filter]);

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

  async function reextractArticle() {
    if (!view) return;
    try {
      await api.reextractArticle(view.article.id);
      await Promise.all([refresh(), loadView(view.article.id)]);
    } catch (e) {
      fail(e);
    }
  }

  const currentArticleId = main === "reader" ? view?.article.id : saved?.id;
  const filterButton = (f: ArticleFilter, label: string) => (
    <button className={JSON.stringify(f) === JSON.stringify(filter) ? "on" : ""} onClick={() => setFilter(f)}>{label}</button>
  );

  return (
    <div className="app">
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
        <ul className="list">
          {articles.map((a) => (
            <li key={a.id}>
              <button className={`item ${currentArticleId === a.id ? "active" : ""} ${a.read_status}`} onClick={() => openPage(a.original_url, undefined, a)}>
                <span className="title">{a.favorite && <span className="star" aria-label="お気に入り">★ </span>}{a.title ?? a.original_url}</span>
                <span className="sub">
                  {a.domain}
                  {a.tags.map((t) => ` #${t}`).join("")}
                  {a.fetch_status === "pending" && " · 取得中…"}
                  {(a.fetch_status === "failed" || a.extraction_status === "failed") && <em> · 失敗</em>}
                  {a.thin && <em title="ページ表示で開いて「描画後のページで保存」できます"> · 本文が短い</em>}
                </span>
              </button>
            </li>
          ))}
        </ul>
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
            onPage={() => openPage(view.article.original_url, undefined, view.article)} onLink={(href) => openPage(href)}
            onToggleRead={toggleRead} onRetry={retryArticle} onReextract={reextractArticle} onTranslate={translateArticle} onSummarize={summarizeArticle}
            onFavorite={() => toggleFavorite(view.article)} onTag={(name, add) => editTag(view.article, name, add)} />
        )}
        {main === "results" && searched && <SearchResults query={searched.query} result={searched.result} onOpen={openHit} />}
        {main === "import" && <ImportView onImported={refresh} />}
        {main === "settings" && <SettingsView />}
        {main === "empty" && <p className="empty">URL を開いてページを読み、「このページを翻訳」「Index に追加」で保存できます。</p>}
      </main>
    </div>
  );
}
