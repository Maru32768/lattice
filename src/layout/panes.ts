// Keyboard focus across the shell's panes (each marked data-pane: nav, list, doc, chat; document panes also data-pane-id).

export const paneOf = (el: Element | null) => el?.closest<HTMLElement>("[data-pane]") ?? null;

// What focus lands on in a pane, best first: the list cursor, the current nav item, the chat input, …
const TARGETS = [
  "[data-pane-target]",
  ".row.cur",
  ".hit.cur",
  ".row.sel",
  ".ni.on",
  ".ib.on",
  "#chat-q",
  ".row",
  ".hit",
  ".ni",
  "input, textarea",
  "button:not(:disabled)",
];

export function focusPane(p: HTMLElement) {
  for (const sel of TARGETS) {
    const el = p.querySelector<HTMLElement>(sel);
    if (el) {
      return el.focus();
    }
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Of `all`, the nearest rectangle lying in direction (dx, dy) from `from` that shares a row (or
 * column) with it: a pane to the right must overlap vertically. Null when nothing is there.
 */
export function neighbor<T extends Rect>(from: Rect, all: T[], dx: number, dy: number): T | null {
  let best: T | null = null;
  let dist = Infinity;
  for (const r of all) {
    if (r === from) {
      continue;
    }
    const gap = dx ? (dx > 0 ? r.x - (from.x + from.w) : from.x - (r.x + r.w)) : dy > 0 ? r.y - (from.y + from.h) : from.y - (r.y + r.h);
    const overlap = dx ? Math.min(r.y + r.h, from.y + from.h) - Math.max(r.y, from.y) : Math.min(r.x + r.w, from.x + from.w) - Math.max(r.x, from.x);
    // Touching panes sit a border apart; a sliver of overlap is a shared corner, not a neighbour.
    if (gap < -1 || overlap <= 1 || gap >= dist) {
      continue;
    }
    dist = gap;
    best = r;
  }
  return best;
}

const DIRS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  H: [-1, 0],
  ArrowRight: [1, 0],
  L: [1, 0],
  ArrowUp: [0, -1],
  K: [0, -1],
  ArrowDown: [0, 1],
  J: [0, 1],
};

/** The pane a tmux-style key after the prefix moves to from `from`: arrows / h j k l to a neighbour, o cycles. Null: nothing there. */
export function paneAfter(key: string, from: HTMLElement | null): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>("[data-pane]")];
  if (key === "O") {
    return all[(all.indexOf(from!) + 1) % all.length] ?? null;
  }
  const d = DIRS[key];
  if (!d) {
    return null;
  }
  if (!from) {
    return all[0] ?? null;
  }
  const rects = all.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const me = rects[all.indexOf(from)];
  return me ? (neighbor(me, rects, d[0], d[1])?.el ?? null) : null;
}

const NAV_ITEMS = ".ni, .nav-search, .nav-rail .ib";

/** j / k in the nav: move focus between its items (Enter then selects the focused one). */
export function stepNav(nav: HTMLElement, d: 1 | -1) {
  const items = [...nav.querySelectorAll<HTMLButtonElement>(NAV_ITEMS)].filter((b) => !b.disabled);
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  items[i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + d))]?.focus();
}
