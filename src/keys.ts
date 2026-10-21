// Keyboard shortcuts: one registry of shell actions with their default keys. The user's
// changes (Settings › ショートカット) persist as overrides; the shell reads the merged bindings.
import { useSyncExternalStore } from "react";
import { keyOf } from "./keyname.ts";
import type { T } from "./i18n/index.ts";

export type ActionId =
  | "palette" | "search" | "next" | "prev" | "open" | "openPage" | "favorite" | "read" | "focus" | "view" | "less" | "more"
  | "escape" | "pane" | "newTab" | "closeTab" | "nextTab" | "prevTab" | "splitRight" | "splitDown" | "saveWord" | "speak" | "popOut" | "back" | "forward";

export interface ActionDef {
  id: ActionId;
  keys: string[];
  /** Also runs while focus is in a text field. */
  inFields?: boolean;
}

export const ACTIONS: ActionDef[] = [
  { id: "palette", keys: ["Ctrl+K"], inFields: true },
  { id: "search", keys: ["/"] },
  { id: "next", keys: ["J", "ArrowDown"] },
  { id: "prev", keys: ["K", "ArrowUp"] },
  { id: "open", keys: ["Enter"] },
  { id: "openPage", keys: ["Shift+Enter"] },
  { id: "favorite", keys: ["S"] },
  { id: "read", keys: ["M"] },
  { id: "focus", keys: ["F"] },
  { id: "view", keys: ["V"] },
  { id: "less", keys: ["["] },
  { id: "more", keys: ["]"] },
  { id: "escape", keys: ["Escape"], inFields: true },
  { id: "pane", keys: ["Ctrl+B"], inFields: true },
  { id: "newTab", keys: ["Ctrl+T"], inFields: true },
  { id: "closeTab", keys: ["Ctrl+W"], inFields: true },
  { id: "nextTab", keys: ["Ctrl+Tab"], inFields: true },
  { id: "prevTab", keys: ["Ctrl+Shift+Tab"], inFields: true },
  { id: "splitRight", keys: ["Ctrl+\\"], inFields: true },
  { id: "splitDown", keys: ["Ctrl+-"], inFields: true },
  { id: "saveWord", keys: ["W"] },
  { id: "speak", keys: ["R"] },
  { id: "popOut", keys: ["Ctrl+Shift+N"], inFields: true },
  { id: "back", keys: ["Alt+ArrowLeft"] },
  { id: "forward", keys: ["Alt+ArrowRight"] },
];

/**
 * Keys a focused page keeps: its Alt+← / Alt+→ (and mouse side buttons) are its own history, and
 * the word card's `speak` has nothing to say there.
 */
const PAGE_OWN = new Set<ActionId>(["saveWord", "speak", "back", "forward"]);

export type Bindings = Record<ActionId, string[]>;
/** The action's name in Settings, the palette and the shortcut help (`keys.<id>` in the catalogs). */
export const actionLabel = (t: T, id: ActionId) => t(`keys.${id}`);

export const DEFAULT_BINDINGS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.keys])) as Bindings;

const NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Backspace: "⌫" };

/** Display form: "Ctrl+K" → "Ctrl K", "J" → "j", "ArrowDown" → "↓". */
export function keyLabel(k: string): string {
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

/** Keys bound to more than one action, with those actions in registry order. */
export function conflicts(b: Bindings): Map<string, ActionId[]> {
  const by = new Map<string, ActionId[]>();
  for (const a of ACTIONS) for (const k of b[a.id]) by.set(k, [...(by.get(k) ?? []), a.id]);
  return new Map([...by].filter(([, ids]) => ids.length > 1));
}

/** How long the pane prefix (Ctrl+B) waits for its follow-up key. */
export const PREFIX_MS = 1500;

/** The app shortcuts the page overlay forwards while the page has keyboard focus. */
export interface PageKeys {
  /** Ctrl / Alt keys of actions that also run in text fields: forwarded even from the page's own fields. */
  inFields: string[];
  /** Forwarded only outside the page's fields. */
  outside: string[];
  /** The pane prefix: the key after it is forwarded too, within prefixMs. */
  prefix: string[];
  prefixMs: number;
}

const MODIFIED = /^(Ctrl|Alt)\+/;

export function pageKeys(b: Bindings): PageKeys {
  const out: PageKeys = { inFields: [], outside: [], prefix: b.pane, prefixMs: PREFIX_MS };
  for (const a of ACTIONS) {
    // A selection in the page is saved with the overlay's own button; back / forward are the page's history; no card speaks.
    if (PAGE_OWN.has(a.id)) continue;
    for (const k of b[a.id]) {
      const mod = MODIFIED.test(k);
      // Enter, Escape, the arrows, Space stay the page's own: it navigates and scrolls with them.
      if (!mod && k.replace(/^Shift\+/, "").length > 1) continue;
      (mod && a.inFields ? out.inFields : out.outside).push(k);
    }
  }
  return out;
}

export const merge = (overrides: Partial<Bindings>): Bindings => ({ ...DEFAULT_BINDINGS, ...overrides });

// ---- persisted store ----------------------------------------------------------------------------
const STORAGE_KEY = "lattice.shortcuts";

function load(): Partial<Bindings> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const out: Partial<Bindings> = {};
    for (const a of ACTIONS) {
      const v = raw[a.id];
      if (Array.isArray(v) && v.every((k) => typeof k === "string")) out[a.id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

let overrides = load();
let bindings = merge(overrides);
const listeners = new Set<() => void>();

function commit(next: Partial<Bindings>) {
  overrides = next;
  bindings = merge(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage: the change lasts for this session only.
  }
  listeners.forEach((f) => f());
}

// Another window (a pop-out, G52) changed the shortcuts: follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    overrides = load();
    bindings = merge(overrides);
    listeners.forEach((f) => f());
  });
}

export const getBindings = () => bindings;
export const isCustom = (id: ActionId) => id in overrides;

export function setKeys(id: ActionId, keys: string[]) {
  const same = keys.length === DEFAULT_BINDINGS[id].length && keys.every((k, i) => k === DEFAULT_BINDINGS[id][i]);
  const { [id]: _, ...rest } = overrides;
  commit(same ? rest : { ...rest, [id]: keys });
}

/** One action back to its default keys, or every action when `id` is omitted. */
export function resetKeys(id?: ActionId) {
  if (!id) return commit({});
  const { [id]: _, ...rest } = overrides;
  commit(rest);
}

export function useBindings(): Bindings {
  return useSyncExternalStore((f) => {
    listeners.add(f);
    return () => listeners.delete(f);
  }, getBindings);
}

/** Up / down inside a popover list: the arrows, plus next / prev keys that are not text input when `typing`. */
export function listStep(e: React.KeyboardEvent, typing: boolean): 1 | -1 | 0 {
  if (e.key === "ArrowDown") return 1;
  if (e.key === "ArrowUp") return -1;
  const k = keyOf(e.nativeEvent);
  if (!k || (typing && k.length === 1)) return 0;
  return bindings.next.includes(k) ? 1 : bindings.prev.includes(k) ? -1 : 0;
}
