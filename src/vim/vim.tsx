// Vim in the text fields: whether it is on and the vimrc text, both kept in the library like the shortcuts, and the way
// to the editor. This file is in the main chunk, so CodeMirror stays out of it: the editor loads only when Vim is on.
import { lazy, useSyncExternalStore } from "react";
import { useT } from "../i18n";
import type { ActionId } from "../lib/keymap";
import { readPref, savePref } from "../lib/prefs";

const ON_KEY = "lattice.chatVim";
const VIMRC_KEY = "lattice.vimrc";

let on = readPref(ON_KEY) === "on";
let vimrc = readPref(VIMRC_KEY) ?? "";
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};

// Another window changed them, or the start-up sync took the library's: follow it.
window.addEventListener("storage", (e) => {
  if (e.key === ON_KEY || e.key === VIMRC_KEY) {
    on = readPref(ON_KEY) === "on";
    vimrc = readPref(VIMRC_KEY) ?? "";
    changed();
  }
});

export const vimEnabled = () => on;

export function setVimEnabled(value: boolean) {
  on = value;
  savePref(ON_KEY, value ? "on" : null);
  changed();
}

export const getVimrc = () => vimrc;

export function setVimrc(text: string) {
  vimrc = text;
  savePref(VIMRC_KEY, text || null);
  changed();
}

export const useVimEnabled = () => useSyncExternalStore(subscribe, vimEnabled);
export const useVimrc = () => useSyncExternalStore(subscribe, getVimrc);

/** How the app and the lazily loaded editor reach each other. */
export const vimBridge = {
  /** Set by the app: runs one of its actions, for the editor's Ex commands. */
  run: (_id: ActionId) => {},
  /** Set by the editor: whether the vimrc maps this key in the mode of `editor`, so the app should leave it alone. */
  owns: (_e: KeyboardEvent, _editor: Element) => false,
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
