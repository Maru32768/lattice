// Pop-out windows (G52, design-review §26): which window this frontend runs in (its Tauri label),
// where each window keeps its layout, and the requests a pop-out sends the main window.
import { emitTo } from "@tauri-apps/api/event";
import type { Citation } from "./api";
import type { OpenDoc } from "./chat";
import type { Doc, Id } from "./layout";
import type { Screen } from "./Nav";
import type { ImportTab } from "./ImportView";
import type { Facets, Scope } from "./library";

export const MAIN = "main";
export const CHAT = "chat";

export type Host = { kind: "main" } | { kind: "doc"; label: string } | { kind: "chat" };

/** What a window shows, from its label: `main`, `doc-<n>` (one pane tree of tabs) or `chat`. Anything else is the main shell. */
export function hostOf(label: string): Host {
  if (label === CHAT) return { kind: "chat" };
  if (/^doc-\d+$/.test(label)) return { kind: "doc", label };
  return { kind: "main" };
}

const PREFIX = "lattice.window.";

/** A pop-out's storage key (its layout; the chat window's is empty). The key's presence means the window is open, so main restores it at startup. */
export const windowKey = (label: string) => PREFIX + label;

/** The pop-outs that are (or were, before a restart) open, from the storage keys. */
/**
 * What a window does with the Page language when it starts. The overlay config in the backend is
 * one for every page webview, so only the main window sends it; a document window asks main for
 * the current choice (its own default would turn translation off everywhere), the chat window has no pages.
 */
export const pageLangOnStart = (h: Host): "send" | "ask" | "none" => (h.kind === "main" ? "send" : h.kind === "doc" ? "ask" : "none");

export const openWindows = (keys: string[]) =>
  keys.filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length)).filter((l) => hostOf(l).kind !== "main");

/** The lowest document-window label not in `open`. */
export function nextDocLabel(open: string[]): string {
  for (let n = 1; ; n++) if (!open.includes(`doc-${n}`)) return `doc-${n}`;
}

export function storageKeys(): string[] {
  try {
    return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);
  } catch {
    return [];
  }
}

/**
 * What a pop-out asks the main window to do: it has no sidebar, list, screens or chat dock of its
 * own. `open` also goes to a document window (a tab dragged onto its strip lands in slot `at`).
 */
export type MainRequest =
  | { kind: "open"; docs: Doc[]; at?: { pane: Id; index: number } }
  | { kind: "chat"; scopeKey?: string }
  | { kind: "chatDocked" }
  | { kind: "chatClosed" }
  /** A document window's saved articles in tabs, for the chat's 開いている記事 (empty as it closes). */
  | { kind: "openDocs"; label: string; docs: OpenDoc[] }
  /** The chat window is listening: send it the current article (`doc-current`). */
  | { kind: "chatReady" }
  /** A document window started: send it the Page language (`page-lang`). */
  | { kind: "pageLang" }
  | { kind: "cite"; citation: Citation }
  | { kind: "screen"; screen: Screen }
  | { kind: "import"; tab: ImportTab }
  | { kind: "discover"; url: string }
  | { kind: "scope"; scope: Scope }
  | { kind: "facets"; facets: Facets }
  | { kind: "search"; query?: string };

export const MAIN_REQUEST = "main-request";
export const toWindow = (label: string, r: MainRequest) => emitTo(label, MAIN_REQUEST, r);
export const toMain = (r: MainRequest) => toWindow(MAIN, r);
