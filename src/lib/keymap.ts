// The key language: canonical key names, the registry of actions with their default keys, and the
// state machine that reads keys. Pure (no React, no storage), so the page overlay runs the same code
// as the app; the user's changes to the bindings persist in keys.ts.
import type { T } from "../i18n/index.ts";
import type { PaneMove } from "../layout/panes.ts";

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Unidentified", "Process"]);

/** Canonical key ("Ctrl+K", "Shift+Enter", "J", "/", "ArrowDown"); null for a lone modifier. */
export function keyOf(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
  if (MODIFIERS.has(e.key)) {
    return null;
  }
  const k = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  // A printed symbol already carries Shift ("?" is Shift+/); letters and named keys keep it.
  const shift = e.shiftKey && (e.key.length > 1 || e.key === " " || /^[a-z]$/i.test(e.key));
  return `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${shift ? "Shift+" : ""}${k}`;
}

export type ActionId =
  | PaneMove
  | "palette"
  | "command"
  | "keyHelp"
  | "escape"
  | "paneLast"
  | "paneNumbers"
  | "paneGrowLeft"
  | "paneGrowRight"
  | "paneGrowUp"
  | "paneGrowDown"
  | "paneSwapPrev"
  | "paneSwapNext"
  | "paneEven"
  | "closePane"
  | "splitRight"
  | "splitDown"
  | "focus"
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "tabByNumber"
  | "tabList"
  | "popOut"
  | "favorite"
  | "read"
  | "view"
  | "summary"
  | "less"
  | "more"
  | "saveWord"
  | "speak"
  | "back"
  | "forward"
  | "moveUp"
  | "moveDown"
  | "search"
  | "next"
  | "prev"
  | "listFirst"
  | "listLast"
  | "listHalfDown"
  | "listHalfUp"
  | "open"
  | "openPage"
  | "scrollDown"
  | "scrollUp"
  | "scrollLeft"
  | "scrollRight"
  | "halfDown"
  | "halfUp"
  | "docTop"
  | "docBottom"
  | "nextArticle"
  | "prevArticle"
  | "docFind"
  | "findNext"
  | "findPrev"
  | "hints"
  | "hintsNew"
  | "wordHints"
  | "visual"
  | "nextHeading"
  | "prevHeading"
  | "focusInput"
  | "docBack"
  | "docForward"
  | "copyUrl"
  | "print";

export type KeyScope = "list" | "doc";

export interface ActionDef {
  id: ActionId;
  keys: string[];
  /** Where the keyboard must be for these keys to run. Undefined: everywhere. */
  scope?: KeyScope;
  /** Also runs while focus is in a text field. */
  inFields?: boolean;
  /** Takes a count: 5j. */
  counted?: boolean;
  /** As tmux -r: after running, its second key alone runs it again for REPEAT_MS. */
  repeat?: boolean;
  /** Runs inside the document itself, not in the app. */
  local?: boolean;
}

/**
 * A binding is one key or, as in tmux, two pressed in turn: `Ctrl+B "`. No single key contains a
 * space (the space bar is "Space"), so a space always separates the two.
 */
export const ACTIONS: ActionDef[] = [
  { id: "palette", keys: ["Ctrl+P"], inFields: true },
  { id: "command", keys: [":", ";", "Ctrl+B :"], inFields: true },
  { id: "keyHelp", keys: ["?", "Ctrl+B ?"], inFields: true },
  { id: "escape", keys: ["Escape"], inFields: true },
  { id: "paneLeft", keys: ["Ctrl+H", "Ctrl+B ArrowLeft", "Ctrl+B H"], inFields: true },
  { id: "paneDown", keys: ["Ctrl+J", "Ctrl+B ArrowDown", "Ctrl+B J"], inFields: true },
  { id: "paneUp", keys: ["Ctrl+K", "Ctrl+B ArrowUp", "Ctrl+B K"], inFields: true },
  { id: "paneRight", keys: ["Ctrl+L", "Ctrl+B ArrowRight", "Ctrl+B L"], inFields: true },
  { id: "paneNext", keys: ["Ctrl+B O"], inFields: true },
  { id: "paneLast", keys: ["Ctrl+B ;"], inFields: true },
  { id: "paneNumbers", keys: ["Ctrl+B Q"], inFields: true },
  { id: "paneGrowLeft", keys: ["Ctrl+B Shift+H", "Ctrl+B Ctrl+ArrowLeft"], inFields: true, repeat: true },
  { id: "paneGrowRight", keys: ["Ctrl+B Shift+L", "Ctrl+B Ctrl+ArrowRight"], inFields: true, repeat: true },
  { id: "paneGrowUp", keys: ["Ctrl+B Shift+K", "Ctrl+B Ctrl+ArrowUp"], inFields: true, repeat: true },
  { id: "paneGrowDown", keys: ["Ctrl+B Shift+J", "Ctrl+B Ctrl+ArrowDown"], inFields: true, repeat: true },
  { id: "paneSwapPrev", keys: ["Ctrl+B {"], inFields: true },
  { id: "paneSwapNext", keys: ["Ctrl+B }"], inFields: true },
  { id: "paneEven", keys: ["Ctrl+B Shift+E"], inFields: true },
  { id: "closePane", keys: ["Ctrl+B X"], inFields: true },
  { id: "splitRight", keys: ["Ctrl+\\", "Ctrl+B %"], inFields: true },
  { id: "splitDown", keys: ["Ctrl+-", 'Ctrl+B "'], inFields: true },
  { id: "focus", keys: ["Ctrl+B Z"], inFields: true },
  { id: "newTab", keys: ["Ctrl+T", "Ctrl+B C"], inFields: true },
  { id: "closeTab", keys: ["Ctrl+W", "Ctrl+B &"], inFields: true },
  { id: "nextTab", keys: ["Ctrl+Tab", "Ctrl+B N", "G T"], inFields: true },
  { id: "prevTab", keys: ["Ctrl+Shift+Tab", "Ctrl+B P", "G Shift+T"], inFields: true },
  // One action for all ten: the handler reads the number off the sequence, 0 being the tenth.
  { id: "tabByNumber", keys: [..."1234567890"].map((d) => `Ctrl+B ${d}`), inFields: true },
  { id: "tabList", keys: ["Ctrl+B W"], inFields: true },
  { id: "popOut", keys: ["Ctrl+Shift+N", "Ctrl+B !"], inFields: true },
  { id: "favorite", keys: ["S"] },
  { id: "read", keys: ["M"] },
  { id: "view", keys: ["G V"] },
  { id: "summary", keys: ["G Y"] },
  { id: "less", keys: ["-"] },
  { id: "more", keys: ["="] },
  { id: "saveWord", keys: ["W"] },
  { id: "speak", keys: ["R"] },
  { id: "back", keys: ["Alt+ArrowLeft"] },
  { id: "forward", keys: ["Alt+ArrowRight"] },
  // A focused feed or folder in the sidebar moves (H26); the row handles these keys itself.
  { id: "moveUp", keys: ["Alt+ArrowUp"] },
  { id: "moveDown", keys: ["Alt+ArrowDown"] },

  { id: "search", keys: ["/"], scope: "list" },
  { id: "next", keys: ["J", "ArrowDown"], scope: "list", counted: true },
  { id: "prev", keys: ["K", "ArrowUp"], scope: "list", counted: true },
  { id: "listFirst", keys: ["G G"], scope: "list" },
  { id: "listLast", keys: ["Shift+G"], scope: "list" },
  { id: "listHalfDown", keys: ["D", "Ctrl+D"], scope: "list", counted: true },
  { id: "listHalfUp", keys: ["U", "Ctrl+U"], scope: "list", counted: true },
  { id: "open", keys: ["Enter"], scope: "list" },
  { id: "openPage", keys: ["Shift+Enter"], scope: "list" },

  { id: "scrollDown", keys: ["J"], scope: "doc", counted: true, local: true },
  { id: "scrollUp", keys: ["K"], scope: "doc", counted: true, local: true },
  { id: "scrollLeft", keys: ["H"], scope: "doc", counted: true, local: true },
  { id: "scrollRight", keys: ["L"], scope: "doc", counted: true, local: true },
  { id: "halfDown", keys: ["D", "Ctrl+D"], scope: "doc", counted: true, local: true },
  { id: "halfUp", keys: ["U", "Ctrl+U"], scope: "doc", counted: true, local: true },
  { id: "docTop", keys: ["G G"], scope: "doc", local: true },
  { id: "docBottom", keys: ["Shift+G"], scope: "doc", local: true },
  { id: "nextArticle", keys: ["Shift+J"], scope: "doc", counted: true },
  { id: "prevArticle", keys: ["Shift+K"], scope: "doc", counted: true },
  { id: "docFind", keys: ["/"], scope: "doc", local: true },
  { id: "findNext", keys: ["N"], scope: "doc", local: true },
  { id: "findPrev", keys: ["Shift+N"], scope: "doc", local: true },
  { id: "hints", keys: ["F"], scope: "doc", local: true },
  { id: "hintsNew", keys: ["Shift+F"], scope: "doc", local: true },
  { id: "wordHints", keys: ["G W"], scope: "doc", local: true },
  { id: "visual", keys: ["V", "Ctrl+B ["], scope: "doc", local: true },
  { id: "nextHeading", keys: ["] ]"], scope: "doc", local: true },
  { id: "prevHeading", keys: ["[ ["], scope: "doc", local: true },
  { id: "focusInput", keys: ["G I"], scope: "doc", local: true },
  { id: "docBack", keys: ["Shift+H"], scope: "doc", local: true },
  { id: "docForward", keys: ["Shift+L"], scope: "doc", local: true },
  { id: "copyUrl", keys: ["Y Y"], scope: "doc" },
  { id: "print", keys: ["Ctrl+Shift+P"], scope: "doc", local: true },
];

/** The actions by where they run, as Settings and the key help list them. */
export const ACTION_GROUPS = [
  { title: "keys.groupEverywhere", actions: ACTIONS.filter((a) => !a.scope) },
  { title: "keys.groupList", actions: ACTIONS.filter((a) => a.scope === "list") },
  { title: "keys.groupDoc", actions: ACTIONS.filter((a) => a.scope === "doc") },
] as const;

/** Ex-style names of actions, for the palette and the editor's command line: the one table of them. */
export const EX_ALIASES: Record<string, ActionId> = {
  split: "splitDown",
  vsplit: "splitRight",
  tabnew: "newTab",
  tabnext: "nextTab",
  tabprev: "prevTab",
  close: "closePane",
  zoom: "focus",
  only: "focus",
  tabclose: "closeTab",
  "wincmd=": "paneEven",
};

/** The keyboard's scope in pane `pane` (a `data-pane`): documents and the chat log are read, everything else is a list. */
export const scopeOf = (pane: string | null | undefined): KeyScope => (pane === "doc" || pane === "chat" ? "doc" : "list");

const applies = (a: ActionDef, scope?: KeyScope) => !scope || !a.scope || a.scope === scope;
export const scopesOverlap = (a: ActionDef, b: ActionDef) => !a.scope || !b.scope || a.scope === b.scope;

/**
 * Keys a focused page keeps: its Alt+← / Alt+→ (and mouse side buttons) are its own history, and
 * the word card's `speak` and the sidebar's row moves have nothing to do there.
 */
const PAGE_OWN = new Set<ActionId>(["saveWord", "speak", "back", "forward", "moveUp", "moveDown"]);

export type Bindings = Record<ActionId, string[]>;
/** The action's name in Settings, the palette and the shortcut help (`keys.<id>` in the catalogs). */
export const actionLabel = (t: T, id: ActionId) => t(`keys.${id}`);

export const DEFAULT_BINDINGS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.keys])) as Bindings;

export const merge = (overrides: Partial<Bindings>): Bindings => ({ ...DEFAULT_BINDINGS, ...overrides });

const NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Backspace: "⌫" };

/** Display form: "Ctrl+K" → "Ctrl K", "J" → "j", "ArrowDown" → "↓", `Ctrl+B "` → `Ctrl B › "`. */
export function keyLabel(k: string): string {
  const [first, second] = k.split(" ");
  if (second) {
    return `${keyLabel(first!)} › ${keyLabel(second)}`;
  }
  const mods: string[] = [];
  let rest = k;
  for (const m of ["Ctrl+", "Alt+", "Shift+"]) {
    if (rest.startsWith(m) && rest.length > m.length) {
      mods.push(m.slice(0, -1));
      rest = rest.slice(m.length);
    }
  }
  const name = NAMES[rest] ?? (rest.length === 1 && mods.length === 0 ? rest.toLowerCase() : rest);
  return [...mods, name].join(" ");
}

/** The action a key runs in `scope` (omitted: in any): the first in registry order that has it. */
export function actionFor(b: Bindings, key: string, scope?: KeyScope): ActionDef | undefined {
  return ACTIONS.find((a) => applies(a, scope) && b[a.id].includes(key));
}

/**
 * An action in `scope` whose two-key binding starts with `key`, preferring one that runs in text
 * fields so the first key works there if any of them does. Such a key waits for its second key:
 * alone, it never runs an action it is also bound to.
 */
export function chordFrom(b: Bindings, key: string, scope?: KeyScope): ActionDef | undefined {
  const all = ACTIONS.filter((a) => applies(a, scope) && b[a.id].some((k) => k.startsWith(`${key} `)));
  return all.find((a) => a.inFields) ?? all[0];
}

/** What can follow `first` in `scope`: each action with its second keys; a key on two actions counts for the first, as in `actionFor`. */
export function afterFirst(b: Bindings, first: string, scope?: KeyScope): [ActionId, string[]][] {
  const seen = new Set<string>();
  const out: [ActionId, string[]][] = [];
  for (const a of ACTIONS) {
    if (!applies(a, scope)) {
      continue;
    }
    const seconds = b[a.id].filter((k) => k.startsWith(`${first} `)).map((k) => k.slice(first.length + 1));
    const fresh = seconds.filter((k) => !seen.has(k));
    fresh.forEach((k) => seen.add(k));
    if (fresh.length) {
      out.push([a.id, fresh]);
    }
  }
  return out;
}

/** Keys on actions that can run at the same place, with those actions in registry order. `J` in a list and in a document is no conflict. */
export function conflicts(b: Bindings): Map<string, ActionDef[]> {
  const by = new Map<string, ActionDef[]>();
  for (const a of ACTIONS) {
    for (const k of b[a.id]) {
      by.set(k, [...(by.get(k) ?? []), a]);
    }
  }
  const out = new Map<string, ActionDef[]>();
  for (const [k, on] of by) {
    const clashing = on.filter((a) => on.some((o) => o !== a && scopesOverlap(a, o)));
    if (clashing.length) {
      out.set(k, clashing);
    }
  }
  return out;
}

// ---- the key state machine ----------------------------------------------------------------------

/** A key sequence under way: a chord's first key, a count, and the repeat window after a `repeat` action. */
export interface KeySeq {
  first: string | null;
  count: number;
  repeat: { first: string; until: number } | null;
}
export const IDLE: KeySeq = { first: null, count: 0, repeat: null };

export type KeyStep =
  /** Not ours: leave the event alone. */
  | { kind: "none"; seq: KeySeq }
  /** A digit of a count, or a chord's first key: swallow. */
  | { kind: "wait"; seq: KeySeq }
  /** Esc or an unbound second key ended a pending sequence: swallow. */
  | { kind: "cancel"; seq: KeySeq }
  | { kind: "run"; action: ActionDef; sequence: string; count: number; seq: KeySeq };

/** As tmux's repeat-time. */
export const REPEAT_MS = 500;

/** Typed text, not a shortcut, when a field has focus. */
export const isPrintable = (key: string) => key.replace(/^Shift\+/, "").length === 1;
/** A shortcut whatever has the focus, and a browser's own key to keep from it. */
export const isModified = (key: string) => /^(Ctrl|Alt)\+/.test(key);

function running(action: ActionDef, sequence: string, first: string | null, count: number, now: number): KeyStep {
  const repeat = action.repeat && first ? { first, until: now + REPEAT_MS } : null;
  return { kind: "run", action, sequence, count: action.counted ? Math.max(1, count) : 1, seq: { ...IDLE, repeat } };
}

/**
 * What `key` does after `seq`, with the keyboard in `scope`: the only key state machine, run by the
 * app for its own keys and by the page overlay for a page's. A pending first key has no timeout: it
 * stays until the next key, Esc or a pointer press.
 */
export function stepKeys(b: Bindings, seq: KeySeq, key: string, ctx: { scope: KeyScope; inField: boolean; now: number }): KeyStep {
  const { scope, inField, now } = ctx;
  const none: KeyStep = { kind: "none", seq: IDLE };
  const cancel: KeyStep = { kind: "cancel", seq: IDLE };
  const allowed = (a: ActionDef) => !inField || a.inFields;

  if (seq.first) {
    const sequence = `${seq.first} ${key}`;
    const a = key === "Escape" ? undefined : actionFor(b, sequence, scope);
    return a && allowed(a) ? running(a, sequence, seq.first, seq.count, now) : cancel;
  }
  if (seq.repeat && now < seq.repeat.until) {
    const sequence = `${seq.repeat.first} ${key}`;
    const a = actionFor(b, sequence, scope);
    if (a?.repeat && allowed(a)) {
      return running(a, sequence, seq.repeat.first, 1, now);
    }
  }
  // Even on an `inFields` action: a `g t` that runs in fields must not eat a typed g.
  if (inField && isPrintable(key)) {
    return none;
  }
  if (seq.count && key === "Escape") {
    return cancel;
  }
  const chord = chordFrom(b, key, scope);
  if (chord) {
    return allowed(chord) ? { kind: "wait", seq: { ...IDLE, first: key, count: seq.count } } : none;
  }
  const action = actionFor(b, key, scope);
  if (action) {
    return allowed(action) ? running(action, key, null, seq.count, now) : none;
  }
  if ((seq.count ? /^\d$/ : /^[1-9]$/).test(key)) {
    return { kind: "wait", seq: { ...IDLE, count: seq.count * 10 + Number(key) } };
  }
  return none;
}

// ---- keys in a page ------------------------------------------------------------------------------

/** What the page overlay needs while the page has keyboard focus. */
export interface PageKeys {
  /** The bindings that apply in a page, for `stepKeys`. */
  bindings: Bindings;
  /** The complete sequences of the app's own actions: all a page may press in the app. */
  sequences: string[];
  /** The chords' first keys, which the app is told of so it can show its hint. */
  first: string[];
}

export function pageKeys(b: Bindings): PageKeys {
  const bindings = {} as Bindings;
  const sequences = new Set<string>();
  const first = new Set<string>();
  for (const a of ACTIONS) {
    // A selection in the page is saved with the overlay's own button; back / forward are the page's history; no card speaks.
    const applicable = a.scope === "list" || PAGE_OWN.has(a.id) ? [] : b[a.id];
    // Enter, Escape, the arrows, Space stay the page's own: it navigates and scrolls with them.
    bindings[a.id] = applicable.filter((k) => isModified(k) || isPrintable(k.split(" ")[0]!));
    for (const k of bindings[a.id]) {
      if (!a.local) {
        sequences.add(k);
      }
      if (k.includes(" ")) {
        first.add(k.slice(0, k.indexOf(" ")));
      }
    }
  }
  return { bindings, sequences: [...sequences], first: [...first] };
}
