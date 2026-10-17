import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type ArticleRow, type FeedCandidate, type FeedRow } from "./api";
import { relTime } from "./time";
import "./manage.css";

const ADDED = "登録しました。新しい記事をバックグラウンドで取得します。";
const bare = (url: string) => url.replace(/^https?:\/\//, "");
const feedName = (f: FeedRow) => f.title ?? bare(f.url);

/** RSS / Atom subscriptions. Polling runs in the background every 30 minutes and at startup. */
export function FeedsView({ articles, onChanged, onShowFeed, initialUrl }: {
  articles: ArticleRow[];
  onChanged: () => void;
  onShowFeed: (id: number) => void;
  initialUrl?: string;
}) {
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [url, setUrl] = useState(initialUrl ?? "");
  const [candidates, setCandidates] = useState<FeedCandidate[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);

  const load = () => api.listFeeds().then(setFeeds).catch((e) => setError(String(e)));
  useEffect(() => {
    load();
    if (initialUrl?.trim()) detect(initialUrl);
    const sub = listen("feeds-changed", () => { load(); onChanged(); });
    return () => { sub.then((f) => f()); };
  }, []);

  async function run(task: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setStatus(await task());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      load();
      onChanged();
    }
  }

  // A site or article URL works too: the backend finds the feeds it links.
  const detect = (u: string) => run(async () => {
    setCandidates([]);
    const found = await api.discoverFeeds(u.trim());
    if (found.length === 0) throw "フィードが見つかりませんでした（ページにフィードへのリンクがなく、/feed などにもありません）";
    setCandidates(found);
    setPicked(found[0].url);
    return null;
  });

  const subscribe = () => {
    const c = candidates.find((x) => x.url === picked);
    if (c) run(async () => {
      await api.addFeed(c.url);
      const rest = candidates.filter((x) => x.url !== c.url);
      setCandidates(rest);
      setPicked(rest[0]?.url ?? null);
      if (rest.length === 0) setUrl("");
      return `${c.title ?? c.url} を${ADDED}`;
    });
  };

  // OPML: subscriptions are the outline elements' xmlUrl attributes.
  const importOpml = (file: File | undefined) => file && run(async () => {
    const urls = [...(await file.text()).matchAll(/xmlUrl\s*=\s*"([^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
    let ok = 0;
    const failed: string[] = [];
    for (const u of urls) {
      setStatus(`登録中… ${ok + failed.length + 1}/${urls.length}`);
      try {
        await api.addFeed(u);
        ok++;
      } catch {
        failed.push(u);
      }
    }
    return `${urls.length} 件中 ${ok} 件を登録${failed.length ? `・失敗: ${failed.join(", ")}` : ""}`;
  });

  const refreshAll = () => run(async () => `更新しました（${await api.refreshFeeds()} 件を取得キューに追加）`);

  async function remove(f: FeedRow) {
    setConfirming(null);
    try {
      await api.removeFeed(f.id);
    } catch (e) {
      setError(String(e));
    }
    load();
    onChanged();
  }

  const unread = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of articles) if (a.feed_id != null && a.read_status === "unread") m.set(a.feed_id, (m.get(a.feed_id) ?? 0) + 1);
    return m;
  }, [articles]);
  const newest = feeds.flatMap((f) => (f.last_fetched_at ? [f.last_fetched_at] : [])).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const errorCount = feeds.filter((f) => f.last_error).length;
  const needle = query.trim().toLowerCase();
  const shown = feeds.filter((f) => (!onlyErrors || f.last_error)
    && (!needle || `${f.title ?? ""} ${f.url} ${f.site_url ?? ""}`.toLowerCase().includes(needle)));

  return (
    <main className="manage">
      <div className="wrap">
        <header className="head">
          <div>
            <h1>フィードを管理</h1>
            <p className="sub">{feeds.length} 件 · 最終巡回 {relTime(newest)} · 起動時と 30 分ごとに新着のみ取得</p>
          </div>
          <div className="acts">
            <label className="btn lg">
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 19h16" /></svg>
              OPML を読み込む
              <input type="file" className="vh" accept=".opml,.xml" disabled={busy} onChange={(e) => importOpml(e.target.files?.[0])} />
            </label>
            <button className="btn lg" onClick={refreshAll} disabled={busy || feeds.length === 0}>
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2.1-5" /><path d="M19 4v4h-4" /></svg>
              すべて更新
            </button>
          </div>
        </header>

        <form className="card add" aria-label="フィードを追加" onSubmit={(e) => { e.preventDefault(); if (url.trim()) detect(url); }}>
          <label htmlFor="feed-url">サイトまたは記事の URL からフィードを検出</label>
          <div className="line">
            <input id="feed-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/ またはフィードの URL" spellCheck={false} />
            <button type="submit" className="btn pri lg" disabled={busy || !url.trim()}>検出</button>
          </div>
          {candidates.length > 0 && (
            <fieldset className="cands">
              <legend>候補が {candidates.length} 件見つかりました</legend>
              {candidates.map((c) => (
                <label key={c.url}>
                  <input type="radio" name="feed-candidate" checked={picked === c.url} onChange={() => setPicked(c.url)} />
                  <span>{c.title ?? bare(c.url)}</span>
                  {c.title && <span className="fs">{bare(c.url)}</span>}
                </label>
              ))}
              <div><button type="button" className="btn sm pri" onClick={subscribe} disabled={busy || !picked}>登録して最新 20 件を取り込む</button></div>
            </fieldset>
          )}
        </form>
        {status && <p role="status" className="msg muted">{status}</p>}
        {error && <p role="alert" className="msg error-text">{error}</p>}

        <div className="filter">
          <button className={`btn sm${onlyErrors ? "" : " on"}`} aria-pressed={!onlyErrors} onClick={() => setOnlyErrors(false)}>すべて {feeds.length}</button>
          <button className={`btn sm${onlyErrors ? " on" : ""}`} aria-pressed={onlyErrors} onClick={() => setOnlyErrors(true)}>エラー {errorCount}</button>
          <label htmlFor="feed-filter" className="vh">フィードを絞り込む</label>
          <input id="feed-filter" className="input sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="名前・ドメインで絞り込む" />
        </div>

        <div className="card scroll">
          <table className="tbl">
            <thead><tr><th>フィード</th><th>状態</th><th>最終更新</th><th className="num">未読 / 記事</th><th><span className="vh">操作</span></th></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={5} className="muted">{feeds.length === 0 ? "フィードはまだありません。" : "一致するフィードはありません。"}</td></tr>}
              {shown.map((f) => confirming === f.id ? (
                <tr key={f.id} className="confirm">
                  <td colSpan={5}>
                    <div className="confirm-line">
                      <div>
                        <div className="fn">{feedName(f)} を削除しますか？</div>
                        <div className="muted">記事 {f.article_count} 件は削除されず「手動追加」に移ります。タグ・訳文・要約も残ります。</div>
                      </div>
                      <div className="acts">
                        <button className="btn sm" onClick={() => setConfirming(null)}>キャンセル</button>
                        <button className="btn sm danger" onClick={() => remove(f)}>フィードを削除</button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={f.id} className={f.last_error ? "err" : undefined}>
                  <td><div className="fn">{feedName(f)}</div><div className="fs">{bare(f.url)}</div></td>
                  <td>{f.last_error ? <span className="st err"><i />{f.last_error}</span> : <span className="st"><i />正常</span>}</td>
                  <td className="num when">{relTime(f.last_fetched_at)}</td>
                  <td className="num">{unread.get(f.id) ?? 0} / {f.article_count}</td>
                  <td className="row-acts">
                    <button className="btn sm ghost" onClick={() => onShowFeed(f.id)} aria-label={`${feedName(f)} の記事を見る`}>記事を見る →</button>
                    <button className="btn sm ghost" onClick={() => setConfirming(f.id)} aria-label={`${feedName(f)} を削除`}>削除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
