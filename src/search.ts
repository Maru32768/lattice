/** Query terms as the backend splits them (whitespace). */
export const terms = (query: string) => query.split(/\s+/).filter(Boolean);

/** Cuts long text to a window around the first matching term. */
export function excerpt(text: string, ts: string[], max = 220): string {
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  const hit = Math.min(...ts.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0), Infinity);
  const start = hit === Infinity ? 0 : Math.max(0, Math.min(hit - max / 3, text.length - max));
  const s = Math.floor(start);
  return `${s > 0 ? "…" : ""}${text.slice(s, s + max)}${s + max < text.length ? "…" : ""}`;
}

/** Splits text into plain/marked segments for case-insensitive term highlighting. */
export function highlight(text: string, ts: string[]): { mark: boolean; v: string }[] {
  const special = new Set(".*+?^${}()|[]\\/".split(""));
  const pats = ts.map((t) => [...t].map((c) => (special.has(c) ? `\\${c}` : c)).join(""));
  if (!pats.length) return [{ mark: false, v: text }];
  // A capturing split puts the matches at odd indices.
  return text.split(new RegExp(`(${pats.join("|")})`, "i"))
    .map((v, i) => ({ mark: i % 2 === 1, v }))
    .filter((s) => s.v !== "");
}
