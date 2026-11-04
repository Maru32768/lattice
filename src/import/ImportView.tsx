import { useState } from "react";
import { api, type GroupRow, type ImportSummary } from "../api";
import { GroupPicker } from "../library/GroupPicker";
import { Icon } from "../ui/Icon";
import "../ui/manage.css";
import { useT, type PlainKey } from "../i18n";
import { skippedLines } from "../lib/urlLines";
import { fileStem, readUtf8 } from "../lib/files";
import { useFileDrop } from "../ui/useFileDrop";

export type ImportTab = "urls" | "markdown" | "pdf";

const URL_FILES = ".txt,.csv,.json,.html,.htm,.md";
const MARKDOWN_FILES = ".md,.markdown";
const PDF_FILES = ".pdf,application/pdf";
// The backend's limits (markdown::MAX_FILE_BYTES, pdf::MAX_BYTES): checked here too, before a huge file is read into memory.
const MARKDOWN_MAX_MB = 10;
const PDF_MAX_MB = 50;
const tooLarge = (file: File, mb: number) => file.size > mb * 1024 * 1024;

const SUB: Record<ImportTab, PlainKey> = {
  urls: "importView.urlsDesc",
  pdf: "importView.pdfDesc",
  markdown: "importView.markdownDesc",
};

/** Bulk import of URLs (anything containing them: a list, bookmarks HTML, CSV, JSON), one
 *  Markdown document (from a file or pasted), or one PDF file. */
export function ImportView({
  tab,
  onTab,
  onImported,
  onOpen,
  groups,
  initialGroups,
  onCreateGroup,
}: {
  tab: ImportTab;
  onTab: (t: ImportTab) => void;
  onImported: () => void;
  /** After a Markdown or PDF import: the article it made (or already was). */
  onOpen: (id: number) => void;
  groups: GroupRow[];
  /** The groups imported articles go into at first (the list's group scope). */
  initialGroups: number[];
  onCreateGroup: (name: string) => Promise<number>;
}) {
  const t = useT();
  const [into, setInto] = useState(initialGroups);
  /** Puts imported articles into the chosen groups (already-saved ones too). */
  const fileInto = async (ids: number[]) => {
    await Promise.all(into.map((g) => api.groupAdd(g, ids)));
  };
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
              <button className={tab === "urls" ? "on" : ""} aria-pressed={tab === "urls"} onClick={() => onTab("urls")}>
                {t("importView.urls")}
              </button>
              <button className={tab === "markdown" ? "on" : ""} aria-pressed={tab === "markdown"} onClick={() => onTab("markdown")}>
                Markdown
              </button>
              <button className={tab === "pdf" ? "on" : ""} aria-pressed={tab === "pdf"} onClick={() => onTab("pdf")}>
                PDF
              </button>
            </div>
          </div>
        </header>
        <GroupField groups={groups} into={into} onInto={setInto} onCreate={onCreateGroup} />
        {tab === "urls" ? (
          <UrlImport onImported={onImported} fileInto={fileInto} />
        ) : tab === "markdown" ? (
          <MarkdownImport onOpen={onOpen} fileInto={fileInto} />
        ) : (
          <PdfImport onOpen={onOpen} fileInto={fileInto} />
        )}
      </div>
    </main>
  );
}

/** グループ: where imported articles go; none by default. */
function GroupField({
  groups,
  into,
  onInto,
  onCreate,
}: {
  groups: GroupRow[];
  into: number[];
  onInto: (ids: number[]) => void;
  onCreate: (name: string) => Promise<number>;
}) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const names = groups.filter((g) => into.includes(g.id)).map((g) => g.name);
  return (
    <div className="import-groups">
      <span className="muted">{t("common.group")}</span>
      <button
        className={`chip${names.length ? " on" : " dashed"}`}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={(e) => {
          const el = e.currentTarget;
          setAnchor((a) => (a ? null : el));
        }}
      >
        <Icon name="folder" size="sm" />
        {names.length ? names.join(" · ") : t("importView.noGroup")}
        <Icon name="down" size="sm" />
      </button>
      {anchor && (
        <GroupPicker
          groups={groups}
          selected={into}
          anchor={anchor}
          onClose={() => setAnchor(null)}
          onCreate={onCreate}
          onToggle={(id, on) => onInto(on ? [...into, id] : into.filter((x) => x !== id))}
        />
      )}
    </div>
  );
}

type FileInto = (ids: number[]) => Promise<void>;

function NoAutoTranslate({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  const t = useT();
  return (
    <label className="ff-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {t("importView.noAutoTranslate")}
    </label>
  );
}

function UrlImport({ onImported, fileInto }: { onImported: () => void; fileInto: FileInto }) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(ImportSummary & ReturnType<typeof skippedLines>) | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadFile(file: File | undefined) {
    if (file) {
      setError(null);
      setText(await file.text());
    }
  }
  const { dragging, zone } = useFileDrop({
    accept: URL_FILES,
    onFile: (file) => void loadFile(file),
    onReject: () => setError(t("common.wrongFile")),
    disabled: busy,
  });

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.importUrls(text);
      await fileInto(r.ids);
      setResult({ ...r, ...skippedLines(text) });
      setText("");
      onImported();
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  return (
    <section className={`card add${dragging ? " dropping" : ""}`} aria-label={t("importView.text")} {...zone}>
      <div className="line">
        <label className="btn">
          {t("importView.chooseFile")}
          <input type="file" className="vh" accept={URL_FILES} onChange={(e) => loadFile(e.target.files?.[0])} />
        </label>
        <span className="muted drop-hint">{t("common.dropOrPaste")}</span>
      </div>
      <textarea
        className="paste"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
        aria-label={t("importView.text")}
        placeholder={"https://example.com/post-1\nhttps://example.com/post-2"}
        spellCheck={false}
      />
      <div className="line">
        <button className="btn pri lg" onClick={run} disabled={busy || !text.trim()}>
          {busy ? t("importView.adding") : t("importView.import")}
        </button>
        {result && (
          <span role="status" className="msg">
            {t("importView.queued", { found: result.found, queued: result.queued })}
            {result.existing > 0 && t("importView.existing", { existing: result.existing })}
            {result.invalid > 0 && t("importView.invalid", { invalid: result.invalid })}
            {result.scheme > 0 && t("common.skippedScheme", { n: result.scheme })}
            {result.noUrl > 0 && t("common.skippedNoUrl", { n: result.noUrl })}
          </span>
        )}
        {error && (
          <span role="alert" className="msg error-text">
            {t.msg(error)}
          </span>
        )}
      </div>
    </section>
  );
}

function MarkdownImport({ onOpen, fileInto }: { onOpen: (id: number) => void; fileInto: FileInto }) {
  const t = useT();
  const [text, setText] = useState("");
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(load: () => Promise<number | null>) {
    setBusy(true);
    setError(null);
    try {
      const id = await load();
      if (id != null) {
        await fileInto([id]);
        onOpen(id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  // No path comes with a dropped file, so relative images show their alt text, as in pasted text.
  const { dragging, zone } = useFileDrop({
    accept: MARKDOWN_FILES,
    onFile: (file) =>
      void run(async () => {
        if (tooLarge(file, MARKDOWN_MAX_MB)) {
          throw new Error(t("be.file.tooLarge", { max: MARKDOWN_MAX_MB }));
        }
        const content = await readUtf8(file);
        if (content === null) {
          throw new Error(t("be.file.notUtf8"));
        }
        return api.importMarkdown(content, fileStem(file.name), manual);
      }),
    onReject: () => setError(t("common.wrongFile")),
    disabled: busy,
  });

  return (
    <section className={`card add${dragging ? " dropping" : ""}`} aria-label="Markdown" {...zone}>
      <div className="line">
        <button className="btn" onClick={() => run(() => api.importMarkdownFile(manual))} disabled={busy}>
          {t("importView.chooseFileEllipsis")}
        </button>
        <span className="muted drop-hint">{t("common.dropOrPaste")}</span>
      </div>
      <textarea
        className="paste"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
        aria-label="Markdown"
        placeholder={t("importView.markdownPlaceholder")}
        spellCheck={false}
      />
      <div className="line">
        <button className="btn pri lg" onClick={() => run(() => api.importMarkdown(text, undefined, manual))} disabled={busy || !text.trim()}>
          {busy ? t("importView.importing") : t("importView.importMarkdown")}
        </button>
        <NoAutoTranslate checked={manual} onChange={setManual} />
        {error && (
          <span role="alert" className="msg error-text">
            {t.msg(error)}
          </span>
        )}
      </div>
    </section>
  );
}

function PdfImport({ onOpen, fileInto }: { onOpen: (id: number) => void; fileInto: FileInto }) {
  const t = useT();
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(load: () => Promise<number | null>) {
    setBusy(true);
    setError(null);
    try {
      const id = await load();
      if (id != null) {
        await fileInto([id]);
        onOpen(id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  const { dragging, zone } = useFileDrop({
    accept: PDF_FILES,
    onFile: (file) =>
      void run(async () => {
        if (tooLarge(file, PDF_MAX_MB)) {
          throw new Error(t("be.file.tooLarge", { max: PDF_MAX_MB }));
        }
        return api.importPdfBytes(new Uint8Array(await file.arrayBuffer()), fileStem(file.name), manual);
      }),
    onReject: () => setError(t("common.wrongFile")),
    disabled: busy,
  });

  return (
    <section className={`card add drop-area${dragging ? " dropping" : ""}`} aria-label="PDF" {...zone}>
      <button className="btn pri lg" onClick={() => run(() => api.importPdfFile(manual))} disabled={busy}>
        {busy ? t("importView.importing") : t("importView.choosePdf")}
      </button>
      <span className="muted drop-hint">{t("common.dropOrPaste")}</span>
      <NoAutoTranslate checked={manual} onChange={setManual} />
      {error && (
        <span role="alert" className="msg error-text">
          {t.msg(error)}
        </span>
      )}
    </section>
  );
}
