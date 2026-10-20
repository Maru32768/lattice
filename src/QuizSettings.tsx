import { useEffect, useState } from "react";
import { SetRow } from "./SetRow";
import { api, type ReviewSettings } from "./api";

const UNITS = [["日", 24 * 60], ["時間", 60], ["分", 1]] as const;

/** The largest unit the minutes divide into evenly: 1440 → 1 日, 90 → 90 分. */
const split = (minutes: number) => {
  const [label, size] = UNITS.find(([, size]) => minutes % size === 0)!;
  return { n: minutes / size, size, label };
};

/** Settings › 復習: the daily limits and the interval bounds of spaced repetition. */
export function QuizSettings() {
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

  if (!value) return error ? <p className="msg error-text" role="alert">{error}</p> : null;
  const min = split(value.min_interval_minutes);
  const num = (id: string, key: keyof ReviewSettings, max: number) => (
    <input id={id} className="input sm num" type="number" min={0} max={max} value={value[key]}
      onChange={(e) => void save({ ...value, [key]: Number(e.target.value) })} />
  );

  return (
    <div className="grp">
      <SetRow title="1 日の新規カード" htmlFor="review-new" desc="まだ一度も答えていないカードを 1 日に出す上限。記事の理解度チェックで答えてから追加したカードは、その答えが 1 回目になります。">
        {num("review-new", "new_per_day", 9999)}<span className="muted">枚</span>
      </SetRow>
      <SetRow title="1 日の復習" htmlFor="review-max" desc="一度答えたカードを 1 日に出す上限。">
        {num("review-max", "reviews_per_day", 9999)}<span className="muted">枚</span>
      </SetRow>
      <SetRow title="最短間隔" htmlFor="review-min"
        desc="「もう一度」と、新しいカードに初めて正解したときの間隔。すべての間隔はこれ以上になります。1 日より短くすると、その日のうちにもう一度出題します（Anki の学習ステップ）。">
        <input id="review-min" className="input sm num" type="number" min={1} value={min.n}
          onChange={(e) => void save({ ...value, min_interval_minutes: Number(e.target.value) * min.size })} />
        <select className="select" aria-label="最短間隔の単位" value={min.size}
          onChange={(e) => void save({ ...value, min_interval_minutes: min.n * Number(e.target.value) })}>
          {UNITS.map(([label, size]) => <option key={size} value={size}>{label}</option>)}
        </select>
      </SetRow>
      <SetRow title="最長間隔" htmlFor="review-longest" desc="間隔はこれより長くなりません。">
        {num("review-longest", "max_interval_days", 36500)}<span className="muted">日</span>
      </SetRow>
      {error && <p className="msg error-text" role="alert">{error}</p>}
    </div>
  );
}
