import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, browser, type ArticleRow, type ArticleView, type SearchHit, type SearchResult } from "./api";
import { BrowserView, type BrowseTarget, type OverlaySettings, type PageState } from "./BrowserView";
import type { LanguageMode } from "./mixed";
import { Reader } from "./Reader";
import { SearchResults } from "./SearchResults";
import "./App.css";

type Main = "empty" | "browser" | "reader" | "results";

export default function App() {
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [main, setMain] = useState<Main>("empty");
  const [error, setError] = useState<string | null>(null);
  const [dbPath, setDbPath] = useState("");

  // Browser
  const [address, setAddress] = useState("");
  const [target, setTarget] = useState<BrowseTarget | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);
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
  const refresh = () => api.listArticles().then(setArticles).catch(fail);
  const loadView = (id: number) => {
    viewId.current = id;
    return api.getArticle(id).then((v) => { if (viewId.current === id) setView(v); }).catch(fail);
  };

  useEffect(() => {
    refresh();
    api.dbPath().then(setDbPath);
    const subs = [
      listen<number>("article-changed", (e) => {
        if (e.payload === viewId.current) loadView(e.payload);
      }),
      listen<{ url: string; loading: boolean }>("browser-page", (e) => {
        setPage((p) => ({ url: e.payload.url, loading: e.payload.loading, title: p?.url === e.payload.url ? p.title : "" }));
        if (!e.payload.loading) api.articleForUrl(e.payload.url).then(setSavedId).catch(() => setSavedId(null));
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
      setSavedId(await api.saveUrl(page.url));
      await refresh();
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

  async function retryArticle() {
    if (!view) return;
    try {
      await api.saveUrl(view.article.original_url);
      await Promise.all([refresh(), loadView(view.article.id)]);
    } catch (e) {
      fail(e);
    }
  }

  const currentArticleId = main === "reader" ? view?.article.id : savedId;

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
        <ul className="list">
          {articles.map((a) => (
            <li key={a.id}>
              <button className={`item ${currentArticleId === a.id ? "active" : ""} ${a.read_status}`} onClick={() => openPage(a.original_url)}>
                <span className="title">{a.title ?? a.original_url}</span>
                <span className="sub">
                  {a.domain}
                  {a.fetch_status === "pending" && " · 取得中…"}
                  {(a.fetch_status === "failed" || a.extraction_status === "failed") && <em> · 失敗</em>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <footer className="dbpath" title={dbPath}>DB: {dbPath}</footer>
      </aside>
      <main className={main === "browser" ? "has-browser" : ""}>
        {main !== "results" && searched && <button className="back" onClick={() => setMain("results")}>← 検索結果に戻る</button>}
        {main === "browser" && target && (
          <BrowserView target={target} page={page} savedId={savedId} saving={saving} overlay={overlay}
            onOverlay={changeOverlay} onSave={saveCurrent} onReader={() => savedId != null && showReader(savedId)} onError={fail} />
        )}
        {main === "reader" && view && (
          <Reader key={view.article.id} view={view} mode={mode} percent={percent} onMode={setMode} onPercent={setPercent}
            onPage={() => openPage(view.article.original_url)} onLink={(href) => openPage(href)}
            onToggleRead={toggleRead} onRetry={retryArticle} onTranslate={translateArticle} />
        )}
        {main === "results" && searched && <SearchResults query={searched.query} result={searched.result} onOpen={openHit} />}
        {main === "empty" && <p className="empty">URL を開いてページを読み、「このページを翻訳」「Index に追加」で保存できます。</p>}
      </main>
    </div>
  );
}
