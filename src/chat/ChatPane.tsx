import { Suspense, useEffect, useRef, useState } from "react";
import { api, type ChatMessage, type ChatThread, type Citation } from "../api";
import { OPEN_ALL, type OpenDoc, openKey, scopeOf, splitCitations, withQuote } from "./chat";
import { type FilterGroup, parseFilterKey } from "../library/scopes";
import { FilterOptgroups } from "../library/FilterOptgroups";
import { Menu } from "../ui/Popover";
import { Icon, Kbd } from "../ui/Icon";
import { VimEditor, VimMode, useVimEnabled } from "../vim/vim";
import { onMiddle } from "../lib/middle";
import { useLatest } from "../lib/useLatest";
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
  /** A scope chosen from outside (Reader 質問, palette); `seq` re-applies the same key. `quote` goes into the input, for the user to ask about. */
  request: { key: string; seq: number; quote?: string } | null;
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
  const [question, setQuestion] = useState(request?.quote ? withQuote("", request.quote) : "");
  const [pending, setPending] = useState<string | null>(null);
  /** The question of a failed send that found a new draft in the input: the log keeps it to copy from. */
  const [unsent, setUnsent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const vimOn = useVimEnabled();
  const [vimMode, setVimMode] = useState("INSERT");
  /** `seq` grows when the question is set from here: the Vim editor starts over on the new text, in insert mode. `focus`: it takes the keyboard. */
  const [editor, setEditor] = useState({ seq: 0, focus: request != null });
  const latestQuestion = useLatest(question);
  const log = useRef<HTMLDivElement>(null);

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
    if (request.quote) {
      setQuestion(withQuote(question, request.quote));
    }
    setEditor({ seq: editor.seq + (request.quote ? 1 : 0), focus: true });
  }
  useEffect(() => {
    if (requestSeq != null) {
      document.getElementById("chat-q")?.focus();
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

  /** Grows with each thread pick: a slower load for an earlier pick must not land under the later one. */
  const openSeq = useRef(0);
  async function openThread(id: number | null) {
    const seq = ++openSeq.current;
    setError(null);
    setUnsent(null);
    setThreadId(id);
    const ms =
      id == null
        ? []
        : await api.chatMessages(id).catch((e: unknown) => {
            fail(e);
            return [];
          });
    if (seq === openSeq.current) {
      setMessages(ms);
    }
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

  async function ask(text: string) {
    const q = text.trim();
    const s = scope();
    if (!q || !s || pending) {
      return;
    }
    setPending(q);
    setQuestion("");
    setEditor((e) => ({ seq: e.seq + 1, focus: true }));
    setError(null);
    setUnsent(null);
    try {
      const m = await api.chatAsk(threadId, q, s);
      setThreadId(m.thread_id);
      setMessages((ms) => [...ms, m]);
      void loadThreads();
    } catch (e) {
      fail(e);
      if (latestQuestion.current.trim()) {
        setUnsent(q);
      } else {
        setQuestion(q);
        // The failure can come long after the send, with the keyboard gone elsewhere.
        const inInput = document.activeElement?.id === "chat-q";
        setEditor((ed) => ({ seq: ed.seq + 1, focus: inInput }));
      }
    }
    setPending(null);
  }

  const title = threads.find((t) => t.id === threadId)?.title ?? t("chatPane.newChat");
  const last = messages[messages.length - 1];
  const askHint = scopeKey === "article" || scopeKey.startsWith("open:") ? t("chatPane.askArticle") : t("chatPane.askSaved");
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
          {messages.length === 0 && !pending && !unsent && <p className="muted chat-hint">{t("chatPane.intro")}</p>}
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
          {unsent && (
            <div className="turn">
              <p className="question">{unsent}</p>
            </div>
          )}
          {error && (
            <p className="error-text" role="alert">
              {t.msg(error)}
            </p>
          )}
        </div>
        <form
          className="chat-f"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <label className="vh" htmlFor="chat-q">
            {t("chatPane.question")}
          </label>
          {vimOn ? (
            <Suspense fallback={<div className="vim-editor" />}>
              <VimEditor
                key={editor.seq}
                id="chat-q"
                className="vim-editor"
                initial={question}
                label={t("chatPane.question")}
                placeholder={askHint}
                autoFocus={editor.focus}
                onChange={setQuestion}
                onWrite={(text) => void ask(text)}
                onQuit={() => document.getElementById("chat-q")?.blur()}
                onMode={setVimMode}
              />
            </Suspense>
          ) : (
            <textarea
              id="chat-q"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              placeholder={askHint}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void ask(question);
                }
              }}
            />
          )}
          <div className="chat-f-row">
            {vimOn && <VimMode mode={vimMode} />}
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
