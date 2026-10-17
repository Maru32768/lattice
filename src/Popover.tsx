import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The Page view's native webview is drawn above all app DOM, so any app overlay that could
 * overlap it reports itself here; the shell hides the webview while one is open (BrowserView `covered`).
 */
export const CoverContext = createContext<(delta: 1 | -1) => void>(() => {});

export function useCover(open: boolean) {
  const cover = useContext(CoverContext);
  useEffect(() => {
    if (!open) return;
    cover(1);
    return () => cover(-1);
  }, [open]);
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
  }, [anchor, onClose]);
}

const escape = (onClose: () => void) => (e: React.KeyboardEvent) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  onClose();
};

/** A dialog anchored below `anchor` (fixed, clamped to the window); focus returns to the anchor on close. */
export function Popover({ anchor, label, width, onClose, children }: {
  anchor: HTMLElement;
  label: string;
  width: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useCover(true);
  useDismiss(ref, anchor, onClose);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 6 });
    const first = ref.current?.querySelector<HTMLElement>("input, [data-autofocus]") ?? ref.current;
    first?.focus();
    return () => anchor.focus();
  }, [anchor]);
  return (
    <div ref={ref} className="pv" role="dialog" aria-label={label} tabIndex={-1}
      style={{ ...pos, width, maxHeight: `calc(100vh - ${pos.top + 12}px)` }} onKeyDown={escape(onClose)}>
      {children}
    </div>
  );
}

export interface MenuItem {
  label: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  checked?: boolean;
}

/** A trigger button plus an anchored menu. `items` entries of "-" are separators, strings are captions. */
export function Menu({ trigger, label, className, items, align = "left", title }: {
  trigger: React.ReactNode;
  label: string;
  className: string;
  items: (MenuItem | "-" | string)[];
  align?: "left" | "right";
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  useCover(open);
  useDismiss(ref, btn.current, () => setOpen(false));
  useEffect(() => { if (open) ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus(); }, [open]);

  function close() {
    setOpen(false);
    btn.current?.focus();
  }

  function arrows(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return escape(close)(e);
    e.preventDefault();
    const all = [...ref.current!.querySelectorAll<HTMLElement>("button:not(:disabled)")];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
  }

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button ref={btn} className={className} aria-label={label} title={title ?? label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>{trigger}</button>
      {open && (
        <div ref={ref} className="menu" role="menu" aria-label={label} onKeyDown={arrows}
          style={{ top: "calc(100% + 4px)", [align]: 0 }}>
          {items.map((it, i) =>
            it === "-" ? <div key={i} className="sep" role="separator" />
            : typeof it === "string" ? <div key={i} className="cap">{it}</div>
            : (
              <button key={i} role={it.checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={it.checked}
                disabled={it.disabled} onClick={() => { close(); it.onSelect(); }}>
                {it.checked !== undefined && <span className="check" aria-hidden="true">{it.checked ? "✓" : ""}</span>}
                {it.label}
              </button>
            ))}
        </div>
      )}
    </span>
  );
}
