import { test } from "node:test";
import assert from "node:assert/strict";
import { dropAt, indexAt, targetIn, toScreen, type WindowGeom } from "./tabDrag.ts";

const strip = (pane: number, y: number, mids: number[]) => ({ pane, x: 0, y, width: 1200, height: 34, mids });
/** The main window at the origin, two panes stacked; a document window to its right at double scale. */
const main: WindowGeom = { label: "main", x: 0, y: 0, width: 1200, height: 800, scale: 1, strips: [strip(1, 32, [60, 160]), strip(2, 420, [])] };
const doc: WindowGeom = { label: "doc-1", x: 1300, y: 100, width: 960, height: 720, scale: 2, strips: [{ pane: 1, x: 0, y: 32, width: 480, height: 34, mids: [60] }] };
const windows = new Map([[main.label, main], [doc.label, doc]]);

test("the slot is the number of tab centers left of the pointer", () => {
  assert.equal(indexAt([60, 160], 10), 0);
  assert.equal(indexAt([60, 160], 100), 1);
  assert.equal(indexAt([60, 160], 500), 2);
  assert.equal(indexAt([], 500), 0, "an empty strip takes the tab first");
});

test("a point on a strip of the dragging window is a slot there; elsewhere in it is away", () => {
  assert.deepEqual(dropAt({ x: 100, y: 40 }, windows, "main"), { kind: "strip", label: "main", pane: 1, index: 1 });
  assert.deepEqual(dropAt({ x: 300, y: 430 }, windows, "main"), { kind: "strip", label: "main", pane: 2, index: 0 });
  assert.deepEqual(dropAt({ x: 300, y: 300 }, windows, "main"), { kind: "away", x: 300, y: 300 }, "over the content, not a strip");
});

test("another window's strip is found in its own scale; the dragging window wins where they overlap", () => {
  // Physical (1400, 180) is client (50, 40) of doc-1 at scale 2: before its one tab's center.
  assert.deepEqual(dropAt({ x: 1400, y: 180 }, windows, "main"), { kind: "strip", label: "doc-1", pane: 1, index: 0 });
  assert.deepEqual(dropAt({ x: 1600, y: 180 }, windows, "main"), { kind: "strip", label: "doc-1", pane: 1, index: 1 });
  assert.deepEqual(dropAt({ x: 1400, y: 400 }, windows, "main"), { kind: "away", x: 1400, y: 400 }, "over doc-1's content: a new window there");
  assert.deepEqual(dropAt({ x: 3000, y: 40 }, windows, "main"), { kind: "away", x: 3000, y: 40 }, "outside every window");
  // A document window over main's strip: (1100, 40) is on main's strip and inside doc-2, above its strip.
  const over = new Map([...windows, ["doc-2", { ...doc, label: "doc-2", x: 1000, y: 0 }]]);
  assert.deepEqual(dropAt({ x: 1100, y: 40 }, over, "main"), { kind: "strip", label: "main", pane: 1, index: 2 }, "main is dragging, so it is on top");
  assert.deepEqual(dropAt({ x: 1100, y: 40 }, over, "doc-2"), { kind: "away", x: 1100, y: 40 }, "doc-2 is dragging, so it is on top");
});

test("nothing can be resolved before the dragging window's own geometry is known", () => {
  assert.equal(dropAt({ x: 100, y: 40 }, new Map([[doc.label, doc]]), "main"), null);
});

test("the pointer maps to the screen through the window's position and scale; a window marks only its own slot", () => {
  assert.deepEqual(toScreen(doc, { x: 50, y: 40 }), { x: 1400, y: 180 });
  const d = dropAt({ x: 1400, y: 180 }, windows, "main");
  assert.deepEqual(targetIn(d, "doc-1"), { pane: 1, index: 0 });
  assert.equal(targetIn(d, "main"), null);
  assert.equal(targetIn({ kind: "away", x: 0, y: 0 }, "main"), null);
});
