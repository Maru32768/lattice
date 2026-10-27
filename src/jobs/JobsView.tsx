import { useEffect, useEffectEvent, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type JobIssue, type JobOverview, type JobState, type ProviderHealth } from "../api";
import { ProviderHealthNotice } from "../settings/ProviderHealth";
import { relTime } from "../lib/time";
import { InfoTip } from "../ui/InfoTip";
import "../ui/manage.css";
import { locale, useT, type PlainKey, type T } from "../i18n";

// Pipeline order; a type the backend adds later still shows, after these.
// `about`: what the job does, the ⓘ next to its name.
const TYPES: { type: string; label: PlainKey; about: PlainKey; hint?: PlainKey }[] = [
  { type: "feed_filter", label: "jobsView.feedFilter", about: "jobsView.feedFilterAbout", hint: "jobsView.feedFilterHint" },
  { type: "ingest", label: "jobsView.ingest", about: "jobsView.ingestAbout" },
  { type: "render", label: "jobsView.render", about: "jobsView.renderAbout", hint: "jobsView.renderHint" },
  { type: "images", label: "jobsView.images", about: "jobsView.imagesAbout" },
  { type: "favicon", label: "jobsView.favicon", about: "jobsView.faviconAbout" },
  { type: "embed", label: "jobsView.embed", about: "jobsView.embedAbout" },
  { type: "translate", label: "jobsView.translate", about: "jobsView.translateAbout" },
  { type: "summarize", label: "jobsView.summarize", about: "jobsView.summarizeAbout" },
  { type: "quiz", label: "jobsView.quiz", about: "jobsView.quizAbout" },
  { type: "vocab", label: "jobsView.vocab", about: "jobsView.vocabAbout" },
  { type: "classify", label: "jobsView.classify", about: "jobsView.classifyAbout", hint: "jobsView.classifyHint" },
  { type: "relevance", label: "jobsView.relevance", about: "jobsView.relevanceAbout", hint: "jobsView.classifyHint" },
];
const STATES: { state: JobState; label: PlainKey; tone: string }[] = [
  { state: "pending", label: "jobsView.pending", tone: "" },
  { state: "backoff", label: "jobsView.backoff", tone: "wait" },
  { state: "running", label: "jobsView.running", tone: "run" },
  { state: "failed", label: "jobsView.failed", tone: "err" },
];
const MAX_ATTEMPTS = 5;
const POLL_MS = 10_000;

const typeLabel = (type: string, t: T) => {
  const label = TYPES.find((x) => x.type === type)?.label;
  return label ? t(label) : type;
};
const aboutOf = (type: string) => TYPES.find((x) => x.type === type)?.about;
const time = (s: string | null, t: T) => (s ? new Date(s).toLocaleString(locale(t.lang)) : "—");

/** Background jobs: counts per type and state, and the failed / backing-off ones with retry and cancel. */
export function JobsView() {
  const t = useT();
  const [data, setData] = useState<JobOverview | null>(null);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<string | null>(null);

  const load = () => Promise.all([api.jobOverview().then(setData), api.llmHealth().then(setHealth)]).catch((e: unknown) => setError(String(e)));
  const reload = useEffectEvent(() => void load());
  // Jobs report every article; coalesce reloads. The poll catches backoffs that expire silently.
  useEffect(() => {
    let timer = 0;
    reload();
    const poll = window.setInterval(() => reload(), POLL_MS);
    const sub = listen("article-changed", () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => reload(), 1000);
    });
    return () => {
      clearInterval(poll);
      clearTimeout(timer);
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

  const retryAll = (type: string | null) => run(async () => t("jobsView.requeued", { x: await api.retryFailedJobs(type) }));
  const retry = (j: JobIssue) => run(async () => ((await api.retryJob(j.id)) ? null : t("jobsView.notRetryable")));
  const cancel = (j: JobIssue) => run(async () => ((await api.cancelJob(j.id)) ? t("jobsView.cancelled") : t("jobsView.notRetryable")));

  const counts = data?.counts ?? [];
  const issues = data?.issues ?? [];
  const hintOf = (type: string) => {
    const hint = TYPES.find((x) => x.type === type)?.hint;
    return hint && t(hint);
  };
  const types = [...new Set([...TYPES.map((type) => type.type), ...counts.map((c) => c.job_type)])];
  const count = (type: string, s: JobState) => counts.find((c) => c.job_type === type && c.state === s)?.count ?? 0;
  const failing = (type: string) => count(type, "failed") + count(type, "backoff");
  const issueTypes = [...new Set(issues.map((j) => j.job_type))];
  // A type whose issues all got retried drops out of the filter row; fall back to すべて.
  const active = only && issueTypes.includes(only) ? only : null;
  const shown = active ? issues.filter((j) => j.job_type === active) : issues;
  const filterButton = (type: string | null, label: string, n: number) => (
    <button
      key={type ?? ""}
      className={`btn sm${active === type ? " on" : ""}`}
      aria-pressed={active === type}
      title={type ?? undefined}
      onClick={() => setOnly(type)}
    >
      {label} {n}
    </button>
  );

  return (
    <main className="manage">
      <div className="wrap wide">
        <header className="head base">
          <h1>{t("common.jobs")}</h1>
          <span className="live">{t("jobsView.live")}</span>
          <span className="aside">{t("jobsView.retryPolicy", { MAX_ATTEMPTS })}</span>
        </header>
        <ProviderHealthNotice health={health} />
        {status && (
          <p role="status" className="msg muted">
            {status}
          </p>
        )}
        {error && (
          <p role="alert" className="msg error-text">
            {t.msg(error)}
          </p>
        )}

        {data && (
          <div className="card scroll">
            <table className="tbl dense">
              <thead>
                <tr>
                  <th>{t("jobsView.type")}</th>
                  {STATES.map((s) => (
                    <th key={s.state} className="r">
                      {t(s.label)}
                    </th>
                  ))}
                  <th>{t("jobsView.note")}</th>
                  <th>
                    <span className="vh">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {types.map((type) => (
                  <tr key={type}>
                    <td>
                      <span className="ty" title={type}>
                        {typeLabel(type, t)}
                      </span>
                      {aboutOf(type) && <InfoTip label={t("jobsView.about", { typeLabel: typeLabel(type, t) })} text={t(aboutOf(type)!)} />}
                    </td>
                    {STATES.map((s) => {
                      const n = count(type, s.state);
                      return (
                        <td key={s.state} className="r">
                          <span className={`cnt ${n ? s.tone : "z"}`}>{n}</span>
                        </td>
                      );
                    })}
                    <td className="hint">{hintOf(type)}</td>
                    <td className="r">
                      {failing(type) > 0 && (
                        <button className="btn sm" onClick={() => retryAll(type)} aria-label={t("jobsView.retryFailedOf", { typeLabel: typeLabel(type, t) })}>
                          {t("jobsView.retryFailed")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && counts.length === 0 && <p className="msg muted">{t("jobsView.none")}</p>}

        {issues.length > 0 && (
          <>
            <div className="issues-head">
              <h2>{t("jobsView.issues")}</h2>
              {filterButton(null, t("jobsView.all"), issues.length)}
              {issueTypes.map((type) => filterButton(type, typeLabel(type, t), issues.filter((j) => j.job_type === type).length))}
              <span className="aside">
                {types.reduce((n, type) => n + failing(type), 0) > issues.length && t("jobsView.showing", { length: issues.length })}
              </span>
              <button className="btn sm" onClick={() => retryAll(null)}>
                {t("jobsView.retryAll")}
              </button>
            </div>
            <div className="card scroll">
              <table className="tbl dense">
                <thead>
                  <tr>
                    <th>{t("jobsView.type")}</th>
                    <th>{t("common.article")}</th>
                    <th>{t("common.error")}</th>
                    <th>{t("jobsView.attempts")}</th>
                    <th>{t("jobsView.next")}</th>
                    <th>{t("jobsView.state")}</th>
                    <th>
                      <span className="vh">{t("common.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((j) => {
                    const failed = j.status === "failed";
                    return (
                      <tr key={j.id}>
                        <td>
                          <span className="ty" title={j.job_type}>
                            {typeLabel(j.job_type, t)}
                          </span>
                        </td>
                        <td
                          className="art"
                          title={t("jobsView.times", { time: time(j.created_at, t), time2: time(j.started_at, t), time3: time(j.completed_at, t) })}
                        >
                          {j.article_title ?? (j.article_id == null ? typeLabel(j.job_type, t) : t("jobsView.articleN", { x: j.article_id }))}
                        </td>
                        <td>
                          {j.last_error && (
                            <span className="er" title={t.msg(j.last_error)}>
                              {t.msg(j.last_error)}
                            </span>
                          )}
                        </td>
                        <td className="m">
                          <span className="att" aria-hidden="true">
                            {Array.from({ length: MAX_ATTEMPTS }, (_, i) => (
                              <i key={i} className={i < j.attempt_count ? "f" : undefined} />
                            ))}
                          </span>
                          {j.attempt_count}/{MAX_ATTEMPTS}
                        </td>
                        <td className={`m${failed ? " z" : ""}`}>{failed ? "—" : relTime(j.next_run_at, t)}</td>
                        <td className={`state${failed ? "" : " wait"}`}>{failed ? t("jobsView.failed") : t("jobsView.backoff")}</td>
                        <td className="r">
                          <button className="btn sm" onClick={() => retry(j)}>
                            {failed ? t("jobsView.retry") : t("jobsView.retryNow")}
                          </button>
                          <button className="btn sm ghost" onClick={() => cancel(j)}>
                            {t("jobsView.cancel")}
                          </button>
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
