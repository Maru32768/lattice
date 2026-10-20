import { useEffect, useRef, useState } from "react";
import { useCover } from "./Popover";

export type Resizable = "nav" | "list" | "search" | "chat";
export type PaneWidths = Record<Resizable, number>;

const LIMITS: Record<Resizable, { min: number; max: number; label: string }> = {
  nav: { min: 180, max: 360, label: "ナビゲーションの幅" },
  list: { min: 300, max: 640, label: "記事一覧の幅" },
  search: { min: 380, max: 760, label: "検索結果の幅" },
  chat: { min: 320, max: 720, label: "対話ペインの幅" },
};
export const DEFAULT_WIDTHS: PaneWidths = { nav: 228, list: 396, search: 520, chat: 430 };

const KEY = "lattice.paneWidths";

/**
 * true: the page webview stays up and follows its pane during a drag. Chromium captures the mouse
 * on the press (the pressed webview's window holds capture until release), so moves over the page
 * still reach this document. false: a still of the page covers it for the drag instead.
 */
const LIVE_RESIZE = true;

const clamp = (p: Resizable, w: number) => Math.round(Math.max(LIMITS[p].min, Math.min(LIMITS[p].max, w)));

export function loadWidths(): PaneWidths {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<PaneWidths>;
    const out = { ...DEFAULT_WIDTHS };
    for (const p of Object.keys(out) as Resizable[]) if (typeof saved[p] === "number") out[p] = clamp(p, saved[p]);
    return out;
  } catch {
    return { ...DEFAULT_WIDTHS };
  }
}

export function saveWidths(w: PaneWidths) {
  try {
    localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    // Blocked storage: widths last for this session only.
  }
}

/**
 * Drag handle on one edge of a pane (Conversation board's dock divider). `side` is where the pane
 * sits: "left" grows the pane as the handle moves right, "right" (the chat dock) as it moves left.
 */
export function Splitter({ pane, side, width, onWidth }: {
  pane: Resizable;
  side: "left" | "right";
  width: number;
  onWidth: (w: number) => void;
}) {
  const [drag, setDrag] = useState<{ x: number; w: number } | null>(null);
  const shield = useRef<HTMLDivElement>(null);
  const dir = side === "left" ? 1 : -1;
  useCover(shield, !!drag && !LIVE_RESIZE);
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => onWidth(clamp(pane, drag.w + dir * (e.clientX - drag.x)));
    const up = () => setDrag(null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
    };
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- listeners live for one drag, during which pane, side and onWidth do not change
  }, [drag]);

  function down(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    // Counted on mousedown: the drag shield takes the second click, so dblclick never reaches the handle.
    if (e.detail === 2) onWidth(DEFAULT_WIDTHS[pane]);
    else setDrag({ x: e.clientX, w: width });
  }

  function keys(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    onWidth(clamp(pane, width + dir * (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 64 : 16)));
  }

  const { min, max, label } = LIMITS[pane];
  return (
    <>
      <div className={`splitter at-${pane}${drag ? " on" : ""}`} role="separator" aria-orientation="vertical" aria-label={label}
        aria-valuenow={width} aria-valuemin={min} aria-valuemax={max} tabIndex={0} title={`${label}（ドラッグ・← → で変更、ダブルクリックで元に戻す）`}
        onMouseDown={down} onKeyDown={keys}>
        <span />
      </div>
      {drag && <div ref={shield} className="drag-shield" />}
    </>
  );
}
