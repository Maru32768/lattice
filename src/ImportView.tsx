import { useState } from "react";
import { api, type ImportSummary } from "./api";
import "./manage.css";

/** Bulk import: paste anything containing URLs, or load a file (URL list, bookmarks HTML, CSV, JSON). */
export function ImportView({ onImported }: { onImported: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadFile(file: File | undefined) {
    if (file) setText(await file.text());
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.importUrls(text));
      onImported();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="manage">
      <div className="wrap">
        <header>
          <h1>一括インポート</h1>
          <p className="sub">URL 一覧、ブラウザのブックマーク（HTML）、CSV、JSON など、URL を含むテキストなら何でも読み込めます。取得はバックグラウンドで行い、失敗した記事があっても残りは続行します。</p>
        </header>
        <section className="card add" aria-label="インポートするテキスト">
          <div>
            <label className="btn">
              ファイルを選択
              <input type="file" className="vh" accept=".txt,.csv,.json,.html,.htm,.md" onChange={(e) => loadFile(e.target.files?.[0])} />
            </label>
          </div>
          <textarea className="paste" value={text} onChange={(e) => setText(e.target.value)} rows={14} aria-label="インポートするテキスト"
            placeholder={"https://example.com/post-1\nhttps://example.com/post-2"} spellCheck={false} />
          <div className="line">
            <button className="btn pri lg" onClick={run} disabled={busy || !text.trim()}>{busy ? "登録中…" : "インポート"}</button>
            {result && (
              <span role="status" className="msg">
                {result.found} 件中 {result.queued} 件を取得キューに追加
                {result.existing > 0 && `・${result.existing} 件は保存済み`}
                {result.invalid > 0 && `・${result.invalid} 件は無効な URL`}
              </span>
            )}
            {error && <span role="alert" className="msg error-text">{error}</span>}
          </div>
        </section>
      </div>
    </main>
  );
}
