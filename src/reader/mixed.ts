import { isWrittenIn, type Target } from "../overlay/logic.ts";

export type LanguageMode = "original" | "translated" | "mixed";

/** Mirrors ir.rs PROSE_KINDS. */
export const TRANSLATABLE = new Set(["heading", "paragraph", "list_item", "blockquote", "caption"]);

/** A block the translate job would still send: untranslated prose not already in `target` (as translate.rs skips). */
export const needsTranslation = (b: { kind: string; text: string; translation: string | null }, target: Target) =>
  TRANSLATABLE.has(b.kind) && b.translation == null && !isWrittenIn(b.text, target);

/** Translated blocks and the total once the job is done, as both the Reader and the list show them. */
export function translationProgress(blocks: { kind: string; text: string; translation: string | null }[], target: Target) {
  const done = blocks.filter((b) => b.translation != null).length;
  // Blocks already in the target language are never translated, so they are not counted as left.
  return { done, total: done + blocks.filter((b) => needsTranslation(b, target)).length };
}

/**
 * Why an extracted article offers no Translate: it has no prose at all (an RFC that is one <pre>),
 * or its prose is all in the target language. Null while there is something to translate.
 */
export function nothingToTranslate(blocks: { kind: string; text: string; translation: string | null }[], target: Target) {
  const { done, total } = translationProgress(blocks, target);
  if (blocks.length === 0 || done > 0 || total > 0) {
    return null;
  }
  return blocks.some((b) => TRANSLATABLE.has(b.kind)) ? ("reader.alreadyInTarget" as const) : ("reader.noProse" as const);
}

/**
 * Whether picking `mode` should start the article's translation: there is prose without a
 * translation and no translate job is queued, running or waiting to retry. A finished job with blocks
 * still missing is left alone (those are usually already in the target language; 続き does the rest).
 */
export function autoTranslates(mode: LanguageMode, blocks: { kind: string; translation: string | null }[], job: { status: string } | undefined): boolean {
  if (mode === "original" || !blocks.some((b) => TRANSLATABLE.has(b.kind) && b.translation == null)) {
    return false;
  }
  return !job || job.status === "failed";
}

const ON_SWITCH_KEY = "lattice.translateOnSwitch";
/** 表示を切り替えたら自動で翻訳 (default on). Per device, like the word marks: it only decides when the UI asks. */
export function translateOnSwitch(): boolean {
  try {
    return localStorage.getItem(ON_SWITCH_KEY) !== "off";
  } catch {
    return true;
  }
}
export function setTranslateOnSwitch(on: boolean) {
  try {
    localStorage.setItem(ON_SWITCH_KEY, on ? "on" : "off");
  } catch {
    // Blocked storage: the default (on) stays.
  }
}

/**
 * Which blocks show their translation. Pure display logic: changing mode or ratio never
 * re-translates. Mixed mode spreads `percent` evenly over translated blocks (by count),
 * so the other language isn't bunched at the top.
 */
export function translatedBlockIds(blocks: { id: number; translation: string | null }[], mode: LanguageMode, percent: number): Set<number> {
  const ids = blocks.filter((b) => b.translation != null).map((b) => b.id);
  if (mode === "original") {
    return new Set();
  }
  if (mode === "translated") {
    return new Set(ids);
  }
  const p = Math.min(100, Math.max(0, Math.round(percent)));
  return new Set(ids.filter((_, i) => Math.floor(((i + 1) * p) / 100) > Math.floor((i * p) / 100)));
}

/** Splits translated text on `backticks` so inline code keeps its styling. */
export function splitBackticks(text: string): { code: boolean; v: string }[] {
  return text
    .split("`")
    .map((v, i) => ({ code: i % 2 === 1, v }))
    .filter((s) => s.v !== "");
}
