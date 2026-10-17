import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type JobIssue, type JobOverview, type JobState } from "./api";

const TYPE_LABELS: Record<string, string> = {
  ingest: "取得",
  embed: "検索 index",
  translate: "翻訳",
  summarize: "要約",
  classify: "分類",
};
const STATES: [JobState, string][] = [["pending", "待機"], ["backoff", "再試行待ち"], ["running", "実行中"], ["failed", "失敗"]];
const POLL_MS = 10_000;

const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;
const time = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

/** Background jobs: counts per type and state, and the failed / backing-off ones with retry and cancel. */
export function JobsView() {
  const [data, setData] = useState<JobOverview | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.jobOverview().then(setData).catch((e) => setError(String(e)));
  // Jobs report every article; coalesce reloads. The poll catches backoffs that expire silently.
  const timer = useRef(0);
  useEffect(() => {
    load();
    const poll = window.setInterval(load, POLL_MS);
    const sub = listen("article-changed", () => {
      clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 1000);
    });
    return () => {
      clearInterval(poll);
      clearTimeout(timer.current);
      sub.then((f) => f());
    };
  }, []);

  async function run(task: () => Promise<string | null>) {
    setError(null);
    try {
      setStatus(await task());
    } catch (e) {
      setError(String(e));
    }
    load();
  }

  const retryAll = (type: string | null) =>
    run(async () => `${await api.retryFailedJobs(type)} 件を再実行キューに入れました`);
  const retry = (j: JobIssue) => run(async () => ((await api.retryJob(j.id)) ? null : "実行中か、既に完了したジョブです"));
  const cancel = (j: JobIssue) => run(async () => ((await api.cancelJob(j.id)) ? "取り消しました" : "実行中か、既に完了したジョブです"));

  const counts = data?.counts ?? [];
  const types = [...new Set(counts.map((c) => c.job_type))];
  const count = (t: string, s: JobState) => counts.find((c) => c.job_type === t && c.state === s)?.count ?? 0;
  const failing = (t: string) => count(t, "failed") + count(t, "backoff");

  return (
    <section className="import jobs">
      <h2>処理状況</h2>
      <p className="muted">取得・検索 index・翻訳・要約・分類のバックグラウンドジョブです。失敗したジョブは間隔を空けて自動で再試行し、5 回失敗すると止まります。「再実行」で待たずにすぐ実行します。</p>
      {status && <p role="status" className="muted">{status}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {data && types.length === 0 && <p className="muted">処理中・失敗したジョブはありません。</p>}
      {types.length > 0 && (
        <table className="job-counts">
          <thead>
            <tr><th>種類</th>{STATES.map(([s, label]) => <th key={s}>{label}</th>)}<th /></tr>
          </thead>
          <tbody>
            {types.map((t) => (
              <tr key={t}>
                <th scope="row">{typeLabel(t)}</th>
                {STATES.map(([s]) => <td key={s} className={s === "failed" && count(t, s) ? "error-text" : ""}>{count(t, s)}</td>)}
                <td>{failing(t) > 0 && <button onClick={() => retryAll(t)}>{typeLabel(t)}の失敗を再実行</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.issues.length > 0 && (
        <>
          <div className="row">
            <h3>失敗・再試行待ち</h3>
            <button onClick={() => retryAll(null)}>失敗をすべて再実行</button>
          </div>
          <ul className="feed-list">
            {data.issues.map((j) => (
              <li key={j.id}>
                <div className="feed-main">
                  <strong>{j.article_title ?? `記事 ${j.article_id ?? "—"}`}</strong>
                  <span className="muted">
                    {typeLabel(j.job_type)}・{j.status === "failed" ? "失敗（自動再試行なし）" : `再試行待ち（${time(j.next_run_at)}）`}・試行 {j.attempt_count} 回
                  </span>
                  <span className="muted">作成 {time(j.created_at)}・開始 {time(j.started_at)}・終了 {time(j.completed_at)}</span>
                  {j.last_error && <span className="error-text">エラー: {j.last_error}</span>}
                </div>
                <button onClick={() => retry(j)}>再実行</button>
                <button onClick={() => cancel(j)}>取り消し</button>
              </li>
            ))}
          </ul>
          {types.reduce((n, t) => n + failing(t), 0) > data.issues.length && <p className="muted">新しい順に {data.issues.length} 件まで表示しています。</p>}
        </>
      )}
    </section>
  );
}
