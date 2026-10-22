import { useEffect, useRef } from "react";
import { useCover } from "./Popover";
import { useT } from "../i18n";

/**
 * A modal confirmation for a destructive action. Focus starts on キャンセル and stays inside;
 * Esc, the scrim and キャンセル cancel. Keys never reach the app's shortcuts behind it.
 */
export function ConfirmDialog({ title, confirm, onConfirm, onCancel, children }: {
  title: string;
  /** Label of the danger button. */
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  useCover(scrim, true);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => before?.focus();
  }, []);

  function keys(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Tab") {
      const buttons = [...ref.current!.querySelectorAll<HTMLElement>("button")];
      const i = buttons.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
  }

  return (
    <div ref={scrim} className="pal-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div ref={ref} className="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-body" onKeyDown={keys}>
        <h2 id="dlg-title">{title}</h2>
        <div id="dlg-body" className="dlg-body">{children}</div>
        <div className="dlg-acts">
          <button ref={cancel} className="btn" onClick={onCancel}>{t("common.cancel")}</button>
          <button className="btn danger" onClick={onConfirm}>{confirm}</button>
        </div>
      </div>
    </div>
  );
}
