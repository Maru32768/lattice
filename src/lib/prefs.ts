// The settings a person picks on purpose live in the library's database (`ui.<key>` rows), so they are in backups and
// move with the data folder. localStorage keeps a copy: the first paint reads it, and pop-outs follow it through
// `storage` events. Screen state (folders, places, layout) stays in localStorage only, per device.
import { useEffect, useState } from "react";
import { api } from "../api.ts";

export const SYNCED = [
  "lattice.shortcuts",
  "lattice.chatVim",
  "lattice.vimrc",
  "lattice.searchEngine",
  "lattice.translateOnSwitch",
  "lattice.vocabAutoplay",
  "lattice.vocabMarks",
] as const;
export type SyncedKey = (typeof SYNCED)[number];

/** The cached value per key, null for none. */
export type Cached = Record<SyncedKey, string | null>;
/** The library's rows: a key with no row is missing. "" is a value the module cleared (Vim off, no vimrc). */
type Rows = Partial<Record<SyncedKey, string>>;

function read(key: SyncedKey): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: SyncedKey, value: string | null) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Blocked storage: the database still keeps it.
  }
}

/** Sets the cached value (null: none) and the library's copy, where "" stands for none. */
export function savePref(key: SyncedKey, value: string | null) {
  write(key, value);
  api.setUiPrefs({ [key]: value ?? "" }).catch(() => {});
}

/**
 * What the start-up sync writes. A row wins over a different cached value; a cached value with no row goes to the
 * database (the first start after the move, one key at a time). `before` is the cache when the rows were asked for and
 * `now` when they came: a key changed in between already went to the database through `savePref` and is newer than
 * both, so it is left alone.
 */
export function planSync(before: Cached, rows: Rows, now: Cached): { cache: Partial<Cached>; db: Rows } {
  const cache: Partial<Cached> = {};
  const db: Rows = {};
  for (const key of SYNCED) {
    const local = before[key] || null;
    const row = rows[key];
    if (now[key] !== before[key]) {
      continue;
    }
    if (row === undefined) {
      if (local !== null) {
        db[key] = local;
      }
    } else if ((row || null) !== local) {
      cache[key] = row || null;
    }
  }
  return { cache, db };
}

const cached = () => Object.fromEntries(SYNCED.map((k) => [k, read(k)])) as Cached;

/** The main window's start: the library's values win over the cache, and the first start copies the cache in. */
export async function syncPrefs() {
  const before = cached();
  const plan = planSync(before, await api.uiPrefs(SYNCED), cached());
  for (const [key, value] of Object.entries(plan.cache) as [SyncedKey, string | null][]) {
    write(key, value);
    // Each module reads it again as if another window had changed it.
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }));
  }
  if (Object.keys(plan.db).length > 0) {
    // shortcut: a change to one of these keys in the moment this is on its way may land first and be overwritten,
    // upgrade if settings ever change on their own at start.
    await api.setUiPrefs(plan.db);
  }
}

/** `useState(load)` that loads again when another window or the start-up sync changes `key`. */
export function useSynced<T>(key: SyncedKey, load: () => T) {
  const [value, setValue] = useState(load);
  useEffect(() => {
    const follow = (e: StorageEvent) => {
      if (e.key === key) {
        setValue(load());
      }
    };
    window.addEventListener("storage", follow);
    return () => window.removeEventListener("storage", follow);
  }, [key, load]);
  return [value, setValue] as const;
}
