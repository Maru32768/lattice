// Run with `npm test` (Node strips the types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Block, SummaryItem } from "../api";
import { citeNumbers, gapAfter, markNumbers, unverifiedNumbers } from "./summary.ts";

const item = (text: string, unverified: [number, number][] = [], block_ids: number[] = []): SummaryItem => ({ text, block_ids, unverified });
const marked = (text: string, unverified: [number, number][]) => markNumbers(item(text, unverified)).map((p) => (p.mark ? `[${p.text}]` : p.text));

test("marks the ranges the check stored and nothing else", () => {
  assert.deepEqual(marked("処理は2倍速く、2万件を扱う。", [[3, 4]]), ["処理は", "[2]", "倍速く、2万件を扱う。"], "not the 2 of 2万");
  assert.deepEqual(marked("Ver.2で", [[4, 5]]), ["Ver.", "[2]", "で"]);
  assert.deepEqual(marked("😀は2倍", [[3, 4]]), ["😀は", "[2]", "倍"], "UTF-16 offsets");
  assert.deepEqual(
    marked("2と3", [
      [0, 1],
      [2, 3],
    ]),
    ["[2]", "と", "[3]"],
  );
  assert.deepEqual(marked("1880年代", []), ["1880年代"]);
});

test("a space follows a sentence unless it ends in Japanese punctuation", () => {
  assert.deepEqual([undefined, "WALを使う。", "速い！", "本当？", "It is fast.", "fsyncが減る"].map(gapAfter), ["", "", "", "", " ", " "]);
});

test("lists each number the article lacks once, as written", () => {
  const items = {
    summary: [
      item("400と400", [
        [0, 3],
        [4, 7],
      ]),
    ],
    key_points: [item("約8万人", [[1, 3]]), item("なし")],
  };
  assert.deepEqual(unverifiedNumbers(items), ["400", "8万"]);
});

test("numbers the cited blocks in the order first cited, leaving out those the article no longer has", () => {
  const cites = (block_ids: number[]) => item("x", [], block_ids);
  const blocks = [3, 5, 9].map((id) => ({ id }) as Block);
  const n = citeNumbers({ summary: [cites([5, 3]), cites([5, 404])], key_points: [cites([9, 3])] }, blocks);
  assert.deepEqual(
    [...n],
    [
      [5, 1],
      [3, 2],
      [9, 3],
    ],
  );
});
