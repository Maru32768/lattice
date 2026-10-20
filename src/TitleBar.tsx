import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "./logo.svg";

// Windows 11 caption glyphs, 10×10.
const GLYPHS = {
  min: <path d="M0 5.5h10" />,
  max: <rect x=".5" y=".5" width="9" height="9" rx="1" />,
  restore: <><rect x=".5" y="2.5" width="7" height="7" rx="1" /><path d="M2.5 2.5v-1a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" /></>,
  close: <path d="M.5.5l9 9M9.5.5l-9 9" />,
};

/**
 * The undecorated window's title bar: press anywhere but the caption buttons to drag the window,
 * double-click to maximize.
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    const sync = () => w.isMaximized().then(setMaximized, () => {});
    void sync();
    const off = w.onResized(() => void sync());
    return () => { void off.then((f) => f()); };
  }, []);
  // Chromium counts a press as a repeat click when it lands on the same spot of the window. A drag
  // moves the window along with the cursor, so a click right after it would read as the drag's
  // second click; Tauri's data-tauri-drag-region then maximizes. The screen position tells them apart.
  const lastPress = useRef<{ x: number; y: number } | null>(null);
  function press(e: React.MouseEvent) {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    e.preventDefault();
    const at = { x: e.screenX, y: e.screenY }, prev = lastPress.current;
    const w = getCurrentWindow();
    if (e.detail >= 2 && prev && Math.abs(at.x - prev.x) <= 2 && Math.abs(at.y - prev.y) <= 2) {
      lastPress.current = null;
      w.toggleMaximize().catch(() => {});
    } else {
      lastPress.current = at;
      w.startDragging().catch(() => {});
    }
  }
  const caption = (glyph: keyof typeof GLYPHS, label: string, run: () => Promise<void>, extra = "") => (
    <button className={`cap${extra}`} onClick={() => run().catch(() => {})} aria-label={label} title={label} tabIndex={-1}>
      <svg viewBox="0 0 10 10" aria-hidden="true">{GLYPHS[glyph]}</svg>
    </button>
  );
  return (
    <header className="titlebar" onMouseDown={press}>
      <img className="tb-icon" src={logo} alt="" width={16} height={16} draggable={false} />
      <span className="tb-name">Lattice</span>
      <span className="grow" />
      {caption("min", "最小化", () => getCurrentWindow().minimize())}
      {caption(maximized ? "restore" : "max", maximized ? "元のサイズに戻す" : "最大化", () => getCurrentWindow().toggleMaximize())}
      {caption("close", "閉じる", () => getCurrentWindow().close(), " close")}
    </header>
  );
}
