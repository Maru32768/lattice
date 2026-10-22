/** Query terms as the backend splits them (whitespace). */
export const terms = (query: string) => query.split(/\s+/).filter(Boolean);

/** Cuts long text to a window around the first matching term. */
export function excerpt(text: string, ts: string[], max = 220): string {
  if (text.length <= max) {
    return text;
  }
  const lower = text.toLowerCase();
  const hit = Math.min(...ts.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0), Infinity);
  const start = hit === Infinity ? 0 : Math.max(0, Math.min(hit - max / 3, text.length - max));
  const s = Math.floor(start);
  return `${s > 0 ? "…" : ""}${text.slice(s, s + max)}${s + max < text.length ? "…" : ""}`;
}

/** Splits text into plain/marked segments for case-insensitive term highlighting. */
export function highlight(text: string, ts: string[]): { mark: boolean; v: string }[] {
  const pats = ts.map((t) => RegExp.escape(t));
  if (!pats.length) {
    return [{ mark: false, v: text }];
  }
  // A capturing split puts the matches at odd indices.
  return text
    .split(new RegExp(`(${pats.join("|")})`, "i"))
    .map((v, i) => ({ mark: i % 2 === 1, v }))
    .filter((s) => s.v !== "");
}

export type SearchMethod = "hybrid" | "lexical" | "semantic";

/**
 * The backend always runs hybrid search; the 全文 / 意味 choice filters hits by how they
 * matched. `ids` limits hits to the articles currently in scope ∧ facets.
 */
export function filterHits<H extends { article_id: number; source: "lexical" | "semantic" | "both" }>(hits: H[], method: SearchMethod, ids: Set<number>): H[] {
  return hits.filter((h) => ids.has(h.article_id) && (method === "hybrid" || h.source === "both" || h.source === method));
}

/** Hits grouped by article, in order of each article's best (first) hit. */
export function groupHits<H extends { article_id: number }>(hits: H[]): { article_id: number; hits: H[] }[] {
  const m = new Map<number, H[]>();
  for (const h of hits) {
    const g = m.get(h.article_id);
    if (g) {
      g.push(h);
    } else {
      m.set(h.article_id, [h]);
    }
  }
  return [...m].map(([article_id, hits]) => ({ article_id, hits }));
}
