import { Fragment, createContext, memo, useContext } from "react";
import type { Block, Inline } from "../api";
import { onMiddle } from "../lib/middle";
import { highlight } from "../search/search";
import { markWords, type WordMarks } from "../vocab/vocab";
import { useT } from "../i18n";
import { type Piece, dropsGap, shownTranslation, splitBackticks } from "./mixed";

// Article content is untrusted: it is rendered only as React text nodes, never as HTML,
// and links open in the in-app browser instead of navigating this (app) WebView.
export const OpenLink = createContext<(href: string, newTab: boolean) => void>(() => {});
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
/** The block's text as rendered, sentence by sentence. */
export function shownText(text: string, pieces: Piece[], shown: (i: number) => boolean): string {
  return pieces
    .map((p, i) => (dropsGap(text, pieces, i, shown) ? "" : p.translation != null && shown(i) ? translationText(p.translation) : text.slice(p.start, p.end)))
    .join("");
}

/** A prose block sentence by sentence, each in the language `shown` picks; `sentence` gives a translated sentence's span its handlers. */
export function Sentences({
  block,
  pieces,
  shown,
  ts,
  sentence,
}: {
  block: Block;
  pieces: Piece[];
  shown: (i: number) => boolean;
  ts?: string[];
  sentence: (i: number) => React.HTMLAttributes<HTMLSpanElement>;
}) {
  return (
    <>
      {pieces.map((p, i) =>
        dropsGap(block.text, pieces, i, shown) ? null : p.translation == null ? (
          <Inlines key={i} inlines={sliceInlines(block, p.start, p.end)} ts={ts} />
        ) : (
          <span key={i} className={`sent${shown(i) ? " tr" : ""}`} {...sentence(i)}>
            {shown(i) ? <Translation text={p.translation} ts={ts} /> : <Inlines inlines={sliceInlines(block, p.start, p.end)} ts={ts} />}
          </span>
        ),
      )}
    </>
  );
}

/** One block of an article. `body` is its text, sentence by sentence; `image` what an image block shows. */
export function BlockView({ block, marker, body, image }: { block: Block; marker?: string; body: React.ReactNode; image: React.ReactNode }) {
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
      return image;
    case "caption":
      return <p className="caption">{body}</p>;
    default:
      return <p>{body}</p>;
  }
}

/** Ordered-list numbering, derived from consecutive list_item blocks. */
export function listMarkers(blocks: Block[]): (string | undefined)[] {
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

/** What an image block without a stored copy shows: a link, or its name for an imported file's image that could not be read. */
export function ImageFallback({ block }: { block: Block }) {
  const t = useT();
  const src = block.attrs.src;
  return src && /^https?:/i.test(src) ? (
    <Link href={src}>{t("reader.image", { name: block.text || src })}</Link>
  ) : (
    <span className="muted">{t("reader.image", { name: block.text || src || "" })}</span>
  );
}
