import { openUrl } from "@tauri-apps/plugin-opener";
import type { ArticleView, Block, Inline } from "./api";

// Article content is untrusted: it is rendered only as React text nodes, never as HTML,
// and links open in the system browser instead of navigating this WebView.
function open(e: React.MouseEvent, href: string) {
  e.preventDefault();
  openUrl(href);
}

function Inlines({ block }: { block: Block }) {
  if (!block.inlines) return <>{block.text}</>;
  return (
    <>
      {block.inlines.map((i: Inline, n) =>
        i.t === "code" ? <code key={n}>{i.v}</code>
        : i.t === "link" ? <a key={n} href={i.href} title={i.href} onClick={(e) => open(e, i.href)}>{i.v}</a>
        : i.v,
      )}
    </>
  );
}

function BlockView({ block, marker }: { block: Block; marker?: string }) {
  const a = block.attrs;
  switch (block.kind) {
    case "heading": {
      const H = `h${Math.min(Math.max((a.level ?? 2), 2), 6)}` as "h2";
      return <H><Inlines block={block} /></H>;
    }
    case "list_item":
      return (
        <div className="li" style={{ marginLeft: `${(a.depth ?? 0) * 1.5}em` }}>
          <span className="marker">{marker}</span>
          <span><Inlines block={block} /></span>
        </div>
      );
    case "blockquote":
      return <blockquote><Inlines block={block} /></blockquote>;
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
      // shortcut: remote images are not loaded (tracking, CSP); download into the store when image saving lands.
      return (
        <figure className="image">
          <a href={a.src} onClick={(e) => open(e, a.src!)}>画像: {block.text || a.src}</a>
        </figure>
      );
    case "caption":
      return <p className="caption"><Inlines block={block} /></p>;
    default:
      return <p><Inlines block={block} /></p>;
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

export function Reader({ view, onToggleRead, onRetry }: {
  view: ArticleView;
  onToggleRead: () => void;
  onRetry: () => void;
}) {
  const { article: a, blocks } = view;
  const failed = a.fetch_status === "failed" || a.extraction_status === "failed";
  const markers = listMarkers(blocks);
  return (
    <article className="reader">
      <header>
        <h1>{a.title ?? a.original_url}</h1>
        <div className="meta">
          <span>{a.site_name ?? a.domain}</span>
          {a.author && <span>{a.author}</span>}
          {a.published_at && <span>{a.published_at.slice(0, 10)}</span>}
          <a href={a.original_url} onClick={(e) => open(e, a.original_url)}>原文URL</a>
          <button onClick={onToggleRead}>{a.read_status === "read" ? "未読に戻す" : "既読にする"}</button>
        </div>
      </header>
      {failed && (
        <div className="error">
          {a.fetch_status === "failed" ? "取得" : "本文抽出"}に失敗しました: {a.last_error}
          <button onClick={onRetry}>再試行</button>
        </div>
      )}
      {blocks.map((b, i) => (
        <div key={b.id} id={`b-${b.id}`} className={`block ${b.kind}`}>
          <BlockView block={b} marker={markers[i]} />
        </div>
      ))}
    </article>
  );
}
