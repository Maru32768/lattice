import { test } from "node:test";
import assert from "node:assert/strict";
import { cardsOf, stack, type Ask } from "./stickies.ts";
import type { Sticky } from "../api.ts";

const sticky = (id: number, block_id: number | null): Sticky => ({
  id,
  article_id: 1,
  block_id,
  kind: "term",
  quote: "q",
  messages: [],
});
const ask = (key: number, blockId: number): Ask => ({ key, blockId, kind: "detail", quote: "q", question: "", step: "pending" });

test("cards go down the article, those without a block of it first", () => {
  // Block ids are not in reading order: a re-extraction keeps those of unchanged blocks.
  const blocks = [{ id: 30 }, { id: 10 }, { id: 20 }];
  const cards = cardsOf([sticky(1, 20), sticky(2, 10), sticky(3, null), sticky(4, 30), sticky(5, 10)], [ask(1, 10), ask(2, 99)], blocks);
  assert.deepEqual(
    cards.map((c) => c.key),
    ["s3", "a2", "s4", "s2", "s5", "a1", "s1"],
  );
});

test("a card is at its block's height, and below the card before where it would cover that", () => {
  const tops = stack([
    { at: 0, height: 50 },
    { at: 20, height: 100 },
    { at: 170, height: 30 },
    { at: 1000, height: 40 },
  ]);
  assert.deepEqual(tops, [0, 60, 170, 1000]);
  assert.deepEqual(stack([]), []);
});

test("the opened card is at its block's height: those before it move up as far as it takes, those after it go below", () => {
  const cards = (at: number) => [
    { at: 0, height: 100 },
    { at: 200, height: 300 },
    { at: 210, height: 50 },
    { at, height: 80 },
    { at: at + 10, height: 40 },
  ];
  assert.deepEqual(stack(cards(520)), [0, 200, 510, 570, 660]);
  assert.deepEqual(stack(cards(520), 3), [0, 150, 460, 520, 610], "the first is out of the way as it is");
  assert.deepEqual(stack(cards(480), 3), [0, 110, 420, 480, 570], "to the top of the column");
  assert.deepEqual(stack(cards(400), 3), [0, 110, 420, 480, 570], "and only then down itself");
  assert.deepEqual(stack(cards(900), 3), stack(cards(900)), "nothing is in its way");
  assert.deepEqual(stack(cards(520), 1), [0, 200, 510, 570, 660]);
});
