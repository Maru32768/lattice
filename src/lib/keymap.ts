// The key language: canonical key names, the registry of actions with their default keys, and what
// a key means. Pure (no React, no storage), so the page overlay can load it too; the user's changes
// to the bindings persist in keys.ts.
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
  | "search"
  | "next"
  | "prev"
  | "open"
  | "openPage"
  | "favorite"
  | "read"
  | "focus"
  | "view"
  | "summary"
  | "less"
  | "more"
  | "escape"
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "splitRight"
  | "splitDown"
  | "closePane"
  | "saveWord"
  | "speak"
  | "popOut"
  | "back"
  | "forward"
  | "moveUp"
  | "moveDown";

export interface ActionDef {
  id: ActionId;
  keys: string[];
  /** Also runs while focus is in a text field. */
  inFields?: boolean;
}

/**
 * A binding is one key or, as in tmux, two pressed in turn: `Ctrl+B "`. No single key contains a
 * space (the space bar is "Space"), so a space always separates the two.
 */
export const ACTIONS: ActionDef[] = [
  { id: "palette", keys: ["Ctrl+K"], inFields: true },
  { id: "search", keys: ["/"] },
  { id: "next", keys: ["J", "ArrowDown"] },
  { id: "prev", keys: ["K", "ArrowUp"] },
  { id: "open", keys: ["Enter"] },
  { id: "openPage", keys: ["Shift+Enter"] },
  { id: "favorite", keys: ["S"] },
  { id: "read", keys: ["M"] },
  { id: "focus", keys: ["F", "Ctrl+B Z"] },
  { id: "view", keys: ["V"] },
  { id: "summary", keys: ["Y"] },
  { id: "less", keys: ["["] },
  { id: "more", keys: ["]"] },
  { id: "escape", keys: ["Escape"], inFields: true },
  { id: "paneLeft", keys: ["Ctrl+B ArrowLeft", "Ctrl+B H"], inFields: true },
  { id: "paneRight", keys: ["Ctrl+B ArrowRight", "Ctrl+B L"], inFields: true },
  { id: "paneUp", keys: ["Ctrl+B ArrowUp", "Ctrl+B K"], inFields: true },
  { id: "paneDown", keys: ["Ctrl+B ArrowDown", "Ctrl+B J"], inFields: true },
  { id: "paneNext", keys: ["Ctrl+B O"], inFields: true },
  { id: "newTab", keys: ["Ctrl+T", "Ctrl+B C"], inFields: true },
  { id: "closeTab", keys: ["Ctrl+W"], inFields: true },
  { id: "nextTab", keys: ["Ctrl+Tab", "Ctrl+B N"], inFields: true },
  { id: "prevTab", keys: ["Ctrl+Shift+Tab", "Ctrl+B P"], inFields: true },
  { id: "splitRight", keys: ["Ctrl+\\", "Ctrl+B %"], inFields: true },
  { id: "splitDown", keys: ["Ctrl+-", 'Ctrl+B "'], inFields: true },
  { id: "closePane", keys: ["Ctrl+B X"], inFields: true },
  { id: "saveWord", keys: ["W"] },
  { id: "speak", keys: ["R"] },
  { id: "popOut", keys: ["Ctrl+Shift+N"], inFields: true },
  { id: "back", keys: ["Alt+ArrowLeft"] },
  { id: "forward", keys: ["Alt+ArrowRight"] },
  // A focused feed or folder in the sidebar moves (H26); the row handles these keys itself.
  { id: "moveUp", keys: ["Alt+ArrowUp"] },
  { id: "moveDown", keys: ["Alt+ArrowDown"] },
];

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

/** The action a key runs: the first in registry order that has it. */
export function actionFor(b: Bindings, key: string): ActionDef | undefined {
  return ACTIONS.find((a) => b[a.id].includes(key));
}

/**
 * An action whose two-key binding starts with `key`, preferring one that runs in text fields so
 * the first key works there if any of them does. Such a key waits for its second key: alone, it
 * never runs an action it is also bound to.
 */
export function chordFrom(b: Bindings, key: string): ActionDef | undefined {
  const all = ACTIONS.filter((a) => b[a.id].some((k) => k.startsWith(`${key} `)));
  return all.find((a) => a.inFields) ?? all[0];
}

/** What can follow `first`: each action with its second keys; a key on two actions counts for the first, as in `actionFor`. */
export function afterFirst(b: Bindings, first: string): [ActionId, string[]][] {
  const seen = new Set<string>();
  const out: [ActionId, string[]][] = [];
  for (const a of ACTIONS) {
    const seconds = b[a.id].filter((k) => k.startsWith(`${first} `)).map((k) => k.slice(first.length + 1));
    const fresh = seconds.filter((k) => !seen.has(k));
    fresh.forEach((k) => seen.add(k));
    if (fresh.length) {
      out.push([a.id, fresh]);
    }
  }
  return out;
}

/** Keys bound to more than one action, with those actions in registry order. */
export function conflicts(b: Bindings): Map<string, ActionId[]> {
  const by = new Map<string, ActionId[]>();
  for (const a of ACTIONS) {
    for (const k of b[a.id]) {
      by.set(k, [...(by.get(k) ?? []), a.id]);
    }
  }
  return new Map([...by].filter(([, ids]) => ids.length > 1));
}

/** How long the first key of a two-key binding waits for the second. */
export const PREFIX_MS = 1500;

/** The app shortcuts the page overlay forwards while the page has keyboard focus. */
export interface PageKeys {
  /** Ctrl / Alt keys of actions that also run in text fields: forwarded even from the page's own fields. */
  inFields: string[];
  /** Forwarded only outside the page's fields. */
  outside: string[];
  /** First keys of two-key bindings: the key after one is forwarded too, whatever it is, within prefixMs. */
  prefix: string[];
  prefixMs: number;
}

const MODIFIED = /^(Ctrl|Alt)\+/;

export function pageKeys(b: Bindings): PageKeys {
  const inFields = new Set<string>();
  const outside = new Set<string>();
  const prefix = new Set<string>();
  for (const a of ACTIONS) {
    // A selection in the page is saved with the overlay's own button; back / forward are the page's history; no card speaks.
    if (PAGE_OWN.has(a.id)) {
      continue;
    }
    for (const k of b[a.id]) {
      const [first, second] = k.split(" ") as [string, string?];
      const mod = MODIFIED.test(first);
      // Enter, Escape, the arrows, Space stay the page's own: it navigates and scrolls with them.
      if (!mod && first.replace(/^Shift\+/, "").length > 1) {
        continue;
      }
      (mod && a.inFields ? inFields : outside).add(first);
      if (second) {
        prefix.add(first);
      }
    }
  }
  return { inFields: [...inFields], outside: [...outside].filter((k) => !inFields.has(k)), prefix: [...prefix], prefixMs: PREFIX_MS };
}
