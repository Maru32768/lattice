import { useState } from "react";
import { api, type ImportSummary } from "./api";
import "./manage.css";

export type ImportTab = "urls" | "markdown";

const SUB: Record<ImportTab, string> = {
  urls: "URL 一覧、ブラウザのブックマーク（HTML）、CSV、JSON など、URL を含むテキストなら何でも読み込めます。取得はバックグラウンドで行い、失敗した記事があっても残りは続行します。",
  markdown: "Markdown を 1 つの記事として取り込みます。タイトルは最初の見出し（# ）、なければファイル名か最初の行です。画像は、URL のものは保存し、相対パスのものはファイルから取り込んだときだけ同じフォルダから読み込みます（貼り付けたときは代替テキストを表示）。HTML タグは取り込みません。",
};

/** Bulk import of URLs (anything containing them: a list, bookmarks HTML, CSV, JSON), or one
 *  Markdown document, from a file or pasted. */
export function ImportView({ tab, onTab, onImported, onOpen }: {
  tab: ImportTab;
  onTab: (t: ImportTab) => void;
  onImported: () => void;
  /** After a Markdown import: the article it made (or already was). */
  onOpen: (id: number) => void;
}) {
  return (
    <main className="manage">
      <div className="wrap">
        <header className="head">
          <div>
            <h1>インポート</h1>
            <p className="sub">{SUB[tab]}</p>
          </div>
          <div className="acts">
            <div className="seg" role="group" aria-label="インポートの種類">
              <button className={tab === "urls" ? "on" : ""} aria-pressed={tab === "urls"} onClick={() => onTab("urls")}>URL 一覧</button>
              <button className={tab === "markdown" ? "on" : ""} aria-pressed={tab === "markdown"} onClick={() => onTab("markdown")}>Markdown</button>
            </div>
          </div>
        </header>
        {tab === "urls" ? <UrlImport onImported={onImported} /> : <MarkdownImport onOpen={onOpen} />}
      </div>
    </main>
  );
}

function UrlImport({ onImported }: { onImported: () => void }) {
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
  );
}

function MarkdownImport({ onOpen }: { onOpen: (id: number) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(load: () => Promise<number | null>) {
    setBusy(true);
    setError(null);
    try {
      const id = await load();
      if (id != null) onOpen(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card add" aria-label="Markdown">
      <div>
        <button className="btn" onClick={() => run(api.importMarkdownFile)} disabled={busy}>ファイルを選択…</button>
      </div>
      <textarea className="paste" value={text} onChange={(e) => setText(e.target.value)} rows={14} aria-label="Markdown"
        placeholder={"# タイトル\n\n本文をここに貼り付け"} spellCheck={false} />
      <div className="line">
        <button className="btn pri lg" onClick={() => run(() => api.importMarkdown(text))} disabled={busy || !text.trim()}>{busy ? "取り込み中…" : "取り込む"}</button>
        {error && <span role="alert" className="msg error-text">{error}</span>}
      </div>
    </section>
  );
}
