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
  | "sendPrefix"
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
  | "listPageDown"
  | "listPageUp"
  | "open"
  | "openPage"
  | "scrollDown"
  | "scrollUp"
  | "scrollLeft"
  | "scrollRight"
  | "halfDown"
  | "halfUp"
  | "pageDown"
  | "pageUp"
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

/** What a document runs (`createDocNav`, `browser_run_doc`): an action, or select all, which sending Ctrl+A does for a page that did not get the key. */
export type DocActionId = ActionId | "selectAll";

export type KeyScope = "list" | "doc";

/** What the keys are for, in the order of the tabs in Settings › Shortcuts and the headings of the key help. */
export const KEY_GROUPS = ["app", "list", "article", "doc", "tabs", "panes"] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];

export interface ActionDef {
  id: ActionId;
  group: KeyGroup;
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
  /**
   * As tmux's send-prefix: the sequence's last key, the prefix, goes on to what has the focus, which does with it what it
   * does without Lattice (with Ctrl+A, a field or a page selects all and Vim increments). The action runs only where the
   * key cannot go on: in a page whose keyboard the app's hint took. Its keys are fixed, since only the prefix is a key to
   * send: Settings › Shortcuts leaves it out, and a stored override is ignored.
   */
  passThrough?: boolean;
}

/** Stands for the prefix in a key, as tmux's `prefix` option: `<prefix> "`. `keyOf` never makes it, since a named key comes from `KeyboardEvent.key`. */
export const PREFIX = "<prefix>";
export const DEFAULT_PREFIX = "Ctrl+A";

/**
 * A binding is one key or, as in tmux, two pressed in turn: `<prefix> "`. No single key contains a
 * space (the space bar is "Space"), so a space always separates the two.
 */
export const ACTIONS: ActionDef[] = [
  { id: "palette", group: "app", keys: ["Ctrl+P"], inFields: true },
  { id: "command", group: "app", keys: [":", ";", "<prefix> :"], inFields: true },
  { id: "keyHelp", group: "app", keys: ["?", "<prefix> ?"], inFields: true },
  { id: "escape", group: "app", keys: ["Escape"], inFields: true },
  { id: "sendPrefix", group: "app", keys: ["<prefix> <prefix>"], inFields: true, passThrough: true },
  { id: "paneLeft", group: "panes", keys: ["Ctrl+H", "<prefix> ArrowLeft", "<prefix> H"], inFields: true },
  { id: "paneDown", group: "panes", keys: ["Ctrl+J", "<prefix> ArrowDown", "<prefix> J"], inFields: true },
  { id: "paneUp", group: "panes", keys: ["Ctrl+K", "<prefix> ArrowUp", "<prefix> K"], inFields: true },
  { id: "paneRight", group: "panes", keys: ["Ctrl+L", "<prefix> ArrowRight", "<prefix> L"], inFields: true },
  { id: "paneNext", group: "panes", keys: ["<prefix> O"], inFields: true },
  { id: "paneLast", group: "panes", keys: ["<prefix> ;"], inFields: true },
  { id: "paneNumbers", group: "panes", keys: ["<prefix> Q"], inFields: true },
  { id: "paneGrowLeft", group: "panes", keys: ["<prefix> Shift+H", "<prefix> Ctrl+ArrowLeft"], inFields: true, repeat: true },
  { id: "paneGrowRight", group: "panes", keys: ["<prefix> Shift+L", "<prefix> Ctrl+ArrowRight"], inFields: true, repeat: true },
  { id: "paneGrowUp", group: "panes", keys: ["<prefix> Shift+K", "<prefix> Ctrl+ArrowUp"], inFields: true, repeat: true },
  { id: "paneGrowDown", group: "panes", keys: ["<prefix> Shift+J", "<prefix> Ctrl+ArrowDown"], inFields: true, repeat: true },
  { id: "paneSwapPrev", group: "panes", keys: ["<prefix> {"], inFields: true },
  { id: "paneSwapNext", group: "panes", keys: ["<prefix> }"], inFields: true },
  { id: "paneEven", group: "panes", keys: ["<prefix> Shift+E"], inFields: true },
  { id: "closePane", group: "panes", keys: ["<prefix> X"], inFields: true },
  { id: "splitRight", group: "panes", keys: ["Ctrl+\\", "<prefix> %"], inFields: true },
  { id: "splitDown", group: "panes", keys: ["Ctrl+-", '<prefix> "'], inFields: true },
  { id: "focus", group: "panes", keys: ["<prefix> Z"], inFields: true },
  { id: "newTab", group: "tabs", keys: ["Ctrl+T", "<prefix> C"], inFields: true },
  { id: "closeTab", group: "tabs", keys: ["Ctrl+W", "<prefix> &"], inFields: true },
  { id: "nextTab", group: "tabs", keys: ["Ctrl+Tab", "<prefix> N", "G T"], inFields: true },
  { id: "prevTab", group: "tabs", keys: ["Ctrl+Shift+Tab", "<prefix> P", "G Shift+T"], inFields: true },
  // One action for all ten: the handler reads the number off the sequence, 0 being the tenth.
  { id: "tabByNumber", group: "tabs", keys: [..."1234567890"].map((d) => `<prefix> ${d}`), inFields: true },
  { id: "tabList", group: "tabs", keys: ["<prefix> W"], inFields: true },
  { id: "popOut", group: "tabs", keys: ["Ctrl+Shift+N", "<prefix> !"], inFields: true },
  { id: "favorite", group: "article", keys: ["S"] },
  { id: "read", group: "article", keys: ["M"] },
  { id: "view", group: "article", keys: ["G V"] },
  { id: "summary", group: "article", keys: ["G Y"] },
  { id: "less", group: "article", keys: ["-"] },
  { id: "more", group: "article", keys: ["="] },
  { id: "saveWord", group: "article", keys: ["W"] },
  { id: "speak", group: "article", keys: ["R"] },
  { id: "back", group: "app", keys: ["Alt+ArrowLeft"] },
  { id: "forward", group: "app", keys: ["Alt+ArrowRight"] },

  { id: "search", group: "list", keys: ["/"], scope: "list" },
  { id: "next", group: "list", keys: ["J", "ArrowDown"], scope: "list", counted: true },
  { id: "prev", group: "list", keys: ["K", "ArrowUp"], scope: "list", counted: true },
  { id: "listFirst", group: "list", keys: ["G G"], scope: "list" },
  { id: "listLast", group: "list", keys: ["Shift+G"], scope: "list" },
  { id: "listHalfDown", group: "list", keys: ["D", "Ctrl+D"], scope: "list", counted: true },
  { id: "listHalfUp", group: "list", keys: ["U", "Ctrl+U"], scope: "list", counted: true },
  { id: "listPageDown", group: "list", keys: ["Ctrl+F"], scope: "list", counted: true },
  { id: "listPageUp", group: "list", keys: ["Ctrl+B"], scope: "list", counted: true },
  { id: "open", group: "list", keys: ["Enter"], scope: "list" },
  { id: "openPage", group: "list", keys: ["Shift+Enter"], scope: "list" },
  // A focused feed or folder in the sidebar moves; the row handles these keys itself. Unscoped, but listed after the list's keys in their tab.
  { id: "moveUp", group: "list", keys: ["Alt+ArrowUp"] },
  { id: "moveDown", group: "list", keys: ["Alt+ArrowDown"] },

  { id: "scrollDown", group: "doc", keys: ["J"], scope: "doc", counted: true, local: true },
  { id: "scrollUp", group: "doc", keys: ["K"], scope: "doc", counted: true, local: true },
  { id: "scrollLeft", group: "doc", keys: ["H"], scope: "doc", counted: true, local: true },
  { id: "scrollRight", group: "doc", keys: ["L"], scope: "doc", counted: true, local: true },
  { id: "halfDown", group: "doc", keys: ["D", "Ctrl+D"], scope: "doc", counted: true, local: true },
  { id: "halfUp", group: "doc", keys: ["U", "Ctrl+U"], scope: "doc", counted: true, local: true },
  { id: "pageDown", group: "doc", keys: ["Ctrl+F"], scope: "doc", counted: true, local: true },
  { id: "pageUp", group: "doc", keys: ["Ctrl+B"], scope: "doc", counted: true, local: true },
  { id: "docTop", group: "doc", keys: ["G G"], scope: "doc", local: true },
  { id: "docBottom", group: "doc", keys: ["Shift+G"], scope: "doc", local: true },
  { id: "nextArticle", group: "article", keys: ["Shift+J"], scope: "doc", counted: true },
  { id: "prevArticle", group: "article", keys: ["Shift+K"], scope: "doc", counted: true },
  { id: "docFind", group: "doc", keys: ["/"], scope: "doc", local: true },
  { id: "findNext", group: "doc", keys: ["N"], scope: "doc", local: true },
  { id: "findPrev", group: "doc", keys: ["Shift+N"], scope: "doc", local: true },
  { id: "hints", group: "doc", keys: ["F"], scope: "doc", local: true },
  { id: "hintsNew", group: "doc", keys: ["Shift+F"], scope: "doc", local: true },
  { id: "wordHints", group: "doc", keys: ["G W"], scope: "doc", local: true },
  { id: "visual", group: "doc", keys: ["V", "<prefix> ["], scope: "doc", local: true },
  { id: "nextHeading", group: "doc", keys: ["] ]"], scope: "doc", local: true },
  { id: "prevHeading", group: "doc", keys: ["[ ["], scope: "doc", local: true },
  { id: "focusInput", group: "doc", keys: ["G I"], scope: "doc", local: true },
  { id: "docBack", group: "doc", keys: ["Shift+H"], scope: "doc", local: true },
  { id: "docForward", group: "doc", keys: ["Shift+L"], scope: "doc", local: true },
  { id: "copyUrl", group: "article", keys: ["Y Y"], scope: "doc" },
  { id: "print", group: "article", keys: ["Ctrl+Shift+P"], scope: "doc", local: true },
];

/** The actions by what they are for, as Settings and the key help list them; where they run is each row's own. */
export const ACTION_GROUPS = KEY_GROUPS.map((id) => ({ id, title: `keys.group.${id}` as const, actions: ACTIONS.filter((a) => a.group === id) }));

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

const withPrefix = (keys: string[], prefix: string) => keys.map((k) => k.replaceAll(PREFIX, prefix));

const defaults = new Map<string, Bindings>();
/** The registry's keys with `prefix`, the same arrays each time: `isCustom` tells a default by its identity. */
export function defaultBindings(prefix: string): Bindings {
  let d = defaults.get(prefix);
  if (!d) {
    d = Object.fromEntries(ACTIONS.map((a) => [a.id, withPrefix(a.keys, prefix)])) as Bindings;
    defaults.set(prefix, d);
  }
  return d;
}

export const DEFAULT_BINDINGS = defaultBindings(DEFAULT_PREFIX);

/** The actions whose keys cannot change (`passThrough`). */
const FIXED = ACTIONS.filter((a) => a.passThrough).map((a) => a.id);

/** The bindings in effect: the defaults with the user's `overrides`, PREFIX read as `prefix`. */
export function merge(overrides: Partial<Bindings>, prefix = DEFAULT_PREFIX): Bindings {
  const d = defaultBindings(prefix);
  // `<prefix> S` and a literal `Ctrl+B S` are one key under Ctrl+B, which a row lists once.
  const own = Object.fromEntries(Object.entries(overrides).map(([id, keys]) => [id, [...new Set(withPrefix(keys, prefix))]]));
  return { ...d, ...own, ...Object.fromEntries(FIXED.map((id) => [id, d[id]])) };
}

const NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Backspace: "⌫" };

/** Display form: "Ctrl+K" → "Ctrl K", "J" → "j", "ArrowDown" → "↓", `Ctrl+A "` → `Ctrl A › "`. */
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

/** Whether a step leaves its last key to what has the focus: see `passThrough`. */
export const passesOn = (step: KeyStep) => step.kind === "run" && !!step.action.passThrough;

/** As tmux's repeat-time. */
export const REPEAT_MS = 500;

/** Typed text, not a shortcut, when a field has focus. */
export const isPrintable = (key: string) => key.replace(/^Shift\+/, "").length === 1;
/** A shortcut whatever has the focus, and a browser's own key to keep from it. */
export const isModified = (key: string) => /^(Ctrl|Alt)\+/.test(key);
/**
 * One key with Ctrl or Alt: a key a field types would keep the pane keys from working there. Not Enter or Esc: with Ctrl, Enter
 * sends a text field (the chat, a note) and Esc leaves one, which read them before the app could, and Windows takes Ctrl+Esc and Alt+Esc.
 */
export const canPrefix = (key: string) => isModified(key) && !key.includes(" ") && !/\+(Enter|Escape)$/.test(key);
/** A browser pages with these. Bound, they are a shortcut like any key (a Vim leader), and the binding keeps them from paging. */
export const isSpace = (key: string) => key === "Space" || key === "Shift+Space";

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
  // Even on an `inFields` action: a `g t` that runs in fields must not eat a typed g, nor a Space binding a typed space.
  if (inField && (isPrintable(key) || isSpace(key))) {
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
    // Enter, Escape and the arrows stay the page's own: it navigates and scrolls with them. A bound Space is a key like any other, as in the app.
    bindings[a.id] = applicable.filter((k) => {
      const first = k.split(" ")[0]!;
      return isModified(k) || isPrintable(first) || isSpace(first);
    });
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
