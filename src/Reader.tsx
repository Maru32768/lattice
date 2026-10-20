import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, isLocal, siteOf, type ArticleView, type Block, type GroupRow, type Inline, type JobRow } from "./api";
import { type LanguageMode, splitBackticks, translatedBlockIds } from "./mixed";
import { DIFFICULTY_LABELS, genreSwatch } from "./library";
import { highlight } from "./search";
import { Menu } from "./Popover";
import { Dif, Icon, Kbd } from "./Icon";
import { Favicon } from "./Favicon";
import { ConfirmDialog } from "./ConfirmDialog";
import { QuizPanel } from "./QuizPanel";
import { GroupChips } from "./GroupPicker";
import { onMiddle } from "./middle";
import { locale, t, useT } from "./i18n";

// Article content is untrusted: it is rendered only as React text nodes, never as HTML,
// and links open in the in-app browser instead of navigating this (app) WebView.
const OpenLink = createContext<(href: string, newTab: boolean) => void>(() => {});

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const openLink = useContext(OpenLink);
  const go = (e: React.MouseEvent, newTab: boolean) => { e.preventDefault(); e.stopPropagation(); openLink(href, newTab); };
  return <a href={href} title={href} onClick={(e) => go(e, e.ctrlKey || e.metaKey)} {...onMiddle(() => openLink(href, true))}>{children}</a>;
}

/** A block to scroll to and mark: a search hit or a chat citation. `seq` re-triggers the scroll. */
export interface Focus {
  block: number;
  label: string;
  terms: string[];
  tone: "hit" | "cite";
  seq: number;
}

/** Mirrors ir.rs PROSE_KINDS. */
export const TRANSLATABLE = new Set(["heading", "paragraph", "list_item", "blockquote", "caption"]);

const busy = (j?: JobRow) => j?.status === "running" || (j?.status === "pending" && !j.last_error);

/** Plain text with search terms marked. */
function Txt({ v, ts }: { v: string; ts?: string[] }) {
  if (!ts?.length) return <>{v}</>;
  return <>{highlight(v, ts).map((s, i) => (s.mark ? <mark key={i}>{s.v}</mark> : s.v))}</>;
}

function Inlines({ block, translated, ts }: { block: Block; translated: boolean; ts?: string[] }) {
  if (translated && block.translation != null) {
    return <>{splitBackticks(block.translation).map((s, n) => (s.code ? <code key={n}>{s.v}</code> : <Txt key={n} v={s.v} ts={ts} />))}</>;
  }
  if (!block.inlines) return <Txt v={block.text} ts={ts} />;
  return (
    <>
      {block.inlines.map((i: Inline, n) =>
        i.t === "code" ? <code key={n}>{i.v}</code>
        : i.t === "link" ? <Link key={n} href={i.href}>{i.v}</Link>
        : <Txt key={n} v={i.v} ts={ts} />,
      )}
    </>
  );
}

/** Stored copy only (as a data: URL, loaded when scrolled near); the app never loads remote images.
 * `imagesJob` changes when the download job progresses, so a block still showing the link retries. */
function ImageBlock({ block, imagesJob }: { block: Block; imagesJob?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || url) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      api.articleImage(block.id).then(setUrl, () => {});
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [block.id, imagesJob, url]);
  const src = block.attrs.src;
  return (
    <figure className="image" ref={ref}>
      {url ? <img src={url} alt={block.text} title={block.text || undefined} />
        : src && /^https?:/i.test(src) ? <Link href={src}>{t("reader.image", { name: block.text || src })}</Link>
        // Imported Markdown: an image that could not be read from the file's folder.
        : <span className="muted">{t("reader.image", { name: block.text || src || "" })}</span>}
    </figure>
  );
}

function BlockView({ block, marker, translated, imagesJob, ts }: { block: Block; marker?: string; translated: boolean; imagesJob?: string; ts?: string[] }) {
  const a = block.attrs;
  const body = <Inlines block={block} translated={translated} ts={ts} />;
  switch (block.kind) {
    case "heading": {
      const H = `h${Math.min(Math.max((a.level ?? 2), 2), 6)}` as "h2";
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
      return <pre className="code" data-lang={a.lang}><code>{block.text}</code></pre>;
    case "table":
      return (
        <div className="table-wrap">
          <table><tbody>
            {a.rows?.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
          </tbody></table>
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
export function ViewSeg({ page, onReader, onPage, readerDisabled, pageDisabled }: {
  page: boolean; onReader: () => void; onPage: () => void; readerDisabled?: boolean; pageDisabled?: boolean;
}) {
  const t = useT();
  return (
    <>
      <div className="seg" role="group" aria-label={t("reader.view")}>
        <button className={page ? "" : "on"} aria-pressed={!page} onClick={onReader} disabled={readerDisabled}
          title={readerDisabled ? t("reader.readerDisabled") : "Reader (v)"}><Icon name="reader" size="md" />Reader</button>
        <button className={page ? "on" : ""} aria-pressed={page} onClick={onPage} disabled={pageDisabled}
          title={pageDisabled ? t("reader.pageDisabled") : "Page (v)"}><Icon name="page" size="md" />Page</button>
      </div>
      <Kbd>v</Kbd>
    </>
  );
}

/** 原文 / 混在 NN% / − / + / 訳文, shared by Reader and Page. */
export function LangSeg({ mode, percent, onChange, label = t("reader.language") }: {
  mode: LanguageMode; percent: number; onChange: (m: LanguageMode, p: number) => void; label?: string;
}) {
  const t = useT();
  const step = (d: number) => onChange("mixed", Math.max(0, Math.min(100, percent + d)));
  return (
    <div className="seg" role="group" aria-label={label}>
      <button className={mode === "original" ? "on" : ""} aria-pressed={mode === "original"} onClick={() => onChange("original", percent)}>{t("reader.original")}</button>
      <button className={mode === "mixed" ? "on" : ""} aria-pressed={mode === "mixed"} onClick={() => onChange("mixed", percent)}>
        {t("reader.mixed")}<span className="mono">{percent}%</span>
      </button>
      <button className="step" onClick={() => step(-10)} aria-label={t("reader.less")} title={t("reader.less")}>−</button>
      <button className="step" onClick={() => step(10)} aria-label={t("reader.more")} title={t("reader.more")}>+</button>
      <button className={mode === "translated" ? "on" : ""} aria-pressed={mode === "translated"} onClick={() => onChange("translated", percent)}>{t("reader.translated")}</button>
    </div>
  );
}

/** Re-translating more blocks than this asks first. */
const RETRANSLATE_CONFIRM_BLOCKS = 50;

function TranslationStatus({ job, done, total, target, onTranslate, onRetranslate }: {
  job?: JobRow; done: number; total: number; target: ArticleView["target_language"]; onTranslate: () => void; onRetranslate: () => void;
}) {
  const t = useT();
  const keys = <span className="keys"><Kbd>[</Kbd><Kbd>]</Kbd>{t("reader.ratioHint")}</span>;
  const hint = <span className="hint-keys">{keys}</span>;
  if (!job) return <>{hint}<button className="tb" onClick={onTranslate} disabled={total === 0}><Icon name="translate" />{t(target === "en" ? "reader.translateToEn" : "reader.translateToJa")}</button></>;
  if (busy(job)) {
    return (
      <span className="tr-prog" role="status">
        <span>{job.status === "running" ? t("reader.translating") : t("reader.waiting")} {done} / {total} block</span>
        <span className="prog"><b style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></span>
      </span>
    );
  }
  if (job.status === "succeeded" && done >= total) {
    return (
      <>
        <span className="hint-keys">{keys}<span className="keys"> · </span>{t("reader.translatedCount", { done, total })}</span>
        <button className="btn sm" onClick={onRetranslate} title={t("reader.retranslateHint")}>{t("reader.retranslate")}</button>
      </>
    );
  }
  const retryAt = job.status === "pending" && job.next_run_at
    ? new Date(job.next_run_at).toLocaleTimeString(locale(t.lang), { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <>
      <span className={job.last_error ? "error-text" : "muted"} title={job.last_error ? t.msg(job.last_error) : undefined}>{done} / {total}{job.last_error && t("reader.failedSuffix")}</span>
      {retryAt && <span className="muted">{t("reader.autoRetry", { retryAt })}</span>}
      {job.last_error && <button className="btn sm" onClick={onTranslate}>{t("common.retry")}</button>}
      {done < total && <button className="btn sm" onClick={onTranslate}>{t("reader.continue")}</button>}
    </>
  );
}

/** Genre chip that edits in place: pick or type one (pinned against auto runs), or let the LLM choose. */
function GenreChip({ genre, classifying, onGenre, onClassify }: {
  genre: string | null; classifying: boolean; onGenre: (name: string) => void; onClassify: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(genre ?? "");
  const [genres, setGenres] = useState<string[]>([]);
  useEffect(() => { setValue(genre ?? ""); }, [genre]);
  useEffect(() => { if (editing) api.listGenres().then((g) => setGenres(g.map((x) => x.name))).catch(() => {}); }, [editing]);
  const commit = () => {
    setEditing(false);
    if (value.trim() !== (genre ?? "")) onGenre(value.trim());
  };
  if (!editing) {
    return (
      <button className="chip" onClick={() => setEditing(true)} title={t("reader.changeGenre")}>
        <span className="sw" style={{ background: genreSwatch(genre) }} />{genre ?? t("common.unclassified")}
      </button>
    );
  }
  return (
    <form className="chip-edit" onSubmit={(e) => { e.preventDefault(); commit(); }}>
      <input className="input sm" list="genre-options" value={value} autoFocus aria-label={t("common.genre")} placeholder={t("common.unclassified")}
        onChange={(e) => setValue(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setValue(genre ?? ""); setEditing(false); } }} />
      <datalist id="genre-options">{genres.map((g) => <option key={g} value={g} />)}</datalist>
      <button type="button" className="btn sm" disabled={classifying} onMouseDown={(e) => e.preventDefault()}
        onClick={() => { setEditing(false); onClassify(); }}>{t("reader.autoClassify")}</button>
    </form>
  );
}

function TagAdder({ onAdd }: { onAdd: (name: string) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  if (!editing) return <button className="chip dashed" onClick={() => setEditing(true)} aria-label={t("reader.addTag")}>{t("reader.addTagButton")}</button>;
  const close = () => { setValue(""); setEditing(false); };
  return (
    <form className="chip-edit" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onAdd(value.trim()); setValue(""); }}>
      <input className="input sm mono" value={value} autoFocus aria-label={t("reader.tagToAdd")} placeholder={t("reader.tagPlaceholder")} onChange={(e) => setValue(e.target.value)}
        onBlur={close} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }} />
    </form>
  );
}

function Summary({ view, onSummarize }: { view: ArticleView; onSummarize: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const job = view.jobs.find((j) => j.type === "summarize");
  const running = busy(job);
  const failed = job && job.last_error && !running && job.status !== "succeeded";
  const s = view.summary;
  const first = s?.text.split("\n").map((l) => l.replace(/^\s*[-・*]\s*/, "").trim()).find(Boolean) ?? "";
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
          {running ? <span className="muted">{t("reader.summarizing")}</span> : <button className="tb" onClick={onSummarize}>{t("reader.summarize")}</button>}
        </div>
      )}
      {s && open && (
        <div className="summary-body">
          <p>{s.text}</p>
          <div className="summary-meta">
            <span>{t("reader.generated", { date: new Date(s.created_at).toLocaleDateString(locale(t.lang), { month: "2-digit", day: "2-digit" }) })}</span>
            {running ? <span>{t("quizPanel.regenerating")}</span> : <button className="tb" onClick={onSummarize}>{t("quizPanel.regenerate")}</button>}
          </div>
        </div>
      )}
      {s?.stale && <div className="summary-note muted">{t("reader.summaryStale")}</div>}
      {failed && <div className="summary-note error-text" title={t.msg(job.last_error)}>{t("reader.summaryFailed", { last_error: t.msg(job.last_error) })}</div>}
    </section>
  );
}

export function Reader({ view, focus, matches, mode, percent, onLang, focusMode, onPage, onLink, onToggleRead, onRetry, onReextract, onRender, onTranslate,
  onRetranslate, onSummarize, onFavorite, onTag, onGenre, onDifficulty, onClassify, onAsk, onFocusMode, onDelete, onFocusBlock, onReviewChanged,
  groups, onGroup, onCreateGroup, groupRequest }: {
  view: ArticleView;
  focus?: Focus;
  /** Search hits in this article: `i` of `n` is the focused one. */
  matches?: { i: number; n: number; onStep: (d: 1 | -1) => void };
  mode: LanguageMode;
  percent: number;
  onLang: (m: LanguageMode, p: number) => void;
  focusMode: boolean;
  onPage: () => void;
  /** `newTab`: Ctrl / middle click. */
  onLink: (href: string, newTab: boolean) => void;
  onToggleRead: () => void;
  onRetry: () => void;
  /** Re-runs extraction on the stored HTML (no network). */
  onReextract: () => void;
  onRender: () => void;
  onTranslate: () => void;
  /** Drops this article's translations and translates it again. */
  onRetranslate: () => void;
  onSummarize: () => void;
  onFavorite: () => void;
  onTag: (name: string, add: boolean) => void;
  onGenre: (name: string) => void;
  onDifficulty: (level: number | null) => void;
  onClassify: () => void;
  onAsk: () => void;
  onFocusMode: () => void;
  /** Asks for confirmation, then deletes the article. */
  onDelete: () => void;
  /** Scrolls to a block and marks it with `label` (a quiz answer's source). */
  onFocusBlock: (block: number, label: string) => void;
  /** Quiz cards were added to or removed from review. */
  onReviewChanged: () => void;
  /** Every group, for the article's group chips and picker. */
  groups: GroupRow[];
  onGroup: (id: number, add: boolean) => void;
  onCreateGroup: (name: string) => Promise<number>;
  /** Opens the group picker when it grows (palette). */
  groupRequest: number;
}) {
  const t = useT();
  const { article: a, blocks } = view;
  // Per-block click overrides on top of the mode; App remounts Reader per article.
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const [pop, setPop] = useState<number | null>(null);
  const [confirmRetranslate, setConfirmRetranslate] = useState(false);
  const [quizOpen, setQuizOpen] = useState(false);
  const timers = useRef({ show: 0, hide: 0 });
  const failed = a.fetch_status === "failed" || a.extraction_status === "failed";
  const markers = listMarkers(blocks);
  const selected = translatedBlockIds(blocks, mode, percent);
  const total = blocks.filter((b) => TRANSLATABLE.has(b.kind)).length;
  const done = blocks.filter((b) => b.translation != null).length;
  const job = view.jobs.find((j) => j.type === "translate");
  const translating = busy(job);
  const images = view.jobs.find((j) => j.type === "images");
  const imagesJob = images && `${images.status}:${images.attempt_count}`;
  const classify = view.jobs.find((j) => j.type === "classify");
  const classifying = busy(classify);
  const rendering = busy(view.jobs.find((j) => j.type === "render"));
  const readLabel = a.read_status === "read" ? t("reader.markUnread") : t("reader.markRead");
  const chars = blocks.reduce((n, b) => n + b.text.length, 0);

  useEffect(() => {
    if (focus) document.getElementById(`b-${focus.block}`)?.scrollIntoView({ block: "center" });
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- scroll once per focus request (seq), and again when the blocks arrive
  }, [focus?.seq, blocks.length]);

  function setLang(m: LanguageMode, p: number) {
    onLang(m, p);
    setFlipped(new Set());
  }

  function flip(id: number) {
    setPop(null);
    setFlipped((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  }

  // Hover shows the other language; clicking it (or the marker, or Enter) flips the block.
  function hover(id: number) {
    clearTimeout(timers.current.show);
    clearTimeout(timers.current.hide);
    timers.current.show = window.setTimeout(() => setPop(id), 300);
  }
  function leave() {
    clearTimeout(timers.current.show);
    timers.current.hide = window.setTimeout(() => setPop(null), 150);
  }

  const retranslate = () => (done > RETRANSLATE_CONFIRM_BLOCKS ? setConfirmRetranslate(true) : onRetranslate());

  const renderBtn = (pri: boolean) => (
    <button className={`btn${pri ? " pri" : ""}`} onClick={onRender} disabled={rendering}
      title={t("reader.renderHint")}>{rendering ? t("reader.rendering") : t("reader.render")}</button>
  );
  const fetched = a.fetch_status === "ok";
  const local = isLocal(a.original_url);

  return (
    <div className="doc">
      <div className="docbar">
        <ViewSeg page={false} onReader={() => {}} onPage={onPage} pageDisabled={local} />
        <div className="vsep" />
        {!failed && <LangSeg mode={mode} percent={percent} onChange={setLang} />}
        {!failed && <TranslationStatus job={job} done={done} total={total} target={view.target_language} onTranslate={onTranslate} onRetranslate={retranslate} />}
        {matches && (
          <span className="matches">
            {t("reader.match", { x: matches.i + 1, n: matches.n })}
            <button className="chip" onClick={() => matches.onStep(-1)} aria-label={t("reader.prevMatch")} disabled={matches.i <= 0}>↑</button>
            <button className="chip" onClick={() => matches.onStep(1)} aria-label={t("reader.nextMatch")} disabled={matches.i >= matches.n - 1}>↓</button>
          </span>
        )}
        <div className="docbar-r">
          <button className={`tb${a.favorite ? " on" : ""}`} onClick={onFavorite} aria-pressed={a.favorite} aria-label={t("browserView.favorite")} title={t("browserView.favorite")}><Icon name="star" /></button>
          <button className="tb" onClick={onToggleRead} title={`${readLabel} (m)`} aria-label={`${readLabel} (m)`}><Icon name="check" /><span className="lbl">{readLabel}</span></button>
          <button className="tb" onClick={onAsk} title={t("reader.chatAbout")} aria-label={t("reader.ask")}><Icon name="chat" /><span className="lbl">{t("reader.ask")}</span></button>
          {!failed && (
            <button className={`tb qz-btn${quizOpen ? " qz-open" : ""}`} onClick={() => setQuizOpen((o) => !o)} aria-pressed={quizOpen} aria-label={t("quizPanel.title")} title={t("reader.quizHint")}>
              <Icon name="quiz" /><span className="lbl">{t("quizPanel.title")}</span>
            </button>
          )}
          <button className="tb" onClick={onFocusMode} aria-pressed={focusMode} aria-label={t("reader.focus")} title={t("reader.focus")}><Icon name="focus" /></button>
          <Menu className="tb" label={t("reader.more2")} align="right" trigger={<Icon name="more" />} items={[
            { label: t("reader.reextractFrom", { x: a.pdf ? "PDF" : local ? "Markdown" : "HTML" }), onSelect: onReextract, disabled: !fetched },
            ...(local || a.pdf ? [] : [{ label: rendering ? t("reader.rendering") : t("reader.render"), onSelect: onRender, disabled: rendering }]),
            { label: classifying ? t("reader.classifying") : t("reader.autoClassify"), onSelect: onClassify, disabled: classifying || failed },
            { label: translating ? t("reader.translatingEllipsis") : t("reader.retranslate"), onSelect: retranslate, disabled: failed || translating || done === 0 },
            { label: view.summary ? t("reader.resummarize") : t("reader.summarize"), onSelect: onSummarize, disabled: failed || busy(view.jobs.find((j) => j.type === "summarize")) },
            "-",
            { label: <span className="error-text">{t("reader.delete")}</span>, onSelect: onDelete },
          ]} />
        </div>
      </div>

      <div className="doc-body">
      <div className="doc-scroll" tabIndex={-1} data-pane-target>
        <article className="reader">
          <div className="art-meta">
            {a.feed_title && <span className="src">{a.feed_title}</span>}
            <span className="with-ico"><Favicon domain={a.domain} feed={a.feed_id} />{a.site_name && a.site_name !== a.feed_title ? `${a.site_name} · ` : ""}{siteOf(a, t)}</span>
            {a.author && <><span>·</span><span>{a.author}</span></>}
            {a.published_at && <><span>·</span><span>{a.published_at.slice(0, 10)}</span></>}
          </div>
          <h1 className="prose art-title">{a.title ?? a.original_url}</h1>
          <div className="art-chips">
            {!failed && <GenreChip genre={a.genre} classifying={classifying} onGenre={onGenre} onClassify={onClassify} />}
            {a.tags.map((tag) => (
              <span key={tag} className="chip mono">{tag}<button className="x" onClick={() => onTag(tag, false)} aria-label={t("reader.removeTag", { tag })}><Icon name="x" size="sm" /></button></span>
            ))}
            <TagAdder onAdd={(tag) => onTag(tag, true)} />
            <GroupChips groups={groups} ids={a.groups} onToggle={onGroup} onCreate={onCreateGroup} request={groupRequest} />
            {!failed && (
              <label className="chip sel-chip" title={t("reader.difficultyHint")}>
                <Dif d={a.difficulty} />{a.difficulty ? t(DIFFICULTY_LABELS[a.difficulty - 1]) : t("common.difficulty")}
                <select value={a.difficulty ?? ""} aria-label={t("common.difficulty")} onChange={(e) => onDifficulty(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">{t("library.difficultyNone")}</option>
                  {DIFFICULTY_LABELS.map((l, i) => <option key={l} value={i + 1}>{i + 1} {t(l)}</option>)}
                </select>
              </label>
            )}
            {!failed && (
              <span className="chip-cap">
                {classifying ? t("reader.classifying") : a.genre_manual || a.difficulty_manual ? t("reader.manual") : t("reader.auto")}
                {classify?.last_error && !classifying && classify.status !== "succeeded" && <span className="error-text" title={t.msg(classify.last_error)}>{t("reader.classifyFailed", { last_error: t.msg(classify.last_error) })}</span>}
              </span>
            )}
          </div>

          {failed && (
            <div className="promoted">
              <div className="note err col">
                <span className="strong">{a.fetch_status === "failed" ? t("reader.fetchFailed") : t("reader.extractFailed")}</span>
                <span>{a.last_error && t.msg(a.last_error)}{fetched && t("reader.fetchedOk", { x: a.pdf ? "PDF" : "HTML" })}{a.pdf && t("reader.imageOnlyPdf")}</span>
              </div>
              <div className="btn-row">
                {!local && !a.pdf && renderBtn(true)}
                {fetched && <button className="btn" onClick={onReextract} title={t("reader.reextractHint", { x: a.pdf ? "PDF" : "HTML" })}>{t("reader.reextractOffline")}</button>}
                {!local && <button className="btn" onClick={onRetry}>{t("common.retry")}</button>}
                {!local && <button className="btn" onClick={onPage}>{t("reader.openInPage")}</button>}
              </div>
            </div>
          )}
          {!failed && <Summary view={view} onSummarize={onSummarize} />}
          {a.from_feed && (
            <div className="note warn center thin">
              <span className="grow">
                {t("reader.fromFeed")}{a.last_error ? t("reader.fromFeedError", { last_error: t.msg(a.last_error) }) : t("reader.fromFeedEmpty")}
              </span>
              <button className="btn" onClick={onRetry} title={t("reader.refetchHint")}>{t("common.retry")}</button>
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
            <div className="prose blocks">
              {blocks.map((b, i) => {
                const has = b.translation != null;
                const translated = selected.has(b.id) !== flipped.has(b.id) && has;
                const pending = !has && translating && TRANSLATABLE.has(b.kind);
                const focused = focus?.block === b.id ? focus : undefined;
                const label = translated ? t("reader.flipToOriginal") : t("reader.flipToTranslation");
                return (
                  <div key={b.id} id={`b-${b.id}`} className={`blk ${b.kind}${focused ? ` is-${focused.tone}` : ""}${has ? " flip" : ""}`}
                    onMouseEnter={has ? () => hover(b.id) : undefined} onMouseLeave={has ? leave : undefined}
                    tabIndex={has ? 0 : undefined} aria-description={has ? t("reader.flipHint") : undefined}
                    onKeyDown={has ? (e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); flip(b.id); } } : undefined}>
                    {has ? <button className={`mk ${translated ? "ja" : "en"}`} onClick={() => flip(b.id)} aria-label={label} title={label}><i /></button>
                      : pending && <span className="mk pend" aria-hidden="true" title={t("reader.waiting")}><i /></span>}
                    {focused && <div className="blk-label">{focused.label}</div>}
                    <BlockView block={b} marker={markers[i]} translated={translated} imagesJob={imagesJob} ts={focused?.terms} />
                    {pop === b.id && (
                      <div className="pop" role="tooltip" onClick={() => flip(b.id)}
                        onMouseEnter={() => clearTimeout(timers.current.hide)}>
                        <div className="pop-h"><span>{translated ? t("reader.original") : t("reader.translated")}</span><span className="r">{t.rich("reader.flipPop", { kbd: <Kbd>Enter</Kbd> })}</span></div>
                        {translated ? b.text : b.translation}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </OpenLink.Provider>
        </article>
      </div>
      {quizOpen && <QuizPanel view={view} onSource={(b) => onFocusBlock(b, t("reader.quizSource"))} onReviewChanged={onReviewChanged} onClose={() => setQuizOpen(false)} />}
      </div>
      {confirmRetranslate && (
        <ConfirmDialog title={t("reader.confirmRetranslate")} confirm={t("reader.retranslate")}
          onConfirm={() => { setConfirmRetranslate(false); onRetranslate(); }} onCancel={() => setConfirmRetranslate(false)}>
          <p>{t("reader.confirmRetranslateDesc", { done })}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
