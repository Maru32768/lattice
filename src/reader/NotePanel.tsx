import { Suspense, useEffect, useEffectEvent, useRef, useState } from "react";
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
/** Each article's open panel, for a failure that comes in after a pane swap: the panel that sent the save may be gone by then. */
const panels = new Map<number, (error: string, body: string) => void>();
/** Saves run one at a time, in typing order: two in flight could land out of order and keep the older text. */
let queue: Promise<unknown> = Promise.resolve();

const noteOf = (view: ArticleView) => typedText.get(view.article.id) ?? view.note ?? "";
/** Whether the article has a memo: the toolbar marks メモ. */
export const hasNote = (view: ArticleView) => noteOf(view).trim() !== "";

/** メモ beside the Reader: the user's plain-text note on the article, saved as they type. */
export function NotePanel({ view, onClose }: { view: ArticleView; onClose: () => void }) {
  const t = useT();
  const id = view.article.id;
  const [text, setText] = useState(() => noteOf(view));
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
    if (body == null) {
      return;
    }
    pending.current = null;
    setStatus("saving");
    queue = queue
      .then(() => api.setArticleNote(id, body))
      .then(
        () => {
          failedSaves.delete(id);
          setStatus("saved");
          setError(null);
        },
        (e: unknown) => {
          failedSaves.set(id, String(e));
          panels.get(id)?.(String(e), body);
        },
      );
  };
  const saveFailed = useEffectEvent((message: string, body: string) => {
    // The next way out (a blur, `:w`, closing) tries again. Only the newest text: an older one would overwrite what is queued or saved after it.
    if (typedText.get(id) === body && pending.current === null) {
      pending.current = body;
    }
    setStatus(null);
    setError(message);
  });
  useEffect(() => {
    panels.set(id, (message, body) => saveFailed(message, body));
    return () => void panels.delete(id);
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
            className="note-text vim-editor"
            initial={text}
            label={t("notePanel.title")}
            placeholder={t("notePanel.placeholder")}
            autoFocus
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
