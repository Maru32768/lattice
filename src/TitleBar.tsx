import { useEffect, useState } from "react";
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
 * The undecorated window's title bar: icon and name on a drag region (double-click maximizes),
 * caption buttons at the right. Tauri's drag script acts only on elements that carry the attribute.
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    const sync = () => w.isMaximized().then(setMaximized, () => {});
    sync();
    const off = w.onResized(sync);
    return () => { off.then((f) => f()); };
  }, []);
  const caption = (glyph: keyof typeof GLYPHS, label: string, run: () => Promise<void>, extra = "") => (
    <button className={`cap${extra}`} onClick={() => run().catch(() => {})} aria-label={label} title={label} tabIndex={-1}>
      <svg viewBox="0 0 10 10" aria-hidden="true">{GLYPHS[glyph]}</svg>
    </button>
  );
  return (
    <header className="titlebar" data-tauri-drag-region>
      <img className="tb-icon" src={logo} alt="" width={16} height={16} draggable={false} data-tauri-drag-region />
      <span className="tb-name" data-tauri-drag-region>Lattice</span>
      <span className="grow" data-tauri-drag-region />
      {caption("min", "最小化", () => getCurrentWindow().minimize())}
      {caption(maximized ? "restore" : "max", maximized ? "元のサイズに戻す" : "最大化", () => getCurrentWindow().toggleMaximize())}
      {caption("close", "閉じる", () => getCurrentWindow().close(), " close")}
    </header>
  );
}
