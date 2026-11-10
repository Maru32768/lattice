// The user's keyboard shortcuts: changes to the default bindings (Settings › ショートカット) persist
// as overrides here; the shell reads the merged bindings. What the keys mean is in keymap.ts.
import { useSyncExternalStore } from "react";
import { ACTIONS, DEFAULT_BINDINGS, keyOf, merge, type ActionId, type Bindings } from "./keymap.ts";

// ---- persisted store ----------------------------------------------------------------------------
const STORAGE_KEY = "lattice.shortcuts";
const STORAGE_VERSION = 2;
const FILE_FORMAT = "lattice.shortcuts";

// It reads imported files too: a key listed twice would repeat a React key in the row.
const keysIn = (v: unknown) => (Array.isArray(v) && v.every((k): k is string => typeof k === "string") ? [...new Set(v.filter(Boolean))] : undefined);

/**
 * The overrides in a stored value. Version 1 had a `pane` action, whose keys led fixed second keys
 * that no override could touch: those now become two-key bindings under the keys it had.
 */
export function fromStored(raw: Record<string, unknown>): Partial<Bindings> {
  const out: Partial<Bindings> = {};
  const current = raw.version === STORAGE_VERSION;
  const pane = keysIn(raw.pane) ?? ["Ctrl+B"];
  const paneMoved = !current && (pane.length !== 1 || pane[0] !== "Ctrl+B");
  for (const a of ACTIONS) {
    const v = keysIn(raw[a.id]);
    const seconds = a.keys.filter((k) => k.startsWith("Ctrl+B ")).map((k) => k.slice("Ctrl+B ".length));
    if (current) {
      if (v) {
        out[a.id] = v;
      }
    } else if (v || (paneMoved && seconds.length)) {
      out[a.id] = [...(v ?? a.keys.filter((k) => !k.startsWith("Ctrl+B "))), ...pane.flatMap((p) => seconds.map((s) => `${p} ${s}`))];
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, version: STORAGE_VERSION }));
  } catch {
    // Blocked storage: the change lasts for this session only.
  }
  listeners.forEach((f) => f());
}

// Another window (a pop-out, G52) changed the shortcuts: follow it.
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
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return (raw as { format?: unknown } | null)?.format === FILE_FORMAT ? fromStored(raw as Record<string, unknown>) : null;
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
