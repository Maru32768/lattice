import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PAIRS, changedLines, shapeMismatches, shapeOf, unpaired } from "./doc-pairs.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("each English doc and its Japanese translation match line for line", () => {
  for (const [en, ja] of PAIRS) {
    assert.deepEqual(shapeMismatches(readFileSync(join(ROOT, en), "utf8"), readFileSync(join(ROOT, ja), "utf8")), [], `${en} / ${ja}`);
  }
});

test("a line's shape is its kind, code spans and link count, with placeholders and link targets free", () => {
  assert.equal(shapeOf("- Press `Ctrl+T` in [the guide](guide.md#x)."), shapeOf("- [ガイド](guide.ja.md#y) で `Ctrl+T` を押す。"));
  assert.equal(shapeOf("| `tag:NAME` | x |"), shapeOf("| `tag:名前` | x |"));
  assert.notEqual(shapeOf("## Settings"), shapeOf("### 設定"));
  assert.notEqual(shapeOf("Press `Ctrl+T`."), shapeOf("`Ctrl+K` を押す。"));
  assert.notEqual(shapeOf("  - nested"), shapeOf("- 入れ子"));
});

test("changed lines are read from git diff -U0 hunks", () => {
  const diff = "@@ -3 +3 @@\n-a\n+b\n@@ -10,2 +10,0 @@\n-c\n-d\n@@ -20,0 +19,2 @@\n+e\n+f\n";
  assert.deepEqual([...changedLines(diff)], ["-3", "+3", "-10", "-11", "+19", "+20", "-after20"]);
});

test("a line changed in one language only is reported", () => {
  const en = "@@ -241 +241 @@\n-x\n+y\n@@ -310 +310 @@\n-x\n+y\n";
  const ja = "@@ -241 +241 @@\n-x\n+y\n";
  assert.deepEqual(unpaired(en, ja), { en: ["-310", "+310"], ja: [] });
  assert.deepEqual(unpaired(en, en), { en: [], ja: [] });
});
