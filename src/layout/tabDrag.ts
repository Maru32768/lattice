// Dragging a tab between windows, live (design-review §26). The backend runs the drag
// (`src-tauri/src/tabdrag.rs`): it follows the cursor, decides where the tab is, and tells the
// window holding the tab where it goes, one window at a time. Windows report their strips and
// pane bodies, measured here, and say when a tab sent to them has arrived.
import type { Doc, Id, Zone } from "./layout";
import type { DropTarget } from "./TabStrip";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One pane's tab strip, in the CSS pixels of its window; `mids` are the tabs' horizontal centers, `body` the pane below the strip. */
export interface Strip extends Rect {
  pane: Id;
  mids: number[];
  body: Rect;
}

/** A window's client area in physical pixels, its scale, and its strips. */
export interface WindowGeom {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  strips: Strip[];
}

/** What the dragging window tells the backend: where the tab is, and the window's geometry. */
export interface DragStart {
  pane: Id;
  index: number;
  /** A document window's only tab: the window itself follows the cursor. */
  alone: boolean;
  /** Where in the tab the pointer went down (CSS px from its corner): a torn-off window keeps that spot under the cursor. */
  grab: [number, number];
  geom: WindowGeom;
}

/** A pane's body in a window split into panes (the dragging one): its center takes the tab, an edge splits the pane on that side. */
export interface ZoneTarget {
  pane: Id;
  zone: Zone;
}

/** Where a drag is over in the window it started in, while the tab is still there: a strip slot (a marker), or a pane body's zone (an overlay). */
export type Over = DropTarget | ZoneTarget;

/** Where the tab goes: a slot or zone in window `label`, or (only a label) that window's focused pane. */
export type Slot = ((DropTarget | ZoneTarget) & { label: string }) | { label: string };

/** A tab sent to this window during a drag, for slot `at` (else the focused pane). */
export interface Take {
  doc: Doc;
  at?: DropTarget;
}

/** Broadcast: a drag began; every window reports its strips until `TAB_DRAG_END`. */
export const TAB_DRAG_START = "tab-drag-start";
/** Broadcast: the drag is over (markers, drawn tabs and the ghost go). */
export const TAB_DRAG_END = "tab-drag-end";
/** To one window: the `Over` to draw, or null. */
export const TAB_DRAG_OVER = "tab-drag-over";
/** To the window holding the tab: it leaves for a new document window. */
export const TAB_DRAG_TEAR = "tab-drag-tear";
/** To the window holding the tab: the `Slot` it goes to, during the drag or as it ends. */
export const TAB_DRAG_DROP = "tab-drag-drop";
/** From the window holding the tab to the one it sends it to: the `Take`. */
export const TAB_DRAG_TAKE = "tab-drag-take";

/** This window's geometry from its DOM, `inner` being its client area's physical position. */
export function measure(label: string, inner: { x: number; y: number }, root: ParentNode = document): WindowGeom {
  const scale = window.devicePixelRatio;
  const strips = [...root.querySelectorAll<HTMLElement>("[data-pane-id]")].map((pane) => {
    const r = pane.querySelector<HTMLElement>(":scope > .tabs")!.getBoundingClientRect();
    const mids = [...pane.querySelectorAll<HTMLElement>(":scope > .tabs > .tab")].map((t) => {
      const b = t.getBoundingClientRect();
      return b.left + b.width / 2;
    });
    const p = pane.getBoundingClientRect();
    const body = { x: p.left, y: r.bottom, width: p.width, height: p.bottom - r.bottom };
    return { pane: Number(pane.dataset.paneId), x: r.left, y: r.top, width: r.width, height: r.height, mids, body };
  });
  return { label, x: inner.x, y: inner.y, width: window.innerWidth * scale, height: window.innerHeight * scale, scale, strips };
}
