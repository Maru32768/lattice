// Run with `npm test` (Node strips the types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Block, SummaryItem } from "../api";
import { citeNumbers, markNumbers } from "./summary.ts";

const marked = (text: string, numbers: string[]) => markNumbers(text, numbers).map((p) => (p.mark ? `[${p.text}]` : p.text));

test("marks each number that stands alone, not one inside a longer number", () => {
  assert.deepEqual(marked("2,000件と2倍と12個と2", ["2"]), ["2,000件と", "[2]", "倍と12個と", "[2]"]);
  assert.deepEqual(marked("3.9秒と13.9秒と3.95秒", ["3.9"]), ["[3.9]", "秒と13.9秒と3.95秒"], "a dot is not a wildcard");
  assert.deepEqual(marked("約8万人", ["8", "8万"]), ["約", "[8万]", "人"], "the longer one first");
  assert.deepEqual(marked("1880年代", []), ["1880年代"]);
  assert.deepEqual(marked("$0.12(est.)", ["0.12"]), ["$", "[0.12]", "(est.)"]);
});

test("numbers the cited blocks in the order first cited, leaving out those the article no longer has", () => {
  const item = (block_ids: number[]): SummaryItem => ({ text: "x", block_ids, unverified: [] });
  const blocks = [3, 5, 9].map((id) => ({ id }) as Block);
  const n = citeNumbers({ summary: [item([5, 3]), item([5, 404])], key_points: [item([9, 3])] }, blocks);
  assert.deepEqual(
    [...n],
    [
      [5, 1],
      [3, 2],
      [9, 3],
    ],
  );
});
