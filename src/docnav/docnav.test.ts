import { test } from "node:test";
import assert from "node:assert/strict";
import { hintLabels } from "./hints.ts";

test("hint labels are all different, none the start of another, and short while few", () => {
  const labels = hintLabels(100);
  assert.equal(new Set(labels).size, 100);
  assert.ok(labels.every((a) => labels.every((b) => a === b || !b.startsWith(a))));
  assert.ok(hintLabels(5).every((l) => l.length === 1));
  assert.ok(
    hintLabels(196).every((l) => l.length === 2),
    "the word hints' cap is every two-letter label",
  );
  assert.deepEqual(hintLabels(0), []);
});
