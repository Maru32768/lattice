import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type FeedRow } from "./api";

/** RSS / Atom subscriptions. Polling runs in the background every 30 minutes and at startup. */
export function FeedsView({ onChanged }: { onChanged: () => void }) {
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.listFeeds().then(setFeeds).catch((e) => setError(String(e)));
  useEffect(() => {
    load();
    const sub = listen("feeds-changed", () => { load(); onChanged(); });
    return () => { sub.then((f) => f()); };
  }, []);

  async function run(task: () => Promise<string>) {
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

  const add = () => run(async () => {
    await api.addFeed(url.trim());
    setUrl("");
    return "登録しました。新しい記事をバックグラウンドで取得します。";
  });

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
    try {
      await api.removeFeed(f.id);
    } catch (e) {
      setError(String(e));
    }
    load();
    onChanged();
  }

  return (
    <section className="import feeds">
      <h2>フィード（RSS / Atom）</h2>
      <p className="muted">登録すると最新 20 件を取り込み、以降は 30 分ごと（と起動時）に新着だけを取り込みます。フィードを削除しても記事は残ります（「手動追加」に移ります）。</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (url.trim()) add(); }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" aria-label="フィードの URL" />
        <button type="submit" disabled={busy || !url.trim()}>登録</button>
        <button type="button" onClick={refreshAll} disabled={busy || feeds.length === 0}>すべて更新</button>
        <label className="file">
          OPML を読み込む
          <input type="file" accept=".opml,.xml" disabled={busy} onChange={(e) => importOpml(e.target.files?.[0])} />
        </label>
      </form>
      {status && <p role="status" className="muted">{status}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <ul className="feed-list">
        {feeds.map((f) => (
          <li key={f.id}>
            <div className="feed-main">
              <strong>{f.title ?? f.url}</strong>
              <span className="muted">{f.url}</span>
              <span className="muted">
                記事 {f.article_count} 件
                {f.last_fetched_at && `・最終取得 ${new Date(f.last_fetched_at).toLocaleString()}`}
              </span>
              {f.last_error && <span className="error-text">エラー: {f.last_error}</span>}
            </div>
            <button onClick={() => remove(f)} aria-label={`${f.title ?? f.url} を削除`}>削除</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
