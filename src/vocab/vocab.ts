// Vocabulary (G56): pure text helpers shared by the Reader, the page overlay (bundled into
// pages, so no React and no catalog here), the review cards and the 単語帳 list.
import type { VocabEntry } from "../api";

/** Mirrors vocab.rs: longer selections and sentences are refused. */
export const MAX_SURFACE = 64;
export const MAX_SENTENCE = 600;
/** Characters kept on each side of the word when a sentence is too long. */
const WINDOW = 250;

export const collapse = (s: string) => s.replace(/\s+/gu, " ").trim();

/** Worth offering 単語を登録: a short selection with a Latin letter, on one line. */
export function isWord(s: string): boolean {
  const v = collapse(s);
  return v.length > 0 && v.length <= MAX_SURFACE && /[A-Za-z]/u.test(v) && !/[\r\n]/u.test(s.trim());
}

/**
 * A sentence end: terminal punctuation (and closing quotes or brackets) before a space, or a line break. Japanese puts no
 * space after its own, and goes on where hiragana follows a quote or bracket, or ？ or ！: 「なぜ遅い？」と問う。速い！と叫ぶ。
 * A next sentence that starts with hiragana there is read as the same one. Japanese stops come with their closers and the
 * hiragana after them, for `sentenceAt` to tell: a lookbehind here would keep the phone page from loading on Safari
 * before 16.4.
 */
const END = /[.!?]["'”’)\]]*(?=\s|$)|([。！？]+)([」』）】〕〉》］"'”’)\]]*)(?=([ぁ-ゟ])?)|\n/gu;

/** The sentence holding [start, end) of `text`, whitespace collapsed; a long one is cut to a window around the word. */
export function sentenceAt(text: string, start: number, end: number): string {
  let from = 0;
  let to = text.length;
  for (const m of text.matchAll(END)) {
    const [, stops, closers, kana] = m;
    if (kana && (closers || /[！？]$/u.test(stops ?? ""))) {
      continue;
    }
    const after = m.index + m[0].length;
    if (after <= start) {
      from = after;
    } else if (m.index >= end) {
      to = after;
      break;
    }
  }
  const sentence = collapse(text.slice(from, to));
  return sentence.length <= MAX_SENTENCE ? sentence : collapse(text.slice(Math.max(from, start - WINDOW), Math.min(to, end + WINDOW)));
}

/** The capture of `selected` in `text`: the occurrence nearest `near` (where the DOM puts the selection). */
export function captureIn(text: string, selected: string, near: number): { surface: string; sentence: string } | null {
  const needle = selected.trim();
  if (!needle) {
    return null;
  }
  let best = -1;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) {
      best = i;
    }
  }
  return best < 0 ? null : { surface: collapse(needle), sentence: sentenceAt(text, best, best + needle.length) };
}

/** Japanese is written with no spaces between its words, so there a word's edge cannot be told. */
export const inWord = (c: string | undefined) => c != null && /[\p{L}\p{N}_]/u.test(c) && !/[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u.test(c);

/** Mirrors stickies.rs: the characters a sticky keeps of the text on each side of its passage. */
export const CONTEXT_CHARS = 32;

/** The text right before and right after a passage, as it was selected; null on a sticky from before that was kept. */
export interface QuoteContext {
  prefix: string | null;
  suffix: string | null;
}

const bare = (s: string) => s.replace(/\s+/gu, "");

/** How many sides of [start, end) of `text`, which has no whitespace, read as they did where the passage was selected. */
export function fitOf(text: string, start: number, end: number, { prefix, suffix }: QuoteContext): number {
  return Number(prefix != null && text.endsWith(bare(prefix), start)) + Number(suffix != null && text.startsWith(bare(suffix), end));
}

/** Of the places found, those that read most as the passage did where it was selected, in their order. */
export function bestFits<T>(found: T[], fit: (place: T) => number): T[] {
  const fits = found.map(fit);
  const top = fits.reduce((a, b) => Math.max(a, b), 0);
  return found.filter((_, i) => fits[i] === top);
}

/**
 * The capture of `form` where it is a whole word in `text`, by the edges of a sticky's mark: of the places that read most as
 * where it was selected, the first with its own case, else the first.
 */
export function wordIn(text: string, form: string, context: QuoteContext = { prefix: null, suffix: null }): { surface: string; sentence: string } | null {
  const want = collapse(form);
  const whole = ([s, e]: [number, number]) => !(inWord(text[s - 1]) && inWord(text[s])) && !(inWord(text[e - 1]) && inWord(text[e]));
  const found = want ? [...text.matchAll(new RegExp(spaced(want), "giu"))].map((m): [number, number] => [m.index, m.index + m[0].length]).filter(whole) : [];
  const flat = bare(text);
  /** Where in `flat` each place of `text` is. */
  const at = [0];
  for (let i = 0; i < text.length; i++) {
    at.push(at[i]! + Number(!/\s/u.test(text[i]!)));
  }
  const near = bestFits(found, ([s, e]) => fitOf(flat, at[s]!, at[e]!, context));
  const [start, end] = near.find(([s, e]) => collapse(text.slice(s, e)) === want) ?? near[0] ?? [];
  return start == null || end == null ? null : { surface: collapse(text.slice(start, end)), sentence: sentenceAt(text, start, end) };
}

/** A form as a pattern of any run of spaces between its words. */
const spaced = (form: string) =>
  collapse(form)
    .split(" ")
    .map((w) => RegExp.escape(w))
    .join("\\s+");

/** Forms as a pattern: case-insensitive, any run of spaces between words, not inside a longer word. */
const pattern = (forms: string[]) => `(?<![\\p{L}\\p{N}])(?:${forms.map(spaced).join("|")})(?![\\p{L}\\p{N}])`;

/** Where `form` occurs in `text` as a whole word, case-insensitively: [start, end) pairs. */
export function findWord(text: string, form: string): [number, number][] {
  if (!collapse(form)) {
    return [];
  }
  return [...text.matchAll(new RegExp(pattern([form]), "giu"))].map((m) => [m.index, m.index + m[0].length]);
}

/** Saved words to mark in article text: one pattern over every form, and each form's meaning. */
export interface WordMarks {
  re: RegExp;
  meanings: Map<string, string>;
}

const key = (form: string) => collapse(form).toLowerCase();

/** Entries with a meaning, by their headword and every form captured; null when there are none. */
export function wordMarks(entries: VocabEntry[]): WordMarks | null {
  const meanings = new Map<string, string>();
  for (const e of entries) {
    if (e.state !== "ready" || !e.meaning) {
      continue;
    }
    for (const f of [e.headword, ...e.contexts.map((c) => c.surface)]) {
      if (key(f) && !meanings.has(key(f))) {
        meanings.set(key(f), e.meaning);
      }
    }
  }
  if (meanings.size === 0) {
    return null;
  }
  // Longest first: "write skew" wins over "write".
  const forms = [...meanings.keys()].sort((a, b) => b.length - a.length);
  return { re: new RegExp(pattern(forms), "giu"), meanings };
}

/** `text` in pieces; a saved word carries its meaning. */
export function markWords(text: string, m: WordMarks | null): { v: string; meaning?: string }[] {
  if (!m) {
    return [{ v: text }];
  }
  const out: { v: string; meaning?: string }[] = [];
  let at = 0;
  for (const hit of text.matchAll(m.re)) {
    if (hit.index > at) {
      out.push({ v: text.slice(at, hit.index) });
    }
    out.push({ v: hit[0], meaning: m.meanings.get(key(hit[0])) });
    at = hit.index + hit[0].length;
  }
  if (at < text.length || out.length === 0) {
    out.push({ v: text.slice(at) });
  }
  return out;
}

export type VocabSort = "added" | "due";

/** The 単語帳 rows: matching `query` in a headword, meaning, definition or captured form; newest or soonest due first. */
export function shownEntries(entries: VocabEntry[], query: string, sort: VocabSort): VocabEntry[] {
  const q = collapse(query).toLowerCase();
  const hit = (e: VocabEntry) => !q || [e.headword, e.meaning, e.definition, ...e.contexts.map((c) => c.surface)].some((s) => s.toLowerCase().includes(q));
  const due = (e: VocabEntry) => e.due_at ?? Number.MAX_SAFE_INTEGER;
  return entries.filter(hit).sort(sort === "due" ? (a, b) => due(a) - due(b) || b.id - a.id : (a, b) => b.id - a.id);
}
