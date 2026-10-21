// Dragging a tab between windows, live (design-review §26). The backend runs the drag
// (`src-tauri/src/tabdrag.rs`): it follows the cursor, decides where the tab is, and tells each
// window what to draw and the window holding the tab where it goes. Windows only report their
// strips, measured here.
import type { Id } from "./layout";
import type { DropTarget, TabLabel } from "./TabStrip";

/** One pane's tab strip, in the CSS pixels of its window; `mids` are the tabs' horizontal centers. */
export interface Strip {
  pane: Id;
  x: number;
  y: number;
  width: number;
  height: number;
  mids: number[];
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

/** What the dragging window tells the backend: the tab as strips draw it, where it is, and the window's geometry. */
export interface DragStart {
  tab: TabLabel;
  pane: Id;
  index: number;
  /** A document window's only tab: the window itself follows the cursor. */
  alone: boolean;
  geom: WindowGeom;
}

/** What a strip draws at a slot: a marker in the window that has the tab, the tab itself (`tab`) in any other. */
export interface Incoming extends DropTarget {
  tab?: TabLabel;
}

/** A slot in window `label`'s strips: where the tab goes when the drag ends. */
export interface Slot extends DropTarget {
  label: string;
}

/** Broadcast: a drag began; every window reports its strips until `TAB_DRAG_END`. */
export const TAB_DRAG_START = "tab-drag-start";
/** Broadcast: the drag is over (markers, drawn tabs and the ghost go). */
export const TAB_DRAG_END = "tab-drag-end";
/** To one window: the `Incoming` slot to draw, or null. */
export const TAB_DRAG_OVER = "tab-drag-over";
/** To the dragging window: the tab leaves for a new document window. */
export const TAB_DRAG_TEAR = "tab-drag-tear";
/** To the window holding the tab when the drag ends: the `Slot` it goes to. */
export const TAB_DRAG_DROP = "tab-drag-drop";

/** This window's geometry from its DOM, `inner` being its client area's physical position. A tab drawn for another window's drag is not one of its tabs. */
export function measure(label: string, inner: { x: number; y: number }, root: ParentNode = document): WindowGeom {
  const scale = window.devicePixelRatio;
  const strips = [...root.querySelectorAll<HTMLElement>("[data-pane-id]")].map((pane) => {
    const r = pane.querySelector<HTMLElement>(":scope > .tabs")!.getBoundingClientRect();
    const mids = [...pane.querySelectorAll<HTMLElement>(":scope > .tabs > .tab:not(.incoming)")].map((t) => {
      const b = t.getBoundingClientRect();
      return b.left + b.width / 2;
    });
    return { pane: Number(pane.dataset.paneId), x: r.left, y: r.top, width: r.width, height: r.height, mids };
  });
  return { label, x: inner.x, y: inner.y, width: window.innerWidth * scale, height: window.innerHeight * scale, scale, strips };
}
