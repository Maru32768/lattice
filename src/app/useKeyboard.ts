import { useEffect, useEffectEvent, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { browser } from "../api";
import { PREFIX_MS, actionFor, getBindings, pageKeys, useBindings, type ActionId } from "../lib/keys";
import { keyOf } from "../lib/keyname";
import { focusPane, paneAfter, paneOf } from "../layout/panes";
import { closePane, focus as focusLayout, pageByKey, tabById, type Layout } from "../layout/layout";
import { openOverlays, pageClickable } from "../ui/Popover";

/** Shortcuts that, pressed in the page, move on to the app: the page's webview gives up the keyboard. */
const LEAVES_PAGE = new Set<ActionId>(["palette", "search", "view", "newTab", "closeTab", "nextTab", "prevTab", "splitRight", "splitDown", "popOut"]);
/** What has a right-click menu: list rows and document tabs (H3). */
export const MENU_TARGETS = ".row[data-id], [role='tab'][data-tab], [data-folder]";
/** tmux keys after the prefix that act on panes and tabs rather than move. */
const PREFIXED: Record<string, ActionId | "closePane"> = {
  '"': "splitDown",
  "%": "splitRight",
  X: "closePane",
  C: "newTab",
  N: "nextTab",
  P: "prevTab",
  Z: "focus",
};

type SetLayout = (f: (l: Layout) => Layout) => void;

/**
 * Which pane has the keyboard: the one focus was moved to (outlined until the pointer is used),
 * and the one last clicked, where arrows scroll instead of moving the list cursor when it is the
 * document or chat. A click in a document pane, or in a page, focuses that pane: the next document opens there.
 */
export function usePaneFocus(layout: Layout, setLayout: SetLayout) {
  const [kbPane, setKbPane] = useState<string | null>(null);
  const pointerPane = useRef<string | null>(null);
  useEffect(() => {
    const focusin = (e: FocusEvent) => setKbPane((p) => p && (paneOf(e.target as Element)?.dataset.pane ?? null));
    const pointer = (e: PointerEvent) => {
      setKbPane(null);
      const p = paneOf(e.target as Element);
      pointerPane.current = p?.dataset.pane ?? null;
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
    pointerPane.current = "doc";
  });
  useEffect(() => {
    const sub = listen<{ tab: string }>("browser-focus", (e) => onPageFocus(e.payload.tab));
    return () => void sub.then((f) => f());
  }, []);

  return { kbPane, setKbPane, pointerPane };
}

/** The tmux-style pane prefix (Ctrl+B): armed until the next key or PREFIX_MS. */
export function usePrefix() {
  const [prefix, setPrefix] = useState(false);
  const timer = useRef(0);
  const arm = () => {
    setPrefix(true);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPrefix(false), PREFIX_MS);
  };
  const disarm = () => {
    clearTimeout(timer.current);
    setPrefix(false);
  };
  return { prefix, arm, disarm };
}

/**
 * The app's shortcuts: keys pressed in the app, and the ones a page's overlay forwards. With the
 * prefix armed the next key acts on panes; otherwise the bound action runs, unless a field, an
 * open overlay or a control owns the key. Also sends the page overlay the keys it forwards.
 */
export function useShortcuts({
  actions,
  prefix,
  layout,
  setLayout,
  focus,
}: {
  actions: Record<ActionId, () => void>;
  prefix: ReturnType<typeof usePrefix>;
  layout: Layout;
  setLayout: SetLayout;
  focus: ReturnType<typeof usePaneFocus>;
}) {
  const bindings = useBindings();
  useEffect(() => {
    browser.setKeys(pageKeys(bindings)).catch(() => {});
  }, [bindings]);

  /** True when focus moved to another pane. */
  function paneKey(key: string, from = paneOf(document.activeElement)): boolean {
    prefix.disarm();
    const act = PREFIXED[key];
    if (act === "closePane") {
      setLayout((l) => closePane(l, l.focused));
      return false;
    }
    if (act) {
      actions[act]();
      return false;
    }
    const p = paneAfter(key, from);
    if (!p) {
      return false;
    }
    focusPane(p);
    focus.setKbPane(p.dataset.pane!);
    if (p.dataset.paneId) {
      setLayout((l) => focusLayout(l, Number(p.dataset.paneId)));
    }
    return true;
  }

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) {
      return;
    }
    const key = keyOf(e);
    if (!key) {
      return;
    }
    if (prefix.prefix) {
      e.preventDefault();
      paneKey(key);
      return;
    }
    // The menu key / Shift+F10: the context menu of the focused row or tab, else of the list cursor's row.
    if ((key === "ContextMenu" || key === "Shift+F10") && !openOverlays()) {
      const on = (e.target as Element).closest?.<HTMLElement>(MENU_TARGETS) ?? document.querySelector<HTMLElement>(".row.cur");
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
    const action = actionFor(getBindings(), key);
    if (!action) {
      return;
    }
    // An open popover, menu or the palette owns the keys (j / k move inside it); Ctrl+K still toggles the palette.
    if (openOverlays() && action.id !== "palette") {
      return;
    }
    const t = e.target as HTMLElement;
    // A drag handle being moved with the keyboard owns the arrows, Space and Enter.
    if (t.closest("[aria-roledescription='sortable']")) {
      return;
    }
    const inField = t.closest("input, textarea, select, [contenteditable='true']");
    if (inField && !action.inFields) {
      return;
    }
    const focused = document.activeElement !== document.body ? paneOf(document.activeElement)?.dataset.pane : focus.pointerPane.current;
    if (key.startsWith("Arrow") && (focused === "doc" || focused === "chat")) {
      return;
    }
    // Esc in a field only leaves the field; panes that own an Esc (palette, search) handle it first.
    if (inField && action.id === "escape") {
      return t.blur();
    }
    // Enter on a control activates it; on a list row or search hit it opens the cursor.
    if ((action.id === "open" || action.id === "openPage") && t.closest("button, a, [role='button']") && !t.closest(".row, .hit")) {
      return;
    }
    // Plain keys on a focused button would also activate it.
    e.preventDefault();
    actions[action.id]();
  });

  // A shortcut the page overlay forwarded: keyboard focus is in that page's pane.
  const onPageKey = useEffectEvent(({ tab, key }: { tab: string; key: string }) => {
    const focusApp = () =>
      getCurrentWebview()
        .setFocus()
        .catch(() => {});
    // What the app focused last is stale (j / k in the nav would step the nav).
    (document.activeElement as HTMLElement | null)?.blur();
    const page = pageByKey(layout, tab);
    const pane = page && tabById(layout, page.id)?.pane.id;
    if (pane != null) {
      setLayout((l) => focusLayout(l, pane));
    }
    if (prefix.prefix) {
      if (paneKey(key, document.querySelector<HTMLElement>(`[data-pane-id='${pane}']`))) {
        void focusApp();
      }
      return;
    }
    const action = actionFor(getBindings(), key);
    if (!action || (openOverlays() && action.id !== "palette")) {
      return;
    }
    if (LEAVES_PAGE.has(action.id)) {
      void focusApp();
    }
    actions[action.id]();
  });

  useEffect(() => {
    const down = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", down);
    const unlisten = listen<{ tab: string; key: string }>("browser-key", (e) => onPageKey(e.payload));
    return () => {
      window.removeEventListener("keydown", down);
      void unlisten.then((f) => f());
    };
  }, []);

  return bindings;
}
