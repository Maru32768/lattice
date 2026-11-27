import { Suspense, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type ArticleView, type Note } from "../api";
import { Icon } from "../ui/Icon";
import "../quiz/quiz.css";
import { useT } from "../i18n";
import { VimEditor, VimMode, useVimEnabled } from "../vim/vim";

/** Typing pauses this long before the memo is saved. */
const SAVE_MS = 800;

/**
 * This window's copy of an article's memo: the text it shows, the stored memo that text was written from, and a newer one
 * another window saved while this one had text not yet saved (`theirs`), which the panel warns of.
 */
type Memo = { text: string; saved: Note; theirs: Note | null };
// Saving does not reload the article view (it would reload the library too), and a panel remounted by a pane
// swap comes up before the old one has flushed. So the copy outlives the view's `note` here, by article id.
const memos = new Map<number, Memo>();
/**
 * The error of an article's last save that failed: its text is only in `memos`, so the panel that comes up next says so and saves again.
 * shortcut: a failure after the panel closed shows only when it opens again, upgrade if saves ever fail for long.
 */
const failedSaves = new Map<number, string>();
/** The open panels, told how each save ended: the panel that sent it may be gone by then after a pane swap, and two panes can show one article. */
const panels = new Set<(id: number, error: string | null, body: string) => void>();
/** Told when a copy changes other than by typing in a panel (`addToNote`, another window's save): the panels show it or warn, the toolbar marks メモ. */
const changed = new Set<(id: number) => void>();
const tellChanged = (id: number) => changed.forEach((f) => f(id));
/** Saves and adds run one at a time, in order: two in flight could land out of order and keep the older text. */
let queue: Promise<unknown> = Promise.resolve();

const unsent = (memo: Memo) => memo.text !== memo.saved.body;

/** This window's copy, unless it has nothing unsent and the view was read after a save the copy has not heard of. */
function current(view: ArticleView): Memo {
  const id = view.article.id;
  const memo = memos.get(id);
  if (memo && (unsent(memo) || memo.theirs || view.note_revision <= memo.saved.revision)) {
    return memo;
  }
  const saved = { article_id: id, body: view.note ?? "", revision: view.note_revision };
  return { text: saved.body, saved, theirs: null };
}

function memoOf(view: ArticleView) {
  const memo = current(view);
  memos.set(view.article.id, memo);
  return memo;
}

/** Another window's save, or the memo one of this window's saves was refused for: shown when nothing here is unsent. */
function take(note: Note) {
  const memo = memos.get(note.article_id);
  if (memo && note.revision <= Math.max(memo.saved.revision, memo.theirs?.revision ?? 0)) {
    return;
  }
  if (!memo || !unsent(memo) || memo.text === note.body) {
    memos.set(note.article_id, { text: note.body, saved: note, theirs: null });
  } else {
    memo.theirs = note;
  }
  tellChanged(note.article_id);
}

// Every article's, not only those open: a panel that opens later starts from the copy here. Behind the saves on their
// way: the event of one can come before its answer, and is no news after it.
listen<Note>("note-changed", (e) => {
  queue = queue.then(() => take(e.payload));
}).catch(() => {});

/** Saves after the saves before it, from the revision they leave; resolves to the error, or null. */
function save(id: number, body: string): Promise<string | null> {
  const ended = queue
    .then(() => {
      const { saved } = memos.get(id)!;
      // Text added from a sticky saves what was typed before it, which the panel may have sent already.
      return body === saved.body ? null : api.setArticleNote(id, body, saved.revision);
    })
    .then(
      (r) => {
        failedSaves.delete(id);
        if (r) {
          const { kind, ...note } = r;
          if (kind === "saved") {
            memos.get(id)!.saved = note;
          } else {
            take(note);
          }
        }
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

/** The memo added to with `text` as stored (`append_article_note`), as this window's copy then stands. */
function added(note: Note, shown: string, based: boolean) {
  const memo = memos.get(note.article_id)!;
  if (memo.theirs) {
    take(note);
  } else if (note.body === shown) {
    memo.saved = note;
  } else if (memo.text === shown && based) {
    // The copy was behind a save it had not heard of yet.
    memos.set(note.article_id, { text: note.body, saved: note, theirs: null });
    tellChanged(note.article_id);
  } else {
    memo.theirs = note;
    tellChanged(note.article_id);
  }
}

/** Whether the article has a memo: the toolbar marks メモ. */
export const useHasNote = (view: ArticleView) =>
  useSyncExternalStore(
    (f) => {
      changed.add(f);
      return () => void changed.delete(f);
    },
    () => current(view).text.trim() !== "",
  );

/**
 * Adds `text` to the end of the article's memo as stored, after a blank line; the panels show it at once. Resolves to the
 * error, or null.
 */
export function addToNote(view: ArticleView, text: string) {
  const id = view.article.id;
  const memo = memoOf(view);
  const before = memo.text;
  if (unsent(memo) && !memo.theirs) {
    void save(id, before);
  }
  const was = before.trimEnd();
  const shown = was ? `${was}\n\n${text}` : text;
  memo.text = shown;
  tellChanged(id);
  const ended = queue
    .then(async () => {
      // The text before the add is stored, or behind what is: the memo the text goes after holds all of it then.
      const based = memos.get(id)!.saved.body === before;
      return { note: await api.appendArticleNote(id, text), based };
    })
    .then(
      ({ note, based }) => {
        failedSaves.delete(id);
        added(note, shown, based);
        panels.forEach((tell) => tell(id, null, shown));
        return null;
      },
      (e: unknown) => {
        failedSaves.set(id, String(e));
        panels.forEach((tell) => tell(id, String(e), shown));
        return String(e);
      },
    );
  queue = ended;
  return ended;
}

/** メモ beside the Reader: the user's plain-text note on the article, saved as they type. */
export function NotePanel({ view, onClose }: { view: ArticleView; onClose: () => void }) {
  const t = useT();
  const id = view.article.id;
  const [initial] = useState(() => memoOf(view));
  const [text, setText] = useState(initial.text);
  const [theirs, setTheirs] = useState(initial.theirs);
  /**
   * How many times the Vim editor came up again, and whether it takes the keyboard then: it takes its text only as it
   * comes up, and the keyboard only then.
   */
  const [shown, setShown] = useState({ n: 0, focus: true });
  const [status, setStatus] = useState<"saving" | "saved" | null>(null);
  const [error, setError] = useState(() => failedSaves.get(id) ?? null);
  const vimOn = useVimEnabled();
  const [vimMode, setVimMode] = useState("INSERT");
  const timer = useRef(0);
  const panel = useRef<HTMLElement>(null);
  /** Text typed but not yet sent. */
  const pending = useRef(failedSaves.has(id) ? text : null);

  const flush = () => {
    clearTimeout(timer.current);
    const body = pending.current;
    pending.current = null;
    const memo = memos.get(id)!;
    // Text held for a retry may be behind what another panel on this article has saved since, and nothing saves over a newer memo the panel warns of.
    if (body == null || memo.text !== body || memo.theirs) {
      return;
    }
    setStatus("saving");
    void save(id, body);
  };
  const saveEnded = useEffectEvent((message: string | null, body: string) => {
    setError(message);
    if (message === null) {
      setStatus(memos.get(id)!.theirs ? null : "saved");
      return;
    }
    // The next way out (a blur, `:w`, closing) tries again. Only the newest text: an older one would overwrite what is queued or saved after it.
    if (memos.get(id)!.text === body) {
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
  // Nothing waiting to be sent is lost: text added to has it and saves it first, another window's save replaces only
  // text with nothing unsent, and loading the saved memo drops it on purpose.
  const onChanged = useEffectEvent(() => {
    const memo = memos.get(id)!;
    setTheirs(memo.theirs);
    if (memo.theirs) {
      setStatus(null);
    }
    if (memo.text !== text) {
      clearTimeout(timer.current);
      pending.current = null;
      setText(memo.text);
      // Where the keyboard was: text added from a sticky leaves it there.
      const focus = panel.current?.contains(document.activeElement) ?? false;
      setShown((s) => ({ n: s.n + 1, focus }));
    }
  });
  useEffect(() => {
    const show = (to: number) => {
      if (to === id) {
        onChanged();
      }
    };
    changed.add(show);
    return () => void changed.delete(show);
  }, [id]);
  const typed = (value: string) => {
    memos.get(id)!.text = value;
    setText(value);
    setError(null);
    setStatus(null);
    pending.current = value;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_MS);
  };
  // The buttons go with the warning, so the keyboard goes back to the editor. Keeping this window's text leaves the editor as
  // it is: made again, Vim would lose its undo.
  const focusEditor = () => panel.current?.querySelector<HTMLElement>('textarea, [role="textbox"]')?.focus();
  const keepMine = () => {
    const memo = memos.get(id)!;
    focusEditor();
    if (memo.theirs) {
      memo.saved = memo.theirs;
      memo.theirs = null;
      tellChanged(id);
      setStatus("saving");
      void save(id, memo.text);
    }
  };
  const loadSaved = () => {
    const memo = memos.get(id)!;
    focusEditor();
    if (memo.theirs) {
      memos.set(id, { text: memo.theirs.body, saved: memo.theirs, theirs: null });
      failedSaves.delete(id);
      setError(null);
      tellChanged(id);
    }
  };
  // Closing the panel or leaving the article saves what was typed.
  const flushOnLeave = useEffectEvent(flush);
  useEffect(() => () => flushOnLeave(), []);

  return (
    <aside ref={panel} className="qz-panel note-panel" aria-label={t("notePanel.title")}>
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
      {theirs && (
        <div className="note-newer" role="alert">
          <p className="qz-note">{t("notePanel.newer")}</p>
          <div>
            <button className="btn sm" onClick={keepMine}>
              {t("notePanel.keepMine")}
            </button>
            <button className="btn sm" onClick={loadSaved}>
              {t("notePanel.loadSaved")}
            </button>
          </div>
        </div>
      )}
      {vimOn ? (
        <Suspense fallback={<div className="note-text vim-editor" />}>
          <VimEditor
            key={shown.n}
            className="note-text vim-editor"
            initial={text}
            label={t("notePanel.title")}
            placeholder={t("notePanel.placeholder")}
            autoFocus={shown.focus}
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
