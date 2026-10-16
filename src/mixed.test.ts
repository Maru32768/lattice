// Run with `npm test` (Node strips the types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBackticks, translatedBlockIds } from "./mixed.ts";

const blocks = Array.from({ length: 10 }, (_, i) => ({ id: i, translation: i === 9 ? null : `t${i}` }));

test("modes", () => {
  assert.equal(translatedBlockIds(blocks, "original", 70).size, 0);
  assert.equal(translatedBlockIds(blocks, "translated", 0).size, 9);
});

test("mixed ratio is exact by count and evenly spread", () => {
  const ten = blocks.map((b) => ({ ...b, translation: "t" }));
  for (const p of [0, 10, 30, 50, 70, 100]) assert.equal(translatedBlockIds(ten, "mixed", p).size, p / 10);
  assert.deepEqual([...translatedBlockIds(ten, "mixed", 30)], [3, 6, 9]);
  assert.equal(translatedBlockIds(blocks, "mixed", 100).has(9), false, "untranslated blocks never flip");
});

test("splitBackticks", () => {
  assert.deepEqual(splitBackticks("ログ（`WAL`）は"), [
    { code: false, v: "ログ（" }, { code: true, v: "WAL" }, { code: false, v: "）は" },
  ]);
});
