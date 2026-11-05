// Vim in the text fields: whether it is on, per device like the shortcuts, and the way to the editor.
// This file is in the main chunk, so CodeMirror stays out of it: the editor loads only when Vim is on.
import { lazy, useSyncExternalStore } from "react";
import { useT } from "../i18n";
import type { ActionId } from "../lib/keymap";

const ON_KEY = "lattice.chatVim";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Blocked storage: the change lasts for this session only.
  }
}

let on = stored(ON_KEY) === "on";
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};

// Another window changed it: follow it.
window.addEventListener("storage", (e) => {
  if (e.key === ON_KEY) {
    on = stored(ON_KEY) === "on";
    changed();
  }
});

export const vimEnabled = () => on;

export function setVimEnabled(value: boolean) {
  on = value;
  store(ON_KEY, value ? "on" : null);
  changed();
}

export const useVimEnabled = () => useSyncExternalStore(subscribe, vimEnabled);

/** How the app and the lazily loaded editor reach each other. */
export const vimBridge = {
  /** Set by the app: runs one of its actions, for the editor's Ex commands. */
  run: (_id: ActionId) => {},
};

export const VimEditor = lazy(() => import("./VimEditor"));

/** The editor's mode and the keys it is waiting on, as the editor's `onMode` reports them. */
export function VimMode({ mode }: { mode: string }) {
  const t = useT();
  return (
    <span className={`bd vim-mode${mode.startsWith("INSERT") ? "" : " run"}`} aria-live="polite" title={t("chatPane.vimMode")}>
      {mode}
    </span>
  );
}
