import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ChatMessage, type ChatThread, type Citation } from "../api";
import { OPEN_ALL, type OpenDoc, openKey, scopeOf, splitCitations } from "./chat";
import { type FilterGroup, parseFilterKey } from "../library/scopes";
import { FilterOptgroups } from "../library/FilterOptgroups";
import { Menu } from "../ui/Popover";
import { Icon, Kbd } from "../ui/Icon";
import { initialVim, vimEnabled, vimKey } from "./vim";
import { onMiddle } from "../lib/middle";
import { useT, type PlainKey } from "../i18n";

const MODE_LABEL = { full: "chatPane.modeFull", retrieval: "chatPane.modeRetrieval", none: null } as const satisfies Record<string, PlainKey | null>;

/** `newTab`: Ctrl / middle click. */
type OnCite = (c: Citation, newTab: boolean) => void;

/** Click props for a citation: Ctrl / middle click opens it in a new tab, as in the list. */
const citeClick = (c: Citation, onCite: OnCite) => ({
  onClick: (e: React.MouseEvent) => onCite(c, e.ctrlKey || e.metaKey),
  ...onMiddle(() => onCite(c, true)),
});

function Cite({ c, onCite }: { c: Citation; onCite: OnCite }) {
  const t = useT();
  const where = `${c.title}${c.heading ? ` › ${c.heading}` : ""}`;
  return (
    <button className="cite" {...citeClick(c, onCite)} title={where} aria-label={t("chatPane.cite", { n: c.n, where })}>
      {c.n}
    </button>
  );
}

// The answer is model output over untrusted pages: rendered as text nodes only, never as HTML.
function Answer({ m, onCite }: { m: ChatMessage; onCite: OnCite }) {
  const t = useT();
  const byN = new Map(m.citations.map((c) => [c.n, c]));
  return (
    <div className="answer">
      {/* Mode "none": no sources in scope, and the answer is the backend's coded message. */}
      <p>
        {splitCitations(m.mode === "none" ? t.msg(m.answer) : m.answer, new Set(byN.keys())).map((p, i) =>
          typeof p === "string" ? p : <Cite key={i} c={byN.get(p.n)!} onCite={onCite} />,
        )}
      </p>
      {m.citations.length > 0 && (
        <ol className="sources">
          {m.citations.map((c) => (
            <li key={c.n}>
              <Cite c={c} onCite={onCite} />
              <button className="source" {...citeClick(c, onCite)}>
                <span className="source-title">
                  {c.title}
                  {c.heading && ` › ${c.heading}`}
                </span>
                <span className="source-text">{c.text}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="answer-meta">
        {m.model && <span>{m.model}</span>}
        {MODE_LABEL[m.mode] && <span>{t(MODE_LABEL[m.mode]!)}</span>}
        {m.citations.length > 0 && <span>{t("chatPane.citations", { length: m.citations.length })}</span>}
      </div>
    </div>
  );
}

/** Right dock: chat over saved articles. `article` is the one open in the Reader or page view. */
export function ChatPane({
  article,
  open,
  groups,
  current,
  request,
  onCite,
  onClose,
  onPopOut,
  onPopIn,
}: {
  article: { id: number; title: string } | null;
  /** The saved articles open in tabs, in this window and the document windows. */
  open: OpenDoc[];
  groups: FilterGroup[];
  /** The list's current scope as a chat scope option (filterKey + label); null when it is 全記事. */
  current: { key: string; label: string } | null;
  /** A scope chosen from outside (Reader 質問, palette); `seq` re-applies the same key. */
  request: { key: string; seq: number } | null;
  onCite: OnCite;
  onClose: () => void;
  /** Main window only: moves the dock to its own window (G52). */
  onPopOut?: () => void;
  /** Chat window only: docks the pane back into the main window. */
  onPopIn?: () => void;
}) {
  const t = useT();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [scopeKey, setScopeKey] = useState(request?.key ?? (article ? "article" : "all"));
  const [picked, setPicked] = useState(request != null);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vimOn, setVimOn] = useState(vimEnabled);
  const [vim, setVim] = useState(initialVim);
  // Where a Vim command left the cursor, applied once React has rendered the new text.
  const [cursor, setCursor] = useState<{ at: number; end: number } | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const normal = vimOn && vim.mode === "normal";

  const fail = (e: unknown) => setError(String(e));
  const loadThreads = () => api.chatThreads().then(setThreads).catch(fail);
  useEffect(() => {
    api
      .chatThreads()
      .then(setThreads)
      .catch((e: unknown) => setError(String(e)));
  }, []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- new turns are drawn below: follow them
  }, [messages, pending]);
  const [requestSeq, setRequestSeq] = useState(request?.seq);
  if (request && request.seq !== requestSeq) {
    setRequestSeq(request.seq);
    setPicked(true);
    setScopeKey(request.key);
  }
  useEffect(() => {
    if (requestSeq != null) {
      input.current?.focus();
    }
  }, [requestSeq]);
  // The chat window learns the current article after it mounts: take it while the user has not picked a scope.
  const hasArticle = article != null;
  const [hadArticle, setHadArticle] = useState(hasArticle);
  if (hasArticle !== hadArticle) {
    setHadArticle(hasArticle);
    if (hasArticle && !picked && scopeKey === "all") {
      setScopeKey("article");
    }
  }
  // A picked article whose tab closed: the scope widens to what is still open.
  if (scopeKey.startsWith("open:") && !open.some((d) => openKey(d.id) === scopeKey)) {
    setScopeKey(open.length ? OPEN_ALL : "all");
  }
  useLayoutEffect(() => {
    if (cursor) {
      input.current?.setSelectionRange(cursor.at, cursor.end);
    }
  }, [cursor]);

  async function openThread(id: number | null) {
    setError(null);
    setThreadId(id);
    setMessages(
      id == null
        ? []
        : await api.chatMessages(id).catch((e: unknown) => {
            fail(e);
            return [];
          }),
    );
  }

  async function removeThread() {
    if (threadId == null) {
      return;
    }
    try {
      await api.chatDeleteThread(threadId);
      await Promise.all([openThread(null), loadThreads()]);
    } catch (e) {
      fail(e);
    }
  }

  const scope = () => scopeOf(scopeKey, article, open);

  async function ask(e: React.SyntheticEvent) {
    e.preventDefault();
    const q = question.trim();
    const s = scope();
    if (!q || !s || pending) {
      return;
    }
    setPending(q);
    setQuestion("");
    setVim(initialVim());
    setError(null);
    try {
      const m = await api.chatAsk(threadId, q, s);
      setThreadId(m.thread_id);
      setMessages((ms) => [...ms, m]);
      void loadThreads();
    } catch (e) {
      fail(e);
      setQuestion(q);
    }
    setPending(null);
  }

  const title = threads.find((t) => t.id === threadId)?.title ?? t("chatPane.newChat");
  const last = messages[messages.length - 1];
  return (
    <>
      <aside className="chat" aria-label={t("common.chat")} data-pane="chat">
        <header className="chat-h">
          <Menu
            className="thread-btn"
            menuClass="threads"
            label={t("chatPane.pickThread")}
            title={t("chatPane.saved")}
            trigger={
              <>
                <span className="thread-title">{title}</span>
                <Icon name="down" />
              </>
            }
            items={[
              { label: t("chatPane.newChat"), onSelect: () => void openThread(null), checked: threadId == null, disabled: !!pending },
              ...(threads.length ? [t("chatPane.savedGroup")] : []),
              ...threads.map((t) => ({ label: t.title, onSelect: () => void openThread(t.id), checked: t.id === threadId, disabled: !!pending })),
              "-",
              { label: t("chatPane.deleteThread"), onSelect: () => void removeThread(), disabled: !!pending || threadId == null },
            ]}
          />
          <span className="muted saved">{t("chatPane.savedCount", { length: threads.length })}</span>
          <button
            className="ib push"
            onClick={() => openThread(null)}
            disabled={!!pending || threadId == null}
            aria-label={t("chatPane.newChat")}
            title={t("chatPane.newChat")}
          >
            <Icon name="plus" />
          </button>
          {onPopOut && (
            <button className="ib" onClick={onPopOut} aria-label={t("chatPane.popOut")} title={t("chatPane.popOut")}>
              <Icon name="popout" />
            </button>
          )}
          {onPopIn && (
            <button className="ib" onClick={onPopIn} aria-label={t("chatPane.popIn")} title={t("chatPane.popIn")}>
              <Icon name="popin" />
            </button>
          )}
          <button className="ib" onClick={onClose} aria-label={t("chatPane.close")} title={t("common.close")}>
            <Icon name="x" />
          </button>
        </header>
        <div className="chat-scope">
          {t("chatPane.scope")}
          <label className="chip scope-chip">
            <select
              value={scopeKey}
              onChange={(e) => {
                setPicked(true);
                setScopeKey(e.target.value);
              }}
              aria-label={t("chatPane.scopeLabel")}
            >
              <option value="article" disabled={!article}>
                {t("chatPane.thisArticle")}
                {article ? t("chatPane.articleTitle", { title: article.title }) : t("chatPane.noArticle")}
              </option>
              <option value={OPEN_ALL} disabled={open.length === 0}>
                {t("chatPane.allOpen", { n: open.length })}
              </option>
              <option value="all">{t("chatPane.allArticles")}</option>
              {current && (
                <option value={current.key}>
                  {parseFilterKey(current.key).kind === "group"
                    ? t("chatPane.thisGroup", { label: current.label })
                    : t("chatPane.currentList", { label: current.label })}
                </option>
              )}
              {open.length > 0 && (
                <optgroup label={t("chatPane.openGroup")}>
                  {open.map((d) => (
                    <option key={d.id} value={openKey(d.id)}>
                      {d.title}
                    </option>
                  ))}
                </optgroup>
              )}
              <FilterOptgroups groups={groups} />
            </select>
            <Icon name="down" size="sm" />
          </label>
          {last && MODE_LABEL[last.mode] && <span className="push">{t(MODE_LABEL[last.mode]!)}</span>}
        </div>
        <div className="chat-log" ref={log}>
          {messages.length === 0 && !pending && <p className="muted chat-hint">{t("chatPane.intro")}</p>}
          {messages.map((m) => (
            <div key={m.id} className="turn">
              <p className="question">{m.question}</p>
              <Answer m={m} onCite={onCite} />
            </div>
          ))}
          {pending && (
            <div className="turn">
              <p className="question">{pending}</p>
              <p className="pending" role="status">
                <span className="dot" />
                {t("chatPane.answering")}
              </p>
            </div>
          )}
          {error && (
            <p className="error-text" role="alert">
              {t.msg(error)}
            </p>
          )}
        </div>
        <form className="chat-f" onSubmit={ask}>
          <label className="vh" htmlFor="chat-q">
            {t("chatPane.question")}
          </label>
          <textarea
            id="chat-q"
            ref={input}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            placeholder={scopeKey === "article" || scopeKey.startsWith("open:") ? t("chatPane.askArticle") : t("chatPane.askSaved")}
            readOnly={normal}
            onFocus={() => setVimOn(vimEnabled())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                return void ask(e);
              }
              if (!vimOn || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) {
                return;
              }
              const t = e.currentTarget;
              const r = vimKey(vim, { text: t.value, cursor: t.selectionStart }, e.key);
              if (!r.handled) {
                return;
              }
              e.preventDefault();
              setVim(r.vim);
              setQuestion(r.buf.text);
              // Normal mode selects the character under the cursor, drawn like Vim's block cursor.
              setCursor({ at: r.buf.cursor, end: r.vim.mode === "normal" ? Math.min(r.buf.cursor + 1, r.buf.text.length) : r.buf.cursor });
            }}
          />
          <div className="chat-f-row">
            {vimOn && (
              <span className={`bd vim-mode${normal ? " run" : ""}`} aria-live="polite" title={t("chatPane.vimMode")}>
                {normal ? "NORMAL" : "INSERT"}
                {vim.pending && ` ${vim.pending}`}
              </span>
            )}
            <span className="push">
              <Kbd>Ctrl</Kbd>
              <Kbd>Enter</Kbd>
              {t("chatPane.hintSend")}
            </span>
            <button type="submit" className="btn sm pri" disabled={!question.trim() || !!pending || !scope()}>
              {pending ? t("chatPane.sending") : t("chatPane.send")}
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
