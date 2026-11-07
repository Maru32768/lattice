import { memo, useEffect, useEffectEvent, useRef, useState } from "react";
import type { ArticleDoc, ArticleRow, VocabCapture } from "../bindings";
import { useT } from "../i18n";
import { translatedShare } from "../overlay/logic";
import { BlockView, ImageFallback, OpenLink, Sentences, listMarkers, shownText } from "../reader/BlockView";
import { type LanguageMode, type Piece, TRANSLATABLE, blockPieces, nothingToTranslate, translatedSentences } from "../reader/mixed";
import { captureIn, isWord } from "../vocab/vocab";
import { type LocalOp, Unauthorized, loadArticle, savedLanguage, saveLanguage, submit, withOps } from "./client";

type StoredBlock = ArticleDoc["blocks"][number];

/** How long the word's button outlives its selection: on a phone, tapping the button may collapse the selection first. */
const KEEP_WORD_MS = 500;
const WORD_TAKEN_MS = 3000;

const openLink = (href: string) => {
  if (/^https?:/i.test(href)) {
    window.open(href, "_blank", "noopener,noreferrer");
  }
};

/** One block: tapping a translated sentence shows its other language. `shownKey` has a "1" per piece that shows its translation. */
const MobileBlock = memo(function MobileBlock({
  block,
  pieces,
  shownKey,
  marker,
  onFlip,
}: {
  block: StoredBlock;
  pieces: Piece[];
  shownKey: string;
  marker?: string;
  onFlip: (block: number, piece: number) => void;
}) {
  return (
    <div className={`blk ${block.kind}`} data-block={block.id}>
      <BlockView
        block={block}
        marker={marker}
        image={
          <figure className="image">
            <ImageFallback block={block} />
          </figure>
        }
        body={
          <Sentences
            block={block}
            pieces={pieces}
            shown={(i) => shownKey[i] === "1"}
            sentence={(i) => ({ onClick: () => flipUnlessSelecting(() => onFlip(block.id, i)) })}
          />
        }
      />
    </div>
  );
});

/** Long-pressing to select text ends in a click: that must leave the sentence as it is. */
function flipUnlessSelecting(flip: () => void) {
  if (window.getSelection()?.isCollapsed !== false) {
    flip();
  }
}

async function fetchDoc(id: number): Promise<ArticleDoc | null | "failed" | "no-token"> {
  try {
    return await loadArticle(id);
  } catch (e) {
    return e instanceof Unauthorized ? "no-token" : "failed";
  }
}

export function ArticlePage({
  id,
  row,
  ops,
  unsent,
  writable,
  onBack,
}: {
  id: number;
  /** The article in the list, which is newer than the page's copy once the list has loaded. */
  row?: ArticleRow;
  ops: LocalOp[];
  unsent: number;
  writable: boolean;
  onBack: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const [doc, setDoc] = useState<ArticleDoc | null | "loading" | "failed" | "no-token">("loading");
  const [{ mode, percent }, setLanguage] = useState(savedLanguage);
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  /** The word selected in one prose block, ready to send. */
  const [word, setWord] = useState<VocabCapture | null>(null);
  const [wordTaken, setWordTaken] = useState(false);
  const timers = useRef({ word: 0, taken: 0 });

  const load = async () => {
    setDoc("loading");
    setDoc(await fetchDoc(id));
  };
  // App remounts this page per article.
  const firstLoad = useEffectEvent(() => void load());
  // oxlint-disable-next-line react/set-state-in-effect -- fetching the article is why the effect exists
  useEffect(() => firstLoad(), []);

  const choose = (m: LanguageMode, p: number) => {
    setLanguage({ mode: m, percent: p });
    setFlipped(new Set());
    saveLanguage({ mode: m, percent: p });
  };
  const toolbar = (
    <header className="m-bar">
      <a className="btn" href="#/" onClick={onBack}>
        {t("mobile.back")}
      </a>
      <div className="seg" role="group" aria-label={t("reader.language")}>
        <button className={mode === "original" ? "on" : ""} aria-pressed={mode === "original"} onClick={() => choose("original", percent)}>
          {t("reader.original")}
        </button>
        <button className={mode === "mixed" ? "on" : ""} aria-pressed={mode === "mixed"} onClick={() => choose("mixed", percent)}>
          {t("reader.mixed")}
        </button>
        <button className={mode === "translated" ? "on" : ""} aria-pressed={mode === "translated"} onClick={() => choose("translated", percent)}>
          {t("reader.translated")}
        </button>
      </div>
      {mode === "mixed" && (
        <div className="m-share">
          <button className="btn" aria-label={t("reader.less")} onClick={() => choose("mixed", Math.max(0, percent - 10))}>
            −
          </button>
          <span className="mono">{percent}%</span>
          <button className="btn" aria-label={t("reader.more")} onClick={() => choose("mixed", Math.min(100, percent + 10))}>
            +
          </button>
        </div>
      )}
    </header>
  );

  const onSelectionChange = useEffectEvent(() => {
    clearTimeout(timers.current.word);
    if (typeof doc === "string" || doc == null || !writable) {
      return;
    }
    const sel = window.getSelection();
    const selected = sel?.toString() ?? "";
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !isWord(selected)) {
      timers.current.word = window.setTimeout(() => setWord(null), KEEP_WORD_MS);
      return;
    }
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-block]");
    const block = el && doc.blocks.find((b) => String(b.id) === el.dataset.block);
    if (!el || !block || !TRANSLATABLE.has(block.kind)) {
      setWord(null);
      return;
    }
    const ps = blockPieces(block);
    const language = translatedSentences(
      [{ id: block.id, text: block.text, pieces: ps }],
      mode,
      translatedShare(percent, doc.target_language, t.lang),
      doc.article.original_url,
    );
    const shown = (i: number) => language.has(`${block.id}:${i}`) !== flipped.has(`${block.id}:${i}`);
    const before = document.createRange();
    before.setStart(el, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const capture = captureIn(shownText(block.text, ps, shown), selected, before.toString().length);
    setWord(
      capture && {
        ...capture,
        article_id: doc.article.id,
        block_id: block.id,
        url: /^https?:/i.test(doc.article.original_url) ? doc.article.original_url : null,
      },
    );
  });
  useEffect(() => {
    document.addEventListener("selectionchange", onSelectionChange);
    const running = timers.current;
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      clearTimeout(running.word);
      clearTimeout(running.taken);
    };
  }, []);

  if (typeof doc === "string" || doc == null) {
    return (
      <>
        {toolbar}
        <main className="m-empty">
          {doc === "loading" && <p>{t("mobile.loading")}</p>}
          {doc === "no-token" && <p>{t("mobile.noToken")}</p>}
          {doc == null && <p>{t("mobile.gone")}</p>}
          {doc === "failed" && (
            <>
              <p role="alert">{t("mobile.loadFailed")}</p>
              <button className="btn" onClick={() => void load()}>
                {t("mobile.retry")}
              </button>
            </>
          )}
        </main>
      </>
    );
  }

  const { blocks } = doc;
  const a = withOps(row ?? doc.article, ops);
  const markers = listMarkers(blocks);
  const pieces = new Map(blocks.map((b) => [b.id, blockPieces(b)]));
  const selected = translatedSentences(
    blocks.map((b) => ({ id: b.id, text: b.text, pieces: pieces.get(b.id)! })),
    mode,
    translatedShare(percent, doc.target_language, t.lang),
    a.original_url,
  );
  const shownKey = (b: StoredBlock) =>
    pieces
      .get(b.id)!
      .map((_, i) => (selected.has(`${b.id}:${i}`) !== flipped.has(`${b.id}:${i}`) ? "1" : "0"))
      .join("");
  const flip = (block: number, piece: number) =>
    setFlipped((old) => {
      const next = new Set(old);
      const key = `${block}:${piece}`;
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  const nothing = nothingToTranslate(blocks, doc.target_language);
  const untranslated = mode !== "original" && !nothing && blocks.length > 0 && !blocks.some((b) => b.translation != null);

  return (
    <>
      {toolbar}
      <main className="m-article">
        <h1>{a.title ?? a.original_url}</h1>
        <p className="m-meta">
          {/^https?:/i.test(a.original_url) && (
            <a href={a.original_url} target="_blank" rel="noopener noreferrer">
              {a.site_name || a.domain}
            </a>
          )}
        </p>
        {writable && (
          <div className="m-actions">
            <button className="btn" aria-pressed={a.favorite} onClick={() => submit({ kind: "set_favorite", article_id: a.id, favorite: !a.favorite })}>
              {a.favorite ? t("mobile.unfavorite") : t("mobile.favorite")}
            </button>
            <button className="btn" onClick={() => submit({ kind: "set_read", article_id: a.id, read: a.read_status !== "read" })}>
              {a.read_status === "read" ? t("mobile.markUnread") : t("mobile.markRead")}
            </button>
          </div>
        )}
        {unsent > 0 && <p className="m-note">{t("mobile.pending", { n: unsent })}</p>}
        {doc.summary && (
          <details className="m-summary">
            <summary>{t("mobile.summary")}</summary>
            {doc.summary.stale && <p className="m-note">{t("reader.summaryStale")}</p>}
            <p>{doc.summary.text}</p>
          </details>
        )}
        {untranslated && <p className="m-note">{t("mobile.notTranslated")}</p>}
        {mode !== "original" && nothing && <p className="m-note">{t(nothing)}</p>}
        {blocks.length === 0 && <p className="m-note">{t("mobile.noText")}</p>}
        <OpenLink.Provider value={openLink}>
          {blocks.map((b, i) => (
            <MobileBlock key={b.id} block={b} pieces={pieces.get(b.id)!} shownKey={shownKey(b)} marker={markers[i]} onFlip={flip} />
          ))}
        </OpenLink.Provider>
      </main>
      {word && (
        <div className="m-word">
          <button
            className="btn pri"
            onPointerDown={() => clearTimeout(timers.current.word)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              submit({ kind: "vocab_add", capture: word });
              setWord(null);
              // Or the selection would offer the same word again.
              window.getSelection()?.removeAllRanges();
              setWordTaken(true);
              clearTimeout(timers.current.taken);
              timers.current.taken = window.setTimeout(() => setWordTaken(false), WORD_TAKEN_MS);
            }}
          >
            {t("vocab.save")}: {word.surface}
          </button>
        </div>
      )}
      {wordTaken && !word && (
        <div className="m-word" role="status">
          <span className="m-word-taken">{t("mobile.wordTaken")}</span>
        </div>
      )}
    </>
  );
}
