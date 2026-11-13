// The user's keyboard shortcuts: the prefix and the changes to the default bindings (Settings › ショートカット) persist
// here; the shell reads the merged bindings. What the keys mean is in keymap.ts.
import { useSyncExternalStore } from "react";
import { ACTIONS, DEFAULT_PREFIX, PREFIX, canPrefix, defaultBindings, keyOf, merge, type ActionId, type Bindings } from "./keymap.ts";
import { savePref } from "./prefs.ts";

// ---- persisted store ----------------------------------------------------------------------------
const STORAGE_KEY = "lattice.shortcuts";
const STORAGE_VERSION = 4;
const FILE_FORMAT = "lattice.shortcuts";

/** What the user changed: the prefix, and the actions' keys with PREFIX for a first key that was the prefix when they were recorded, so that they move with it. */
export interface Shortcuts {
  prefix: string;
  overrides: Partial<Bindings>;
}
const NONE: Shortcuts = { prefix: DEFAULT_PREFIX, overrides: {} };

// It reads imported files too: a key listed twice would repeat a React key in the row.
const keysIn = (v: unknown) => (Array.isArray(v) && v.every((k): k is string => typeof k === "string") ? [...new Set(v.filter(Boolean))] : undefined);

/**
 * The prefix and keys in a stored value, as they were stored. Another version's are dropped, not read. A key that starts with
 * the stored prefix itself, not PREFIX, was recorded under another one: reading it as PREFIX would move it with the next.
 */
export function fromStored(raw: Record<string, unknown>): Shortcuts {
  if (raw.version !== STORAGE_VERSION) {
    return NONE;
  }
  const overrides: Partial<Bindings> = {};
  for (const a of ACTIONS) {
    const v = keysIn(raw[a.id]);
    if (v) {
      overrides[a.id] = v;
    }
  }
  return { prefix: typeof raw.prefix === "string" && canPrefix(raw.prefix) ? raw.prefix : DEFAULT_PREFIX, overrides };
}

const stored = ({ prefix, overrides }: Shortcuts) => ({ version: STORAGE_VERSION, ...(prefix === DEFAULT_PREFIX ? {} : { prefix }), ...overrides });

function load(): Shortcuts {
  try {
    return fromStored(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>);
  } catch {
    return NONE;
  }
}

let state = load();
let bindings = merge(state.overrides, state.prefix);
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

function commit(next: Shortcuts) {
  state = next;
  bindings = merge(state.overrides, state.prefix);
  savePref(STORAGE_KEY, JSON.stringify(stored(state)));
  listeners.forEach((f) => f());
}

// Another window changed the shortcuts, or the start-up sync took the library's: follow it. Only the main window edits
// them, so this is how a pop-out (G52) keeps up.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) {
      return;
    }
    state = load();
    bindings = merge(state.overrides, state.prefix);
    listeners.forEach((f) => f());
  });
}

export const getBindings = () => bindings;
export const getPrefix = () => state.prefix;
/** Pass the bindings a component rendered with, so a memoized render follows a change. A default that moved with the prefix is no change. */
export const isCustom = (id: ActionId, b: Bindings = bindings) => b[id] !== defaultBindings(state.prefix)[id];

/**
 * `keys` as pressed now: a two-key binding whose first key is the prefix is kept as PREFIX and the rest, so that it moves with
 * the prefix, and the others stay as pressed. Only the first key: as a second key the prefix is send-prefix's.
 */
export function setKeys(id: ActionId, keys: string[]) {
  const { prefix } = state;
  const registry = ACTIONS.find((a) => a.id === id)!.keys;
  const had = state.overrides[id] ?? registry;
  // A key the row already had keeps its stored forms (two can show as one under this prefix); only one recorded now is read against the prefix.
  const kept = keys.flatMap((k) => {
    const was = had.filter((s) => s.replaceAll(PREFIX, prefix) === k);
    return was.length ? was : [k.startsWith(`${prefix} `) ? PREFIX + k.slice(prefix.length) : k];
  });
  // Back to the defaults as stored: a literal key that this prefix makes look like a default is still a change.
  const same = kept.length === registry.length && kept.every((k, i) => k === registry[i]);
  const { [id]: _, ...rest } = state.overrides;
  commit({ ...state, overrides: same ? rest : { ...rest, [id]: kept } });
}

/** The defaults and the keys recorded under the prefix move to `prefix`; a key recorded under another first key stays as it is. */
export const setPrefix = (prefix: string) => commit({ ...state, prefix });

/** One action back to its default keys. */
export function resetKeys(id: ActionId) {
  const { [id]: _, ...rest } = state.overrides;
  commit({ ...state, overrides: rest });
}

/** Makes `next` the whole of the shortcuts (the default prefix and no overrides: all at their defaults) and returns what it replaced. */
export function replaceKeys(next: Shortcuts): Shortcuts {
  const prev = state;
  commit(next);
  return prev;
}

/** The shortcuts as a file: the stored value, marked so that reading another JSON file does not reset every key. */
export const shortcutsFile = () => JSON.stringify({ format: FILE_FORMAT, ...stored(state) }, null, 2);

/** The shortcuts in a file `shortcutsFile` wrote, or null for any other text. */
export function parseShortcutsFile(text: string): Shortcuts | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    // Another version's file reads as nothing, as fromStored would drop its keys and reset every action.
    return raw?.format === FILE_FORMAT && raw.version === STORAGE_VERSION ? fromStored(raw) : null;
  } catch {
    return null;
  }
}

export const useBindings = (): Bindings => useSyncExternalStore(subscribe, getBindings);
export const usePrefix = (): string => useSyncExternalStore(subscribe, getPrefix);

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
