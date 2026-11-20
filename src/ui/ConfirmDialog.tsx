import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertDialog as AD } from "radix-ui";
import { coverStyle, useCover } from "./Popover";
import { useT } from "../i18n";

/**
 * A modal confirmation for a destructive action, on body so no toolbar's overflow clips it. Focus
 * starts on キャンセル; Esc, the scrim and キャンセル cancel. Keys never reach the app's shortcuts behind it.
 */
export function ConfirmDialog({
  title,
  confirm,
  cancel,
  armMs,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  /** Label of the danger button. */
  confirm: string;
  /** Label of the button that cancels, キャンセル by default. */
  cancel?: string;
  /** Keeps the danger button off for this long once the dialog shows: a click meant for what was there before must not press it. */
  armMs?: number;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const scrim = useRef<HTMLDivElement>(null);
  const clear = useCover(scrim, true);
  const [armed, setArmed] = useState(!armMs);
  // Counted from when it shows: over a page webview it waits, invisible, for the page's still.
  useEffect(() => {
    if (armed || !clear) {
      return;
    }
    const timer = setTimeout(() => setArmed(true), armMs);
    return () => clearTimeout(timer);
  }, [armed, clear, armMs]);
  // Not AD.Portal: it mounts a render late, after useCover has measured.
  return createPortal(
    <AD.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <AD.Overlay
        ref={scrim}
        className="pal-scrim"
        style={coverStyle(clear)}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) {
            onCancel();
          }
        }}
      >
        <AD.Content className="dlg" onKeyDown={(e) => e.stopPropagation()}>
          <AD.Title asChild>
            <h2>{title}</h2>
          </AD.Title>
          <AD.Description asChild>
            <div className="dlg-body">{children}</div>
          </AD.Description>
          <div className="dlg-acts">
            <AD.Cancel className="btn">{cancel ?? t("common.cancel")}</AD.Cancel>
            {/* Not AD.Action: it would also close, calling onCancel after onConfirm. */}
            <button className="btn danger" onClick={onConfirm} disabled={!armed}>
              {confirm}
            </button>
          </div>
        </AD.Content>
      </AD.Overlay>
    </AD.Root>,
    document.body,
  );
}
