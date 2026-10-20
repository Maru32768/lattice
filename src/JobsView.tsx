import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type JobIssue, type JobOverview, type JobState } from "./api";
import { relTime } from "./time";
import "./manage.css";

// Pipeline order; a type the backend adds later still shows, after these.
const TYPES: { type: string; label: string; hint?: string }[] = [
  { type: "ingest", label: "取得" },
  { type: "render", label: "描画", hint: "裏描画 · 最大約 20 秒/件" },
  { type: "images", label: "画像" },
  { type: "favicon", label: "サイトアイコン" },
  { type: "embed", label: "検索 index" },
  { type: "translate", label: "翻訳" },
  { type: "summarize", label: "要約" },
  { type: "quiz", label: "クイズ" },
  { type: "classify", label: "分類", hint: "最大 20 件を 1 呼び出しに" },
];
const STATES: { state: JobState; label: string; tone: string }[] = [
  { state: "pending", label: "待機", tone: "" },
  { state: "backoff", label: "再試行待ち", tone: "wait" },
  { state: "running", label: "実行中", tone: "run" },
  { state: "failed", label: "失敗", tone: "err" },
];
const MAX_ATTEMPTS = 5;
const POLL_MS = 10_000;

const typeLabel = (t: string) => TYPES.find((x) => x.type === t)?.label ?? t;
const time = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

/** Background jobs: counts per type and state, and the failed / backing-off ones with retry and cancel. */
export function JobsView() {
  const [data, setData] = useState<JobOverview | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<string | null>(null);

  const load = () => api.jobOverview().then(setData).catch((e) => setError(String(e)));
  // Jobs report every article; coalesce reloads. The poll catches backoffs that expire silently.
  const timer = useRef(0);
  useEffect(() => {
    void load();
    const poll = window.setInterval(load, POLL_MS);
    const sub = listen("article-changed", () => {
      clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 1000);
    });
    return () => {
      clearInterval(poll);
      clearTimeout(timer.current);
      void sub.then((f) => f());
    };
  }, []);

  async function run(task: () => Promise<string | null>) {
    setError(null);
    try {
      setStatus(await task());
    } catch (e) {
      setError(String(e));
    }
    void load();
  }

  const retryAll = (type: string | null) =>
    run(async () => `${await api.retryFailedJobs(type)} 件を再実行キューに入れました`);
  const retry = (j: JobIssue) => run(async () => ((await api.retryJob(j.id)) ? null : "実行中か、既に完了したジョブです"));
  const cancel = (j: JobIssue) => run(async () => ((await api.cancelJob(j.id)) ? "取り消しました" : "実行中か、既に完了したジョブです"));

  const counts = data?.counts ?? [];
  const issues = data?.issues ?? [];
  const types = [...new Set([...TYPES.map((t) => t.type), ...counts.map((c) => c.job_type)])];
  const count = (t: string, s: JobState) => counts.find((c) => c.job_type === t && c.state === s)?.count ?? 0;
  const failing = (t: string) => count(t, "failed") + count(t, "backoff");
  const issueTypes = [...new Set(issues.map((j) => j.job_type))];
  // A type whose issues all got retried drops out of the filter row; fall back to すべて.
  const active = only && issueTypes.includes(only) ? only : null;
  const shown = active ? issues.filter((j) => j.job_type === active) : issues;
  const filterButton = (type: string | null, label: string, n: number) => (
    <button key={type ?? ""} className={`btn sm${active === type ? " on" : ""}`} aria-pressed={active === type} onClick={() => setOnly(type)}>{label} {n}</button>
  );

  return (
    <main className="manage">
      <div className="wrap wide">
        <header className="head base">
          <h1>処理状況</h1>
          <span className="live">ライブ · イベント + 10 秒ごと</span>
          <span className="aside">失敗は間隔を空けて自動再試行、{MAX_ATTEMPTS} 回で停止</span>
        </header>
        {status && <p role="status" className="msg muted">{status}</p>}
        {error && <p role="alert" className="msg error-text">{error}</p>}

        {data && (
          <div className="card scroll">
            <table className="tbl dense">
              <thead>
                <tr><th>種類</th>{STATES.map((s) => <th key={s.state} className="r">{s.label}</th>)}<th>補足</th><th><span className="vh">操作</span></th></tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t}>
                    <td><span className="ty" title={typeLabel(t)}>{t}</span></td>
                    {STATES.map((s) => {
                      const n = count(t, s.state);
                      return <td key={s.state} className="r"><span className={`cnt ${n ? s.tone : "z"}`}>{n}</span></td>;
                    })}
                    <td className="hint">{TYPES.find((x) => x.type === t)?.hint}</td>
                    <td className="r">{failing(t) > 0 && <button className="btn sm" onClick={() => retryAll(t)} aria-label={`${typeLabel(t)}の失敗を再実行`}>失敗を再実行</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && counts.length === 0 && <p className="msg muted">処理中・失敗したジョブはありません。</p>}

        {issues.length > 0 && (
          <>
            <div className="issues-head">
              <h2>失敗・再試行待ち</h2>
              {filterButton(null, "すべて", issues.length)}
              {issueTypes.map((t) => filterButton(t, t, issues.filter((j) => j.job_type === t).length))}
              <span className="aside">{types.reduce((n, t) => n + failing(t), 0) > issues.length && `新しい順に ${issues.length} 件まで表示しています。`}</span>
              <button className="btn sm" onClick={() => retryAll(null)}>失敗をすべて再実行</button>
            </div>
            <div className="card scroll">
              <table className="tbl dense">
                <thead><tr><th>種類</th><th>記事</th><th>エラー</th><th>試行</th><th>次回</th><th>状態</th><th><span className="vh">操作</span></th></tr></thead>
                <tbody>
                  {shown.map((j) => {
                    const failed = j.status === "failed";
                    return (
                      <tr key={j.id}>
                        <td><span className="ty" title={typeLabel(j.job_type)}>{j.job_type}</span></td>
                        <td className="art" title={`作成 ${time(j.created_at)}・開始 ${time(j.started_at)}・終了 ${time(j.completed_at)}`}>
                          {j.article_title ?? `記事 ${j.article_id ?? "—"}`}
                        </td>
                        <td>{j.last_error && <span className="er" title={j.last_error}>{j.last_error}</span>}</td>
                        <td className="m">
                          <span className="att" aria-hidden="true">
                            {Array.from({ length: MAX_ATTEMPTS }, (_, i) => <i key={i} className={i < j.attempt_count ? "f" : undefined} />)}
                          </span>
                          {j.attempt_count}/{MAX_ATTEMPTS}
                        </td>
                        <td className={`m${failed ? " z" : ""}`}>{failed ? "—" : relTime(j.next_run_at)}</td>
                        <td className={`state${failed ? "" : " wait"}`}>{failed ? "失敗" : "再試行待ち"}</td>
                        <td className="r">
                          <button className="btn sm" onClick={() => retry(j)}>{failed ? "再実行" : "今すぐ再実行"}</button>
                          <button className="btn sm ghost" onClick={() => cancel(j)}>取り消し</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
