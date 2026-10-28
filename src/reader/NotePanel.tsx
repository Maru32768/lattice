import { useEffect, useEffectEvent, useRef, useState } from "react";
import { api, type ArticleView } from "../api";
import { Icon } from "../ui/Icon";
import "../quiz/quiz.css";
import { useT } from "../i18n";

/** Typing pauses this long before the memo is saved. */
const SAVE_MS = 800;

// Saving does not reload the article view (it would reload the library too), so the text saved
// this session outlives the view's `note` here, by article id.
// shortcut: another window keeps the memo it loaded until its article view is reloaded.
const saved = new Map<number, string>();
/** Saves run one at a time, in typing order: two in flight could land out of order and keep the older text. */
let queue: Promise<unknown> = Promise.resolve();

const noteOf = (view: ArticleView) => saved.get(view.article.id) ?? view.note ?? "";
/** Whether the article has a memo: the toolbar marks メモ. */
export const hasNote = (view: ArticleView) => noteOf(view).trim() !== "";

/** メモ beside the Reader: the user's plain-text note on the article, saved as they type. */
export function NotePanel({ view, onClose }: { view: ArticleView; onClose: () => void }) {
  const t = useT();
  const id = view.article.id;
  const [text, setText] = useState(() => noteOf(view));
  const [status, setStatus] = useState<"saving" | "saved" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef(0);
  /** Text typed but not yet sent. */
  const pending = useRef<string | null>(null);

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
          saved.set(id, body);
          setStatus("saved");
        },
        (e: unknown) => {
          setStatus(null);
          setError(String(e));
        },
      );
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
        <button className="ib push" onClick={onClose} aria-label={t("notePanel.close")} title={t("common.close")}>
          <Icon name="x" />
        </button>
      </div>
      <textarea
        className="note-text"
        value={text}
        autoFocus
        spellCheck={false}
        placeholder={t("notePanel.placeholder")}
        aria-label={t("notePanel.title")}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
          setStatus(null);
          pending.current = e.target.value;
          clearTimeout(timer.current);
          timer.current = window.setTimeout(flush, SAVE_MS);
        }}
        onBlur={flush}
      />
      {error && (
        <p className="qz-note error-text note-error" role="alert">
          {t.msg(error)}
        </p>
      )}
    </aside>
  );
}
