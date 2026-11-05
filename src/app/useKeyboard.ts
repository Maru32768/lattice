import { useEffect, useEffectEvent, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { browser } from "../api";
import { getBindings, useBindings } from "../lib/keys";
import { IDLE, actionFor, chordFrom, keyOf, pageKeys, scopeOf, stepKeys, type ActionId, type KeyScope, type KeySeq } from "../lib/keymap";
import { focusPane, isPaneMove, paneAfter, paneOf, type PaneMove } from "../layout/panes";
import { focus as focusLayout, pageByKey, tabById, type Workspace } from "../layout/layout";
import { openOverlays, pageClickable } from "../ui/Popover";
import { IS_MAIN } from "./host";

/** Shortcuts that, pressed in the page, move on to the app: the page's webview gives up the keyboard. */
const LEAVES_PAGE = new Set<ActionId>([
  "palette",
  "command",
  "keyHelp",
  "view",
  "newTab",
  "closeTab",
  "nextTab",
  "prevTab",
  "tabByNumber",
  "tabList",
  "splitRight",
  "splitDown",
  "popOut",
]);
/** What has a right-click menu: list rows and document tabs (H3). */
export const MENU_TARGETS = ".row[data-id], [role='tab'][data-tab], [data-folder]";
/** Showing the hint covers a page's webview, which would flash on every `gg`: which-key's delay. */
const HINT_MS = 400;

type SetLayout = (f: (l: Workspace) => Workspace) => void;

/**
 * Which pane has the keyboard: the one focus was moved to (outlined until the pointer is used), and
 * the one it or the pointer was in last. A click in a document pane, or in a page, focuses that
 * pane: the next document opens there.
 */
export function usePaneFocus(layout: Workspace, setLayout: SetLayout) {
  const [kbPane, setKbPane] = useState<string | null>(null);
  const lastPane = useRef<HTMLElement | null>(null);
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
    // it behind its still gives it the focus too, which would close the menu that hid it.
    if (pageClickable(tab)) {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      document.body.click();
    }
    const t = pageByKey(layout, tab);
    const hit = t && tabById(layout, t.id);
    if (!hit) {
      return;
    }
    setLayout((l) => focusLayout(l, hit.pane.id));
    setKbPane(null);
    lastPane.current = document.querySelector<HTMLElement>(`[data-pane-id='${hit.pane.id}']`);
  });
  useEffect(() => {
    const sub = listen<{ tab: string }>("browser-focus", (e) => onPageFocus(e.payload.tab));
    return () => void sub.then((f) => f());
  }, []);

  /** The pane the keyboard is in: the one with DOM focus, else the last it or the pointer was in, while that is still on screen. */
  const keyPane = () => paneOf(document.activeElement) ?? (lastPane.current?.isConnected ? lastPane.current : null);
  const setLastPane = (p: HTMLElement | null) => {
    lastPane.current = p;
  };

  return { kbPane, setKbPane, keyPane, setLastPane };
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
}: {
  actions: ActionHandlers;
  keySeq: ReturnType<typeof useKeySeq>;
  layout: Workspace;
  setLayout: SetLayout;
  focus: ReturnType<typeof usePaneFocus>;
}) {
  const bindings = useBindings();
  useEffect(() => {
    browser.setKeys(pageKeys(bindings)).catch(() => {});
  }, [bindings]);

  /** The pane focus moved to, if any. */
  function movePane(move: PaneMove, from: HTMLElement | null): HTMLElement | null {
    const p = paneAfter(move, from);
    if (!p) {
      return null;
    }
    focusPane(p);
    focus.setKbPane(p.dataset.pane!);
    if (p.dataset.paneId) {
      setLayout((l) => focusLayout(l, Number(p.dataset.paneId)));
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
    const inField = !!t.closest("input, textarea, select, [contenteditable='true']");
    // A pop-out has no list for the keys to mean.
    const scope = scopeOf(focus.keyPane()?.dataset.pane ?? (IS_MAIN ? "list" : "doc"));
    const step = stepKeys(getBindings(), seq, key, { scope, inField, now: Date.now() });
    // An open popover, menu or the palette owns the keys (j / k move inside it); the palette's own key still toggles it.
    if (!seq.first && openOverlays() && !(step.kind === "run" && step.action.id === "palette")) {
      return;
    }
    keySeq.track(step.seq, scope);
    if (step.kind === "none") {
      return;
    }
    if (step.kind !== "run") {
      e.preventDefault();
      return;
    }
    const { id } = step.action;
    // Esc in a field only leaves the field; panes that own an Esc (palette, search) handle it first.
    if (inField && id === "escape") {
      return t.blur();
    }
    // Enter on a control activates it; on a list row or search hit it opens the cursor.
    if ((id === "open" || id === "openPage") && t.closest("button, a, [role='button']") && !t.closest(".row, .hit")) {
      return;
    }
    // Plain keys on a focused button would also activate it.
    e.preventDefault();
    run(id, step.count, step.sequence);
  });

  // What the page overlay forwarded: keyboard focus is in that page's pane. Its `stepKeys` has read
  // the keys, so this is a whole sequence, a chord's first key, or empty for one that ended there.
  const onPageKey = useEffectEvent(({ tab, key, count }: { tab: string; key: string; count: number }) => {
    if (!key) {
      return keySeq.track(IDLE);
    }
    const focusApp = () =>
      getCurrentWebview()
        .setFocus()
        .catch(() => {});
    // What the app focused last is stale (j / k in the nav would step the nav).
    (document.activeElement as HTMLElement | null)?.blur();
    const page = pageByKey(layout, tab);
    const pane = page && tabById(layout, page.id)?.pane.id;
    const paneEl = document.querySelector<HTMLElement>(`[data-pane-id='${pane}']`);
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
      if (movePane(action.id, paneEl)) {
        void focusApp();
      }
      return;
    }
    if (LEAVES_PAGE.has(action.id)) {
      void focusApp();
    }
    actions[action.id](count, key);
  });

  useEffect(() => {
    const down = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", down);
    const unlisten = listen<{ tab: string; key: string; count: number }>("browser-key", (e) => onPageKey(e.payload));
    return () => {
      window.removeEventListener("keydown", down);
      void unlisten.then((f) => f());
    };
  }, []);

  return { run };
}
