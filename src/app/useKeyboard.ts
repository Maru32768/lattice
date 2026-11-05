import { useEffect, useEffectEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { browser } from "../api";
import { getBindings, useBindings } from "../lib/keys";
import { IDLE, actionFor, chordFrom, keyOf, pageKeys, scopeOf, stepKeys, type ActionId, type KeyScope, type KeySeq } from "../lib/keymap";
import { focusPane, isPaneMove, paneAfter, paneOf, type PaneMove } from "../layout/panes";
import { focus as focusLayout, pageByKey, tabById, unzoom, type Workspace } from "../layout/layout";
import { openOverlays, pageClickable } from "../ui/Popover";
import { vimBridge } from "../vim/vim";
import { IS_MAIN } from "./host";

/** Shortcuts that, pressed in the page, open something in the app: the page's webview gives up the keyboard. */
const LEAVES_PAGE = new Set<ActionId>(["palette", "command", "keyHelp", "newTab", "tabList", "popOut", "paneNumbers"]);
/** What has a right-click menu: list rows and document tabs (H3). */
export const MENU_TARGETS = ".row[data-id], [role='tab'][data-tab], [data-folder]";
/** Showing the hint covers a page's webview, which would flash on every `gg`: which-key's delay. */
const HINT_MS = 400;
/** CodeMirror's root, which is only ever there for a Vim editor. */
const EDITOR = ".cm-editor";

type SetLayout = (f: (l: Workspace) => Workspace) => void;

const focusApp = () =>
  getCurrentWebview()
    .setFocus()
    .catch(() => {});

const focusedDoc = () => document.querySelector<HTMLElement>(".dpane.focused");
const paneById = (id: number) => document.querySelector<HTMLElement>(`[data-pane-id='${id}']`);

/** The page pane `p` shows, by its webview's key. */
const pageIn = (p: Element | null) => p?.querySelector<HTMLElement>("[data-page-key]")?.dataset.pageKey;

/**
 * Which pane has the keyboard: the one focus was moved to (outlined until the pointer is used), and
 * the one it or the pointer was in last. A click in a document pane, or in a page, focuses that
 * pane: the next document opens there.
 */
export function usePaneFocus(layout: Workspace, setLayout: SetLayout) {
  const [kbPane, setKbPane] = useState<string | null>(null);
  const lastPane = useRef<HTMLElement | null>(null);
  /** The page `focusPage` gave the keyboard to, until its focus event comes. */
  const keyedPage = useRef<string | null>(null);
  useEffect(() => {
    const focusin = (e: FocusEvent) => {
      const p = paneOf(e.target as Element);
      if (p) {
        lastPane.current = p;
      }
      setKbPane((k) => k && (p?.dataset.pane ?? null));
    };
    const pointer = (e: PointerEvent) => {
      setKbPane(null);
      const p = paneOf(e.target as Element);
      lastPane.current = p;
      if (p?.dataset.paneId) {
        setLayout((l) => focusLayout(l, Number(p.dataset.paneId)));
      }
    };
    window.addEventListener("focusin", focusin);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("focusin", focusin);
      window.removeEventListener("pointerdown", pointer, true);
    };
  }, [setLayout]);

  const onPageFocus = useEffectEvent((tab: string) => {
    // The click never reached this document: replay it as a press outside every open menu and
    // popover (Radix dismisses a left press on its click). Not for a page under an overlay: hiding
    // it behind its still gives it the focus too, which would close the menu that hid it. Nor when
    // the keys moved here: no click, and the pane keeps its outline.
    const keyed = keyedPage.current === tab;
    keyedPage.current = null;
    if (!keyed && pageClickable(tab)) {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      document.body.click();
    }
    const t = pageByKey(layout, tab);
    const hit = t && tabById(layout, t.id);
    // A page out of sight under the zoom can get the focus as one hidden behind its still does: the user chose nothing.
    if (!hit || (layout.zoomed != null && layout.zoomed !== hit.pane.id)) {
      return;
    }
    setLayout((l) => focusLayout(l, hit.pane.id));
    if (!keyed) {
      setKbPane(null);
    }
    lastPane.current = paneById(hit.pane.id);
  });
  useEffect(() => {
    const sub = listen<{ tab: string }>("browser-focus", (e) => onPageFocus(e.payload.tab));
    return () => void sub.then((f) => f());
  }, []);

  /**
   * The pane the keyboard is in: the one with DOM focus, else the last it or the pointer was in,
   * while that is still on screen. A document pane stands for the documents: whichever is focused by
   * now, as a split or a close moves that.
   */
  const keyPane = () => {
    const last = lastPane.current;
    return paneOf(document.activeElement) ?? (last?.dataset.paneId ? focusedDoc() : last?.isConnected ? last : null);
  };
  const setLastPane = (p: HTMLElement | null) => {
    lastPane.current = p;
  };

  /** The keyboard goes to the page `tab`; what the app focused last is stale from here on. */
  const focusPage = (tab: string) => {
    lastPane.current = focusedDoc();
    keyedPage.current = tab;
    (document.activeElement as HTMLElement | null)?.blur();
    browser.focus(tab).catch(() => {});
  };

  /** The keyboard goes into pane `p`, whichever kind it is; a document pane also takes the focus. */
  const enterPane = (p: HTMLElement) => {
    const page = pageIn(p);
    if (page) {
      focusPage(page);
    } else {
      focusPane(p);
    }
    setKbPane(p.dataset.pane!);
    if (p.dataset.paneId) {
      setLayout((l) => focusLayout(l, Number(p.dataset.paneId)));
    }
  };

  /** The focus goes to document pane `id` and the keyboard with it: from a document, `followDoc` takes it along once that pane is on screen. */
  const enterDoc = (id: number) => {
    const p = paneById(id);
    if (p && keyPane()?.dataset.pane !== "doc") {
      enterPane(p);
    } else {
      setLayout((l) => focusLayout(l, id));
    }
  };

  /**
   * The keyboard goes to what document pane `id` shows (a page by its webview's key, else the app's
   * own document): for when a key or a closing overlay changed that. Only from the document: a list
   * that opens articles keeps its cursor, and a field or a tab in that pane keeps what it has.
   */
  const followDoc = (id: number, shown: string | number | undefined) => {
    const active = document.activeElement as HTMLElement;
    const pane = paneById(id);
    if (keyPane()?.dataset.pane !== "doc" || (active !== document.body && pane?.contains(active))) {
      return;
    }
    if (typeof shown === "string") {
      return focusPage(shown);
    }
    active.blur();
    void focusApp();
    pane?.querySelector<HTMLElement>(".doc-scroll")?.focus();
  };

  return { kbPane, setKbPane, keyPane, setLastPane, focusPage, enterPane, enterDoc, followDoc };
}

/**
 * The key sequence under way (`stepKeys`'s state), and the hint for a chord's first key, which shows
 * after a moment so a quick `gg` never draws it. A pointer press ends the sequence.
 */
export function useKeySeq() {
  const seq = useRef(IDLE);
  const [hint, setHint] = useState<{ first: string; scope: KeyScope } | null>(null);
  const timer = useRef(0);
  const track = (next: KeySeq, scope: KeyScope = "list", onHint?: () => void) => {
    seq.current = next;
    clearTimeout(timer.current);
    setHint(null);
    const first = next.first;
    if (first) {
      timer.current = window.setTimeout(() => {
        setHint({ first, scope });
        onHint?.();
      }, HINT_MS);
    }
  };
  const onPointer = useEffectEvent(() => track(IDLE));
  useEffect(() => {
    const press = () => onPointer();
    window.addEventListener("pointerdown", press, true);
    return () => window.removeEventListener("pointerdown", press, true);
  }, []);
  return { seq, hint, track };
}

export type ActionHandlers = Record<Exclude<ActionId, PaneMove>, (count: number, sequence: string) => void>;

/**
 * The app's shortcuts: keys pressed in the app, and the ones a page's overlay forwards. A key runs
 * its action unless a field, an open overlay or a control owns it. Also sends the page overlay the
 * bindings it reads. Returns how to run an action by id, for the palette.
 */
export function useShortcuts({
  actions,
  keySeq,
  layout,
  setLayout,
  focus,
  docKeys,
}: {
  actions: ActionHandlers;
  keySeq: ReturnType<typeof useKeySeq>;
  layout: Workspace;
  setLayout: SetLayout;
  focus: ReturnType<typeof usePaneFocus>;
  /** Whether the document's mode took the key: it hears each key first. */
  docKeys: (key: string) => boolean;
}) {
  const bindings = useBindings();
  useEffect(() => {
    browser.setKeys(pageKeys(bindings)).catch(() => {});
  }, [bindings]);

  /** The pane focus moved to, if any. */
  function movePane(move: PaneMove, from: HTMLElement | null): HTMLElement | null {
    // Zoomed, no other pane is on screen to measure: as in tmux, the move ends the zoom and goes by where the panes then are.
    if (layout.zoomed != null) {
      flushSync(() => setLayout(unzoom));
    }
    const p = paneAfter(move, from);
    if (p) {
      focus.enterPane(p);
    }
    return p;
  }

  function run(id: ActionId, count: number, sequence: string) {
    if (isPaneMove(id)) {
      movePane(id, focus.keyPane());
    } else {
      actions[id](count, sequence);
    }
  }

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) {
      return;
    }
    const key = keyOf(e);
    if (!key) {
      return;
    }
    if (docKeys(key)) {
      return e.preventDefault();
    }
    const t = e.target as HTMLElement;
    const seq = keySeq.seq.current;
    if (!seq.first) {
      // The menu key / Shift+F10: the context menu of the focused row or tab, else of the list cursor's row.
      if ((key === "ContextMenu" || key === "Shift+F10") && !openOverlays()) {
        const on = t.closest?.<HTMLElement>(MENU_TARGETS) ?? document.querySelector<HTMLElement>(".row.cur");
        if (!on) {
          return;
        }
        e.preventDefault();
        on.focus();
        // The menu opens at the event's point: under the start of the element.
        const r = on.getBoundingClientRect();
        on.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 16, clientY: r.bottom }));
        return;
      }
      // A drag handle being moved with the keyboard owns the arrows, Space and Enter.
      if (t.closest("[aria-roledescription='sortable']")) {
        return;
      }
    }
    const inField = !!t.closest("input, textarea, select, [contenteditable='true'], [data-lattice-field]");
    // A pop-out has no list for the keys to mean, and under the zoom none is on screen.
    const scope = scopeOf(focus.keyPane()?.dataset.pane ?? (IS_MAIN && layout.zoomed == null ? "list" : "doc"));
    const step = stepKeys(getBindings(), seq, key, { scope, inField, now: Date.now() });
    // An open popover, menu or the palette owns the keys (j / k move inside it); the palette's own key still toggles it.
    if (!seq.first && openOverlays() && !(step.kind === "run" && step.action.id === "palette")) {
      return;
    }
    keySeq.track(step.seq, scope);
    if (step.kind === "none") {
      return;
    }
    // The hint took the keyboard from this page to read the second key: it goes back, unless the action moves on.
    const backTo = seq.first && !inField ? pageIn(focus.keyPane()) : undefined;
    if (step.kind !== "run") {
      e.preventDefault();
      if (backTo) {
        focus.focusPage(backTo);
      }
      return;
    }
    const { id } = step.action;
    // Esc in a field only leaves the field; panes that own an Esc (palette, search) handle it first. A Vim editor keeps it for its modes.
    if (inField && id === "escape") {
      return t.closest(EDITOR) ? undefined : t.blur();
    }
    // Enter on a control activates it; on a list row or search hit it opens the cursor.
    if ((id === "open" || id === "openPage") && t.closest("button, a, [role='button']") && !t.closest(".row, .hit")) {
      return;
    }
    // Plain keys on a focused button would also activate it.
    e.preventDefault();
    run(id, step.count, step.sequence);
    if (backTo && !LEAVES_PAGE.has(id) && !isPaneMove(id)) {
      focus.focusPage(backTo);
    }
  });

  // What the page overlay forwarded: keyboard focus is in that page's pane. Its `stepKeys` has read
  // the keys, so this is a whole sequence, a chord's first key, or empty for one that ended there.
  const onPageKey = useEffectEvent(({ tab, key, count }: { tab: string; key: string; count: number }) => {
    if (!key) {
      return keySeq.track(IDLE);
    }
    // What the app focused last is stale (j / k in the nav would step the nav).
    (document.activeElement as HTMLElement | null)?.blur();
    const page = pageByKey(layout, tab);
    const pane = page && tabById(layout, page.id)?.pane.id;
    const paneEl = pane == null ? null : paneById(pane);
    if (pane != null) {
      setLayout((l) => focusLayout(l, pane));
      focus.setLastPane(paneEl);
    }
    // A page under the hint hides, and the backend refuses a hidden page's keys: from then on the app reads the second key.
    if (chordFrom(getBindings(), key, "doc")) {
      return keySeq.track({ ...IDLE, first: key }, "doc", () => void focusApp());
    }
    keySeq.track(IDLE);
    const action = actionFor(getBindings(), key, "doc");
    // A chord skips the check: the hint for its first key counts as an open overlay itself.
    if (!action || (!key.includes(" ") && openOverlays() && action.id !== "palette")) {
      return;
    }
    if (isPaneMove(action.id)) {
      const to = movePane(action.id, paneEl);
      if (to && !pageIn(to)) {
        void focusApp();
      }
      return;
    }
    if (LEAVES_PAGE.has(action.id)) {
      void focusApp();
    }
    actions[action.id](count, key);
  });

  // The engine in a Vim editor would use the app's keys and stop them (Ctrl+B is its page up), so the app reads them
  // first and keeps those it claims. A key the vimrc maps in this mode is the engine's, unless it ends a chord under way.
  const onEditorKey = useEffectEvent((e: KeyboardEvent, editor: Element) => {
    if (keySeq.seq.current.first || !vimBridge.owns(e, editor)) {
      onKey(e);
      if (e.defaultPrevented) {
        e.stopPropagation();
      }
    }
  });
  const onEditorAction = useEffectEvent((id: ActionId) => run(id, 1, ""));

  useEffect(() => {
    const capture = (e: KeyboardEvent) => {
      const editor = (e.target as Element).closest(EDITOR);
      if (editor) {
        onEditorKey(e, editor);
      }
    };
    const down = (e: KeyboardEvent) => {
      if (!(e.target as Element).closest(EDITOR)) {
        onKey(e);
      }
    };
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", down);
    vimBridge.run = (id) => onEditorAction(id);
    const unlisten = listen<{ tab: string; key: string; count: number }>("browser-key", (e) => onPageKey(e.payload));
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("keydown", down);
      void unlisten.then((f) => f());
    };
  }, []);

  return { run };
}
