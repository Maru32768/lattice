import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ChatMessage, type ChatScope, type ChatThread, type Citation } from "./api";
import { splitCitations } from "./chat";
import { type FilterGroup, parseFilterKey } from "./scopes";
import { FilterOptgroups } from "./FilterOptgroups";
import { Menu } from "./Popover";
import { Icon, Kbd } from "./Icon";
import { initialVim, vimEnabled, vimKey } from "./vim";

const MODE_LABEL = { full: "記事全文から回答", retrieval: "検索で選んだ関連箇所から回答", none: "" } as const;

function Cite({ c, onCite }: { c: Citation; onCite: (c: Citation) => void }) {
  const where = `${c.title}${c.heading ? ` › ${c.heading}` : ""}`;
  return <button className="cite" onClick={() => onCite(c)} title={where} aria-label={`出典 ${c.n}: ${where}`}>{c.n}</button>;
}

// The answer is model output over untrusted pages: rendered as text nodes only, never as HTML.
function Answer({ m, onCite }: { m: ChatMessage; onCite: (c: Citation) => void }) {
  const byN = new Map(m.citations.map((c) => [c.n, c]));
  return (
    <div className="answer">
      <p>{splitCitations(m.answer, new Set(byN.keys())).map((p, i) =>
        typeof p === "string" ? p : <Cite key={i} c={byN.get(p.n)!} onCite={onCite} />)}</p>
      {m.citations.length > 0 && (
        <ol className="sources">
          {m.citations.map((c) => (
            <li key={c.n}>
              <Cite c={c} onCite={onCite} />
              <button className="source" onClick={() => onCite(c)}>
                <span className="source-title">{c.title}{c.heading && ` › ${c.heading}`}</span>
                <span className="source-text">{c.text}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="answer-meta">
        {m.model && <span>{m.model}</span>}
        {MODE_LABEL[m.mode] && <span>{MODE_LABEL[m.mode]}</span>}
        {m.citations.length > 0 && <span>引用 {m.citations.length}</span>}
      </div>
    </div>
  );
}

/** Right dock: chat over saved articles. `article` is the one open in the Reader or page view. */
export function ChatPane({ article, groups, current, request, onCite, onClose }: {
  article: { id: number; title: string } | null;
  groups: FilterGroup[];
  /** The list's current scope as a chat scope option (filterKey + label); null when it is 全記事. */
  current: { key: string; label: string } | null;
  /** A scope chosen from outside (Reader 質問, palette); `seq` re-applies the same key. */
  request: { key: string; seq: number } | null;
  onCite: (c: Citation) => void;
  onClose: () => void;
}) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [scopeKey, setScopeKey] = useState(request?.key ?? (article ? "article" : "all"));
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vimOn, setVimOn] = useState(vimEnabled);
  const [vim, setVim] = useState(initialVim);
  // Where a Vim command left the cursor, applied once React has rendered the new text.
  const [cursor, setCursor] = useState<{ at: number } | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const normal = vimOn && vim.mode === "normal";

  const fail = (e: unknown) => setError(String(e));
  const loadThreads = () => api.chatThreads().then(setThreads).catch(fail);
  useEffect(() => { void loadThreads(); }, []);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, pending]);
  useEffect(() => {
    if (!request) return;
    setScopeKey(request.key);
    input.current?.focus();
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- a request applies once per seq
  }, [request?.seq]);
  useLayoutEffect(() => {
    const t = input.current;
    // Normal mode selects the character under the cursor, drawn like Vim's block cursor.
    if (cursor && t) t.setSelectionRange(cursor.at, normal ? Math.min(cursor.at + 1, t.value.length) : cursor.at);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- a command's cursor applies once
  }, [cursor]);

  async function openThread(id: number | null) {
    setError(null);
    setThreadId(id);
    setMessages(id == null ? [] : await api.chatMessages(id).catch((e) => { fail(e); return []; }));
  }

  async function removeThread() {
    if (threadId == null) return;
    try {
      await api.chatDeleteThread(threadId);
      await Promise.all([openThread(null), loadThreads()]);
    } catch (e) {
      fail(e);
    }
  }

  function scope(): ChatScope | null {
    if (scopeKey === "article") return article && { kind: "article", id: article.id };
    return { kind: "filter", filter: scopeKey === "all" ? { kind: "all" } : parseFilterKey(scopeKey) };
  }

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    const s = scope();
    if (!q || !s || pending) return;
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
    } finally {
      setPending(null);
    }
  }

  const title = threads.find((t) => t.id === threadId)?.title ?? "新しい会話";
  const last = messages[messages.length - 1];
  return (
    <>
      <aside className="chat" aria-label="対話" data-pane="chat">
        <header className="chat-h">
          <Menu className="thread-btn" label="会話を選ぶ" title="保存済みの会話" trigger={<><span className="thread-title">{title}</span><Icon name="down" /></>}
            items={[
              { label: "新しい会話", onSelect: () => void openThread(null), checked: threadId == null, disabled: !!pending },
              ...(threads.length ? ["保存済み"] : []),
              ...threads.map((t) => ({ label: t.title, onSelect: () => void openThread(t.id), checked: t.id === threadId, disabled: !!pending })),
              "-",
              { label: "この会話を削除", onSelect: () => void removeThread(), disabled: !!pending || threadId == null },
            ]} />
          <span className="muted saved">保存済み {threads.length} 件</span>
          <button className="ib push" onClick={() => openThread(null)} disabled={!!pending || threadId == null} aria-label="新しい会話" title="新しい会話"><Icon name="plus" /></button>
          <button className="ib" onClick={onClose} aria-label="対話ペインを閉じる" title="閉じる"><Icon name="x" /></button>
        </header>
        <div className="chat-scope">
          範囲
          <label className="chip scope-chip">
            <select value={scopeKey} onChange={(e) => setScopeKey(e.target.value)} aria-label="質問の範囲">
              <option value="article" disabled={!article}>この記事{article ? `（${article.title}）` : "（記事を開いていません）"}</option>
              <option value="all">全記事</option>
              {current && <option value={current.key}>現在の一覧: {current.label}</option>}
              <FilterOptgroups groups={groups} />
            </select>
            <Icon name="down" size="sm" />
          </label>
          {last && MODE_LABEL[last.mode] && <span className="push">{MODE_LABEL[last.mode]}</span>}
        </div>
        <div className="chat-log" ref={log}>
          {messages.length === 0 && !pending && (
            <p className="muted chat-hint">保存した記事をもとに回答します。回答中の番号をクリックすると、根拠の箇所を開きます。</p>
          )}
          {messages.map((m) => (
            <div key={m.id} className="turn">
              <p className="question">{m.question}</p>
              <Answer m={m} onCite={onCite} />
            </div>
          ))}
          {pending && (
            <div className="turn">
              <p className="question">{pending}</p>
              <p className="pending" role="status"><span className="dot" />回答を生成しています…</p>
            </div>
          )}
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
        <form className="chat-f" onSubmit={ask}>
          <label className="vh" htmlFor="chat-q">質問</label>
          <textarea id="chat-q" ref={input} value={question} onChange={(e) => setQuestion(e.target.value)} rows={3}
            placeholder={scopeKey === "article" ? "この記事について質問…" : "保存した記事について質問…"}
            readOnly={normal} onFocus={() => setVimOn(vimEnabled())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return void ask(e);
              if (!vimOn || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
              const t = e.currentTarget;
              const r = vimKey(vim, { text: t.value, cursor: t.selectionStart }, e.key);
              if (!r.handled) return;
              e.preventDefault();
              setVim(r.vim);
              setQuestion(r.buf.text);
              setCursor({ at: r.buf.cursor });
            }} />
          <div className="chat-f-row">
            {vimOn && (
              <span className={`bd vim-mode${normal ? " run" : ""}`} aria-live="polite" title="Vim のモード">
                {normal ? "NORMAL" : "INSERT"}{vim.pending && ` ${vim.pending}`}
              </span>
            )}
            <span className="push"><Kbd>Ctrl</Kbd><Kbd>Enter</Kbd> 送信</span>
            <button type="submit" className="btn sm pri" disabled={!question.trim() || !!pending || !scope()}>{pending ? "回答中…" : "送信"}</button>
          </div>
        </form>
      </aside>
    </>
  );
}
