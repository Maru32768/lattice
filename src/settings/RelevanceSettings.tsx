import { useEffect, useState } from "react";
import { SetRow, Switch } from "../ui/SetRow";
import { api, type RelevanceStatus } from "../api";
import { useT } from "../i18n";

const THRESHOLDS = [2, 3, 4, 5];

export function RelevanceSettings({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [st, setSt] = useState<RelevanceStatus | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.relevanceStatus().then(setSt).catch((e) => setError(String(e)));
  useEffect(() => { api.relevanceStatus().then(setSt).catch((e) => setError(String(e))); }, []);

  async function run(task: () => Promise<string | null | void>) {
    setError(null);
    await task().then((done) => setStatus(done ?? null), (e) => setError(String(e)));
    void load();
    onChanged();
  }

  if (!st) return error ? <p className="msg error-text" role="alert">{t.msg(error)}</p> : null;
  const outdated = st.stale + st.unscored;
  return (
    <div className="grp">
      {!st.has_profile && <p className="note warn" role="note">{t("relevanceSettings.noProfile")}</p>}
      <SetRow title={t("relevanceSettings.auto")} htmlFor="auto-relevance" desc={t("relevanceSettings.autoDesc")}>
        <Switch id="auto-relevance" checked={st.auto && st.has_profile} onChange={(on) => run(() => api.setAutoRelevance(on))} />
      </SetRow>
      <SetRow title={t("relevanceSettings.threshold")} htmlFor="relevance-threshold" desc={t("relevanceSettings.thresholdDesc")}>
        <select id="relevance-threshold" className="select" value={st.threshold} onChange={(e) => run(() => api.setRelevanceThreshold(Number(e.target.value)))}>
          {THRESHOLDS.map((n) => <option key={n} value={n}>{t("relevanceSettings.atLeast", { n })}</option>)}
        </select>
      </SetRow>
      <SetRow title={t("relevanceSettings.rescore")}
        desc={t("relevanceSettings.counts", { scored: st.scored, stale: st.stale, unscored: st.unscored })}>
        <button className="btn" disabled={!st.has_profile || outdated === 0}
          onClick={() => run(async () => t("relevanceSettings.queued", { n: await api.rescoreRelevance(null) }))}>{t("relevanceSettings.rescoreAll")}</button>
      </SetRow>
      {status && <p role="status" className="msg">{status}</p>}
      {error && <p className="msg error-text" role="alert">{t.msg(error)}</p>}
    </div>
  );
}
