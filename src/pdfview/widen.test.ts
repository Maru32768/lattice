import assert from "node:assert/strict";
import test from "node:test";
import { widen } from "./widen.ts";

test("text that fits leaves the box alone", () => {
  assert.deepEqual(widen(0, 100, 100), { left: 0, right: 0 });
});

test("a centred line grows evenly and stays centred", () => {
  assert.deepEqual(widen(60, 105, 105), { left: 30, right: 30 });
  assert.deepEqual(widen(60, 100, 104), { left: 30, right: 30 });
  assert.deepEqual(widen(60, 91, 109), { left: 30, right: 30 });
});

test("a centred line stops at the nearer edge on both sides", () => {
  assert.deepEqual(widen(400, 100, 104), { left: 100, right: 100 });
  assert.deepEqual(widen(400, 104, 100), { left: 100, right: 100 });
});

test("a line whose rooms differ by more than a tenth of their sum keeps its left edge", () => {
  assert.deepEqual(widen(60, 80, 100), { left: 0, right: 60 });
});

test("a line at the column's left keeps its left edge", () => {
  assert.deepEqual(widen(60, 0, 200), { left: 0, right: 60 });
  assert.deepEqual(widen(60, 10, 200), { left: 0, right: 60 });
});

test("it grows no further than the room", () => {
  assert.deepEqual(widen(300, 0, 200), { left: 0, right: 200 });
  assert.deepEqual(widen(60, 80, 0), { left: 0, right: 0 });
});
