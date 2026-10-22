import { useRef } from "react";
import { createPortal } from "react-dom";
import { AlertDialog as AD } from "radix-ui";
import { useCover } from "./Popover";
import { useT } from "../i18n";

/**
 * A modal confirmation for a destructive action, on body so no toolbar's overflow clips it. Focus
 * starts on キャンセル; Esc, the scrim and キャンセル cancel. Keys never reach the app's shortcuts behind it.
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
  const scrim = useRef<HTMLDivElement>(null);
  useCover(scrim, true);
  // Not AD.Portal: it mounts a render late, after useCover has measured.
  return createPortal(
    <AD.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AD.Overlay ref={scrim} className="pal-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
        <AD.Content className="dlg" onKeyDown={(e) => e.stopPropagation()}>
          <AD.Title asChild><h2>{title}</h2></AD.Title>
          <AD.Description asChild><div className="dlg-body">{children}</div></AD.Description>
          <div className="dlg-acts">
            <AD.Cancel className="btn">{t("common.cancel")}</AD.Cancel>
            {/* Not AD.Action: it would also close, calling onCancel after onConfirm. */}
            <button className="btn danger" onClick={onConfirm}>{confirm}</button>
          </div>
        </AD.Content>
      </AD.Overlay>
    </AD.Root>,
    document.body,
  );
}
