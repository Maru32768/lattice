import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, type ArticleView, type Block, type Inline, type JobRow } from "./api";
import { type LanguageMode, splitBackticks, translatedBlockIds } from "./mixed";
import { GenreField } from "./GenreField";
import { DifficultyField } from "./DifficultyField";

// Article content is untrusted: it is rendered only as React text nodes, never as HTML,
// and links open in the in-app browser instead of navigating this (app) WebView.
const OpenLink = createContext<(href: string) => void>(() => {});

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const openLink = useContext(OpenLink);
  return <a href={href} title={href} onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLink(href); }}>{children}</a>;
}

/** Mirrors ir.rs PROSE_KINDS. */
const TRANSLATABLE = new Set(["heading", "paragraph", "list_item", "blockquote", "caption"]);

function Inlines({ block, translated }: { block: Block; translated: boolean }) {
  if (translated && block.translation != null) {
    return <>{splitBackticks(block.translation).map((s, n) => (s.code ? <code key={n}>{s.v}</code> : s.v))}</>;
  }
  if (!block.inlines) return <>{block.text}</>;
  return (
    <>
      {block.inlines.map((i: Inline, n) =>
        i.t === "code" ? <code key={n}>{i.v}</code>
        : i.t === "link" ? <Link key={n} href={i.href}>{i.v}</Link>
        : i.v,
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

function BlockView({ block, marker, translated, imagesJob }: { block: Block; marker?: string; translated: boolean; imagesJob?: string }) {
  const a = block.attrs;
  const body = <Inlines block={block} translated={translated} />;
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
      return <pre data-lang={a.lang}><code>{block.text}</code></pre>;
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

function Summary({ view, onSummarize }: { view: ArticleView; onSummarize: () => void }) {
  const job = view.jobs.find((j) => j.type === "summarize");
  const busy = job?.status === "running" || (job?.status === "pending" && !job.last_error);
  const failed = job && job.last_error && !busy && job.status !== "succeeded";
  return (
    <section className="summary" aria-label="要約">
      {view.summary && <p className="summary-text">{view.summary.text}</p>}
      <div className="summary-actions">
        {busy ? <span className="status">要約を作成中…</span>
          : <button onClick={onSummarize}>{view.summary ? "要約を作り直す" : "要約を作成"}</button>}
        {view.summary?.stale && <span className="status">本文が更新されています</span>}
        {failed && <span className="status error-text" title={job.last_error ?? ""}>失敗: {job.last_error}</span>}
      </div>
    </section>
  );
}

function TranslationStatus({ job, done, total, onTranslate }: {
  job?: JobRow; done: number; total: number; onTranslate: () => void;
}) {
  const progress = `${done}/${total}`;
  if (!job) return <button onClick={onTranslate} disabled={total === 0}>日本語に翻訳</button>;
  if (job.status === "running") return <span className="status">翻訳中… {progress}</span>;
  if (job.status === "pending" && !job.last_error) return <span className="status">翻訳待ち… {progress}</span>;
  if (job.status === "succeeded" && done >= total) return <span className="status">翻訳済み {progress}</span>;
  const retryAt = job.status === "pending" && job.next_run_at
    ? `（${new Date(job.next_run_at).toLocaleTimeString()} に自動再試行）` : "";
  return (
    <span className="status error-text" title={job.last_error ?? ""}>
      翻訳 {progress}{job.last_error && `・失敗${retryAt}: ${job.last_error}`}
      <button onClick={onTranslate}>{job.last_error ? "再試行" : "続きを翻訳"}</button>
    </span>
  );
}

/** For pages whose server HTML had little text: re-saves the page as rendered in a hidden webview (background job). */
function RenderAction({ view, onRender }: { view: ArticleView; onRender: () => void }) {
  const job = view.jobs.find((j) => j.type === "render");
  const busy = job?.status === "running" || (job?.status === "pending" && !job.last_error);
  return busy ? <span className="status">描画して取り込み中…</span>
    : <button onClick={onRender} title="裏の非表示ブラウザでページを描画し、その内容で保存し直します">描画して取り込み直す</button>;
}

export function Reader({ view, mode, percent, onMode, onPercent, onPage, onLink, onToggleRead, onRetry, onReextract, onRender, onTranslate, onSummarize, onFavorite, onTag, onGenre, onDifficulty, onClassify }: {
  view: ArticleView;
  onRender: () => void;
  onGenre: (name: string) => void;
  onDifficulty: (level: number | null) => void;
  onClassify: () => void;
  onSummarize: () => void;
  onFavorite: () => void;
  onTag: (name: string, add: boolean) => void;
  onPage: () => void;
  onLink: (href: string) => void;
  mode: LanguageMode;
  percent: number;
  onMode: (m: LanguageMode) => void;
  onPercent: (p: number) => void;
  onToggleRead: () => void;
  onRetry: () => void;
  /** Re-runs extraction on the stored HTML (no network). */
  onReextract: () => void;
  onTranslate: () => void;
}) {
  const { article: a, blocks } = view;
  // Per-block click overrides on top of the mode; App remounts Reader per article.
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const failed = a.fetch_status === "failed" || a.extraction_status === "failed";
  const markers = listMarkers(blocks);
  const selected = translatedBlockIds(blocks, mode, percent);
  const total = blocks.filter((b) => TRANSLATABLE.has(b.kind)).length;
  const done = blocks.filter((b) => b.translation != null).length;
  const job = view.jobs.find((j) => j.type === "translate");
  const images = view.jobs.find((j) => j.type === "images");
  const imagesJob = images && `${images.status}:${images.attempt_count}`;

  // Hover shows the other language; clicking that tooltip flips the block (as in the page view).
  const [newTag, setNewTag] = useState("");
  const [tip, setTip] = useState<{ id: number; text: string; translated: boolean; x: number; y: number } | null>(null);
  const timers = useRef({ show: 0, hide: 0 });

  function hover(e: React.MouseEvent, b: Block, translated: boolean) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    clearTimeout(timers.current.show);
    clearTimeout(timers.current.hide);
    timers.current.show = window.setTimeout(() => {
      setTip({ id: b.id, text: translated ? b.text : b.translation ?? "", translated, x, y: rect.top });
    }, 300);
  }

  function leave() {
    clearTimeout(timers.current.show);
    timers.current.hide = window.setTimeout(() => setTip(null), 150);
  }

  function flip(id: number) {
    setFlipped((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  }

  return (
    <article className="reader">
      <header>
        <h1>{a.title ?? a.original_url}</h1>
        <div className="meta">
          <span>{a.site_name ?? a.domain}</span>
          {a.author && <span>{a.author}</span>}
          {a.published_at && <span>{a.published_at.slice(0, 10)}</span>}
          {!failed && <DifficultyField article={a} onDifficulty={onDifficulty} />}
          <button onClick={onPage}>ページ表示</button>
          <button onClick={onToggleRead}>{a.read_status === "read" ? "未読に戻す" : "既読にする"}</button>
          <button onClick={onFavorite} aria-pressed={a.favorite} title="お気に入り">{a.favorite ? "★" : "☆"}</button>
          {!failed && !a.thin && <button onClick={onReextract} title="保存済みの HTML から抽出し直します">再抽出</button>}
        </div>
        <div className="tags">
          {a.tags.map((t) => (
            <span key={t} className="tag">#{t}<button onClick={() => onTag(t, false)} aria-label={`タグ ${t} を外す`}>×</button></span>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); if (newTag.trim()) { onTag(newTag, true); setNewTag(""); } }}>
            <input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="タグを追加" aria-label="タグを追加" />
          </form>
        </div>
        {!failed && <GenreField view={view} onGenre={onGenre} onClassify={onClassify} />}
        {!failed && (
          <div className="toolbar">
            <div className="segmented" role="radiogroup" aria-label="表示言語">
              {([["original", "原文"], ["translated", "翻訳"], ["mixed", "混在"]] as const).map(([m, label]) => (
                <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""}
                  onClick={() => { onMode(m); setFlipped(new Set()); }}>{label}</button>
              ))}
            </div>
            {mode === "mixed" && (
              <label className="ratio">
                日本語 {percent}%
                <input type="range" min={0} max={100} step={10} value={percent}
                  onChange={(e) => onPercent(Number(e.target.value))} />
              </label>
            )}
            <TranslationStatus job={job} done={done} total={total} onTranslate={onTranslate} />
          </div>
        )}
      </header>
      {!failed && <Summary view={view} onSummarize={onSummarize} />}
      {failed && (
        <div className="error">
          {a.fetch_status === "failed" ? "取得" : "本文抽出"}に失敗しました: {a.last_error}
          <button onClick={onRetry}>再試行</button>
          {a.fetch_status === "ok" && <button onClick={onReextract} title="保存済みの HTML から抽出し直します">再抽出</button>}
          {a.fetch_status === "ok" && <RenderAction view={view} onRender={onRender} />}
        </div>
      )}
      {a.thin && (
        <div className="notice">
          本文がほとんど抽出できませんでした（JavaScript で描画するページかもしれません）。
          「描画して取り込み直す」か、ページ表示で開いて読み込み後に「描画後のページで保存」を押すと保存し直せます。
          {a.last_error && <> {a.last_error}。</>}
          <RenderAction view={view} onRender={onRender} />
          <button onClick={onReextract} title="保存済みの HTML から抽出し直します">再抽出</button>
        </div>
      )}
      <OpenLink.Provider value={onLink}>
        {blocks.map((b, i) => {
          const has = b.translation != null;
          const translated = selected.has(b.id) !== flipped.has(b.id) && has;
          return (
            <div key={b.id} id={`b-${b.id}`}
              className={`block ${b.kind}${has ? " has-translation" : ""}${translated ? " translated" : ""}`}
              onMouseEnter={has ? (e) => hover(e, b, translated) : undefined}
              onMouseLeave={has ? leave : undefined}
              tabIndex={has ? 0 : undefined}
              onKeyDown={has ? (e) => { if (e.key === "Enter" && e.target === e.currentTarget) flip(b.id); } : undefined}
              aria-description={has ? "Enter で原文／訳文を切替" : undefined}>
              <BlockView block={b} marker={markers[i]} translated={translated} imagesJob={imagesJob} />
            </div>
          );
        })}
      </OpenLink.Provider>
      {tip && (
        <div className="reader-tip" role="tooltip" style={{ left: Math.max(8, tip.x - 24), top: tip.y }}
          onMouseEnter={() => clearTimeout(timers.current.hide)} onMouseLeave={leave}
          onClick={() => { flip(tip.id); setTip(null); }}>
          {tip.text}
          <span className="hint">{tip.translated ? "クリックで原文に切替" : "クリックで訳文に切替"}</span>
        </div>
      )}
    </article>
  );
}
