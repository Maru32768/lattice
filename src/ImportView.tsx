import { useState } from "react";
import { api, type ImportSummary } from "./api";
import "./manage.css";
import { useT, type PlainKey } from "./i18n";

export type ImportTab = "urls" | "markdown" | "pdf";

const SUB: Record<ImportTab, PlainKey> = {
  urls: "importView.urlsDesc",
  pdf: "importView.pdfDesc",
  markdown: "importView.markdownDesc",
};

/** Bulk import of URLs (anything containing them: a list, bookmarks HTML, CSV, JSON), one
 *  Markdown document (from a file or pasted), or one PDF file. */
export function ImportView({ tab, onTab, onImported, onOpen }: {
  tab: ImportTab;
  onTab: (t: ImportTab) => void;
  onImported: () => void;
  /** After a Markdown or PDF import: the article it made (or already was). */
  onOpen: (id: number) => void;
}) {
  const t = useT();
  return (
    <main className="manage">
      <div className="wrap">
        <header className="head">
          <div>
            <h1>{t("importView.title")}</h1>
            <p className="sub">{t(SUB[tab])}</p>
          </div>
          <div className="acts">
            <div className="seg" role="group" aria-label={t("importView.kind")}>
              <button className={tab === "urls" ? "on" : ""} aria-pressed={tab === "urls"} onClick={() => onTab("urls")}>{t("importView.urls")}</button>
              <button className={tab === "markdown" ? "on" : ""} aria-pressed={tab === "markdown"} onClick={() => onTab("markdown")}>Markdown</button>
              <button className={tab === "pdf" ? "on" : ""} aria-pressed={tab === "pdf"} onClick={() => onTab("pdf")}>PDF</button>
            </div>
          </div>
        </header>
        {tab === "urls" ? <UrlImport onImported={onImported} /> : tab === "markdown" ? <MarkdownImport onOpen={onOpen} /> : <PdfImport onOpen={onOpen} />}
      </div>
    </main>
  );
}

function UrlImport({ onImported }: { onImported: () => void }) {
  const t = useT();
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
    <section className="card add" aria-label={t("importView.text")}>
      <div>
        <label className="btn">
          {t("importView.chooseFile")}
          <input type="file" className="vh" accept=".txt,.csv,.json,.html,.htm,.md" onChange={(e) => loadFile(e.target.files?.[0])} />
        </label>
      </div>
      <textarea className="paste" value={text} onChange={(e) => setText(e.target.value)} rows={14} aria-label={t("importView.text")}
        placeholder={"https://example.com/post-1\nhttps://example.com/post-2"} spellCheck={false} />
      <div className="line">
        <button className="btn pri lg" onClick={run} disabled={busy || !text.trim()}>{busy ? t("importView.adding") : t("importView.import")}</button>
        {result && (
          <span role="status" className="msg">
            {t("importView.queued", { found: result.found, queued: result.queued })}
            {result.existing > 0 && t("importView.existing", { existing: result.existing })}
            {result.invalid > 0 && t("importView.invalid", { invalid: result.invalid })}
          </span>
        )}
        {error && <span role="alert" className="msg error-text">{t.msg(error)}</span>}
      </div>
    </section>
  );
}

function MarkdownImport({ onOpen }: { onOpen: (id: number) => void }) {
  const t = useT();
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
        <button className="btn" onClick={() => run(api.importMarkdownFile)} disabled={busy}>{t("importView.chooseFileEllipsis")}</button>
      </div>
      <textarea className="paste" value={text} onChange={(e) => setText(e.target.value)} rows={14} aria-label="Markdown"
        placeholder={t("importView.markdownPlaceholder")} spellCheck={false} />
      <div className="line">
        <button className="btn pri lg" onClick={() => run(() => api.importMarkdown(text))} disabled={busy || !text.trim()}>{busy ? t("importView.importing") : t("importView.importMarkdown")}</button>
        {error && <span role="alert" className="msg error-text">{t.msg(error)}</span>}
      </div>
    </section>
  );
}

function PdfImport({ onOpen }: { onOpen: (id: number) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const id = await api.importPdfFile();
      if (id != null) onOpen(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card add" aria-label="PDF">
      <div className="line">
        <button className="btn pri lg" onClick={run} disabled={busy}>{busy ? t("importView.importing") : t("importView.choosePdf")}</button>
        {error && <span role="alert" className="msg error-text">{t.msg(error)}</span>}
      </div>
    </section>
  );
}
