import { useEffect, useEffectEvent, useRef, useState } from "react";
import { coverStyle, useCover } from "../ui/Popover";
import { useT } from "../i18n";
import { keyOf } from "../lib/keymap";

/**
 * tmux's display-panes: a number over each pane on screen until the next key. Its digit moves the
 * keyboard there, 0 being the tenth, as for tabs; any other key or a pointer press only ends it.
 */
export function PaneNumbers({ onPick, onClose }: { onPick: (pane: HTMLElement) => void; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const clear = useCover(ref, true);
  const [shown] = useState(() =>
    [...document.querySelectorAll<HTMLElement>("[data-pane]")]
      .filter((el) => el.getClientRects().length > 0)
      .slice(0, 10)
      .map((el) => ({ el, rect: el.getBoundingClientRect() })),
  );
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const key = keyOf(e);
    if (!key) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const picked = /^\d$/.test(key) ? shown[(Number(key) + 9) % 10] : undefined;
    if (picked) {
      onPick(picked.el);
    } else {
      onClose();
    }
  });
  const onPress = useEffectEvent(onClose);
  useEffect(() => {
    const key = (e: KeyboardEvent) => onKey(e);
    const press = () => onPress();
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", press, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", press, true);
    };
  }, []);
  return (
    <div ref={ref} className="pane-nums" role="status" aria-label={t("keys.paneNumbers")} style={coverStyle(clear)}>
      {shown.map(({ rect }, i) => (
        <span key={i} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
          <b>{(i + 1) % 10}</b>
        </span>
      ))}
    </div>
  );
}
