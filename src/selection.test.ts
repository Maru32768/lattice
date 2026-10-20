import { test } from "node:test";
import assert from "node:assert/strict";
import { pick } from "./selection.ts";

const order = [5, 3, 9, 1, 7];

test("a click toggles one row; Shift+click adds the span from the last clicked row, either way", () => {
  assert.deepEqual(pick(order, [], null, 3, false), [3]);
  assert.deepEqual(pick(order, [3], 3, 3, false), []);
  assert.deepEqual(pick(order, [3], 3, 1, true), [3, 9, 1]);
  assert.deepEqual(pick(order, [1], 1, 5, true), [1, 5, 3, 9]);
  assert.deepEqual(pick(order, [], null, 9, true), [9], "no anchor yet: Shift+click picks the row");
  assert.deepEqual(pick(order, [2], 2, 9, true), [2, 9], "the anchor left the list");
});
