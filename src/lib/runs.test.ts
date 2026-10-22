import { test } from "node:test";
import assert from "node:assert/strict";
import { withStarts } from "./runs.ts";

test("withStarts: each run starts where the ones before it end", () => {
  assert.deepEqual(
    withStarts(["ab", "", "cde"], (s) => s.length).map((r) => r.start),
    [0, 2, 2],
  );
  assert.deepEqual(
    withStarts([1, 2], (n) => n, 5),
    [
      { item: 1, start: 5 },
      { item: 2, start: 6 },
    ],
  );
  assert.deepEqual(
    withStarts([], () => 1),
    [],
  );
});
