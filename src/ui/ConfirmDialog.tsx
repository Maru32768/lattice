import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AlertDialog as AD } from "radix-ui";
import { coverStyle, useCover } from "./Popover";
import { useT } from "../i18n";

/** When this window last came into focus, or 0 while it is out of it. */
let focusedSince = 0;
const watchers = new Set<() => void>();
const watch = (f: () => void) => {
  watchers.add(f);
  return () => void watchers.delete(f);
};
const refocus = () => {
  focusedSince = document.hasFocus() ? performance.now() : 0;
  watchers.forEach((f) => f());
};
addEventListener("focus", refocus);
addEventListener("blur", refocus);
refocus();

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
  /**
   * Keeps the danger button off for this long once the dialog shows with this window in focus: a click meant for what was
   * there before, or one that only brings the window forward, must not press it.
   */
  armMs?: number;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const scrim = useRef<HTMLDivElement>(null);
  const clear = useCover(scrim, true);
  const since = useSyncExternalStore(watch, () => focusedSince);
  const [armedFor, setArmedFor] = useState<number | null>(null);
  // Counted from when it shows, over a page webview too, which it waits for invisible, and again each time the window comes into focus.
  useEffect(() => {
    if (!armMs || !clear || !since) {
      return;
    }
    const timer = setTimeout(() => setArmedFor(since), armMs);
    return () => clearTimeout(timer);
  }, [armMs, clear, since]);
  const armed = !armMs || (since > 0 && armedFor === since);
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
          // Not while the danger button waits: the click that brings the window forward would answer what it never read.
          if (e.target === e.currentTarget && armed) {
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
