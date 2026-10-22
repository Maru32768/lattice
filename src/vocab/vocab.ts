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

/** A sentence end: terminal punctuation (and closing quotes or brackets) before a space, or a line break. */
const END = /[.!?。！？]["'”’)\]]*(?=\s|$)|\n/gu;

/** The sentence holding [start, end) of `text`, whitespace collapsed; a long one is cut to a window around the word. */
export function sentenceAt(text: string, start: number, end: number): string {
  let from = 0;
  let to = text.length;
  for (const m of text.matchAll(END)) {
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

/** A form as a pattern: case-insensitive, any run of spaces between words, not inside a longer word. */
const pattern = (forms: string[]) =>
  `(?<![\\p{L}\\p{N}])(?:${forms
    .map((f) =>
      collapse(f)
        .split(" ")
        .map((w) => RegExp.escape(w))
        .join("\\s+"),
    )
    .join("|")})(?![\\p{L}\\p{N}])`;

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
