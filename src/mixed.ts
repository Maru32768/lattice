export type LanguageMode = "original" | "translated" | "mixed";

/**
 * Which blocks show their translation. Pure display logic: changing mode or ratio never
 * re-translates. Mixed mode spreads `percent` evenly over translated blocks (by count),
 * so Japanese isn't bunched at the top.
 */
export function translatedBlockIds(
  blocks: { id: number; translation: string | null }[],
  mode: LanguageMode,
  percent: number,
): Set<number> {
  const ids = blocks.filter((b) => b.translation != null).map((b) => b.id);
  if (mode === "original") return new Set();
  if (mode === "translated") return new Set(ids);
  const p = Math.min(100, Math.max(0, Math.round(percent)));
  return new Set(ids.filter((_, i) => Math.floor(((i + 1) * p) / 100) > Math.floor((i * p) / 100)));
}

/** Splits translated text on `backticks` so inline code keeps its styling. */
export function splitBackticks(text: string): { code: boolean; v: string }[] {
  return text.split("`").map((v, i) => ({ code: i % 2 === 1, v })).filter((s) => s.v !== "");
}
