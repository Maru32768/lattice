import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type ArticleRow, type ArticleView } from "./api";
import type { LanguageMode } from "./mixed";
import { Reader } from "./Reader";
import "./App.css";

export default function App() {
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [view, setView] = useState<ArticleView | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dbPath, setDbPath] = useState("");
  const [mode, setMode] = useState<LanguageMode>("mixed");
  const [percent, setPercent] = useState(70);
  const currentId = useRef<number | null>(null);

  const refresh = () => api.listArticles().then(setArticles).catch((e) => setError(String(e)));
  const select = (id: number) => {
    currentId.current = id;
    return api.getArticle(id).then((v) => { if (currentId.current === id) setView(v); })
      .catch((e) => setError(String(e)));
  };

  useEffect(() => {
    refresh();
    api.dbPath().then(setDbPath);
    // The job runner reports progress per batch; reload the open article when it changes.
    const unlisten = listen<number>("article-changed", (e) => {
      if (e.payload === currentId.current) select(e.payload);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  async function translate() {
    if (!view) return;
    try {
      await api.translateArticle(view.article.id);
      await select(view.article.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function save(target: string) {
    setBusy(true);
    setError(null);
    try {
      const id = await api.saveUrl(target);
      await refresh();
      await select(id);
      setUrl("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRead() {
    if (!view) return;
    const a = view.article;
    await api.setRead(a.id, a.read_status !== "read");
    await Promise.all([refresh(), select(a.id)]);
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <form onSubmit={(e) => { e.preventDefault(); if (url.trim()) save(url); }}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="記事URLを貼り付け"
            aria-label="記事URL"
            disabled={busy}
          />
          <button type="submit" disabled={busy || !url.trim()}>{busy ? "保存中…" : "保存"}</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        <ul className="list">
          {articles.map((a) => (
            <li key={a.id}>
              <button
                className={`item ${view?.article.id === a.id ? "active" : ""} ${a.read_status}`}
                onClick={() => select(a.id)}
              >
                <span className="title">{a.title ?? a.original_url}</span>
                <span className="sub">
                  {a.domain}
                  {(a.fetch_status === "failed" || a.extraction_status === "failed") && <em> · 失敗</em>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <footer className="dbpath" title={dbPath}>DB: {dbPath}</footer>
      </aside>
      <main>
        {view
          ? <Reader key={view.article.id} view={view} mode={mode} percent={percent} onMode={setMode} onPercent={setPercent}
              onToggleRead={toggleRead} onRetry={() => save(view.article.original_url)} onTranslate={translate} />
          : <p className="empty">URLを保存すると、ここに本文が表示されます。</p>}
      </main>
    </div>
  );
}
