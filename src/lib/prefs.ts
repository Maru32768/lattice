// The settings a person picks on purpose live in the library's database (`ui.<key>` rows), so they are in backups and
// move with the data folder. localStorage keeps a copy: the first paint reads it, and pop-outs follow it through
// `storage` events. Screen state (folders, places, layout) stays in localStorage only, per device.
import { useEffect, useState } from "react";
import { api } from "../api.ts";

export const SYNCED = [
  "lattice.shortcuts",
  "lattice.chatVim",
  "lattice.vimrc",
  "lattice.chatSendKey",
  "lattice.searchEngine",
  "lattice.translateOnSwitch",
  "lattice.vocabAutoplay",
  "lattice.vocabMarks",
] as const;
type SyncedKey = (typeof SYNCED)[number];

export type Cached = Record<SyncedKey, string | null>;
/** The library's rows: a key with no row is missing. "" is a value the module cleared (Vim off, no vimrc). */
type Rows = Partial<Record<SyncedKey, string>>;

export function readPref(key: SyncedKey): string | null {
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
    // Blocked storage: savePref still sends it to the library, but the modules read only the cache and see the default.
  }
}

// One write at a time, in the order made: each command waits for the store's lock on a task of its own, so two in
// flight can land the other way round and leave the library older than the cache, which then loses at the next start.
let sending: Promise<void> = Promise.resolve();
function send(prefs: Rows) {
  sending = sending.then(() => api.setUiPrefs(prefs)).catch(() => {});
  return sending;
}

/** Sets the cached value (null: none) and the library's copy, where "" stands for none. */
export function savePref(key: SyncedKey, value: string | null) {
  write(key, value);
  void send({ [key]: value ?? "" });
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
    if (now[key] !== before[key]) {
      continue;
    }
    const local = before[key] || null;
    const row = rows[key];
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

const cached = () => Object.fromEntries(SYNCED.map((k) => [k, readPref(k)])) as Cached;

/** The main window's start: the library's values win over the cache, and the first start copies the cache in. */
export async function syncPrefs() {
  const before = cached();
  const plan = planSync(before, await api.uiPrefs(SYNCED), cached());
  for (const [key, value] of Object.entries(plan.cache) as [SyncedKey, string | null][]) {
    write(key, value);
    // Each module reads it again as if another window had changed it.
    window.dispatchEvent(new StorageEvent("storage", { key }));
  }
  if (Object.keys(plan.db).length > 0) {
    // Queued before any change made after the plan, so such a change lands after the copy.
    await send(plan.db);
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
    // oxlint-disable-next-line react/set-state-in-effect -- a sync that landed between the first render and this subscription sent its event to no one
    setValue(load());
    return () => window.removeEventListener("storage", follow);
  }, [key, load]);
  return [value, setValue] as const;
}
