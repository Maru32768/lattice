import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ContextMenu as CM, DropdownMenu as DM, Popover as PV } from "radix-ui";
import { listStep } from "../lib/keys";

/**
 * The Page view's native webview is drawn above all app DOM, so every app overlay reports its
 * rectangle here; the Page view hides the webview while one of them intersects it. Kept outside
 * React state so opening a menu re-renders only the Page views, not the whole app (H8).
 */
let rects: DOMRect[] = [];
/** The page webviews drawn now, by tab key (their placeholders' rectangles); one hidden behind its still is not here. */
const pages = new Map<string, () => DOMRect | undefined>();
const watchers = new Set<() => void>();
const notify = () => watchers.forEach((w) => w());
const watch = (w: () => void) => {
  watchers.add(w);
  return () => void watchers.delete(w);
};
/** Reports an overlay's rectangle; returns the function that withdraws it. */
export function coverRect(r: DOMRect) {
  rects = [...rects, r];
  notify();
  return () => {
    rects = rects.filter((x) => x !== r);
    notify();
  };
}
export const CoverContext = createContext<(r: DOMRect) => () => void>(coverRect);
/** How many overlays are open now. */
export const openOverlays = () => rects.length;
export function useOverlays() {
  return useSyncExternalStore(watch, () => rects);
}
/** The Page view reports its webview as drawn (`rect`) or as hidden behind its still (null). */
export function pageDrawn(key: string, rect: (() => DOMRect | undefined) | null) {
  if (rect) pages.set(key, rect);
  else pages.delete(key);
  notify();
}

export function useCover(ref: React.RefObject<HTMLElement | null>, open: boolean) {
  const cover = useContext(CoverContext);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    return cover(ref.current.getBoundingClientRect());
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the rectangle is reported once per opening; cover and ref are stable
  }, [open]);
}

export const intersects = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** Page `key` is drawn and no overlay covers it, so a focus it reports came from a click on it. */
export function pageClickable(key: string) {
  const b = pages.get(key)?.();
  return !!b && !rects.some((r) => intersects(r, b));
}
const underPage = (r: DOMRect) => [...pages.values()].some((p) => {
  const b = p();
  return !!b && intersects(b, r);
});

/** Invisible but focusable: Radix moves focus into the surface while it waits. */
const WAITING: React.CSSProperties = { opacity: 0, pointerEvents: "none" };

/**
 * Reports the surface's rectangle once Radix has placed it, and keeps it invisible while a page
 * webview is drawn under it. The webview hides only after its still is painted; a surface shown
 * before that is drawn in pieces, the part over the page later than the rest (H22).
 */
function useSurface() {
  const cover = useContext(CoverContext);
  const ref = useRef<HTMLDivElement>(null);
  const [clear, setClear] = useState(false);
  const undo = useRef<(() => void)[]>([]);
  useEffect(() => () => {
    undo.current.forEach((f) => f());
    undo.current = [];
  }, []);
  const onPlaced = () => {
    if (undo.current.length || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    // Radix can report the placement before its position reaches the DOM: the surface is still
    // parked above the window (translate(0, -200%)), which overlaps no page. Measure where it lands.
    if (r.bottom <= 0) return void requestAnimationFrame(onPlaced);
    const check = () => !underPage(r) && setClear(true);
    undo.current.push(cover(r), watch(check));
    check();
  };
  // Radix leaves `onPlaced` out of the menu and popover prop types but passes it on to the Popper,
  // which calls it once placed; every e2e menu spec depends on it.
  return { ref, style: clear ? undefined : WAITING, ...({ onPlaced } as object) };
}

/** Radix puts focus back where it was when a surface closes; not when the close already moved it (a press on another control, a picked item that opened a dialog). */
function keepFocus(e: Event) {
  if (document.activeElement && document.activeElement !== document.body) e.preventDefault();
}

/** A dialog anchored below `anchor`, kept inside the anchor's pane; focus returns to the anchor (or its first button) on close. */
export function Popover({ anchor, label, width, onClose, children }: {
  anchor: HTMLElement;
  label: string;
  width: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const s = useSurface();
  // Inside the pane, so a popover opened from the list stays off the page webview.
  const pane = anchor.closest("[data-pane]");
  const w = Math.min(width, (pane?.clientWidth ?? window.innerWidth) - 16);
  return (
    <PV.Root open onOpenChange={(o) => !o && onClose()}>
      <PV.Anchor virtualRef={{ current: anchor }} />
      <PV.Portal>
        <PV.Content {...s} className="pv" aria-label={label} align="start" sideOffset={4} collisionBoundary={pane} collisionPadding={8}
          style={{ ...s.style, width: w, maxHeight: "var(--radix-popover-content-available-height)" }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (s.ref.current?.querySelector<HTMLElement>("input, [data-autofocus]") ?? s.ref.current)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            keepFocus(e);
            if (e.defaultPrevented) return;
            e.preventDefault();
            (anchor.querySelector("button") ?? anchor).focus();
          }}
          // The anchor toggles the popover itself: a press on it is not a press outside.
          onInteractOutside={(e) => anchor.contains(e.target as Node) && e.preventDefault()}>
          {children}
        </PV.Content>
      </PV.Portal>
    </PV.Root>
  );
}

export interface MenuItem {
  label: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  checked?: boolean;
  /** A line under the label saying what the item does. */
  hint?: string;
  /** Destructive (delete): drawn in the error color. */
  danger?: boolean;
}

/** j / k (the list bindings) step through a menu as the arrows do; Radix handles the arrows. */
function stepKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") return;
  const d = listStep(e, false);
  if (!d) return;
  e.preventDefault();
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[role^='menuitem']:not([data-disabled])")];
  const i = all.indexOf(document.activeElement as HTMLElement);
  all[(i + d + all.length) % all.length]?.focus();
}

/** The parts both menus share; `items` entries of "-" are separators, other strings captions. */
function MenuItems({ parts: P, items }: { parts: Pick<typeof DM, "Item" | "Label" | "Separator">; items: (MenuItem | string)[] }) {
  return items.map((it, i) =>
    it === "-" ? <P.Separator key={i} className="sep" />
    : typeof it === "string" ? <P.Label key={i} className="cap">{it}</P.Label>
    : (
      <P.Item key={i} asChild disabled={it.disabled} onSelect={it.onSelect}>
        <button role={it.checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={it.checked} className={it.danger ? "danger" : undefined}
          disabled={it.disabled} title={it.hint}>
          {it.checked !== undefined && <span className="check" aria-hidden="true">{it.checked ? "✓" : ""}</span>}
          {it.hint ? <span className="mi">{it.label}<span className="mi-hint">{it.hint}</span></span> : it.label}
        </button>
      </P.Item>
    ));
}

/** The content's props both menus share. */
const menuProps = (label: string, s: ReturnType<typeof useSurface>, height: string) => ({
  ...s, className: "menu", "aria-label": label, loop: true, collisionPadding: 8,
  style: { ...s.style, maxHeight: `var(${height})`, overflowY: "auto" as const },
  onCloseAutoFocus: keepFocus, onKeyDown: stepKeys,
});

/**
 * A trigger button plus an anchored menu, kept inside the trigger's pane unless `inPane` is false
 * (the nav is narrower than a menu: its menus open beside their trigger, over the list).
 */
export function Menu({ trigger, label, className, items, align = "left", title, inPane = true, menuClass }: {
  trigger: React.ReactNode;
  label: string;
  className: string;
  /** "-" is a separator; any other string, a caption. */
  items: (MenuItem | string)[];
  align?: "left" | "right";
  title?: string;
  inPane?: boolean;
  /** A class added to the open menu (it is drawn in a portal, outside the trigger's subtree). */
  menuClass?: string;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <span style={{ display: "inline-flex" }}>
      <DM.Root modal={false}>
        <DM.Trigger ref={btn} className={className} aria-label={label} title={title ?? label}>{trigger}</DM.Trigger>
        <DM.Portal>
          <MenuContent label={label} items={items} align={align === "left" ? "start" : "end"} menuClass={menuClass}
            boundary={inPane ? btn.current?.closest("[data-pane]") ?? null : null} />
        </DM.Portal>
      </DM.Root>
    </span>
  );
}

function MenuContent({ label, items, align, boundary, menuClass }: {
  label: string;
  items: (MenuItem | string)[];
  align: "start" | "end";
  boundary: Element | null;
  menuClass?: string;
}) {
  const p = menuProps(label, useSurface(), "--radix-dropdown-menu-content-available-height");
  return (
    <DM.Content {...p} className={menuClass ? `menu ${menuClass}` : "menu"} align={align} sideOffset={4} collisionBoundary={boundary}>
      <MenuItems parts={DM} items={items} />
    </DM.Content>
  );
}

/**
 * The right-click menu (H3) of whatever inside `children` matches `targets`: that element's own
 * contextmenu handler sets `items`. A press anywhere else gets the WebView's menu. The menu key and
 * Shift+F10 dispatch a contextmenu event at the focused target (App).
 */
export function ContextMenu({ label, items, targets, children }: {
  label: string;
  items: (MenuItem | string)[];
  targets: string;
  children: React.ReactElement;
}) {
  return (
    <CM.Root modal={false}>
      <CM.Trigger asChild onContextMenuCapture={(e) => {
        if (!(e.target as Element).closest(targets)) e.stopPropagation();
      }}>{children}</CM.Trigger>
      <CM.Portal>
        <ContextContent label={label} items={items} />
      </CM.Portal>
    </CM.Root>
  );
}

function ContextContent({ label, items }: { label: string; items: (MenuItem | string)[] }) {
  return (
    <CM.Content {...menuProps(label, useSurface(), "--radix-context-menu-content-available-height")}>
      <MenuItems parts={CM} items={items} />
    </CM.Content>
  );
}
