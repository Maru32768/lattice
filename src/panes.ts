// Keyboard focus across the shell's panes (each marked data-pane: nav, list, doc, chat), left to right in DOM order.

export const paneOf = (el: Element | null) => el?.closest<HTMLElement>("[data-pane]") ?? null;

// What focus lands on in a pane, best first: the list cursor, the current nav item, the chat input, …
const TARGETS = ["[data-pane-target]", ".row.cur", ".hit.cur", ".row.sel", ".ni.on", ".ib.on", "#chat-q", ".row", ".hit", ".ni", "input, textarea", "button:not(:disabled)"];

export function focusPane(p: HTMLElement) {
  for (const sel of TARGETS) {
    const el = p.querySelector<HTMLElement>(sel);
    if (el) return el.focus();
  }
}

/** The pane a tmux-style key after the prefix moves to: ← → / h l to a neighbour, o cycles. Null: nothing there. */
export function paneAfter(key: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>("[data-pane]")];
  const i = all.indexOf(paneOf(document.activeElement)!);
  if (key === "O") return all[(i + 1) % all.length] ?? null;
  const d = ({ ArrowLeft: -1, H: -1, ArrowRight: 1, L: 1 } as Record<string, number>)[key];
  // ↑ ↓ / k j: the panes sit side by side, so nothing is above or below.
  if (!d) return null;
  return i < 0 ? all[0] ?? null : all[i + d] ?? null;
}

const NAV_ITEMS = ".ni, .nav-search, .nav-rail .ib";

/** j / k in the nav: move focus between its items (Enter then selects the focused one). */
export function stepNav(nav: HTMLElement, d: 1 | -1) {
  const items = [...nav.querySelectorAll<HTMLButtonElement>(NAV_ITEMS)].filter((b) => !b.disabled);
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  items[i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + d))]?.focus();
}
