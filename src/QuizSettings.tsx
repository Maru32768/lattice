import { useEffect, useState } from "react";
import { SetRow } from "./SetRow";
import { api, type ReviewSettings } from "./api";
import { useT } from "./i18n";

const UNITS = [["quizSettings.days", 24 * 60], ["quizSettings.hours", 60], ["quizSettings.minutes", 1]] as const;

/** The largest unit the minutes divide into evenly: 1440 → 1 日, 90 → 90 分. */
const split = (minutes: number) => {
  const [label, size] = UNITS.find(([, size]) => minutes % size === 0)!;
  return { n: minutes / size, size, label };
};

/** Settings › 復習: the daily limits and the interval bounds of spaced repetition. */
export function QuizSettings() {
  const t = useT();
  const [value, setValue] = useState<ReviewSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.reviewSettings().then(setValue).catch((e) => setError(String(e))); }, []);

  async function save(next: ReviewSettings) {
    setValue(next);
    setError(null);
    try {
      await api.setReviewSettings(next);
    } catch (e) {
      setError(String(e));
    }
  }

  if (!value) return error ? <p className="msg error-text" role="alert">{t.msg(error)}</p> : null;
  const min = split(value.min_interval_minutes);
  const num = (id: string, key: keyof ReviewSettings, max: number) => (
    <input id={id} className="input sm num" type="number" min={0} max={max} value={value[key]}
      onChange={(e) => void save({ ...value, [key]: Number(e.target.value) })} />
  );

  return (
    <div className="grp">
      <SetRow title={t("quizSettings.newPerDay")} htmlFor="review-new" desc={t("quizSettings.newPerDayDesc")}>
        {num("review-new", "new_per_day", 9999)}<span className="muted">{t("quizSettings.cards")}</span>
      </SetRow>
      <SetRow title={t("quizSettings.reviewsPerDay")} htmlFor="review-max" desc={t("quizSettings.reviewsPerDayDesc")}>
        {num("review-max", "reviews_per_day", 9999)}<span className="muted">{t("quizSettings.cards")}</span>
      </SetRow>
      <SetRow title={t("quizSettings.minInterval")} htmlFor="review-min"
        desc={t("quizSettings.minIntervalDesc")}>
        <input id="review-min" className="input sm num" type="number" min={1} value={min.n}
          onChange={(e) => void save({ ...value, min_interval_minutes: Number(e.target.value) * min.size })} />
        <select className="select" aria-label={t("quizSettings.minIntervalUnit")} value={min.size}
          onChange={(e) => void save({ ...value, min_interval_minutes: min.n * Number(e.target.value) })}>
          {UNITS.map(([label, size]) => <option key={size} value={size}>{t(label)}</option>)}
        </select>
      </SetRow>
      <SetRow title={t("quizSettings.maxInterval")} htmlFor="review-longest" desc={t("quizSettings.maxIntervalDesc")}>
        {num("review-longest", "max_interval_days", 36500)}<span className="muted">{t("quizSettings.days")}</span>
      </SetRow>
      {error && <p className="msg error-text" role="alert">{t.msg(error)}</p>}
    </div>
  );
}
