const MIN = 60_000;
const UNITS: [number, string][] = [[24 * 60 * MIN, "日"], [60 * MIN, "時間"], [MIN, "分"]];

/** "12 分前", "3 分後", "4 日前", "たった今"; a month or more away falls back to the date. */
export function relTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = t - now;
  const abs = Math.abs(diff);
  if (abs < MIN) return "たった今";
  if (abs >= 30 * 24 * 60 * MIN) return new Date(t).toLocaleDateString("ja-JP");
  const [size, unit] = UNITS.find(([size]) => abs >= size)!;
  return `${Math.floor(abs / size)} ${unit}${diff < 0 ? "前" : "後"}`;
}
