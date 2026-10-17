import { useEffect, useRef, useState } from "react";
import { api, type ChatMessage, type ChatScope, type ChatThread, type Citation } from "./api";
import { splitCitations } from "./chat";
import { type FilterGroup, parseFilterKey } from "./scopes";
import { FilterOptgroups } from "./FilterOptgroups";

const MODE_LABEL = { full: "記事全文から回答", retrieval: "検索で選んだ関連箇所から回答", none: "" } as const;

function Chip({ c, onCite }: { c: Citation; onCite: (c: Citation) => void }) {
  const where = `${c.title}${c.heading ? ` › ${c.heading}` : ""}`;
  return <button className="cite" onClick={() => onCite(c)} title={where} aria-label={`出典 ${c.n}: ${where}`}>{c.n}</button>;
}

// The answer is model output over untrusted pages: rendered as text nodes only, never as HTML.
function Answer({ m, onCite }: { m: ChatMessage; onCite: (c: Citation) => void }) {
  const byN = new Map(m.citations.map((c) => [c.n, c]));
  return (
    <div className="chat-answer">
      <p>{splitCitations(m.answer, new Set(byN.keys())).map((p, i) =>
        typeof p === "string" ? p : <Chip key={i} c={byN.get(p.n)!} onCite={onCite} />)}</p>
      {m.citations.length > 0 && (
        <ol className="chat-sources">
          {m.citations.map((c) => (
            <li key={c.n}>
              <Chip c={c} onCite={onCite} />
              <button className="source" onClick={() => onCite(c)}>
                <span className="source-title">{c.title}{c.heading && ` › ${c.heading}`}</span>
                <span className="source-text">{c.text}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {MODE_LABEL[m.mode] && <span className="chat-meta">{MODE_LABEL[m.mode]}</span>}
    </div>
  );
}

/** Right-side chat over saved articles. `article` is the one open in the Reader or browser. */
export function ChatPane({ article, groups, onCite, onClose }: {
  article: { id: number; title: string } | null;
  groups: FilterGroup[];
  onCite: (c: Citation) => void;
  onClose: () => void;
}) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [scopeKey, setScopeKey] = useState(article ? "article" : "all");
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  const fail = (e: unknown) => setError(String(e));
  const loadThreads = () => api.chatThreads().then(setThreads).catch(fail);
  useEffect(() => { loadThreads(); }, []);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, pending]);

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
    setError(null);
    try {
      const m = await api.chatAsk(threadId, q, s);
      setThreadId(m.thread_id);
      setMessages((ms) => [...ms, m]);
      loadThreads();
    } catch (e) {
      fail(e);
      setQuestion(q);
    } finally {
      setPending(null);
    }
  }

  return (
    <aside className="chat" aria-label="記事への質問">
      <header className="chat-head">
        <select value={threadId ?? ""} disabled={!!pending} aria-label="会話"
          onChange={(e) => openThread(e.target.value ? Number(e.target.value) : null)}>
          <option value="">新しい会話</option>
          {threads.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        <button onClick={() => openThread(null)} disabled={!!pending || threadId == null}>新しい会話</button>
        <button onClick={removeThread} disabled={!!pending || threadId == null} title="この会話を削除">削除</button>
        <button onClick={onClose} aria-label="対話ペインを閉じる" title="閉じる">×</button>
      </header>
      <div className="chat-log" ref={log}>
        {messages.length === 0 && !pending && (
          <p className="chat-hint">保存した記事をもとに回答します。回答中の番号をクリックすると、根拠の箇所を開きます。</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className="chat-turn">
            <p className="chat-question">{m.question}</p>
            <Answer m={m} onCite={onCite} />
          </div>
        ))}
        {pending && (
          <div className="chat-turn">
            <p className="chat-question">{pending}</p>
            <p className="chat-pending" role="status">回答を生成しています…</p>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <form className="chat-form" onSubmit={ask}>
        <label className="chat-scope">
          範囲
          <select value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}>
            <option value="article" disabled={!article}>この記事{article ? `（${article.title}）` : "（記事を開いていません）"}</option>
            <option value="all">全記事</option>
            <FilterOptgroups groups={groups} />
          </select>
        </label>
        <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} placeholder="質問を入力（Ctrl+Enter で送信）"
          aria-label="質問" onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ask(e); }} />
        <button type="submit" disabled={!question.trim() || !!pending || !scope()}>{pending ? "回答中…" : "質問する"}</button>
      </form>
    </aside>
  );
}
