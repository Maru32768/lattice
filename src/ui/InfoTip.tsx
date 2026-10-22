import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

/** Room the tooltip keeps from the window's right edge (its max-width plus a margin). */
const TIP_W = 300;

/**
 * ⓘ with a tooltip on hover and keyboard focus; Esc hides it. The text is the icon's description
 * (`aria-describedby`), so a screen reader reads it without the tooltip showing. Drawn fixed in
 * the body so a scrolling table does not clip it.
 */
export function InfoTip({ label, text }: { label: string; text: string }) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const show = () => {
    const r = ref.current!.getBoundingClientRect();
    setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - TIP_W)), top: r.bottom + 6 });
  };
  const hide = () => setAt(null);
  return (
    <>
      <span
        ref={ref}
        className="info-i"
        tabIndex={0}
        role="img"
        aria-label={label}
        aria-describedby={id}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key === "Escape" && at) {
            e.stopPropagation();
            hide();
          }
        }}
      >
        <Icon name="info" size="sm" />
      </span>
      {createPortal(
        <span id={id} role="tooltip" className="info-tip" hidden={!at} style={at ?? undefined}>
          {text}
        </span>,
        document.body,
      )}
    </>
  );
}
