import { useEffect, useState } from "react";
import { SetRow } from "../ui/SetRow";
import { api, type AutoSummarize } from "../api";
import { useT } from "../i18n";

/** The scores `relevance::SCORES` allows, as the 「重要」 threshold offers them. */
const THRESHOLDS = [2, 3, 4, 5];

const valueOf = (mode: AutoSummarize) => (typeof mode === "string" ? mode : String(mode.important));
const modeOf = (value: string): AutoSummarize => (value === "off" || value === "all" ? value : { important: Number(value) });

export function SummarySettings() {
  const t = useT();
  const [mode, setMode] = useState<AutoSummarize>("off");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .autoSummarize()
      .then(setMode)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  async function save(m: AutoSummarize) {
    setMode(m);
    setError(null);
    try {
      await api.setAutoSummarize(m);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="grp">
      <SetRow title={t("summarySettings.auto")} htmlFor="auto-summarize" desc={t("summarySettings.autoDesc")}>
        <select id="auto-summarize" className="select" value={valueOf(mode)} onChange={(e) => void save(modeOf(e.target.value))}>
          <option value="off">{t("summarySettings.off")}</option>
          <option value="all">{t("summarySettings.all")}</option>
          {THRESHOLDS.map((n) => (
            <option key={n} value={n}>
              {t("summarySettings.important", { n })}
            </option>
          ))}
        </select>
      </SetRow>
      {error && (
        <p className="msg error-text" role="alert">
          {t.msg(error)}
        </p>
      )}
    </div>
  );
}
