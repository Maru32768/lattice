import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, type ArticleView, type Block, type Inline, type JobRow } from "./api";
import { type LanguageMode, splitBackticks, translatedBlockIds } from "./mixed";
import { DIFFICULTY_LABELS, genreSwatch } from "./library";
import { UNCLASSIFIED } from "./groups";
import { highlight } from "./search";
import { Menu } from "./Popover";
import { Dif, Icon, Kbd } from "./Icon";

// Article content is untrusted: it is rendered only as React text nodes, never as HTML,
// and links open in the in-app browser instead of navigating this (app) WebView.
const OpenLink = createContext<(href: string) => void>(() => {});

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const openLink = useContext(OpenLink);
  return <a href={href} title={href} onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLink(href); }}>{children}</a>;
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
  const src = block.attrs.src!;
  return (
    <figure className="image" ref={ref}>
      {url ? <img src={url} alt={block.text} title={block.text || undefined} />
        : <Link href={src}>画像: {block.text || src}</Link>}
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
export function ViewSeg({ page, onReader, onPage, readerDisabled }: { page: boolean; onReader: () => void; onPage: () => void; readerDisabled?: boolean }) {
  return (
    <>
      <div className="seg" role="group" aria-label="表示">
        <button className={page ? "" : "on"} aria-pressed={!page} onClick={onReader} disabled={readerDisabled}
          title={readerDisabled ? "Index に追加すると Reader が使えます" : "Reader (v)"}><Icon name="reader" size="md" />Reader</button>
        <button className={page ? "on" : ""} aria-pressed={page} onClick={onPage} title="Page (v)"><Icon name="page" size="md" />Page</button>
      </div>
      <Kbd>v</Kbd>
    </>
  );
}

/** 原文 / 混在 NN% / − / + / 訳文, shared by Reader and Page. */
export function LangSeg({ mode, percent, onChange, label = "表示言語" }: {
  mode: LanguageMode; percent: number; onChange: (m: LanguageMode, p: number) => void; label?: string;
}) {
  const step = (d: number) => onChange("mixed", Math.max(0, Math.min(100, percent + d)));
  return (
    <div className="seg" role="group" aria-label={label}>
      <button className={mode === "original" ? "on" : ""} aria-pressed={mode === "original"} onClick={() => onChange("original", percent)}>原文</button>
      <button className={mode === "mixed" ? "on" : ""} aria-pressed={mode === "mixed"} onClick={() => onChange("mixed", percent)}>
        混在 <span className="mono">{percent}%</span>
      </button>
      <button className="step" onClick={() => step(-10)} aria-label="訳文の割合を下げる ([)" title="訳文の割合を下げる ([)">−</button>
      <button className="step" onClick={() => step(10)} aria-label="訳文の割合を上げる (])" title="訳文の割合を上げる (])">+</button>
      <button className={mode === "translated" ? "on" : ""} aria-pressed={mode === "translated"} onClick={() => onChange("translated", percent)}>訳文</button>
    </div>
  );
}

function TranslationStatus({ job, done, total, target, onTranslate }: { job?: JobRow; done: number; total: number; target: ArticleView["target_language"]; onTranslate: () => void }) {
  const keys = <span className="keys"><Kbd>[</Kbd><Kbd>]</Kbd> 割合</span>;
  const hint = <span className="hint-keys">{keys}</span>;
  if (!job) return <>{hint}<button className="tb" onClick={onTranslate} disabled={total === 0}><Icon name="translate" />{target === "en" ? "英語" : "日本語"}に翻訳</button></>;
  if (busy(job)) {
    return (
      <span className="tr-prog" role="status">
        <span>{job.status === "running" ? "翻訳中" : "翻訳待ち"} {done} / {total} block</span>
        <span className="prog"><b style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></span>
      </span>
    );
  }
  if (job.status === "succeeded" && done >= total) return <span className="hint-keys">{keys}<span className="keys"> · </span>翻訳 {done}/{total}</span>;
  const retryAt = job.status === "pending" && job.next_run_at
    ? new Date(job.next_run_at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <>
      <span className={job.last_error ? "error-text" : "muted"} title={job.last_error ?? undefined}>{done} / {total}{job.last_error && " · 失敗"}</span>
      {retryAt && <span className="muted">自動再試行 {retryAt}</span>}
      {job.last_error && <button className="btn sm" onClick={onTranslate}>再試行</button>}
      {done < total && <button className="btn sm" onClick={onTranslate}>続きを翻訳</button>}
    </>
  );
}

/** Genre chip that edits in place: pick or type one (pinned against auto runs), or let the LLM choose. */
function GenreChip({ genre, classifying, onGenre, onClassify }: {
  genre: string | null; classifying: boolean; onGenre: (name: string) => void; onClassify: () => void;
}) {
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
      <button className="chip" onClick={() => setEditing(true)} title="ジャンルを変更">
        <span className="sw" style={{ background: genreSwatch(genre) }} />{genre ?? UNCLASSIFIED}
      </button>
    );
  }
  return (
    <form className="chip-edit" onSubmit={(e) => { e.preventDefault(); commit(); }}>
      <input className="input sm" list="genre-options" value={value} autoFocus aria-label="ジャンル" placeholder={UNCLASSIFIED}
        onChange={(e) => setValue(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setValue(genre ?? ""); setEditing(false); } }} />
      <datalist id="genre-options">{genres.map((g) => <option key={g} value={g} />)}</datalist>
      <button type="button" className="btn sm" disabled={classifying} onMouseDown={(e) => e.preventDefault()}
        onClick={() => { setEditing(false); onClassify(); }}>自動分類</button>
    </form>
  );
}

function TagAdder({ onAdd }: { onAdd: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  if (!editing) return <button className="chip dashed" onClick={() => setEditing(true)} aria-label="タグを追加">+ タグ</button>;
  const close = () => { setValue(""); setEditing(false); };
  return (
    <form className="chip-edit" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onAdd(value.trim()); setValue(""); }}>
      <input className="input sm mono" value={value} autoFocus aria-label="追加するタグ" placeholder="タグ名 Enter" onChange={(e) => setValue(e.target.value)}
        onBlur={close} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }} />
    </form>
  );
}

function Summary({ view, onSummarize }: { view: ArticleView; onSummarize: () => void }) {
  const [open, setOpen] = useState(false);
  const job = view.jobs.find((j) => j.type === "summarize");
  const running = busy(job);
  const failed = job && job.last_error && !running && job.status !== "succeeded";
  const s = view.summary;
  const first = s?.text.split("\n").map((l) => l.replace(/^\s*[-・*]\s*/, "").trim()).find(Boolean) ?? "";
  return (
    <section className="summary" aria-label="要約">
      {s ? (
        <button className="summary-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="cap">要約</span>
          <span className="first">{open ? "" : first}</span>
          <Icon name={open ? "up" : "down"} />
        </button>
      ) : (
        <div className="summary-row">
          <span className="cap">要約</span>
          {running ? <span className="muted">要約を作成中…</span> : <button className="tb" onClick={onSummarize}>要約を作成</button>}
        </div>
      )}
      {s && open && (
        <div className="summary-body">
          <p>{s.text}</p>
          <div className="summary-meta">
            <span>{new Date(s.created_at).toLocaleDateString("ja-JP", { month: "2-digit", day: "2-digit" })} 生成</span>
            {running ? <span>作り直し中…</span> : <button className="tb" onClick={onSummarize}>作り直す</button>}
          </div>
        </div>
      )}
      {s?.stale && <div className="summary-note muted">本文が更新されています</div>}
      {failed && <div className="summary-note error-text" title={job.last_error ?? ""}>要約に失敗: {job.last_error}</div>}
    </section>
  );
}

export function Reader({ view, focus, matches, mode, percent, onLang, focusMode, onPage, onLink, onToggleRead, onRetry, onReextract, onRender, onTranslate,
  onSummarize, onFavorite, onTag, onGenre, onDifficulty, onClassify, onAsk, onFocusMode, onDelete }: {
  view: ArticleView;
  focus?: Focus;
  /** Search hits in this article: `i` of `n` is the focused one. */
  matches?: { i: number; n: number; onStep: (d: 1 | -1) => void };
  mode: LanguageMode;
  percent: number;
  onLang: (m: LanguageMode, p: number) => void;
  focusMode: boolean;
  onPage: () => void;
  onLink: (href: string) => void;
  onToggleRead: () => void;
  onRetry: () => void;
  /** Re-runs extraction on the stored HTML (no network). */
  onReextract: () => void;
  onRender: () => void;
  onTranslate: () => void;
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
}) {
  const { article: a, blocks } = view;
  // Per-block click overrides on top of the mode; App remounts Reader per article.
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const [pop, setPop] = useState<number | null>(null);
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
  const readLabel = a.read_status === "read" ? "未読に戻す" : "既読にする";
  const chars = blocks.reduce((n, b) => n + b.text.length, 0);

  useEffect(() => {
    if (focus) document.getElementById(`b-${focus.block}`)?.scrollIntoView({ block: "center" });
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

  const renderBtn = (pri: boolean) => (
    <button className={`btn${pri ? " pri" : ""}`} onClick={onRender} disabled={rendering}
      title="裏の非表示ブラウザでページを描画し、その内容で保存し直します">{rendering ? "描画して取り込み中…" : "描画して取り込み直す"}</button>
  );
  const fetched = a.fetch_status === "ok";

  return (
    <div className="doc">
      <div className="docbar">
        <ViewSeg page={false} onReader={() => {}} onPage={onPage} />
        <div className="vsep" />
        {!failed && <LangSeg mode={mode} percent={percent} onChange={setLang} />}
        {!failed && <TranslationStatus job={job} done={done} total={total} target={view.target_language} onTranslate={onTranslate} />}
        {matches && (
          <span className="matches">
            一致 {matches.i + 1} / {matches.n}
            <button className="chip" onClick={() => matches.onStep(-1)} aria-label="前の一致" disabled={matches.i <= 0}>↑</button>
            <button className="chip" onClick={() => matches.onStep(1)} aria-label="次の一致" disabled={matches.i >= matches.n - 1}>↓</button>
          </span>
        )}
        <div className="docbar-r">
          <button className={`tb${a.favorite ? " on" : ""}`} onClick={onFavorite} aria-pressed={a.favorite} aria-label="お気に入り (s)" title="お気に入り (s)"><Icon name="star" /></button>
          <button className="tb" onClick={onToggleRead} title={`${readLabel} (m)`} aria-label={`${readLabel} (m)`}><Icon name="check" /><span className="lbl">{readLabel}</span></button>
          <button className="tb" onClick={onAsk} title="この記事について対話" aria-label="質問"><Icon name="chat" /><span className="lbl">質問</span></button>
          <button className="tb" onClick={onFocusMode} aria-pressed={focusMode} aria-label="フォーカスモード (f)" title="フォーカスモード (f)"><Icon name="focus" /></button>
          <Menu className="tb" label="その他（再抽出・描画して取り込み直す・自動分類・要約を作り直す・削除）" align="right" trigger={<Icon name="more" />} items={[
            { label: "再抽出（保存済みの HTML から）", onSelect: onReextract, disabled: !fetched },
            { label: rendering ? "描画して取り込み中…" : "描画して取り込み直す", onSelect: onRender, disabled: rendering || !fetched },
            { label: classifying ? "分類中…" : "自動分類", onSelect: onClassify, disabled: classifying || failed },
            { label: view.summary ? "要約を作り直す" : "要約を作成", onSelect: onSummarize, disabled: failed || busy(view.jobs.find((j) => j.type === "summarize")) },
            "-",
            { label: <span className="error-text">記事を削除…</span>, onSelect: onDelete },
          ]} />
        </div>
      </div>

      <div className="doc-scroll">
        <article className="reader">
          <div className="art-meta">
            {a.feed_title && <span className="src">{a.feed_title}</span>}
            <span>{a.site_name && a.site_name !== a.feed_title ? `${a.site_name} · ` : ""}{a.domain}</span>
            {a.author && <><span>·</span><span>{a.author}</span></>}
            {a.published_at && <><span>·</span><span>{a.published_at.slice(0, 10)}</span></>}
          </div>
          <h1 className="prose art-title">{a.title ?? a.original_url}</h1>
          <div className="art-chips">
            {!failed && <GenreChip genre={a.genre} classifying={classifying} onGenre={onGenre} onClassify={onClassify} />}
            {a.tags.map((t) => (
              <span key={t} className="chip mono">{t}<button className="x" onClick={() => onTag(t, false)} aria-label={`タグ ${t} を外す`}><Icon name="x" size="sm" /></button></span>
            ))}
            <TagAdder onAdd={(t) => onTag(t, true)} />
            {!failed && (
              <label className="chip sel-chip" title="難易度（未判定に戻すと自動分類で推定し直します）">
                <Dif d={a.difficulty} />{a.difficulty ? DIFFICULTY_LABELS[a.difficulty - 1] : "難易度"}
                <select value={a.difficulty ?? ""} aria-label="難易度" onChange={(e) => onDifficulty(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">未判定</option>
                  {DIFFICULTY_LABELS.map((l, i) => <option key={l} value={i + 1}>{i + 1} {l}</option>)}
                </select>
              </label>
            )}
            {!failed && (
              <span className="chip-cap">
                {classifying ? "分類中…" : a.genre_manual || a.difficulty_manual ? "手動" : "自動分類 · 手動で固定可"}
                {classify?.last_error && !classifying && classify.status !== "succeeded" && <span className="error-text" title={classify.last_error}> · 分類に失敗: {classify.last_error}</span>}
              </span>
            )}
          </div>

          {failed && (
            <div className="promoted">
              <div className="note err col">
                <span className="strong">{a.fetch_status === "failed" ? "ページを取得できませんでした" : "本文を抽出できませんでした"}</span>
                <span>{a.last_error}{fetched && " — 取得は成功し、HTML は保存済みです。"}</span>
              </div>
              <div className="btn-row">
                {fetched && renderBtn(true)}
                {fetched && <button className="btn" onClick={onReextract} title="保存済みの HTML から抽出し直します">再抽出（オフライン）</button>}
                <button className="btn" onClick={onRetry}>再試行</button>
                <button className="btn" onClick={onPage}>Page で開く</button>
              </div>
            </div>
          )}
          {!failed && <Summary view={view} onSummarize={onSummarize} />}
          {a.thin && (
            <div className="note warn center thin">
              <span className="grow">
                抽出できた本文は {chars.toLocaleString()} 文字だけです。元ページの一部しか取れていない可能性があります（JavaScript で描画するページかもしれません）。
                Page で開いて読み込み後に「描画後のページで保存し直す」こともできます。{a.last_error && ` ${a.last_error}。`}
              </span>
              {renderBtn(false)}
            </div>
          )}
          {!failed && job?.last_error && !translating && done < total && (
            <div className="note err">
              <Icon name="alert" />
              <span>{job.last_error}。保存済みの {done} block は残っているので、再試行は未翻訳の {total - done} block だけです。</span>
            </div>
          )}

          <OpenLink.Provider value={onLink}>
            <div className="prose blocks">
              {blocks.map((b, i) => {
                const has = b.translation != null;
                const translated = selected.has(b.id) !== flipped.has(b.id) && has;
                const pending = !has && translating && TRANSLATABLE.has(b.kind);
                const focused = focus?.block === b.id ? focus : undefined;
                const label = translated ? "この block を原文に切り替え" : "この block を訳文に切り替え";
                return (
                  <div key={b.id} id={`b-${b.id}`} className={`blk ${b.kind}${focused ? ` is-${focused.tone}` : ""}${has ? " flip" : ""}`}
                    onMouseEnter={has ? () => hover(b.id) : undefined} onMouseLeave={has ? leave : undefined}
                    tabIndex={has ? 0 : undefined} aria-description={has ? "Enter で原文／訳文を切替" : undefined}
                    onKeyDown={has ? (e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); flip(b.id); } } : undefined}>
                    {has ? <button className={`mk ${translated ? "ja" : "en"}`} onClick={() => flip(b.id)} aria-label={label} title={label}><i /></button>
                      : pending && <span className="mk pend" aria-hidden="true" title="翻訳待ち"><i /></span>}
                    {focused && <div className="blk-label">{focused.label}</div>}
                    <BlockView block={b} marker={markers[i]} translated={translated} imagesJob={imagesJob} ts={focused?.terms} />
                    {pop === b.id && (
                      <div className="pop" role="tooltip" onClick={() => flip(b.id)}
                        onMouseEnter={() => clearTimeout(timers.current.hide)}>
                        <div className="pop-h"><span>{translated ? "原文" : "訳文"}</span><span className="r">クリック / <Kbd>Enter</Kbd> で反転</span></div>
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
    </div>
  );
}
