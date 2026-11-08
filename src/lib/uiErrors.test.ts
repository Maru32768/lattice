import assert from "node:assert/strict";
import { test } from "node:test";
import { errorFilter } from "./uiErrors.ts";

test("logs each message once, and no more than the limit", () => {
  const shouldLog = errorFilter(3);
  const logged = ["a", "b", "a", "b", "a", "c", "d", "e"].filter(shouldLog);
  assert.deepEqual(logged, ["a", "b", "c"]);
});
