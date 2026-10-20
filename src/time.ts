import { locale, type T } from "./i18n/index.ts";

const MIN = 60_000;
const UNITS: [number, Intl.RelativeTimeFormatUnit][] = [[24 * 60 * MIN, "day"], [60 * MIN, "hour"], [MIN, "minute"]];

/** "12 分前" / "12 minutes ago", "in 3 minutes", "just now"; a month or more away falls back to the date. */
export function relTime(iso: string | null, t: T, now = Date.now()): string {
  if (!iso) return "—";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "—";
  const diff = at - now;
  const abs = Math.abs(diff);
  if (abs < MIN) return t("time.justNow");
  if (abs >= 30 * 24 * 60 * MIN) return new Date(at).toLocaleDateString(locale(t.lang));
  const [size, unit] = UNITS.find(([size]) => abs >= size)!;
  return new Intl.RelativeTimeFormat(locale(t.lang)).format(Math.sign(diff) * Math.floor(abs / size), unit);
}
