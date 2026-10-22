// Vim-style editing for the chat input (G43): a pure state machine over (text, cursor), so the
// textarea stays a plain textarea and every command is unit-tested here.

export type Mode = "normal" | "insert";
export interface Buffer { text: string; cursor: number }
export interface Vim {
  mode: Mode;
  /** The first key of a two-key command: d, c, y or g. */
  pending: string;
  register: { text: string; linewise: boolean } | null;
  undo: Buffer[];
}

export const initialVim = (): Vim => ({ mode: "insert", pending: "", register: null, undo: [] });

const UNDO_LIMIT = 100;
// Keys normal mode leaves to the textarea: moving with them never edits the text.
const NATIVE = /^(Arrow|Home$|End$|Page|Tab$|Shift$|Control$|Alt$|Meta$|F\d)/;

const kind = (c: string | undefined) => (c === undefined ? -1 : /\s/.test(c) ? 0 : /[\p{L}\p{N}_]/u.test(c) ? 1 : 2);
const lineStart = (t: string, i: number) => (i === 0 ? 0 : t.lastIndexOf("\n", i - 1) + 1);
const lineEnd = (t: string, i: number) => {
  const n = t.indexOf("\n", i);
  return n < 0 ? t.length : n;
};
/** Normal mode sits on a character, never past the line's last one. */
const clamp = (t: string, i: number) => Math.max(lineStart(t, i), Math.min(i, lineEnd(t, i) - 1));
const firstNonBlank = (t: string, i: number) => {
  let j = lineStart(t, i);
  while (j < lineEnd(t, i) && /\s/.test(t.charAt(j))) j++;
  return j;
};

function wordStart(t: string, i: number): number {
  let j = i;
  const k = kind(t[j]);
  if (k > 0) while (kind(t[j]) === k) j++;
  while (kind(t[j]) === 0) j++;
  return j;
}

function wordEnd(t: string, i: number): number {
  let j = i + 1;
  while (kind(t[j]) === 0) j++;
  const k = kind(t[j]);
  if (k > 0) while (kind(t[j + 1]) === k) j++;
  return Math.min(j, t.length - 1);
}

function wordBack(t: string, i: number): number {
  let j = i - 1;
  while (j > 0 && kind(t[j]) === 0) j--;
  const k = kind(t[j]);
  while (j > 0 && kind(t[j - 1]) === k) j--;
  return Math.max(j, 0);
}

function lineDown(t: string, i: number, by: 1 | -1): number {
  const col = i - lineStart(t, i);
  const s = by > 0 ? lineEnd(t, i) + 1 : lineStart(t, i) - 1;
  if (s < 0 || s > t.length) return i;
  const target = lineStart(t, s);
  return clamp(t, Math.min(target + col, lineEnd(t, target)));
}

const motions: Record<string, (t: string, i: number) => number> = {
  h: (t, i) => Math.max(lineStart(t, i), i - 1),
  l: (t, i) => clamp(t, i + 1),
  j: (t, i) => lineDown(t, i, 1),
  k: (t, i) => lineDown(t, i, -1),
  w: (t, i) => clamp(t, wordStart(t, i)),
  b: wordBack,
  e: (t, i) => clamp(t, wordEnd(t, i)),
  "0": lineStart,
  $: (t, i) => clamp(t, lineEnd(t, i)),
  G: (t) => lineStart(t, t.length),
};

const splice = (t: string, from: number, to: number, insert = "") => t.slice(0, from) + insert + t.slice(to);

/** End of what `dw` deletes from `i`: up to the next word, but not past the end of the line. */
const dwEnd = (t: string, i: number) => Math.min(Math.max(wordStart(t, i), i + 1), lineEnd(t, i));
/** End of what `cw` changes: the rest of this word (or blank run), not the blanks after it. */
function cwEnd(t: string, i: number): number {
  let j = i;
  const k = kind(t[j]);
  while (j < lineEnd(t, i) && kind(t[j]) === k) j++;
  return j;
}

export interface Result { vim: Vim; buf: Buffer; handled: boolean }

/**
 * Applies `key` (a `KeyboardEvent.key`, no Ctrl/Alt/Meta) to the buffer. `handled` false means
 * the textarea (or the page) should do its default: insert mode types, Esc in normal leaves the field.
 */
export function vimKey(vim: Vim, buf: Buffer, key: string): Result {
  const { text: t, cursor: i } = buf;
  const same = (v: Partial<Vim> = {}, b: Buffer = buf): Result => ({ vim: { ...vim, pending: "", ...v }, buf: b, handled: true });
  const edit = (b: Buffer, v: Partial<Vim> = {}): Result => same({ undo: [...vim.undo, buf].slice(-UNDO_LIMIT), ...v }, b);
  const insert = (cursor: number, text = t) => edit({ text, cursor }, { mode: "insert" });

  if (vim.mode === "insert") {
    if (key !== "Escape") return { vim, buf, handled: false };
    // Entering insert saved an undo step; drop it if nothing was typed.
    const undo = vim.undo[vim.undo.length - 1]?.text === t ? vim.undo.slice(0, -1) : vim.undo;
    return same({ mode: "normal", undo }, { text: t, cursor: clamp(t, i > lineStart(t, i) ? i - 1 : i) });
  }

  const op = vim.pending + key;
  switch (op) {
    case "gg": return same({}, { text: t, cursor: 0 });
    case "dd":
    case "yy": {
      const s = lineStart(t, i), e = lineEnd(t, i);
      const register = { text: t.slice(s, e), linewise: true };
      if (op === "yy") return same({ register });
      const [from, to] = e < t.length ? [s, e + 1] : [Math.max(s - 1, 0), e];
      const text = splice(t, from, to);
      return edit({ text, cursor: firstNonBlank(text, Math.min(from, text.length)) }, { register });
    }
    case "dw":
    case "cw": {
      const e = op === "dw" ? dwEnd(t, i) : cwEnd(t, i);
      const register = { text: t.slice(i, e), linewise: false };
      const text = splice(t, i, e);
      return edit({ text, cursor: op === "dw" ? clamp(text, i) : i }, { register, mode: op === "cw" ? "insert" : "normal" });
    }
  }
  if (vim.pending) return same();

  const motion = motions[key];
  if (motion) return same({}, { text: t, cursor: motion(t, i) });
  switch (key) {
    case "d": case "c": case "y": case "g": return same({ pending: key });
    case "i": return insert(i);
    case "a": return insert(Math.min(i + 1, lineEnd(t, i)));
    case "I": return insert(firstNonBlank(t, i));
    case "A": return insert(lineEnd(t, i));
    case "o": { const e = lineEnd(t, i); return insert(e + 1, splice(t, e, e, "\n")); }
    case "O": { const s = lineStart(t, i); return insert(s, splice(t, s, s, "\n")); }
    case "x": {
      if (i >= lineEnd(t, i)) return same();
      const text = splice(t, i, i + 1);
      return edit({ text, cursor: clamp(text, i) }, { register: { text: t.charAt(i), linewise: false } });
    }
    case "p": {
      const r = vim.register;
      if (!r) return same();
      if (r.linewise) {
        const e = lineEnd(t, i);
        return edit({ text: splice(t, e, e, `\n${r.text}`), cursor: e + 1 });
      }
      const at = Math.min(i + 1, lineEnd(t, i));
      return edit({ text: splice(t, at, at, r.text), cursor: at + r.text.length - 1 });
    }
    case "u": {
      const prev = vim.undo[vim.undo.length - 1];
      return prev ? same({ undo: vim.undo.slice(0, -1) }, { text: prev.text, cursor: clamp(prev.text, prev.cursor) }) : same();
    }
    case "Escape": return { vim, buf, handled: false };
  }
  // Anything else in normal mode is swallowed rather than typed.
  return NATIVE.test(key) ? { vim, buf, handled: false } : same();
}

// A per-device preference like the shortcuts, so it lives in localStorage, not the database.
const STORAGE_KEY = "lattice.chatVim";

export function vimEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function setVimEnabled(on: boolean) {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "on");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Blocked storage: the change lasts until the chat pane re-reads it.
  }
}
