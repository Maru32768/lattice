// What the editor can use of a .vimrc. Pure and free of CodeMirror: Settings lists the skipped lines without loading the editor.
import { EX_ALIASES } from "../lib/keymap.ts";

export type VimrcContext = "normal" | "visual" | "insert" | null;
export type SkipReason = "plugin" | "script" | "mode" | "expr" | "unknownEx" | "unknownOption" | "app";
export type VimrcEntry =
  | { kind: "ex"; line: number; ex: string }
  | { kind: "nop"; line: number; lhs: string; context: VimrcContext }
  /** A key that gives up the engine's own command in these modes, which comes before every mapping: a mapping written earlier stays. */
  | { kind: "free"; line: number; lhs: string; modes: FreedMode[] }
  | { kind: "skip"; line: number; text: string; reason: SkipReason };
/** Insert mode has no command for a key to give up: there a key is text. */
export type FreedMode = "normal" | "visual";
const BOTH_MODES: FreedMode[] = ["normal", "visual"];
export interface KnownNames {
  ex: Set<string>;
  options: Set<string>;
}

/** The ways Vim lets a command be shortened: from `short` up to its full name. */
const spell = (full: string, short = full) => Array.from({ length: full.length - short.length + 1 }, (_, i) => full.slice(0, short.length + i));

/** The engine's Ex commands as [name, shortest spelling]. A test holds these two tables to the engine. */
export const ENGINE_EX: [string, string?][] = [
  ["colorscheme", "colo"],
  ["map"],
  ["imap", "im"],
  ["nmap", "nm"],
  ["vmap", "vm"],
  ["omap", "om"],
  ["noremap", "no"],
  ["nnoremap", "nn"],
  ["vnoremap", "vn"],
  ["inoremap", "ino"],
  ["onoremap", "ono"],
  ["unmap"],
  ["mapclear", "mapc"],
  ["nmapclear", "nmapc"],
  ["vmapclear", "vmapc"],
  ["imapclear", "imapc"],
  ["omapclear", "omapc"],
  ["write", "w"],
  ["undo", "u"],
  ["redo", "red"],
  ["set", "se"],
  ["setlocal", "setl"],
  ["setglobal", "setg"],
  ["sort", "sor"],
  ["substitute", "s"],
  ["startinsert", "start"],
  ["nohlsearch", "noh"],
  ["yank", "y"],
  ["put", "pu"],
  ["delmarks", "delm"],
  ["marks"],
  ["registers", "reg"],
  ["vglobal", "v"],
  ["delete", "d"],
  ["join", "j"],
  ["normal", "norm"],
  ["global", "g"],
  ["version", "ve"],
];
export const ENGINE_OPTIONS = ["filetype", "ft", "textwidth", "tw", "langmap", "lmap", "pcre", "insertModeEscKeysTimeout"];

/** What the editor understands: the engine's names, and the ones the editor defines on top of it. */
export const KNOWN: KnownNames = {
  ex: new Set([
    ...ENGINE_EX.flatMap(([name, short]) => spell(name, short)),
    ...spell("quit", "q"),
    ...spell("wincmd", "winc"),
    ...Object.keys(EX_ALIASES).filter((name) => !name.includes("=")),
  ]),
  options: new Set([...ENGINE_OPTIONS, "clipboard", "cb"]),
};

const table = (rows: [string, string?][]) => new Set(rows.flatMap(([full, short]) => spell(full, short)));

/** The engine has no x maps: visual maps stand in for them. */
const MAPS = new Map(
  (
    [
      ["map", "map", "map"],
      ["nmap", "nm", "nmap"],
      ["vmap", "vm", "vmap"],
      ["xmap", "xm", "vmap"],
      ["imap", "im", "imap"],
      ["omap", "om", "omap"],
      ["noremap", "no", "noremap"],
      ["nnoremap", "nn", "nnoremap"],
      ["vnoremap", "vn", "vnoremap"],
      ["xnoremap", "xn", "vnoremap"],
      ["inoremap", "ino", "inoremap"],
      ["onoremap", "ono", "onoremap"],
    ] as const
  ).flatMap(([full, short, as]) => spell(full, short).map((s) => [s, as] as const)),
);
const NO_SUCH_MODE = table([
  ["tnoremap", "tno"],
  ["tmap", "tma"],
  ["tunmap", "tunma"],
  ["cnoremap", "cno"],
  ["cmap", "cm"],
  ["cunmap", "cu"],
  ["snoremap", "snor"],
  ["smap"],
  ["sunmap", "sunm"],
  ["lnoremap", "ln"],
  ["lmap", "lm"],
  ["lunmap", "lu"],
  ["map!"],
  ["noremap!"],
  ["unmap!"],
]);
const SET = table([
  ["set", "se"],
  ["setlocal", "setl"],
  ["setglobal", "setg"],
]);
const CLEARS = table([["unmap"], ["mapclear", "mapc"], ["nmapclear", "nmapc"], ["vmapclear", "vmapc"], ["imapclear", "imapc"], ["omapclear", "omapc"]]);
const SCRIPT = table([
  ["autocmd", "au"],
  ["let"],
  ["unlet", "unl"],
  ["call", "cal"],
  ["colorscheme", "colo"],
  ["highlight", "hi"],
  ["syntax", "sy"],
  ["filetype", "filet"],
  ["source", "so"],
  ["runtime", "ru"],
  ["command", "com"],
  ["execute", "exe"],
  ["echo", "ec"],
  ["echomsg", "echom"],
  ["scriptencoding", "scripte"],
  ["packadd", "pa"],
  ["abbreviate", "ab"],
  ["iabbrev", "ia"],
  ["cabbrev", "ca"],
  ["language", "lan"],
]);
const OPENS = table([["if"], ["function", "fu"], ["augroup", "aug"], ["for"], ["while", "wh"], ["try"]]);
const CLOSES = table([
  ["endif", "en"],
  ["endfunction", "endf"],
  ["endfor", "endfo"],
  ["endwhile", "endw"],
  ["endtry", "endt"],
]);

const word = (s: string) => /^\w*/.exec(s)![0];

/** How deep inside if / function / augroup blocks the statements of `s` end. */
function depthAfter(s: string, depth: number): number {
  let d = depth;
  for (const part of s.split("|").map((p) => p.trim())) {
    const w = word(part);
    if (CLOSES.has(w) || /^aug\w*\s+end$/i.test(part)) {
      d--;
    } else if (OPENS.has(w)) {
      d++;
    }
  }
  return Math.max(d, 0);
}

/** Lines with `\` continuations folded in, each numbered where it starts. */
function logicalLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const more = /^\s*\\(.*)$/.exec(raw);
    const last = out[out.length - 1];
    if (more && last) {
      last.text += more[1];
    } else {
      out.push({ line: i + 1, text: raw });
    }
  });
  return out;
}

const KEY_NAMES = new Map(
  Object.entries({
    cr: "CR",
    return: "CR",
    enter: "CR",
    esc: "Esc",
    space: "Space",
    tab: "Tab",
    bs: "BS",
    del: "Del",
    delete: "Del",
    ins: "Ins",
    insert: "Ins",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
  }),
);

/** Key names in the spelling the engine matches, which is the one it makes from key events: `<c-h>` is `<C-h>`, `<esc>` is `<Esc>`. */
function engineKeys(keys: string): string {
  return keys.replace(/<((?:[csma]-)*)([^<>\s]+)>/gi, (whole, mods: string, name: string) => {
    const upper = mods.toUpperCase();
    const shift = upper.includes("S-");
    const single = name.length === 1;
    const known = KEY_NAMES.get(name.toLowerCase()) ?? (/^f\d+$/i.test(name) ? name.toUpperCase() : undefined);
    // Other brackets are text: a mapping can type `<b>`.
    if (!known && !(single && mods)) {
      return whole;
    }
    const prefix = ["C-", "A-", "M-", "S-"].filter((m) => upper.includes(m)).join("");
    // A shifted character is its capital; only with another modifier does the event also say S-.
    if (single && prefix === "S-") {
      return name.toUpperCase();
    }
    return `<${prefix}${known ?? (shift ? name.toUpperCase() : name.toLowerCase())}>`;
  });
}

/** Whether `set <word>` names an option: `word`, `noword`, `word!`, `word=value`. */
function optionKnown(word: string, known: KnownNames): boolean {
  const name = word.replace(/!$|=.*$/, "");
  return known.options.has(name) || (name.startsWith("no") && known.options.has(name.slice(2)));
}

/** Why the Ex commands a mapping's right-hand side runs cannot run here. */
function rhsProblem(rhs: string, insert: boolean, known: KnownNames): SkipReason | null {
  // In insert mode a colon is text, until the mapping leaves insert mode.
  const from = insert ? rhs.search(/<Esc>|<C-o>/) : 0;
  if (from < 0) {
    return null;
  }
  // A colon a motion or a register takes is no Ex command (`f:`, `":`); after `gt` or `zt`, whole commands themselves, it is, while `gg` and `zz` leave the `f` its own.
  for (const [, ex] of rhs.slice(from).matchAll(/(?<!(?:^|[^gz]|gg|zz)[fFtTr]|"):(.*?)(?:<CR>|$)/g)) {
    const m = /^(?:%|(?:[.$\d+-]|'.)*(?:,(?:[.$\d+-]|'.)*)?)\s*(\w+|[!#&*<=>@~])?\s*(.*)$/.exec(ex!);
    const name = m?.[1];
    if (!name) {
      continue;
    }
    if (!known.ex.has(name)) {
      return "unknownEx";
    }
    if (SET.has(name) && m[2]!.split(/\s+/).some((w) => w && !optionKnown(w, known))) {
      return "unknownOption";
    }
  }
  return null;
}

const NOP_CONTEXT: Partial<Record<string, VimrcContext>> = {
  map: null,
  noremap: null,
  nmap: "normal",
  nnoremap: "normal",
  vmap: "visual",
  vnoremap: "visual",
  imap: "insert",
  inoremap: "insert",
};

function parseMap(line: number, text: string, cmd: string, rest: string, known: KnownNames): VimrcEntry {
  const skip = (reason: SkipReason): VimrcEntry => ({ kind: "skip", line, text, reason });
  const special = /^(?:<(?:silent|unique|script|nowait|buffer|expr)>\s*)*/i.exec(rest)![0];
  if (/<expr>/i.test(special)) {
    return skip("expr");
  }
  const parts = /^(\S+)\s+(.+)$/.exec(rest.slice(special.length));
  if (!parts) {
    return skip("script");
  }
  const lhs = engineKeys(parts[1]!);
  // `:<C-u>` clears the range Vim prefills; the engine prefills none, and would type those keys into the command.
  const rhs = engineKeys(parts[2]!).replace(/:<C-u>/g, ":");
  if (lhs.startsWith("<C-w>") || rhs.startsWith("<C-w>")) {
    return skip("app");
  }
  if (EX_NAME.test(lhs)) {
    return skip("script");
  }
  if (/^<nop>$/i.test(rhs)) {
    const context = NOP_CONTEXT[cmd];
    return context === undefined ? skip("mode") : { kind: "nop", line, lhs, context };
  }
  const problem = rhsProblem(rhs, cmd.startsWith("i"), known);
  return problem ? skip(problem) : { kind: "ex", line, ex: `${cmd} ${lhs} ${rhs}` };
}

function parseSet(line: number, text: string, known: KnownNames): VimrcEntry[] {
  // Only here is `"` a comment: a mapping's right-hand side can hold one, as in `"zyiw`.
  return text
    .replace(/\s*".*$/, "")
    .split("|")
    .flatMap((statement): VimrcEntry[] => {
      const [cmd = "", ...words] = statement.trim().split(/\s+/);
      if (!SET.has(cmd)) {
        return [{ kind: "skip", line, text: statement.trim(), reason: "script" }];
      }
      return words.map((w) => {
        const unknown: VimrcEntry = { kind: "skip", line, text: `set ${w}`, reason: "unknownOption" };
        const op = /^(\w+)([-+^]=)(.*)$/.exec(w);
        if (op) {
          // The engine's set has no `+=`; `clipboard`, the option it is written for, is on or off here.
          return (op[1] === "clipboard" || op[1] === "cb") && op[2] !== "-=" ? { kind: "ex", line, ex: `set clipboard=${op[3]}` } : unknown;
        }
        return optionKnown(w, known) ? { kind: "ex", line, ex: `set ${w}` } : unknown;
      });
    });
}

const DEFAULT_LEADER = "\\";
/** A key that to the engine names an Ex command: its `map` and `unmap` refuse one with a mode, and `unmap` throws. */
const EX_NAME = /^:./;

/** A leader as written in `let mapleader = "..."`, spelled as a key. As in Vim, an empty one is the default. */
function leaderKey(value: string): string {
  const key = value.replace(/\\(<[^>]+>)/, "$1").replace(/\\([\\"])/, "$1");
  return engineKeys(key === " " ? "<Space>" : key || DEFAULT_LEADER);
}

/** The entries of `text`, in order: what applies and, with a reason, what does not. */
export function parseVimrc(text: string, known: KnownNames): VimrcEntry[] {
  let out: VimrcEntry[] = [];
  const leaders = { mapleader: DEFAULT_LEADER, maplocalleader: DEFAULT_LEADER };
  let depth = 0;
  for (const { line, text: raw } of logicalLines(text)) {
    const original = raw.trim().replace(/^:+\s*/, "");
    if (!original || original.startsWith('"')) {
      continue;
    }
    const inBlock = depth > 0;
    if (inBlock || OPENS.has(word(original))) {
      if (!inBlock) {
        out.push({ kind: "skip", line, text: original, reason: "script" });
      }
      depth = depthAfter(original, depth);
      continue;
    }
    const skip = (reason: SkipReason): VimrcEntry => ({ kind: "skip", line, text: original, reason });
    const leader = /^let\s+(?:g:)?(map(?:local)?leader)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:".*)?$/.exec(original);
    if (leader) {
      const key = leaderKey(leader[2] ?? leader[3]!);
      leaders[leader[1] as keyof typeof leaders] = key;
      // A key with a command of its own runs at once, so without this `<leader>x` could never be reached.
      out.push(EX_NAME.test(key) ? skip("script") : { kind: "free", line, lhs: key, modes: BOTH_MODES });
      continue;
    }
    const s = original.replace(/<(local)?leader>/gi, (_, local?: string) => (local ? leaders.maplocalleader : leaders.mapleader));
    // A leader of spaces can leave nothing here, and a line can hold a lone CR, where `.` alone stops. This pattern matches any text.
    const [, cmd = "", rest = ""] = /^(\S*)\s*(.*)$/s.exec(s)!;
    if (/<plug>/i.test(s) || /^plug\s/i.test(s) || /^call\s+plug#/.test(s)) {
      out.push(skip("plugin"));
    } else if (MAPS.has(cmd)) {
      out.push(parseMap(line, original, MAPS.get(cmd)!, rest, known));
    } else if (NO_SUCH_MODE.has(cmd)) {
      out.push(skip("mode"));
    } else if (SET.has(cmd)) {
      out.push(...parseSet(line, s, known));
    } else if (cmd === "unmap" && rest) {
      // As in Vim, it undoes what the file mapped so far in these modes and the key's own command stays. With nothing to undo, that command goes.
      const lhs = engineKeys(rest);
      const kept = out.filter((e) => {
        const m = mappingOf(e);
        return m?.lhs !== lhs || m.modes.includes("insert");
      });
      out = kept.length < out.length ? kept : [...out, EX_NAME.test(lhs) ? skip("script") : { kind: "free", line, lhs, modes: BOTH_MODES }];
    } else if (CLEARS.has(cmd)) {
      out = cmd === "unmap" ? out : out.filter((e) => !clearedBy(cmd, e));
      out.push({ kind: "ex", line, ex: `${cmd} ${engineKeys(rest)}`.trim() });
    } else if (SCRIPT.has(cmd.replace(/!$/, "")) || known.ex.has(cmd)) {
      // A command the engine could run edits the text, which is no setting to run whenever the vimrc loads.
      out.push(skip("script"));
    } else {
      out.push(skip("unknownEx"));
    }
  }
  // The engine runs a whole match at once, however many longer mappings share its start, so a key that does nothing
  // on its own and leads others must not be mapped: with no command of its own it waits for the next key.
  const mappings = out.flatMap((e) => mappingOf(e) ?? []);
  return out.flatMap((e): VimrcEntry[] => {
    const nop = e.kind === "nop" ? mappingOf(e)! : null;
    const leads = nop && mappings.some((m) => m.lhs !== nop.lhs && m.lhs.startsWith(nop.lhs) && m.modes.some((mode) => nop.modes.includes(mode)));
    if (!leads) {
      return [e];
    }
    const modes = nop.modes.filter((mode) => mode !== "insert");
    return modes.length ? [{ kind: "free", line: e.line, lhs: nop.lhs, modes }] : [];
  });
}

type Mode = "normal" | "visual" | "insert";
/** The modes a map command works in, by its first letter. Operator-pending keys wait in normal mode. */
const MODES_OF: Record<string, Mode[]> = { "": ["normal", "visual"], n: ["normal"], o: ["normal"], v: ["visual"], i: ["insert"] };
/** A mapping's line: its mode letter, for which the `n` of `noremap` does not count, and its key. */
const MAP_LINE = /^(n|o|v|i|)(?:nore)?map (\S+)/;

function mappingOf(e: VimrcEntry): { lhs: string; modes: Mode[] } | null {
  if (e.kind === "nop") {
    return { lhs: e.lhs, modes: e.context ? [e.context] : MODES_OF[""]! };
  }
  const m = e.kind === "ex" ? MAP_LINE.exec(e.ex) : null;
  return m && { lhs: m[2]!, modes: MODES_OF[m[1]!]! };
}

/**
 * Whether a clear command leaves nothing of mapping `e`, as the engine runs it: plain `mapclear` takes every mode.
 * shortcut: a `map` under `nmapclear` still counts as mapped in normal mode, upgrade if a vimrc needs the app's key back there.
 */
function clearedBy(cmd: string, e: VimrcEntry): boolean {
  if (e.kind !== "nop" && !mappingOf(e)) {
    return false;
  }
  const mode = /^[nvio]?/.exec(cmd)![0];
  const mapped = e.kind === "nop" ? (e.context?.charAt(0) ?? "") : e.kind === "ex" ? MAP_LINE.exec(e.ex)![1]! : "";
  return !mode || mode === mapped;
}

/**
 * By mode, the keys the entries' mappings start with: in that mode the vimrc, not the app, has asked for them.
 * shortcut: a later key of a mapping still goes to the app if the app binds it, upgrade if a vimrc needs that.
 */
export function mappedKeys(entries: VimrcEntry[]): Record<Mode, Set<string>> {
  const out = { normal: new Set<string>(), visual: new Set<string>(), insert: new Set<string>() };
  for (const m of entries.flatMap((e) => mappingOf(e) ?? [])) {
    m.modes.forEach((mode) => out[mode].add(/^<[^>]+>|^./.exec(m.lhs)![0]));
  }
  return out;
}
