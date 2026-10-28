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

/** One pane's tab strip, in the CSS pixels of its window: its tabs' left and right edges, which of them is the dragged one, and `body`, the pane below the strip. */
export interface Strip extends Rect {
  pane: Id;
  tabs: [number, number][];
  held: number | null;
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
  /** Where in the tab the pointer went down (CSS px from its corner): it stays under the cursor along a strip and in a torn-off window. */
  grab: [number, number];
  /** The tab's width: when its edge passes a neighbour's center, they change places. */
  width: number;
  geom: WindowGeom;
}

/** A pane's body in a window split into panes (the dragging one): its center takes the tab, an edge splits the pane on that side. */
export interface ZoneTarget {
  pane: Id;
  zone: Zone;
}

/** What the window a drag started in marks while the tab has not left it: a slot in another pane's strip, or a pane body's zone (an overlay). */
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
/** Broadcast: the drag is over (markers go, the tab settles in its slot). */
export const TAB_DRAG_END = "tab-drag-end";
/** To one window: the `Over` to draw, or null. */
export const TAB_DRAG_OVER = "tab-drag-over";
/** To the window holding the tab in a strip: the `Slide` to draw it at, or null for its slot. */
export const TAB_DRAG_SLIDE = "tab-drag-slide";

/** The dragged tab drawn with its left edge `x` CSS px from pane `pane`'s strip's left, following the cursor. */
export interface Slide {
  pane: Id;
  x: number;
}
/** To the window holding the tab: it leaves for a new document window. */
export const TAB_DRAG_TEAR = "tab-drag-tear";
/** To the window holding the tab: the `Slot` it goes to, during the drag or as it ends. */
export const TAB_DRAG_DROP = "tab-drag-drop";
/** From the window holding the tab to the one it sends it to: the `Take`. */
export const TAB_DRAG_TAKE = "tab-drag-take";

/** This window's geometry from its DOM, `inner` being its client area's physical position, `held` the dragged tab if it is here. */
export function measure(label: string, inner: { x: number; y: number }, held: Id | null, root: ParentNode = document): WindowGeom {
  const scale = window.devicePixelRatio;
  const strips = [...root.querySelectorAll<HTMLElement>("[data-pane-id]")].map((pane) => {
    const r = pane.querySelector<HTMLElement>(":scope > .tabs")!.getBoundingClientRect();
    const els = [...pane.querySelectorAll<HTMLElement>(":scope > .tabs > .tab")];
    // The dragged tab is drawn shifted along the strip; only its width counts, which a shift keeps.
    const tabs = els.map((t): [number, number] => {
      const b = t.getBoundingClientRect();
      return [b.left, b.right];
    });
    const at = els.findIndex((t) => t.dataset.tab === String(held));
    const p = pane.getBoundingClientRect();
    const body = { x: p.left, y: r.bottom, width: p.width, height: p.bottom - r.bottom };
    return { pane: Number(pane.dataset.paneId), x: r.left, y: r.top, width: r.width, height: r.height, tabs, held: at < 0 ? null : at, body };
  });
  return { label, x: inner.x, y: inner.y, width: window.innerWidth * scale, height: window.innerHeight * scale, scale, strips };
}
