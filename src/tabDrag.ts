// Dragging a tab between windows (design-review §26). A drag is resolved from geometry, not from
// the DOM under the pointer (`elementFromPoint` cannot see other windows): when a drag starts,
// every window measures its tab strips and sends them to the dragging window, which maps the
// pointer to physical screen pixels and asks `dropAt` where the tab would land.
import type { Id } from "./layout";
import type { DropTarget } from "./TabStrip";

/** A point in physical screen pixels (what Tauri reports for window positions). */
export interface Point {
  x: number;
  y: number;
}

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

/** Where a dropped tab goes: a slot in some window's strip, or away from every strip (a new window there). */
export type Drop = { kind: "strip"; label: string; pane: Id; index: number } | { kind: "away"; x: number; y: number };

/** Broadcast by the dragging window; every window answers with `TAB_STRIPS` to `source`. */
export const TAB_DRAG_START = "tab-drag-start";
export const TAB_STRIPS = "tab-strips";
/** Sent to the window under the pointer: the slot to mark, or null when the pointer left it. */
export const TAB_DRAG_OVER = "tab-drag-over";

export const indexAt = (mids: number[], x: number) => mids.filter((m) => m < x).length;

const inside = (p: Point, r: { x: number; y: number; width: number; height: number }) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;

export const toScreen = (g: WindowGeom, client: Point): Point => ({ x: g.x + client.x * g.scale, y: g.y + client.y * g.scale });

/**
 * The drop for screen point `p`. The dragging window is checked first: it is the active window,
 * so it is above the others (two other windows overlapping each other is resolved by report order).
 * Null until the dragging window's own geometry has arrived.
 */
export function dropAt(p: Point, windows: Map<string, WindowGeom>, source: string): Drop | null {
  const own = windows.get(source);
  if (!own) return null;
  for (const g of [own, ...[...windows.values()].filter((w) => w.label !== source)]) {
    if (!inside(p, g)) continue;
    const c = { x: (p.x - g.x) / g.scale, y: (p.y - g.y) / g.scale };
    const s = g.strips.find((st) => inside(c, st));
    if (s) return { kind: "strip", label: g.label, pane: s.pane, index: indexAt(s.mids, c.x) };
    break;
  }
  return { kind: "away", x: p.x, y: p.y };
}

/** The target to mark in window `label` for `d`, or null when `d` is elsewhere. */
export const targetIn = (d: Drop | null, label: string): DropTarget | null => (d?.kind === "strip" && d.label === label ? { pane: d.pane, index: d.index } : null);

/** This window's geometry from its DOM, `inner` being its client area's physical position. */
export function measure(label: string, inner: Point, root: ParentNode = document): WindowGeom {
  const scale = window.devicePixelRatio;
  const strips = [...root.querySelectorAll<HTMLElement>("[data-pane-id]")].map((pane) => {
    const r = pane.querySelector<HTMLElement>(":scope > .tabs")!.getBoundingClientRect();
    const mids = [...pane.querySelectorAll<HTMLElement>(":scope > .tabs > .tab")].map((t) => {
      const b = t.getBoundingClientRect();
      return b.left + b.width / 2;
    });
    return { pane: Number(pane.dataset.paneId), x: r.left, y: r.top, width: r.width, height: r.height, mids };
  });
  return { label, x: inner.x, y: inner.y, width: window.innerWidth * scale, height: window.innerHeight * scale, scale, strips };
}
