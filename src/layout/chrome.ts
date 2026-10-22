import type { Id, Node } from "./layout";

/**
 * In a pop-out the tab strips are the title bar (H19): the strips along the window's top edge drag
 * the window, and the one at its top-right corner holds the window controls.
 */
export function topStrips(n: Node): { top: Set<Id>; corner: Id } {
  if (n.kind === "pane") return { top: new Set([n.id]), corner: n.id };
  // Stacked panes: only the first reaches the top. Side by side: all do, and the last has the corner.
  const [first] = n.children;
  if (n.dir === "column" && first) return topStrips(first);
  const all = n.children.map(topStrips);
  return { top: new Set(all.flatMap((c) => [...c.top])), corner: all.at(-1)?.corner ?? n.id };
}
