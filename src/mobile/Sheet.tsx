import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "../i18n";

/** A sheet from the bottom of the screen. A modal `<dialog>`: Esc and the back gesture close it. */
export function Sheet({
  open,
  onClose,
  title,
  className,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  className?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) {
      d.showModal();
    } else if (!open && d?.open) {
      d.close();
    }
  }, [open]);
  return (
    <dialog ref={ref} className={className ? `m-sheet ${className}` : "m-sheet"} aria-label={title} onClose={onClose}>
      <header>
        <h2>{title}</h2>
        <button className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      </header>
      <div className="m-sheet-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>
  );
}
