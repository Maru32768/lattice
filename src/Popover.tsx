import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listStep } from "./keys";

/**
 * The Page view's native webview is drawn above all app DOM, so every app overlay reports its
 * rectangle here; the Page view hides the webview while one of them intersects it.
 * Returns the function that withdraws the report.
 */
export const CoverContext = createContext<(r: DOMRect) => () => void>(() => () => {});

export function useCover(ref: React.RefObject<HTMLElement | null>, open: boolean) {
  const cover = useContext(CoverContext);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    return cover(ref.current.getBoundingClientRect());
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the rectangle is reported once per opening; cover and ref are stable
  }, [open]);
}

export const intersects = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Where a surface anchored below `anchor` goes: inside the pane the anchor sits in (so a popover
 * opened from the list stays off the page webview), else inside the window. Computed during render
 * so the first frame is already in place.
 */
function place(anchor: HTMLElement, width: number, align: "left" | "right") {
  const r = anchor.getBoundingClientRect();
  const pane = anchor.closest("[data-pane]")?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  const w = Math.min(width, pane.width - 16);
  const lo = pane.left + 8, hi = pane.right - w - 8;
  const left = Math.max(lo, Math.min(align === "left" ? r.left : r.right - w, hi));
  return { left, top: r.bottom + 4, width: w };
}

/** Closes on Escape and on a pointer press outside `ref` (and outside `anchor`, which toggles itself). */
function useDismiss(ref: React.RefObject<HTMLElement | null>, anchor: HTMLElement | null, onClose: () => void) {
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- ref is read when the pointer is pressed, not when the effect runs
  }, [anchor, onClose]);
}

const escape = (onClose: () => void) => (e: React.KeyboardEvent) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  onClose();
};

/** A dialog anchored below `anchor` (fixed, clamped to the window); focus returns to the anchor (or its first button) on close. */
export function Popover({ anchor, label, width, onClose, children }: {
  anchor: HTMLElement;
  label: string;
  width: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useMemo(() => place(anchor, width, "left"), [anchor, width]);
  useCover(ref, true);
  useDismiss(ref, anchor, onClose);
  useLayoutEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("input, [data-autofocus]") ?? ref.current;
    first?.focus();
    return () => (anchor.querySelector<HTMLElement>("button") ?? anchor).focus();
  }, [anchor]);
  return (
    <div ref={ref} className="pv" role="dialog" aria-label={label} tabIndex={-1}
      style={{ ...pos, maxHeight: `calc(100vh - ${pos.top + 12}px)` }} onKeyDown={escape(onClose)}>
      {children}
    </div>
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

/** `.menu` min-width; a wider menu grows away from the aligned edge. */
const MENU_WIDTH = 220;

function menuPlace(btn: HTMLElement, align: "left" | "right") {
  const p = place(btn, MENU_WIDTH, align);
  return align === "left" ? { left: p.left, top: p.top } : { right: window.innerWidth - p.left - p.width, top: p.top };
}

/**
 * The open menu: arrows move, Esc and a pick close it and return focus to `back`, a press outside
 * dismisses it. `at` is a point (a context menu) clamped into the window before the first paint.
 */
function MenuBody({ label, items, style, at, anchor, back, onClose }: {
  label: string;
  items: (MenuItem | string)[];
  style?: React.CSSProperties;
  at?: { x: number; y: number };
  /** Toggles the menu itself, so a press on it is not a dismissal. */
  anchor: HTMLElement | null;
  back: HTMLElement | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!at || !el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, at.y + r.height > window.innerHeight - 8 ? at.y - r.height : at.y)}px`;
  }, [at]);
  // After the placement above: the rectangle reported is where the menu is drawn.
  useCover(ref, true);
  useDismiss(ref, anchor, onClose);
  useEffect(() => { ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus(); }, []);

  function close() {
    onClose();
    back?.focus();
  }

  function arrows(e: React.KeyboardEvent) {
    const d = listStep(e, false);
    if (!d) return escape(close)(e);
    e.preventDefault();
    const all = [...ref.current!.querySelectorAll<HTMLElement>("button:not(:disabled)")];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + d + all.length) % all.length]?.focus();
  }

  return (
    <div ref={ref} className="menu" role="menu" aria-label={label} onKeyDown={arrows} style={at ? { left: at.x, top: at.y } : style}>
      {items.map((it, i) =>
        it === "-" ? <div key={i} className="sep" role="separator" />
        : typeof it === "string" ? <div key={i} className="cap">{it}</div>
        : (
          <button key={i} role={it.checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={it.checked} className={it.danger ? "danger" : undefined}
            disabled={it.disabled} title={it.hint} onClick={() => { close(); it.onSelect(); }}>
            {it.checked !== undefined && <span className="check" aria-hidden="true">{it.checked ? "✓" : ""}</span>}
            {it.hint ? <span className="mi">{it.label}<span className="mi-hint">{it.hint}</span></span> : it.label}
          </button>
        ))}
    </div>
  );
}

/** A trigger button plus an anchored menu. `items` entries of "-" are separators, strings are captions. */
export function Menu({ trigger, label, className, items, align = "left", title }: {
  trigger: React.ReactNode;
  label: string;
  className: string;
  /** "-" is a separator; any other string, a caption. */
  items: (MenuItem | string)[];
  align?: "left" | "right";
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <span style={{ display: "inline-flex" }}>
      <button ref={btn} className={className} aria-label={label} title={title ?? label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>{trigger}</button>
      {open && <MenuBody label={label} items={items} style={menuPlace(btn.current!, align)} anchor={btn.current} back={btn.current} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** A menu at a point: right-click, or the menu key / Shift+F10 on the element `from` (which gets focus back). */
export function ContextMenu({ x, y, label, items, from, onClose }: {
  x: number;
  y: number;
  label: string;
  items: (MenuItem | string)[];
  from: HTMLElement | null;
  onClose: () => void;
}) {
  const at = useMemo(() => ({ x, y }), [x, y]);
  return <MenuBody label={label} items={items} at={at} anchor={null} back={from} onClose={onClose} />;
}

/** Where a context menu opened from the keyboard goes: under the start of the element. */
export const menuPoint = (e: React.MouseEvent | MouseEvent, el: HTMLElement) => {
  if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
  const r = el.getBoundingClientRect();
  return { x: r.left + 16, y: r.bottom };
};
