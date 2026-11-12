import { useRef, useState, useSyncExternalStore } from "react";
import { api, type GroupRow, type ImportSummary } from "../api";
import { GroupPicker } from "../library/GroupPicker";
import { Icon } from "../ui/Icon";
import "../ui/manage.css";
import { useT, type PlainKey } from "../i18n";
import { skippedLines } from "../lib/urlLines";
import { fileStem, readUtf8 } from "../lib/files";
import { useFileDrop } from "../ui/useFileDrop";
import { readPref, savePref, useSynced } from "../lib/prefs";

export type ImportTab = "urls" | "markdown" | "pdf";

const URL_FILES = ".txt,.csv,.json,.html,.htm,.md";
const MARKDOWN_FILES = ".md,.markdown";
const PDF_FILES = ".pdf,application/pdf";
// The backend's limits (markdown::MAX_FILE_BYTES, pdf::MAX_BYTES): checked here too, before a huge file is read into memory.
const MARKDOWN_MAX_MB = 10;
const PDF_MAX_MB = 50;
const tooLarge = (file: File, mb: number) => file.size > mb * 1024 * 1024;

const NO_AUTO_KEY = "lattice.importNoAutoTranslate";
/** 自動で翻訳しない, shared by the Markdown and PDF tabs and kept for the next import: a book comes in as many files. */
const noAutoTranslate = () => readPref(NO_AUTO_KEY) === "on";

const SUB: Record<ImportTab, PlainKey> = {
  urls: "importView.urlsDesc",
  pdf: "importView.pdfDesc",
  markdown: "importView.markdownDesc",
};

/** Bulk import of URLs (anything containing them: a list, bookmarks HTML, CSV, JSON), one
 *  Markdown document (from a file or pasted), or PDF files. */
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
  /** After a Markdown import or one PDF: the article it made (or already was). */
  onOpen: (id: number) => void;
  groups: GroupRow[];
  /** The groups imported articles go into at first (the list's group scope). */
  initialGroups: number[];
  onCreateGroup: (name: string) => Promise<number>;
}) {
  const t = useT();
  const [into, setInto] = useState(initialGroups);
  const [manual, setManualState] = useSynced(NO_AUTO_KEY, noAutoTranslate);
  const setManual = (on: boolean) => {
    setManualState(on);
    savePref(NO_AUTO_KEY, on ? "on" : "off");
  };
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
          <MarkdownImport onOpen={onOpen} fileInto={fileInto} manual={manual} onManual={setManual} />
        ) : (
          <PdfImport onOpen={onOpen} onImported={onImported} fileInto={fileInto} manual={manual} onManual={setManual} />
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

interface Manual {
  manual: boolean;
  onManual: (on: boolean) => void;
}

function MarkdownImport({ onOpen, fileInto, manual, onManual }: { onOpen: (id: number) => void; fileInto: FileInto } & Manual) {
  const t = useT();
  const [text, setText] = useState("");
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
        <NoAutoTranslate checked={manual} onChange={onManual} />
        {error && (
          <span role="alert" className="msg error-text">
            {t.msg(error)}
          </span>
        )}
      </div>
    </section>
  );
}

interface Failed {
  name: string;
  error: string;
}

/** One PDF's import: its article, or why it could not be imported (the rest still go in). */
async function importPdf(file: File, manual: boolean, tooLargeError: string): Promise<{ id: number } | { error: string }> {
  if (tooLarge(file, PDF_MAX_MB)) {
    return { error: tooLargeError };
  }
  try {
    return { id: await api.importPdfBytes(new Uint8Array(await file.arrayBuffer()), fileStem(file.name), manual) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The PDF tab's import, kept outside the component: switching tab or screen mid-import unmounts it, and on the way back
 * the run must still show, with the files that failed, and a second run must not start beside it and mix the books' order.
 */
interface PdfRun {
  /** The file being imported (1-based) and how many there are; null when idle. */
  progress: { at: number; of: number } | null;
  done: { imported: number; failed: Failed[] } | null;
  error: string | null;
}
let pdfRun: PdfRun = { progress: null, done: null, error: null };
const pdfRunListeners = new Set<() => void>();
function setPdfRun(next: Partial<PdfRun>) {
  pdfRun = { ...pdfRun, ...next };
  pdfRunListeners.forEach((l) => l());
}
const subscribePdfRun = (l: () => void) => {
  pdfRunListeners.add(l);
  return () => void pdfRunListeners.delete(l);
};
const currentPdfRun = () => pdfRun;
const usePdfRun = () => useSyncExternalStore(subscribePdfRun, currentPdfRun);

async function importPdfs(
  picked: File[],
  {
    manual,
    tooLargeError,
    fileInto,
    onOpen,
    onImported,
  }: { manual: boolean; tooLargeError: string; fileInto: FileInto; onOpen: (id: number) => void; onImported: () => void },
) {
  if (pdfRun.progress) {
    return;
  }
  // "01 …", "02 …" and "2 …", "10 …" both go in chapter order, so the library lists them as the book does.
  const files = picked.toSorted((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  setPdfRun({ progress: { at: 1, of: files.length }, done: null, error: null });
  const ids: number[] = [];
  const failed: Failed[] = [];
  for (const [i, file] of files.entries()) {
    setPdfRun({ progress: { at: i + 1, of: files.length } });
    const r = await importPdf(file, manual, tooLargeError);
    if ("id" in r) {
      ids.push(r.id);
    } else {
      failed.push({ name: file.name, error: r.error });
    }
  }
  let error: string | null = null;
  // With nothing imported there is nothing to file, and a group deleted meanwhile would report an error of its own.
  if (ids.length > 0) {
    try {
      await fileInto(ids);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  setPdfRun({ progress: null });
  const [id] = ids;
  if (files.length === 1) {
    // As before the screen took several files: an article left out of its group stays here to say so.
    if (id !== undefined && error === null) {
      onOpen(id);
    } else {
      setPdfRun({ error: error ?? failed[0]?.error ?? null });
    }
    return;
  }
  setPdfRun({ done: { imported: ids.length, failed }, error });
  onImported();
}

/** One PDF opens in the Reader, as before; several (a book split into chapters) stay here with what came of each. */
function PdfImport({ onOpen, onImported, fileInto, manual, onManual }: { onOpen: (id: number) => void; onImported: () => void; fileInto: FileInto } & Manual) {
  const t = useT();
  const picker = useRef<HTMLInputElement>(null);
  const { progress, done, error } = usePdfRun();
  const busy = progress !== null;
  const importAll = (files: File[]) =>
    void importPdfs(files, { manual, tooLargeError: t("be.file.tooLarge", { max: PDF_MAX_MB }), fileInto, onOpen, onImported });

  const { dragging, zone } = useFileDrop({
    accept: PDF_FILES,
    onFiles: importAll,
    onReject: () => setPdfRun({ error: t("common.wrongFile") }),
    disabled: busy,
  });

  return (
    <section className={`card add drop-area${dragging ? " dropping" : ""}`} aria-label="PDF" {...zone}>
      <button className="btn pri lg" onClick={() => picker.current?.click()} disabled={busy}>
        {progress === null ? t("importView.choosePdf") : progress.of > 1 ? t("importView.importingOf", progress) : t("importView.importing")}
      </button>
      <input
        ref={picker}
        type="file"
        className="vh"
        accept={PDF_FILES}
        multiple
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Cleared so that picking the same files again still counts as a change.
          e.target.value = "";
          if (files.length > 0) {
            importAll(files);
          }
        }}
      />
      <span className="muted drop-hint">{t("common.dropOrPaste")}</span>
      <NoAutoTranslate checked={manual} onChange={onManual} />
      {done && (
        <span role="status" className="msg">
          {t("importView.pdfsImported", { n: done.imported })}
        </span>
      )}
      {done && done.failed.length > 0 && (
        <ul role="alert" className="msg error-text">
          {done.failed.map((f) => (
            <li key={f.name}>{t("importView.pdfFailed", { name: f.name, error: t.msg(f.error) })}</li>
          ))}
        </ul>
      )}
      {error && (
        <span role="alert" className="msg error-text">
          {t.msg(error)}
        </span>
      )}
    </section>
  );
}
