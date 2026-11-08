import assert from "node:assert/strict";
import { test } from "node:test";
import { errorFilter } from "./uiErrors.ts";

test("logs each message once, says when the limit is reached, and starts over each hour", () => {
  const filter = errorFilter(3, 1000);
  const logged = ["a", "b", "a", "b", "c", "d", "e"].map((m) => filter(m, 0)).filter((m) => m !== null);
  assert.deepEqual(logged, ["a", "b", "c", "3 UI errors this hour: the rest of the hour is not logged"]);
  assert.equal(filter("a", 999), null);
  assert.equal(filter("a", 1000), "a");
});
