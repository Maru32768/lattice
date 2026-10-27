import { Fragment, createContext, memo, useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, isLocal, siteOf, type ArticleView, type Block, type GroupRow, type Inline, type JobRow, type VocabCapture } from "../api";
import { translatedShare } from "../overlay/logic";
import {
  type LanguageMode,
  type Piece,
  TRANSLATABLE,
  blockPieces,
  dropsGap,
  nothingToTranslate,
  shownTranslation,
  splitBackticks,
  translatedSentences,
  translationProgress,
} from "./mixed";
import { DIFFICULTY_LABELS, genreSwatch } from "../library/library";
import { highlight } from "../search/search";
import { Menu, type MenuItem } from "../ui/Popover";
import { ActionKey, Dif, Icon, Kbd } from "../ui/Icon";
import { Favicon } from "../ui/Favicon";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { QuizPanel, useSidePanel, type SidePanel } from "../quiz/QuizPanel";
import { NotePanel, hasNote } from "./NotePanel";
import { GroupChips } from "../library/GroupPicker";
import { onMiddle } from "../lib/middle";
import { captureIn, isWord, markWords, type WordMarks } from "../vocab/vocab";
import { locale, useT } from "../i18n";
import "../vocab/vocab.css";

// Article content is untrusted: it is rendered only as React text nodes, never as HTML,
// and links open in the in-app browser instead of navigating this (app) WebView.
const OpenLink = createContext<(href: string, newTab: boolean) => void>(() => {});
/** Saved words to underline (G56), or null when marking is off or the book is empty. */
export const WordMarksContext = createContext<WordMarks | null>(null);

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const openLink = useContext(OpenLink);
  const go = (e: React.MouseEvent, newTab: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    openLink(href, newTab);
  };
  return (
    <a href={href} title={href} onClick={(e) => go(e, e.ctrlKey || e.metaKey)} {...onMiddle(() => openLink(href, true))}>
      {children}
    </a>
  );
}

/** A block to scroll to and mark: a search hit or a chat citation. `seq` re-triggers the scroll. */
export interface Focus {
  block: number;
  label: string;
  terms: string[];
  tone: "hit" | "cite";
  seq: number;
}

const busy = (j?: JobRow) => j?.status === "running" || (j?.status === "pending" && !j.last_error);

/** Plain text with search terms and saved words marked. Memoized: hovering a block re-renders the Reader. */
const Txt = memo(function Txt({ v, ts }: { v: string; ts?: string[] }) {
  const marks = useContext(WordMarksContext);
  const words = (s: string) =>
    markWords(s, marks).map((p, i) =>
      p.meaning != null ? (
        <span key={i} className="vw" title={p.meaning}>
          {p.v}
        </span>
      ) : (
        p.v
      ),
    );
  if (!ts?.length) {
    return <>{words(v)}</>;
  }
  return <>{highlight(v, ts).map((s, i) => (s.mark ? <mark key={i}>{words(s.v)}</mark> : <Fragment key={i}>{words(s.v)}</Fragment>))}</>;
});

/** The block's inlines between two offsets of its text (a sentence, or the text between sentences). */
function sliceInlines(block: Block, start: number, end: number): Inline[] {
  if (!block.inlines) {
    return [{ t: "text", v: block.text.slice(start, end) }];
  }
  const out: Inline[] = [];
  let at = 0;
  for (const i of block.inlines) {
    const [from, to] = [Math.max(start, at), Math.min(end, at + i.v.length)];
    if (from < to) {
      out.push({ ...i, v: i.v.slice(from - at, to - at) });
    }
    at += i.v.length;
  }
  return out;
}

function Translation({ text, ts }: { text: string; ts?: string[] }) {
  return <>{splitBackticks(shownTranslation(text)).map((s, n) => (s.code ? <code key={n}>{s.v}</code> : <Txt key={n} v={s.v} ts={ts} />))}</>;
}

/** The text of a translated sentence as rendered (backticks become <code>). */
const translationText = (tr: string) =>
  splitBackticks(shownTranslation(tr))
    .map((s) => s.v)
    .join("");

function Inlines({ inlines, ts }: { inlines: Inline[]; ts?: string[] }) {
  return (
    <>
      {inlines.map((i: Inline, n) =>
        i.t === "code" ? (
          <code key={n}>{i.v}</code>
        ) : i.t === "link" ? (
          <Link key={n} href={i.href}>
            {i.v}
          </Link>
        ) : (
          <Txt key={n} v={i.v} ts={ts} />
        ),
      )}
    </>
  );
}

/** Stored copy only (as a data: URL, loaded when scrolled near); the app never loads remote images.
 * `imagesJob` changes when the download job progresses, so a block still showing the link retries. */
function ImageBlock({ block, imagesJob }: { block: Block; imagesJob?: string }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || url) {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) {
          return;
        }
        io.disconnect();
        api.articleImage(block.id).then(setUrl, () => {});
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new imagesJob is the retry trigger
  }, [block.id, imagesJob, url]);
  const src = block.attrs.src;
  return (
    <figure className="image" ref={ref}>
      {url ? (
        <img src={url} alt={block.text} title={block.text || undefined} />
      ) : src && /^https?:/i.test(src) ? (
        <Link href={src}>{t("reader.image", { name: block.text || src })}</Link>
      ) : (
        // Imported Markdown: an image that could not be read from the file's folder.
        <span className="muted">{t("reader.image", { name: block.text || src || "" })}</span>
      )}
    </figure>
  );
}

/**
 * A prose block sentence by sentence, each in the language `shown` picks; hovering a translated
 * sentence (`onHover`) offers the other language.
 */
function Sentences({
  block,
  pieces,
  shown,
  ts,
  onHover,
  onLeave,
}: {
  block: Block;
  pieces: Piece[];
  shown: (i: number) => boolean;
  ts?: string[];
  onHover: (i: number) => void;
  onLeave: () => void;
}) {
  return (
    <>
      {pieces.map((p, i) =>
        dropsGap(block.text, pieces, i, shown) ? null : p.translation == null ? (
          <Inlines key={i} inlines={sliceInlines(block, p.start, p.end)} ts={ts} />
        ) : (
          <span key={i} className={`sent${shown(i) ? " tr" : ""}`} onMouseEnter={() => onHover(i)} onMouseLeave={onLeave}>
            {shown(i) ? <Translation text={p.translation} ts={ts} /> : <Inlines inlines={sliceInlines(block, p.start, p.end)} ts={ts} />}
          </span>
        ),
      )}
    </>
  );
}

function BlockView({ block, marker, body, imagesJob }: { block: Block; marker?: string; body: React.ReactNode; imagesJob?: string }) {
  const a = block.attrs;
  switch (block.kind) {
    case "heading": {
      const H = `h${Math.min(Math.max(a.level ?? 2, 2), 6)}` as "h2";
      return <H>{body}</H>;
    }
    case "list_item":
      return (
        <div className="li" style={{ marginLeft: `${(a.depth ?? 0) * 1.5}em` }}>
          <span className="marker">{marker}</span>
          <span>{body}</span>
        </div>
      );
    case "blockquote":
      return <blockquote>{body}</blockquote>;
    case "code":
      return (
        <pre className="code" data-lang={a.lang}>
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      return (
        <div className="table-wrap">
          <table>
            <tbody>
              {a.rows?.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image":
      return <ImageBlock block={block} imagesJob={imagesJob} />;
    case "caption":
      return <p className="caption">{body}</p>;
    default:
      return <p>{body}</p>;
  }
}

/** Ordered-list numbering, derived from consecutive list_item blocks. */
function listMarkers(blocks: Block[]): (string | undefined)[] {
  let counters: number[] = [];
  return blocks.map((b) => {
    if (b.kind !== "list_item") {
      counters = [];
      return undefined;
    }
    const d = b.attrs.depth ?? 0;
    counters = counters.slice(0, d + 1);
    counters[d] = (counters[d] ?? 0) + 1;
    return b.attrs.ordered ? `${counters[d]}.` : "•";
  });
}

/** Reader | Page, shared by both toolbars. */
export function ViewSeg({
  page,
  onReader,
  onPage,
  readerDisabled,
  pageDisabled,
}: {
  page: boolean;
  onReader: () => void;
  onPage: () => void;
  readerDisabled?: boolean;
  pageDisabled?: boolean;
}) {
  const t = useT();
  return (
    <>
      <div className="seg" role="group" aria-label={t("reader.view")}>
        <button
          className={page ? "" : "on"}
          aria-pressed={!page}
          onClick={onReader}
          disabled={readerDisabled}
          aria-label="Reader"
          title={readerDisabled ? t("reader.readerDisabled") : "Reader (v)"}
        >
          <Icon name="reader" size="md" />
          <span className="lbl">Reader</span>
        </button>
        <button
          className={page ? "on" : ""}
          aria-pressed={page}
          onClick={onPage}
          disabled={pageDisabled}
          aria-label="Page"
          title={pageDisabled ? t("reader.pageDisabled") : "Page (v)"}
        >
          <Icon name="page" size="md" />
          <span className="lbl">Page</span>
        </button>
      </div>
      <Kbd>v</Kbd>
    </>
  );
}

/** 原文 / 混在 NN% / − / + / 訳文, shared by Reader and Page. */
export function LangSeg({
  mode,
  percent,
  onChange,
  label,
}: {
  mode: LanguageMode;
  percent: number;
  onChange: (m: LanguageMode, p: number) => void;
  label?: string;
}) {
  const t = useT();
  const step = (d: number) => onChange("mixed", Math.max(0, Math.min(100, percent + d)));
  return (
    <div className="seg" role="group" aria-label={label ?? t("reader.language")}>
      <button className={mode === "original" ? "on" : ""} aria-pressed={mode === "original"} onClick={() => onChange("original", percent)}>
        {t("reader.original")}
      </button>
      <button className={mode === "mixed" ? "on" : ""} aria-pressed={mode === "mixed"} onClick={() => onChange("mixed", percent)}>
        {t("reader.mixed")}
        <span className="mono">{percent}%</span>
      </button>
      <button className="step" onClick={() => step(-10)} aria-label={t("reader.less")} title={t("reader.less")}>
        −
      </button>
      <button className="step" onClick={() => step(10)} aria-label={t("reader.more")} title={t("reader.more")}>
        +
      </button>
      <button className={mode === "translated" ? "on" : ""} aria-pressed={mode === "translated"} onClick={() => onChange("translated", percent)}>
        {t("reader.translated")}
      </button>
    </div>
  );
}

/** Re-translating more blocks than this asks first. */
const RETRANSLATE_CONFIRM_BLOCKS = 50;

/** Redoing `done` translated blocks: the action, asking first when there are many, and its dialog. */
function useRetranslate(done: number, onRetranslate: () => void): [() => void, React.ReactNode] {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const dialog = asking && (
    <ConfirmDialog
      title={t("reader.confirmRetranslate")}
      confirm={t("reader.retranslate")}
      onConfirm={() => {
        setAsking(false);
        onRetranslate();
      }}
      onCancel={() => setAsking(false)}
    >
      <p>{t("reader.confirmRetranslateDesc", { done })}</p>
    </ConfirmDialog>
  );
  return [() => (done > RETRANSLATE_CONFIRM_BLOCKS ? setAsking(true) : onRetranslate()), dialog];
}

/** What a saved article's toolbar does, the same from the Reader and the Page view (H14). */
export interface DocActions {
  focusMode: boolean;
  onFavorite: () => void;
  onToggleRead: () => void;
  onAsk: () => void;
  onFocusMode: () => void;
  /** Re-runs extraction on the stored HTML (no network). */
  onReextract: () => void;
  onRender: () => void;
  onClassify: () => void;
  /** Drops this article's translations and translates it again. */
  onRetranslate: () => void;
  onSummarize: () => void;
  onCopyUrl: () => void;
  /** Asks for confirmation, then removes the article from the Index. */
  onDelete: () => void;
  /** Shows a block in the Reader, marked with `label` (a quiz answer's source). */
  onFocusBlock: (block: number, label: string) => void;
  /** Quiz cards were added to or removed from review. */
  onReviewChanged: () => void;
}

/**
 * The right end of both toolbars: ☆ 既読 対話 理解度チェック (the view's own toggles) フォーカス ⋯.
 * `rerender` is ⋯'s re-import from a rendered page: the Reader renders it in the background, the
 * Page view takes the page as shown.
 */
export function ArticleTools({
  view,
  act,
  panel,
  onPanel,
  rerender,
  children,
}: {
  view: ArticleView;
  act: DocActions;
  /** The panel open beside the article. */
  panel: SidePanel | null;
  onPanel: (p: SidePanel) => void;
  rerender?: MenuItem;
  children?: React.ReactNode;
}) {
  const t = useT();
  const a = view.article;
  const failed = a.fetch_status === "failed" || a.extraction_status === "failed";
  const local = isLocal(a.original_url);
  const done = view.blocks.filter((b) => b.translation != null).length;
  const [retranslate, dialog] = useRetranslate(done, act.onRetranslate);
  const job = (type: string) => busy(view.jobs.find((j) => j.type === type));
  const readLabel = a.read_status === "read" ? t("reader.markUnread") : t("reader.markRead");
  const rendering = job("render");
  return (
    <div className="docbar-r">
      <button
        className={`tb${a.favorite ? " on" : ""}`}
        onClick={act.onFavorite}
        aria-pressed={a.favorite}
        aria-label={t("browserView.favorite")}
        title={t("browserView.favorite")}
      >
        <Icon name="star" />
      </button>
      <button className="tb" onClick={act.onToggleRead} title={`${readLabel} (m)`} aria-label={`${readLabel} (m)`}>
        <Icon name="check" />
        <span className="lbl">{readLabel}</span>
      </button>
      <button className="tb" onClick={act.onAsk} title={t("reader.chatAbout")} aria-label={t("reader.ask")}>
        <Icon name="chat" />
        <span className="lbl">{t("reader.ask")}</span>
      </button>
      {!failed && (
        <button
          className={`tb qz-btn${panel === "quiz" ? " qz-open" : ""}`}
          onClick={() => onPanel("quiz")}
          aria-pressed={panel === "quiz"}
          aria-label={t("quizPanel.title")}
          title={t("reader.quizHint")}
        >
          <Icon name="quiz" />
          <span className="lbl">{t("quizPanel.title")}</span>
        </button>
      )}
      <button
        className={`tb qz-btn${panel === "note" ? " qz-open" : hasNote(view) ? " on" : ""}`}
        onClick={() => onPanel("note")}
        aria-pressed={panel === "note"}
        aria-label={t("notePanel.title")}
        title={t("reader.noteHint")}
      >
        <Icon name="note" />
        <span className="lbl">{t("notePanel.title")}</span>
      </button>
      {children}
      <button className="tb" onClick={act.onFocusMode} aria-pressed={act.focusMode} aria-label={t("reader.focus")} title={t("reader.focus")}>
        <Icon name="focus" />
      </button>
      <Menu
        className="tb"
        label={t("reader.more2")}
        align="right"
        trigger={<Icon name="more" />}
        items={[
          {
            label: t("reader.reextractFrom", { x: a.pdf ? "PDF" : local ? "Markdown" : "HTML" }),
            onSelect: act.onReextract,
            disabled: a.fetch_status !== "ok",
          },
          ...(rerender
            ? [rerender]
            : local || a.pdf
              ? []
              : [{ label: rendering ? t("reader.rendering") : t("reader.render"), onSelect: act.onRender, disabled: rendering }]),
          { label: job("classify") ? t("reader.classifying") : t("reader.autoClassify"), onSelect: act.onClassify, disabled: job("classify") || failed },
          // Shown whenever there is a translation to redo, not only once the whole article is translated (G29).
          ...(done > 0
            ? [
                {
                  label: job("translate") ? t("reader.translatingEllipsis") : t("reader.retranslate"),
                  hint: t("reader.retranslateHint"),
                  onSelect: retranslate,
                  disabled: failed || job("translate"),
                },
              ]
            : []),
          { label: view.summary ? t("reader.resummarize") : t("reader.summarize"), onSelect: act.onSummarize, disabled: failed || job("summarize") },
          "-",
          { label: t("articleMenu.copyUrl"), onSelect: act.onCopyUrl, disabled: local },
          "-",
          { label: t("browserView.remove"), onSelect: act.onDelete, danger: true },
        ]}
      />
      {dialog}
    </div>
  );
}

function TranslationStatus({
  job,
  done,
  total,
  nothing,
  target,
  onTranslate,
  onRetranslate,
}: {
  job?: JobRow;
  done: number;
  total: number;
  nothing: ReturnType<typeof nothingToTranslate>;
  target: ArticleView["target_language"];
  onTranslate: () => void;
  onRetranslate: () => void;
}) {
  const t = useT();
  const keys = (
    <span className="keys">
      <Kbd>[</Kbd>
      <Kbd>]</Kbd>
      {t("reader.ratioHint")}
    </span>
  );
  const hint = <span className="hint-keys">{keys}</span>;
  if (job && busy(job)) {
    return (
      <span className="tr-prog" role="status">
        <span>
          {job.status === "running" ? t("reader.translating") : t("reader.waiting")} {t("reader.blockProgress", { done, total })}
        </span>
        <span className="prog">
          <b style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
        </span>
      </span>
    );
  }
  // No job yet, or it finished: some blocks may be translated already (a finished job, the Page view's cache).
  if (!job?.last_error) {
    if (done >= total) {
      if (nothing) {
        return (
          <span className="muted" role="status">
            {t(nothing)}
          </span>
        );
      }
      return done === 0 ? (
        hint
      ) : (
        <>
          <span className="hint-keys">
            {keys}
            <span className="keys"> · </span>
            {t("reader.translatedCount", { done, total })}
          </span>
          <button className="btn sm" onClick={onRetranslate} title={t("reader.retranslateHint")}>
            {t("reader.retranslate")}
          </button>
        </>
      );
    }
    return (
      <>
        <span className="hint-keys">
          {keys}
          {done > 0 && (
            <>
              <span className="keys"> · </span>
              {t("reader.translatedCount", { done, total })}
            </>
          )}
        </span>
        <button className="tb" onClick={onTranslate} title={t(target === "en" ? "reader.translateIntoEn" : "reader.translateIntoJa")}>
          <Icon name="translate" />
          {done > 0 ? t("reader.translateRest") : t("reader.translate")}
        </button>
      </>
    );
  }
  const retryAt =
    job.status === "pending" && job.next_run_at ? new Date(job.next_run_at).toLocaleTimeString(locale(t.lang), { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <>
      <span className="error-text" title={t.msg(job.last_error)}>
        {done} / {total}
        {t("reader.failedSuffix")}
      </span>
      {retryAt && <span className="muted">{t("reader.autoRetry", { retryAt })}</span>}
      <button className="btn sm" onClick={onTranslate}>
        {t("common.retry")}
      </button>
    </>
  );
}

/** Genre chip that edits in place: pick or type one (pinned against auto runs), or let the LLM choose. */
function GenreChip({
  genre,
  classifying,
  onGenre,
  onClassify,
}: {
  genre: string | null;
  classifying: boolean;
  onGenre: (name: string) => void;
  onClassify: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(genre ?? "");
  const [genres, setGenres] = useState<string[]>([]);
  const [prevGenre, setPrevGenre] = useState(genre);
  if (prevGenre !== genre) {
    setPrevGenre(genre);
    setValue(genre ?? "");
  }
  const edit = () => {
    setEditing(true);
    api
      .listGenres()
      .then((g) => setGenres(g.map((x) => x.name)))
      .catch(() => {});
  };
  const commit = () => {
    setEditing(false);
    if (value.trim() !== (genre ?? "")) {
      onGenre(value.trim());
    }
  };
  if (!editing) {
    return (
      <button className="chip" onClick={edit} title={t("reader.changeGenre")}>
        <span className="sw" style={{ background: genreSwatch(genre) }} />
        {genre ?? t("common.unclassified")}
      </button>
    );
  }
  return (
    <form
      className="chip-edit"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <input
        className="input sm"
        list="genre-options"
        value={value}
        autoFocus
        aria-label={t("common.genre")}
        placeholder={t("common.unclassified")}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setValue(genre ?? "");
            setEditing(false);
          }
        }}
      />
      <datalist id="genre-options">
        {genres.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <button
        type="button"
        className="btn sm"
        disabled={classifying}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setEditing(false);
          onClassify();
        }}
      >
        {t("reader.autoClassify")}
      </button>
    </form>
  );
}

function TagAdder({ onAdd }: { onAdd: (name: string) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  if (!editing) {
    return (
      <button className="chip dashed" onClick={() => setEditing(true)} aria-label={t("reader.addTag")}>
        {t("reader.addTagButton")}
      </button>
    );
  }
  const close = () => {
    setValue("");
    setEditing(false);
  };
  return (
    <form
      className="chip-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) {
          onAdd(value.trim());
        }
        setValue("");
      }}
    >
      <input
        className="input sm mono"
        value={value}
        autoFocus
        aria-label={t("reader.tagToAdd")}
        placeholder={t("reader.tagPlaceholder")}
        onChange={(e) => setValue(e.target.value)}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
    </form>
  );
}

/** The summary row, opened to the full text on a click (closed at first, in the Reader and in the Page view's strip). */
export function Summary({ view, onSummarize }: { view: ArticleView; onSummarize: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const job = view.jobs.find((j) => j.type === "summarize");
  const running = busy(job);
  const failed = job && job.last_error && !running && job.status !== "succeeded";
  const s = view.summary;
  const first =
    s?.text
      .split("\n")
      .map((l) => l.replace(/^\s*[-・*]\s*/, "").trim())
      .find(Boolean) ?? "";
  return (
    <section className="summary" aria-label={t("reader.summary")}>
      {s ? (
        <button className="summary-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="cap">{t("reader.summary")}</span>
          <span className="first">{open ? "" : first}</span>
          <Icon name={open ? "up" : "down"} />
        </button>
      ) : (
        <div className="summary-row">
          <span className="cap">{t("reader.summary")}</span>
          {running ? (
            <span className="muted">{t("reader.summarizing")}</span>
          ) : (
            <button className="tb" onClick={onSummarize}>
              {t("reader.summarize")}
            </button>
          )}
        </div>
      )}
      {s && open && (
        <div className="summary-body">
          <p>{s.text}</p>
          <div className="summary-meta">
            <span>{t("reader.generated", { date: new Date(s.created_at).toLocaleDateString(locale(t.lang), { month: "2-digit", day: "2-digit" }) })}</span>
            {running ? (
              <span>{t("quizPanel.regenerating")}</span>
            ) : (
              <button className="tb" onClick={onSummarize}>
                {t("quizPanel.regenerate")}
              </button>
            )}
          </div>
        </div>
      )}
      {s?.stale && <div className="summary-note muted">{t("reader.summaryStale")}</div>}
      {failed && (
        <div className="summary-note error-text" title={t.msg(job.last_error)}>
          {t("reader.summaryFailed", { last_error: t.msg(job.last_error) })}
        </div>
      )}
    </section>
  );
}

export function Reader({
  view,
  act,
  focus,
  matches,
  mode,
  percent,
  onLang,
  onPage,
  onLink,
  onRetry,
  onTranslate,
  onTag,
  onGenre,
  onDifficulty,
  saveWordSeq,
  onVocabChanged,
  groups,
  onGroup,
  onCreateGroup,
  groupRequest,
}: {
  view: ArticleView;
  act: DocActions;
  focus?: Focus;
  /** Search hits in this article: `i` of `n` is the focused one. */
  matches?: { i: number; n: number; onStep: (d: 1 | -1) => void };
  mode: LanguageMode;
  percent: number;
  onLang: (m: LanguageMode, p: number) => void;
  onPage: () => void;
  /** `newTab`: Ctrl / middle click. */
  onLink: (href: string, newTab: boolean) => void;
  onRetry: () => void;
  onTranslate: () => void;
  onTag: (name: string, add: boolean) => void;
  onGenre: (name: string) => void;
  onDifficulty: (level: number | null) => void;
  /** Bumped by the 単語を登録 shortcut: saves the word selected in this article, if any. */
  saveWordSeq: number;
  /** A word was saved. */
  onVocabChanged: () => void;
  /** Every group, for the article's group chips and picker. */
  groups: GroupRow[];
  onGroup: (id: number, add: boolean) => void;
  onCreateGroup: (name: string) => Promise<number>;
  /** Opens the group picker when it grows (palette). */
  groupRequest: number;
}) {
  const t = useT();
  const { article: a, blocks } = view;
  // Per-sentence click overrides on top of the mode (`${block id}:${piece}`); App remounts Reader per article.
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  /** The sentence whose other language is shown under its block. */
  const [pop, setPop] = useState<{ block: number; piece: number } | null>(null);
  const [panel, togglePanel, closePanel] = useSidePanel(a.id);
  const timers = useRef({ show: 0, hide: 0, cap: 0 });
  const blocksEl = useRef<HTMLDivElement>(null);
  /** 単語を登録 over the selection, then what came of it. */
  const [cap, setCap] = useState<{ capture: VocabCapture; x: number; y: number; status?: string; error?: string } | null>(null);
  const failed = a.fetch_status === "failed" || a.extraction_status === "failed";
  const markers = listMarkers(blocks);
  const pieces = new Map(blocks.map((b) => [b.id, blockPieces(b)]));
  const selected = translatedSentences(
    blocks.map((b) => ({ id: b.id, text: b.text, pieces: pieces.get(b.id)! })),
    mode,
    translatedShare(percent, view.target_language, t.lang),
    a.original_url,
  );
  const { done, total } = translationProgress(blocks, view.target_language);
  const nothing = nothingToTranslate(blocks, view.target_language);
  const job = view.jobs.find((j) => j.type === "translate");
  const translating = busy(job);
  const images = view.jobs.find((j) => j.type === "images");
  const imagesJob = images && `${images.status}:${images.attempt_count}`;
  const classify = view.jobs.find((j) => j.type === "classify");
  const classifying = busy(classify);
  const rendering = busy(view.jobs.find((j) => j.type === "render"));
  const chars = blocks.reduce((n, b) => n + b.text.length, 0);

  const focusBlock = focus?.block;
  useEffect(() => {
    if (focusBlock != null) {
      document.getElementById(`b-${focusBlock}`)?.scrollIntoView({ block: "center" });
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- scroll once per focus request (seq), and again when the blocks arrive
  }, [focusBlock, focus?.seq, blocks.length]);

  const shows = (id: number, i: number) => selected.has(`${id}:${i}`) !== flipped.has(`${id}:${i}`);
  /** Whether any sentence of the block shows its translation (its marker, and what flipping the block does). */
  const blockShows = (b: Block) => pieces.get(b.id)!.some((p, i) => p.translation != null && shows(b.id, i));
  /** The block's text as rendered, sentence by sentence. */
  const shownText = (b: Block) =>
    pieces
      .get(b.id)!
      .map((p, i, ps) =>
        dropsGap(b.text, ps, i, (j) => shows(b.id, j))
          ? ""
          : p.translation != null && shows(b.id, i)
            ? translationText(p.translation)
            : b.text.slice(p.start, p.end),
      )
      .join("");

  /** The word selected in one prose block of this article, as shown (original or translation), and where to put the button. */
  function selectionCapture(): { capture: VocabCapture; x: number; y: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !isWord(sel.toString())) {
      return null;
    }
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".blk");
    const block = el && blocksEl.current?.contains(el) ? blocks.find((b) => el.id === `b-${b.id}`) : undefined;
    if (!el || !block || !TRANSLATABLE.has(block.kind)) {
      return null;
    }
    const before = document.createRange();
    before.setStart(el, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const c = captureIn(shownText(block), sel.toString(), before.toString().length);
    if (!c) {
      return null;
    }
    const r = range.getBoundingClientRect();
    return {
      capture: { ...c, article_id: a.id, block_id: block.id, url: isLocal(a.original_url) ? null : a.original_url },
      x: r.left + r.width / 2,
      y: r.bottom,
    };
  }

  async function saveWord(c: { capture: VocabCapture; x: number; y: number }) {
    clearTimeout(timers.current.cap);
    await api
      .vocabAdd(c.capture)
      .then((r) => {
        setCap({ ...c, status: t(r.new ? "vocab.saved" : "vocab.added", { word: c.capture.surface }) });
        onVocabChanged();
      })
      .catch((e: unknown) => setCap({ ...c, error: String(e) }));
    timers.current.cap = window.setTimeout(() => setCap(null), 2000);
  }

  const offerCapture = () => {
    clearTimeout(timers.current.cap);
    setCap(selectionCapture());
  };
  useEffect(() => {
    const collapsed = () => {
      if (window.getSelection()?.isCollapsed) {
        setCap((c) => (c?.status || c?.error ? c : null));
      }
    };
    document.addEventListener("selectionchange", collapsed);
    const t = timers.current;
    return () => {
      document.removeEventListener("selectionchange", collapsed);
      clearTimeout(t.cap);
    };
  }, []);
  const onSaveWordKey = useEffectEvent(() => {
    const c = selectionCapture();
    if (c) {
      void saveWord(c);
    }
  });
  useEffect(() => {
    if (saveWordSeq) {
      onSaveWordKey();
    }
  }, [saveWordSeq]);

  function setLang(m: LanguageMode, p: number) {
    onLang(m, p);
    setFlipped(new Set());
  }

  /** Flips sentences of a block: one (its tooltip), or all of them to the other language (the marker, Enter). */
  function flip(b: Block, piece?: number) {
    setPop(null);
    const to = !blockShows(b);
    const keys = pieces
      .get(b.id)!
      .flatMap((p, i) => (p.translation != null && (piece === undefined ? shows(b.id, i) !== to : i === piece) ? [`${b.id}:${i}`] : []));
    setFlipped((s) => {
      const n = new Set(s);
      for (const k of keys) {
        if (!n.delete(k)) {
          n.add(k);
        }
      }
      return n;
    });
  }

  // Hovering a sentence shows its other language; clicking that flips the sentence.
  function hover(block: number, piece: number) {
    clearTimeout(timers.current.show);
    clearTimeout(timers.current.hide);
    timers.current.show = window.setTimeout(() => setPop({ block, piece }), 300);
  }
  function leave() {
    clearTimeout(timers.current.show);
    timers.current.hide = window.setTimeout(() => setPop(null), 150);
  }

  const [retranslate, retranslateDialog] = useRetranslate(done, act.onRetranslate);

  const renderBtn = (pri: boolean) => (
    <button className={`btn${pri ? " pri" : ""}`} onClick={act.onRender} disabled={rendering} title={t("reader.renderHint")}>
      {rendering ? t("reader.rendering") : t("reader.render")}
    </button>
  );
  const fetched = a.fetch_status === "ok";
  const local = isLocal(a.original_url);

  return (
    <div className="doc">
      <div className="docbar">
        <ViewSeg page={false} onReader={() => {}} onPage={onPage} pageDisabled={local} />
        <div className="vsep" />
        {!failed && <LangSeg mode={mode} percent={percent} onChange={setLang} />}
        {!failed && (
          <TranslationStatus
            job={job}
            done={done}
            total={total}
            nothing={nothing}
            target={view.target_language}
            onTranslate={onTranslate}
            onRetranslate={retranslate}
          />
        )}
        {matches && (
          <span className="matches">
            {t("reader.match", { x: matches.i + 1, n: matches.n })}
            <button className="chip" onClick={() => matches.onStep(-1)} aria-label={t("reader.prevMatch")} disabled={matches.i <= 0}>
              ↑
            </button>
            <button className="chip" onClick={() => matches.onStep(1)} aria-label={t("reader.nextMatch")} disabled={matches.i >= matches.n - 1}>
              ↓
            </button>
          </span>
        )}
        <ArticleTools view={view} act={act} panel={panel} onPanel={togglePanel} />
      </div>

      <div className="doc-body">
        <div className="doc-scroll" tabIndex={-1} data-pane-target onScroll={cap && !cap.status ? () => setCap(null) : undefined}>
          <article className="reader">
            <div className="art-meta">
              {a.feed_title && <span className="src">{a.feed_title}</span>}
              <span className="with-ico">
                <Favicon domain={a.domain} feed={a.feed_id} />
                {a.site_name && a.site_name !== a.feed_title ? `${a.site_name} · ` : ""}
                {siteOf(a, t)}
              </span>
              {a.author && (
                <>
                  <span>·</span>
                  <span>{a.author}</span>
                </>
              )}
              {a.published_at && (
                <>
                  <span>·</span>
                  <span>{a.published_at.slice(0, 10)}</span>
                </>
              )}
            </div>
            <h1 className="prose art-title">{a.title ?? a.original_url}</h1>
            <div className="art-chips">
              {!failed && <GenreChip genre={a.genre} classifying={classifying} onGenre={onGenre} onClassify={act.onClassify} />}
              {a.tags.map((tag) => (
                <span key={tag} className="chip mono">
                  {tag}
                  <button className="x" onClick={() => onTag(tag, false)} aria-label={t("reader.removeTag", { tag })}>
                    <Icon name="x" size="sm" />
                  </button>
                </span>
              ))}
              <TagAdder onAdd={(tag) => onTag(tag, true)} />
              <GroupChips groups={groups} ids={a.groups} onToggle={onGroup} onCreate={onCreateGroup} request={groupRequest} />
              {!failed && (
                <label className="chip sel-chip" title={t("reader.difficultyHint")}>
                  <Dif d={a.difficulty} />
                  {t(DIFFICULTY_LABELS[(a.difficulty ?? 0) - 1] ?? "common.difficulty")}
                  <select
                    value={a.difficulty ?? ""}
                    aria-label={t("common.difficulty")}
                    onChange={(e) => onDifficulty(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">{t("library.difficultyNone")}</option>
                    {DIFFICULTY_LABELS.map((l, i) => (
                      <option key={l} value={i + 1}>
                        {i + 1} {t(l)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!failed && (
                <span className="chip-cap">
                  {classifying ? t("reader.classifying") : a.genre_manual || a.difficulty_manual ? t("reader.manual") : t("reader.auto")}
                  {classify?.last_error && !classifying && classify.status !== "succeeded" && (
                    <span className="error-text" title={t.msg(classify.last_error)}>
                      {t("reader.classifyFailed", { last_error: t.msg(classify.last_error) })}
                    </span>
                  )}
                </span>
              )}
            </div>

            {a.relevance != null && (
              <p className="art-relevance">
                <span className="imp-score">{t("reader.relevance", { score: a.relevance })}</span>
                {a.relevance_reason}
                {a.relevance_stale && <span className="muted">{t("reader.relevanceStale")}</span>}
              </p>
            )}

            {failed && (
              <div className="promoted">
                <div className="note err col">
                  <span className="strong">{a.fetch_status === "failed" ? t("reader.fetchFailed") : t("reader.extractFailed")}</span>
                  <span>
                    {a.last_error && t.msg(a.last_error)}
                    {fetched && t("reader.fetchedOk", { x: a.pdf ? "PDF" : "HTML" })}
                    {a.pdf && t("reader.imageOnlyPdf")}
                  </span>
                </div>
                <div className="btn-row">
                  {!local && !a.pdf && renderBtn(true)}
                  {fetched && (
                    <button className="btn" onClick={act.onReextract} title={t("reader.reextractHint", { x: a.pdf ? "PDF" : "HTML" })}>
                      {t("reader.reextractOffline")}
                    </button>
                  )}
                  {!local && (
                    <button className="btn" onClick={onRetry}>
                      {t("common.retry")}
                    </button>
                  )}
                  {!local && (
                    <button className="btn" onClick={onPage}>
                      {t("reader.openInPage")}
                    </button>
                  )}
                </div>
              </div>
            )}
            {!failed && <Summary view={view} onSummarize={act.onSummarize} />}
            {a.from_feed && (
              <div className="note warn center thin">
                <span className="grow">
                  {t("reader.fromFeed")}
                  {a.last_error ? t("reader.fromFeedError", { last_error: t.msg(a.last_error) }) : t("reader.fromFeedEmpty")}
                </span>
                <button className="btn" onClick={onRetry} title={t("reader.refetchHint")}>
                  {t("common.retry")}
                </button>
                {renderBtn(false)}
              </div>
            )}
            {a.thin && (
              <div className="note warn center thin">
                <span className="grow">
                  {t("reader.thin", { n: chars })}
                  {a.last_error && t("reader.thinError", { last_error: t.msg(a.last_error) })}
                </span>
                {renderBtn(false)}
              </div>
            )}
            {!failed && job?.last_error && !translating && done < total && (
              <div className="note err">
                <Icon name="alert" />
                <span>{t("reader.translateFailed", { last_error: t.msg(job.last_error), done, x: total - done })}</span>
              </div>
            )}

            <OpenLink.Provider value={onLink}>
              <div className="prose blocks" ref={blocksEl} onMouseUp={offerCapture} onKeyUp={(e) => e.shiftKey && offerCapture()}>
                {blocks.map((b, i) => {
                  const has = b.translation != null;
                  const translated = blockShows(b);
                  const ps = pieces.get(b.id)!;
                  const popped = pop?.block === b.id ? ps[pop.piece] : undefined;
                  const popShown = popped != null && shows(b.id, pop!.piece);
                  const pending = !has && translating && TRANSLATABLE.has(b.kind);
                  const focused = focus?.block === b.id ? focus : undefined;
                  const label = translated ? t("reader.flipToOriginal") : t("reader.flipToTranslation");
                  return (
                    <div
                      key={b.id}
                      id={`b-${b.id}`}
                      className={`blk ${b.kind}${focused ? ` is-${focused.tone}` : ""}${has ? " flip" : ""}`}
                      tabIndex={has ? 0 : undefined}
                      aria-description={has ? t("reader.flipHint") : undefined}
                      onKeyDown={
                        has
                          ? (e) => {
                              if (e.key === "Enter" && e.target === e.currentTarget) {
                                e.preventDefault();
                                flip(b);
                              }
                            }
                          : undefined
                      }
                    >
                      {has ? (
                        <button className={`mk ${translated ? "ja" : "en"}`} onClick={() => flip(b)} aria-label={label} title={label}>
                          <i />
                        </button>
                      ) : (
                        pending && (
                          <span className="mk pend" aria-hidden="true" title={t("reader.waiting")}>
                            <i />
                          </span>
                        )
                      )}
                      {focused && <div className="blk-label">{focused.label}</div>}
                      <BlockView
                        block={b}
                        marker={markers[i]}
                        imagesJob={imagesJob}
                        body={
                          <Sentences block={b} pieces={ps} shown={(j) => shows(b.id, j)} ts={focused?.terms} onHover={(j) => hover(b.id, j)} onLeave={leave} />
                        }
                      />
                      {popped?.translation != null && (
                        <div
                          className="pop"
                          role="tooltip"
                          onClick={() => flip(b, pop!.piece)}
                          onMouseEnter={() => clearTimeout(timers.current.hide)}
                          onMouseLeave={leave}
                        >
                          <div className="pop-h">
                            <span>{popShown ? t("reader.original") : t("reader.translated")}</span>
                            <span className="r">{t.rich("reader.flipPop", { kbd: <Kbd>Enter</Kbd> })}</span>
                          </div>
                          {popShown ? b.text.slice(popped.start, popped.end) : popped.translation}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </OpenLink.Provider>
          </article>
        </div>
        {panel === "quiz" && (
          <QuizPanel view={view} onSource={(b) => act.onFocusBlock(b, t("reader.quizSource"))} onReviewChanged={act.onReviewChanged} onClose={closePanel} />
        )}
        {panel === "note" && <NotePanel key={a.id} view={view} onClose={closePanel} />}
      </div>
      {cap &&
        createPortal(
          <div className="vw-cap" style={{ left: cap.x, top: cap.y }} role={cap.status || cap.error ? "status" : undefined}>
            {cap.status ? (
              <span className="msg">{cap.status}</span>
            ) : cap.error ? (
              <span className="msg error-text">{t.msg(cap.error)}</span>
            ) : (
              <button className="btn sm pri" onMouseDown={(e) => e.preventDefault()} onClick={() => void saveWord(cap)}>
                {t("vocab.save")}
                <ActionKey id="saveWord" />
              </button>
            )}
          </div>,
          document.body,
        )}
      {retranslateDialog}
    </div>
  );
}
