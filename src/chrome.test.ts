import { test } from "node:test";
import assert from "node:assert/strict";
import { topStrips } from "./chrome.ts";
import type { Node } from "./layout.ts";

const pane = (id: number): Node => ({ kind: "pane", id, tabs: [], active: null });
const split = (id: number, dir: "row" | "column", ...children: Node[]): Node => ({ kind: "split", id, dir, children, sizes: children.map(() => 1 / children.length) });
const of = (n: Node) => { const s = topStrips(n); return { top: [...s.top].sort((a, b) => a - b), corner: s.corner }; };

test("topStrips: a single pane is the whole title bar", () => {
  assert.deepEqual(of(pane(1)), { top: [1], corner: 1 });
});

test("topStrips: side by side, every pane's strip is on top and the rightmost holds the controls", () => {
  assert.deepEqual(of(split(9, "row", pane(1), pane(2), pane(3))), { top: [1, 2, 3], corner: 3 });
});

test("topStrips: stacked, only the upper pane reaches the top; nested splits follow the same rule", () => {
  assert.deepEqual(of(split(9, "column", pane(1), pane(2))), { top: [1], corner: 1 });
  // | 1 | 2 over 3 |  and  | 4 over 5 | 6 |
  assert.deepEqual(of(split(9, "row", pane(1), split(8, "column", pane(2), pane(3)))), { top: [1, 2], corner: 2 });
  assert.deepEqual(of(split(9, "row", split(8, "column", pane(4), pane(5)), pane(6))), { top: [4, 6], corner: 6 });
});
