import { useRef, useState } from "react";
import { Favicon } from "./Favicon";
import { Icon } from "./Icon";
import type { Dir, Id, Pane, Tab } from "./layout";

export interface TabLabel {
  title: string;
  domain: string;
  feed?: number | null;
}

/** Where a dragged tab would land: before the `index`-th tab of pane `pane`. */
export interface DropTarget {
  pane: Id;
  index: number;
}

/** The strip under the pointer, and the slot the pointer is over in it. */
function targetAt(x: number, y: number): DropTarget | null {
  const pane = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pane-id]");
  if (!pane) return null;
  const tabs = [...pane.querySelectorAll<HTMLElement>(":scope > .tabs > .tab")];
  const index = tabs.filter((t) => {
    const r = t.getBoundingClientRect();
    return r.left + r.width / 2 < x;
  }).length;
  return { pane: Number(pane.dataset.paneId), index };
}

/** Moves of less than this many pixels are a click. */
const DRAG_PX = 4;

/**
 * One pane's tabs: title and favicon, × (middle-click closes too), drag to reorder or to another
 * pane's strip, + for a new tab, and the pane's split and close buttons.
 */
export function TabStrip({ pane, multi, labelOf, drop, onActivate, onClose, onNew, onSplit, onClosePane, onDrag, onDrop }: {
  pane: Pane;
  /** More than one pane: this one can be closed. */
  multi: boolean;
  labelOf: (t: Tab) => TabLabel;
  drop: DropTarget | null;
  onActivate: (tab: Id) => void;
  onClose: (tab: Id) => void;
  onNew: () => void;
  onSplit: (dir: Dir) => void;
  onClosePane: () => void;
  onDrag: (t: DropTarget | null) => void;
  onDrop: (tab: Id, t: DropTarget) => void;
}) {
  const [dragging, setDragging] = useState<Id | null>(null);
  const press = useRef<{ tab: Id; x: number; y: number; moved: boolean } | null>(null);

  function down(e: React.PointerEvent, tab: Id) {
    // A middle press would start Chromium's autoscroll (and then no auxclick comes); see middle.ts.
    if (e.button === 1) return e.preventDefault();
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    press.current = { tab, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function moveP(e: React.PointerEvent) {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_PX) return;
    p.moved = true;
    setDragging(p.tab);
    onDrag(targetAt(e.clientX, e.clientY));
  }

  function up(e: React.PointerEvent, tab: Id) {
    if (e.button === 1) return onClose(tab);
    const p = press.current;
    press.current = null;
    setDragging(null);
    onDrag(null);
    if (!p) return;
    if (!p.moved) return onActivate(p.tab);
    const t = targetAt(e.clientX, e.clientY);
    if (t) onDrop(p.tab, t);
  }

  const here = drop?.pane === pane.id ? drop.index : -1;
  return (
    <div className="tabs" role="tablist" aria-label="タブ">
      {pane.tabs.map((t, i) => {
        const { title, domain, feed } = labelOf(t);
        const on = t.id === pane.active;
        return (
          <div key={t.id} role="tab" aria-selected={on} tabIndex={on ? 0 : -1} title={title}
            className={`tab${on ? " on" : ""}${dragging === t.id ? " dragging" : ""}${here === i ? " drop-before" : ""}${here === i + 1 && i === pane.tabs.length - 1 ? " drop-after" : ""}`}
            onPointerDown={(e) => down(e, t.id)} onPointerMove={moveP} onPointerUp={(e) => up(e, t.id)} onPointerCancel={(e) => up(e, t.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(t.id); } }}>
            {t.kind === "page" ? <Favicon domain={domain} /> : <Favicon domain={domain} feed={feed} />}
            <span className="tab-t">{title}</span>
            <button className="x" onClick={() => onClose(t.id)} aria-label={`${title} を閉じる`} title="閉じる (Ctrl+W)" tabIndex={-1}><Icon name="x" size="sm" /></button>
          </div>
        );
      })}
      <button className="ib" onClick={onNew} aria-label="新しいタブ" title="新しいタブ (Ctrl+T)"><Icon name="plus" /></button>
      <span className="grow" />
      <button className="ib" onClick={() => onSplit("row")} aria-label="右に分割" title="右に分割 (Ctrl+\)"><Icon name="vsplit" /></button>
      <button className="ib" onClick={() => onSplit("column")} aria-label="下に分割" title="下に分割 (Ctrl+-)"><Icon name="hsplit" /></button>
      {multi && <button className="ib" onClick={onClosePane} aria-label="ペインを閉じる" title="ペインを閉じる"><Icon name="x" /></button>}
    </div>
  );
}
