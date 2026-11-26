import { Suspense, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { api, type ArticleView } from "../api";
import { Icon } from "../ui/Icon";
import "../quiz/quiz.css";
import { useT } from "../i18n";
import { VimEditor, VimMode, useVimEnabled } from "../vim/vim";

/** Typing pauses this long before the memo is saved. */
const SAVE_MS = 800;

// Saving does not reload the article view (it would reload the library too), and a panel remounted by a pane
// swap comes up before the old one has flushed. So the text typed this session outlives the view's `note` here, by article id.
// shortcut: another window keeps the memo it loaded until its article view is reloaded.
const typedText = new Map<number, string>();
/**
 * The error of an article's last save that failed: its text is only in `typedText`, so the panel that comes up next says so and saves again.
 * shortcut: a failure after the panel closed shows only when it opens again, upgrade if saves ever fail for long.
 */
const failedSaves = new Map<number, string>();
/** The open panels, told how each save ended: the panel that sent it may be gone by then after a pane swap, and two panes can show one article. */
const panels = new Set<(id: number, error: string | null, body: string) => void>();
/** Told of text added to a memo from elsewhere (`addToNote`): the open panels show it, the toolbar marks メモ. */
const added = new Set<(id: number, body: string) => void>();
/** Saves run one at a time, in typing order: two in flight could land out of order and keep the older text. */
let queue: Promise<unknown> = Promise.resolve();

/** Saves after the saves before it; resolves to the error, or null. */
function save(id: number, body: string): Promise<string | null> {
  const ended = queue
    .then(() => api.setArticleNote(id, body))
    .then(
      () => {
        failedSaves.delete(id);
        panels.forEach((tell) => tell(id, null, body));
        return null;
      },
      (e: unknown) => {
        failedSaves.set(id, String(e));
        panels.forEach((tell) => tell(id, String(e), body));
        return String(e);
      },
    );
  queue = ended;
  return ended;
}

const noteOf = (view: ArticleView) => typedText.get(view.article.id) ?? view.note ?? "";
/** Whether the article has a memo: the toolbar marks メモ. */
export const useHasNote = (view: ArticleView) =>
  useSyncExternalStore(
    (f) => {
      added.add(f);
      return () => void added.delete(f);
    },
    () => noteOf(view).trim() !== "",
  );

/** Adds `text` to the end of the article's memo, after a blank line, and saves it. Resolves to the error of the save, or null. */
export function addToNote(view: ArticleView, text: string) {
  const id = view.article.id;
  const was = noteOf(view).trimEnd();
  const body = was ? `${was}\n\n${text}` : text;
  typedText.set(id, body);
  added.forEach((show) => show(id, body));
  return save(id, body);
}

/** メモ beside the Reader: the user's plain-text note on the article, saved as they type. */
export function NotePanel({ view, onClose }: { view: ArticleView; onClose: () => void }) {
  const t = useT();
  const id = view.article.id;
  const [text, setText] = useState(() => noteOf(view));
  /** How many times text added elsewhere has replaced it: the Vim editor takes its text only as it comes up. */
  const [shown, setShown] = useState(0);
  const [status, setStatus] = useState<"saving" | "saved" | null>(null);
  const [error, setError] = useState(() => failedSaves.get(id) ?? null);
  const vimOn = useVimEnabled();
  const [vimMode, setVimMode] = useState("INSERT");
  const timer = useRef(0);
  /** Text typed but not yet sent. */
  const pending = useRef(failedSaves.has(id) ? text : null);

  const flush = () => {
    clearTimeout(timer.current);
    const body = pending.current;
    pending.current = null;
    // Text held for a retry may be behind what another panel on this article has saved since.
    if (body == null || typedText.get(id) !== body) {
      return;
    }
    setStatus("saving");
    void save(id, body);
  };
  const saveEnded = useEffectEvent((message: string | null, body: string) => {
    setError(message);
    if (message === null) {
      setStatus("saved");
      return;
    }
    // The next way out (a blur, `:w`, closing) tries again. Only the newest text: an older one would overwrite what is queued or saved after it.
    if (typedText.get(id) === body) {
      pending.current = body;
    }
    setStatus(null);
  });
  useEffect(() => {
    const tell = (saved: number, message: string | null, body: string) => {
      if (saved === id) {
        saveEnded(message, body);
      }
    };
    panels.add(tell);
    return () => void panels.delete(tell);
  }, [id]);
  // What was typed and not yet sent is in the text added to, which is being saved.
  useEffect(() => {
    const show = (to: number, body: string) => {
      if (to === id) {
        clearTimeout(timer.current);
        pending.current = null;
        setText(body);
        setShown((n) => n + 1);
      }
    };
    added.add(show);
    return () => void added.delete(show);
  }, [id]);
  const typed = (value: string) => {
    typedText.set(id, value);
    setText(value);
    setError(null);
    setStatus(null);
    pending.current = value;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_MS);
  };
  // Closing the panel or leaving the article saves what was typed.
  const flushOnLeave = useEffectEvent(flush);
  useEffect(() => () => flushOnLeave(), []);

  return (
    <aside className="qz-panel note-panel" aria-label={t("notePanel.title")}>
      <div className="qz-h">
        <Icon name="note" />
        <span className="qz-title">{t("notePanel.title")}</span>
        <span className="qz-n" role="status">
          {status === "saving" ? t("notePanel.saving") : status === "saved" ? t("notePanel.saved") : ""}
        </span>
        {vimOn && <VimMode mode={vimMode} />}
        <button className="ib push" onClick={onClose} aria-label={t("notePanel.close")} title={t("common.close")}>
          <Icon name="x" />
        </button>
      </div>
      {vimOn ? (
        <Suspense fallback={<div className="note-text vim-editor" />}>
          <VimEditor
            key={shown}
            className="note-text vim-editor"
            initial={text}
            label={t("notePanel.title")}
            placeholder={t("notePanel.placeholder")}
            // Not as it comes up again: the text was added from a sticky, which keeps the keyboard.
            autoFocus={shown === 0}
            onChange={typed}
            onWrite={flush}
            onQuit={onClose}
            onMode={setVimMode}
            onBlur={flush}
          />
        </Suspense>
      ) : (
        <textarea
          className="note-text"
          value={text}
          autoFocus
          spellCheck={false}
          placeholder={t("notePanel.placeholder")}
          aria-label={t("notePanel.title")}
          onChange={(e) => typed(e.target.value)}
          onBlur={flush}
        />
      )}
      {error && (
        <p className="qz-note error-text note-error" role="alert">
          {t.msg(error)}
        </p>
      )}
    </aside>
  );
}
