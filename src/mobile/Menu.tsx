import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n";
import { Icon } from "../ui/Icon";

const popovers = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean };

/** The ⋯ button and its menu. A popover: a tap outside or Esc closes it, as a menu should. */
export function Menu({ items }: { items: MenuItem[] }) {
  const t = useT();
  const id = useId();
  /** Only where popovers are not supported (iOS before 17): the menu then opens by this, and stays hidden otherwise. */
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // What a popover does by itself: a tap outside the menu or Esc closes it.
  useEffect(() => {
    if (!open) {
      return;
    }
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !toggle.current?.contains(target)) {
        setOpen(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <>
      <button
        ref={toggle}
        className="m-icon"
        popoverTarget={id}
        onClick={popovers ? undefined : () => setOpen(!open)}
        aria-label={t("mobile.menu")}
        aria-haspopup="menu"
      >
        <Icon name="more" />
      </button>
      <div ref={menu} id={id} className={open ? "m-menu open" : "m-menu"} popover="auto" role="menu" aria-label={t("mobile.menu")}>
        {items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            className={item.danger ? "danger" : undefined}
            onClick={() => {
              // Not popoverTargetAction: an item whose label changes is a new button by then, and a removed one hides nothing.
              if (popovers) {
                menu.current?.hidePopover();
              }
              setOpen(false);
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
