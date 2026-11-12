// Which key sends a question from the chat box, kept in the library like the Vim setting (vim.tsx). The Vim editor keeps its own keys: `:w` and Ctrl+Enter.
import { useSyncExternalStore } from "react";
import { readPref, savePref } from "../lib/prefs.ts";

export const SEND_KEYS = ["ctrlEnter", "enter", "enterOneLine"] as const;
export type SendKey = (typeof SEND_KEYS)[number];

const STORAGE_KEY = "lattice.chatSendKey";

/** Whether a plain Enter sends `text` in the mode. Ctrl+Enter sends in every mode. A newline counts, not a wrapped line. */
export const plainEnterSends = (mode: SendKey, text: string) => mode === "enter" || (mode === "enterOneLine" && !text.includes("\n"));

type Press = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing">;

/** Whether the key pressed in the box sends `text`. Shift+Enter and Alt+Enter are a new line, and an Enter that confirms the IME's conversion never sends. */
export function sendsOn(mode: SendKey, text: string, e: Press): boolean {
  // In WebView2 a key the IME holds comes as "Process" (keyCode 229), which is no Enter.
  if (e.key !== "Enter" || e.isComposing) {
    return false;
  }
  return e.ctrlKey || e.metaKey || (!e.shiftKey && !e.altKey && plainEnterSends(mode, text));
}

const load = (): SendKey => SEND_KEYS.find((k) => k === readPref(STORAGE_KEY)) ?? "ctrlEnter";

let mode = load();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};

// Another window changed it, or the start-up sync took the library's: follow it. The unit tests import this file without a window.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      mode = load();
      changed();
    }
  });
}

export function setSendKey(next: SendKey) {
  mode = next;
  savePref(STORAGE_KEY, next === "ctrlEnter" ? null : next);
  changed();
}

const sendKey = () => mode;
export const useSendKey = () => useSyncExternalStore(subscribe, sendKey);
