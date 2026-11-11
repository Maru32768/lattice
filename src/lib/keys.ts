// The user's keyboard shortcuts: changes to the default bindings (Settings › ショートカット) persist
// as overrides here; the shell reads the merged bindings. What the keys mean is in keymap.ts.
import { useSyncExternalStore } from "react";
import { ACTIONS, DEFAULT_BINDINGS, keyOf, merge, type ActionId, type Bindings } from "./keymap.ts";
import { savePref } from "./prefs.ts";

// ---- persisted store ----------------------------------------------------------------------------
const STORAGE_KEY = "lattice.shortcuts";
const STORAGE_VERSION = 3;
const FILE_FORMAT = "lattice.shortcuts";
/** The default chords' first key, as tmux's prefix. Before version 3 it was Ctrl+B, which now pages up. */
const PREFIX = "Ctrl+A ";
const OLD_PREFIX = "Ctrl+B ";

// It reads imported files too: a key listed twice would repeat a React key in the row.
const keysIn = (v: unknown) => (Array.isArray(v) && v.every((k): k is string => typeof k === "string") ? [...new Set(v.filter(Boolean))] : undefined);

/**
 * Version 1's overrides as version 2's. Version 1 had a `pane` action, whose keys led fixed second
 * keys that no override could touch: those become two-key bindings under the keys it had.
 */
function fromVersion1(raw: Record<string, unknown>): Partial<Bindings> {
  const out: Partial<Bindings> = {};
  const pane = keysIn(raw.pane) ?? ["Ctrl+B"];
  const paneMoved = pane.length !== 1 || pane[0] !== "Ctrl+B";
  for (const a of ACTIONS) {
    const v = keysIn(raw[a.id]);
    const seconds = a.keys.filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
    if (v || (paneMoved && seconds.length)) {
      out[a.id] = [...(v ?? a.keys.filter((k) => !k.startsWith(PREFIX))), ...pane.flatMap((p) => seconds.map((s) => `${p} ${s}`))];
    }
  }
  return out;
}

/** A version 2 key as version 3's: a key after Ctrl+B goes after Ctrl+A, and page up, Ctrl+B Ctrl+B there, is Ctrl+B. */
const fromVersion2 = (id: ActionId, k: string) =>
  (id === "pageUp" || id === "listPageUp") && k === "Ctrl+B Ctrl+B" ? "Ctrl+B" : k.startsWith(OLD_PREFIX) ? PREFIX + k.slice(OLD_PREFIX.length) : k;

/** The overrides in a stored value of any version. */
export function fromStored(raw: Record<string, unknown>): Partial<Bindings> {
  const current = raw.version === STORAGE_VERSION;
  const stored: Record<string, unknown> = current || raw.version === 2 ? raw : fromVersion1(raw);
  const out: Partial<Bindings> = {};
  for (const a of ACTIONS) {
    const v = keysIn(stored[a.id]);
    if (v) {
      out[a.id] = current ? v : [...new Set(v.map((k) => fromVersion2(a.id, k)))];
    }
  }
  return out;
}

function load(): Partial<Bindings> {
  try {
    return fromStored(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>);
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
  savePref(STORAGE_KEY, JSON.stringify({ ...next, version: STORAGE_VERSION }));
  listeners.forEach((f) => f());
}

// Another window changed the shortcuts, or the start-up sync took the library's: follow it. Only the main window edits
// them, so this is how a pop-out (G52) keeps up.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) {
      return;
    }
    overrides = load();
    bindings = merge(overrides);
    listeners.forEach((f) => f());
  });
}

export const getBindings = () => bindings;
/** Pass the bindings a component rendered with, so a memoized render follows a change. */
export const isCustom = (id: ActionId, b: Bindings = bindings) => b[id] !== DEFAULT_BINDINGS[id];

export function setKeys(id: ActionId, keys: string[]) {
  const same = keys.length === DEFAULT_BINDINGS[id].length && keys.every((k, i) => k === DEFAULT_BINDINGS[id][i]);
  const { [id]: _, ...rest } = overrides;
  commit(same ? rest : { ...rest, [id]: keys });
}

/** One action back to its default keys. */
export function resetKeys(id: ActionId) {
  const { [id]: _, ...rest } = overrides;
  commit(rest);
}

/** Makes `next` the whole set of overrides (`{}`: every action at its defaults) and returns the set it replaced. */
export function replaceKeys(next: Partial<Bindings>): Partial<Bindings> {
  const prev = overrides;
  commit(next);
  return prev;
}

/** The overrides as a file: the stored value, marked so that reading another JSON file does not reset every key. */
export const shortcutsFile = () => JSON.stringify({ format: FILE_FORMAT, version: STORAGE_VERSION, ...overrides }, null, 2);

/** The overrides in a file `shortcutsFile` wrote, or null for any other text. */
export function parseShortcutsFile(text: string): Partial<Bindings> | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    // Only the versions that wrote files: fromStored reads any other as version 1 and would add the old pane keys again.
    return raw?.format === FILE_FORMAT && (raw.version === 2 || raw.version === STORAGE_VERSION) ? fromStored(raw) : null;
  } catch {
    return null;
  }
}

export function useBindings(): Bindings {
  return useSyncExternalStore((f) => {
    listeners.add(f);
    return () => listeners.delete(f);
  }, getBindings);
}

/** Up / down inside a popover list: the arrows, plus next / prev keys that are not text input when `typing`. */
export function listStep(e: React.KeyboardEvent, typing: boolean): 1 | -1 | 0 {
  if (e.key === "ArrowDown") {
    return 1;
  }
  if (e.key === "ArrowUp") {
    return -1;
  }
  const k = keyOf(e.nativeEvent);
  if (!k || (typing && k.length === 1)) {
    return 0;
  }
  return bindings.next.includes(k) ? 1 : bindings.prev.includes(k) ? -1 : 0;
}
