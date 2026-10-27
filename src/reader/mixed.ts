import { assignTranslated, endsSpaced, isWrittenIn, type Target } from "../overlay/logic.ts";

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

/** A stretch of a block's text: a translated sentence, or the text between sentences (`translation` null). */
export interface Piece {
  start: number;
  end: number;
  translation: string | null;
}

/**
 * A block cut into its translated sentences (the translation's units, as the Page view wraps
 * them) and the text between. A block whose text does not contain every unit (a translation of
 * other wording) is one sentence with the whole translation, as is one without units.
 */
export function blockPieces(b: { text: string; translation: string | null; units?: { source: string; translation: string }[] }): Piece[] {
  const whole = [{ start: 0, end: b.text.length, translation: b.translation }];
  if (b.translation == null || !b.units?.length) {
    return whole;
  }
  const out: Piece[] = [];
  let at = 0;
  for (const u of b.units) {
    const i = u.source ? b.text.indexOf(u.source, at) : -1;
    if (i < 0) {
      return whole;
    }
    if (i > at) {
      out.push({ start: at, end: i, translation: null });
    }
    out.push({ start: i, end: i + u.source.length, translation: u.translation });
    at = i + u.source.length;
  }
  if (at < b.text.length) {
    out.push({ start: at, end: b.text.length, translation: null });
  }
  return out;
}

/**
 * Which sentences show their translation, as `${block id}:${piece index}`. Pure display logic:
 * changing mode or ratio never re-translates. Mixed mode picks sentences in each block as the
 * Page view's overlay does (`assignTranslated`, seeded by the article's URL), so both views mix alike.
 */
export function translatedSentences(blocks: { id: number; text: string; pieces: Piece[] }[], mode: LanguageMode, percent: number, seed: string): Set<string> {
  const out = new Set<string>();
  if (mode === "original") {
    return out;
  }
  for (const b of blocks) {
    const idx = b.pieces.flatMap((p, i) => (p.translation == null ? [] : [i]));
    const picks =
      mode === "translated"
        ? idx.map(() => true)
        : assignTranslated(
            idx.map((i) => b.text.slice(b.pieces[i]!.start, b.pieces[i]!.end)),
            percent,
            seed,
          );
    idx.forEach((i, n) => {
      if (picks[n]) {
        out.add(`${b.id}:${i}`);
      }
    });
  }
  return out;
}

/**
 * Whether the text between sentences is left out: only spaces between two sentences that both show
 * their translation (Japanese sentences take none; `shownTranslation` spaces English ones).
 */
export function dropsGap(text: string, pieces: Piece[], i: number, shown: (i: number) => boolean): boolean {
  const [p, before, after] = [pieces[i]!, pieces[i - 1], pieces[i + 1]];
  return (
    p.translation == null && !text.slice(p.start, p.end).trim() && before?.translation != null && after?.translation != null && shown(i - 1) && shown(i + 1)
  );
}

/** A translated sentence as shown: a space after a Latin-script end, as the units carry none between them. */
export const shownTranslation = (tr: string) => (endsSpaced(tr) ? `${tr} ` : tr);

/** Splits translated text on `backticks` so inline code keeps its styling. */
export function splitBackticks(text: string): { code: boolean; v: string }[] {
  return text
    .split("`")
    .map((v, i) => ({ code: i % 2 === 1, v }))
    .filter((s) => s.v !== "");
}
