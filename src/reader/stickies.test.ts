import { test } from "node:test";
import assert from "node:assert/strict";
import { asksLeft, cardsOf, explanationOf, findPassage, goneOf, stack, type Ask } from "./stickies.ts";
import type { Sticky } from "../api.ts";

/** With a message of each of the ids. */
const sticky = (id: number, block_id: number | null, messages: number[] = [], parent: number | null = null): Sticky => ({
  id,
  article_id: 1,
  block_id,
  parent,
  origin: parent == null ? "text" : "answer",
  kind: "term",
  quote: "q",
  quote_prefix: null,
  quote_suffix: null,
  messages: messages.map((m) => ({ id: m, question: "", answer: `answer ${m}`, citations: [] })),
});
const ask = (key: number, blockId: number, parent: number | null = null): Ask => ({
  key,
  blockId,
  parent,
  origin: parent == null ? "text" : "answer",
  kind: "detail",
  quote: "q",
  quotePrefix: null,
  quoteSuffix: null,
  question: "",
  step: "pending",
});
const followUp = (key: number, of: number): Ask => ({ key, sticky: of, question: "half", step: "writing" });

test("cards go down the article, those without a block of it first", () => {
  // Block ids are not in reading order: a re-extraction keeps those of unchanged blocks.
  const blocks = [{ id: 30 }, { id: 10 }, { id: 20 }];
  const cards = cardsOf([sticky(1, 20), sticky(2, 10), sticky(3, null), sticky(4, 30), sticky(5, 10)], [ask(1, 10), ask(2, 99)], blocks);
  assert.deepEqual(
    cards.map((c) => c.key),
    ["s3", "a2", "s4", "s2", "s5", "a1", "s1"],
  );
});

test("a card is followed by those on its answers, all the way down, on the block of the first", () => {
  const blocks = [{ id: 10 }, { id: 20 }];
  const saved = [
    sticky(1, 20, [1]),
    sticky(2, 10, [2, 5]),
    sticky(3, 10, [3], 5),
    sticky(4, 10, [4], 3),
    sticky(5, 10, [6]),
    sticky(6, 10, [7], 2),
    sticky(7, 10, [8], 99),
    sticky(8, 10, [9], 3),
  ];
  const cards = cardsOf(saved, [followUp(1, 2), ask(2, 10, 2), ask(3, 10), ask(4, 99, 4), ask(5, 10, 99)], blocks);
  assert.deepEqual(
    cards.map((c) => [c.depth, c.key, c.parent, c.root, c.blockId]),
    [
      [0, "s2", undefined, "s2", 10],
      // Oldest first, whichever of its answers they are on, each before the next one's, and what waits last.
      [1, "s3", "s2", "s2", 10],
      [2, "s4", "s3", "s2", 10],
      [3, "a4", "s4", "s2", 10],
      [2, "s8", "s3", "s2", 10],
      [1, "s6", "s2", "s2", 10],
      [1, "a2", "s2", "s2", 10],
      [0, "s5", undefined, "s5", 10],
      // Their parents are gone.
      [0, "s7", undefined, "s7", 10],
      [0, "a3", undefined, "a3", 10],
      [0, "a5", undefined, "a5", 10],
      [0, "s1", undefined, "s1", 20],
    ],
  );
});

test("a question in a sticky goes with it, and one on its answer stays without it, also when its id is given again", () => {
  const before = [sticky(1, 10, [1, 2]), sticky(2, 10, [3])];
  const asks = [followUp(1, 1), ask(2, 10, 2), followUp(3, 2), ask(4, 10, 3), ask(5, 10)];
  const left = (now: Sticky[]) => asksLeft(asks, goneOf(before, now)).map((a) => ("sticky" in a ? `${a.key} in ${a.sticky}` : `${a.key} on ${a.parent}`));
  const all = ["1 in 1", "2 on 2", "3 in 2", "4 on 3", "5 on null"];
  assert.deepEqual(left(before), all);
  assert.deepEqual(left([{ ...before[0], block_id: null }, sticky(2, 10, [3, 4]), sticky(3, 10, [5])]), all, "as they go on");
  const gone = ["2 on null", "3 in 2", "4 on 3", "5 on null"];
  assert.deepEqual(left([before[1]]), gone);
  assert.deepEqual(left([{ ...before[0], id: 9 }, before[1]]), gone, "another that reads the same");
  assert.deepEqual(left([{ ...before[0], quote: "another" }, before[1]]), gone);
  assert.deepEqual(left([sticky(1, 10, [4]), before[1]]), gone);
  assert.deepEqual(left([{ ...before[0], messages: [{ ...before[0].messages[0], answer: "another" }] }, before[1]]), gone);
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

test("the pinned card is at its block's height: those before it move up as far as it takes, those after it go below", () => {
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

test("a held card stays where it is put: those between it and the pinned one give way down to it, and then the pinned one does", () => {
  const cards = (child: number) => [
    { at: 0, height: 100 },
    { at: 180, height: 100 },
    { at: 0, height: child },
    { at: 460, height: 50 },
    { at: 500, height: 80 },
  ];
  // The card at 180 was 20 px higher before its child came, with nothing between.
  assert.deepEqual(stack(cards(60), 1, 4), [0, 180, 290, 440, 500], "there is room");
  assert.deepEqual(stack(cards(140), 1, 4), [0, 180, 290, 440, 500], "as much as there is");
  assert.deepEqual(stack(cards(150), 1, 4), [0, 180, 290, 450, 510], "the pinned one goes down");
  assert.deepEqual(stack(cards(150), 4), [0, 170, 280, 440, 500], "without one held it is the first ones that go up");
  assert.deepEqual(
    stack(
      [
        { at: 0, height: 100 },
        { at: 60, height: 100 },
        { at: 400, height: 50 },
      ],
      1,
      2,
    ),
    [0, 110, 400],
    "no higher than the column's top leaves",
  );
});

test("a passage is found in the text nodes as the reader selected it, whitespace apart, starting in the block's own", () => {
  const texts = ["A first ", "line.\n", "  Then ", "the next.", "After"];
  assert.deepEqual(findPassage(texts, 4, "first line. Then"), [
    [0, 2],
    [2, 6],
  ]);
  assert.deepEqual(
    findPassage(texts, 2, "line. Then the next. After"),
    [
      [1, 0],
      [4, 5],
    ],
    "on into the blocks after",
  );
  assert.equal(findPassage(texts, 2, "Then the next."), null, "it starts in another block");
  assert.equal(findPassage(texts, 4, "first  lines"), null);
  assert.equal(findPassage(texts, 4, " \n"), null);
  assert.deepEqual(findPassage(["ab ab"], 1, "ab"), [
    [0, 0],
    [0, 2],
  ]);
});

test("a passage of words is found where it is whole words before where it starts or ends inside one", () => {
  assert.deepEqual(findPassage(["Deadlocks happen when a lock is held."], 1, "lock"), [
    [0, 24],
    [0, 28],
  ]);
  assert.deepEqual(
    findPassage(["A locksmith fixed the lock."], 1, "lock"),
    [
      [0, 22],
      [0, 26],
    ],
    "nor where it ends inside one",
  );
  assert.deepEqual(findPassage(["This is the thesis."], 1, "is"), [
    [0, 5],
    [0, 7],
  ]);
  assert.deepEqual(
    findPassage(["Bathe cats, not ", "the cat."], 2, "the cat"),
    [
      [1, 0],
      [1, 7],
    ],
    "across text nodes",
  );
  assert.deepEqual(findPassage(["Locks"], 1, "lock"), null, "case as selected");
  assert.deepEqual(findPassage(["Deadlocks"], 1, "lock"), [
    [0, 4],
    [0, 8],
  ]);
  assert.deepEqual(
    findPassage(["デッドロックは、ロック"], 1, "ロック"),
    [
      [0, 3],
      [0, 6],
    ],
    "Japanese, which has no spaces to tell a word's edge by",
  );
  assert.deepEqual(
    findPassage(["Deadlocks", " A lock is held."], 1, "lock"),
    [
      [0, 4],
      [0, 8],
    ],
    "in its own block, though it is whole in the next",
  );
  assert.deepEqual(
    findPassage(["ユーザーIDを確かめてから、ユーザーに返す。"], 1, "ユーザー"),
    [
      [0, 0],
      [0, 4],
    ],
    "nor by a mark that Japanese shares with no one script",
  );
});

test("a word does not go on from one text node to the next one set apart from it, as in another cell or block", () => {
  const cells = ["Primitive", "Use", "lock", "Guard a resource with a lock."];
  assert.deepEqual(findPassage(cells, 4, "lock", [false, true, true, true]), [
    [2, 0],
    [2, 4],
  ]);
  assert.deepEqual(findPassage(["Deadlocks and the lock", "When two threads wait."], 1, "lock", [false, true]), [
    [0, 18],
    [0, 22],
  ]);
  assert.deepEqual(
    findPassage(["Dead", "locks and the lock"], 2, "lock", [false, false]),
    [
      [1, 14],
      [1, 18],
    ],
    "inline, as a link in a word",
  );
});

test("of a passage twice, it is the one that reads as where it was selected, whitespace apart, else the first", () => {
  const texts = ["The log is append-only.\n  Readers ", "tail the log as it grows."];
  const later = { prefix: "append-only. Readers tail the", suffix: " as it grows." };
  assert.deepEqual(findPassage(texts, 2, "log", [], later), [
    [1, 9],
    [1, 12],
  ]);
  assert.deepEqual(
    findPassage(texts, 2, "log", [], { prefix: "Writers tail the", suffix: " as it grows." }),
    [
      [1, 9],
      [1, 12],
    ],
    "where one side still reads so",
  );
  assert.deepEqual(
    findPassage(["Readers tail the log. Writers append to the log."], 1, "log", [], { prefix: "Writers append to the", suffix: "." }),
    [
      [0, 44],
      [0, 47],
    ],
    "where only the side before tells them apart",
  );
  for (const context of [
    { prefix: "Writers tail the", suffix: " when it shrinks." },
    { prefix: null, suffix: null },
  ]) {
    assert.deepEqual(findPassage(texts, 2, "log", [], context), [
      [0, 4],
      [0, 7],
    ]);
  }
  assert.deepEqual(
    findPassage(["Deadlocks happen when a lock is held."], 1, "lock", [], { prefix: "Dead", suffix: "s happen when a lock" }),
    [
      [0, 4],
      [0, 8],
    ],
    "inside a word, as it was selected",
  );
  assert.deepEqual(
    findPassage(["A log. A log."], 1, "log", [], { prefix: "A", suffix: "." }),
    [
      [0, 2],
      [0, 5],
    ],
    "the first of those that read so",
  );
});

test("a sticky's explanation is its first answer without the markers it cites and the space before them", () => {
  const citation = (n: number) => ({ n, block_id: n, article_id: 1, url: "", title: "", heading: null, text: "" });
  const term = sticky(1, 10, [1, 2]);
  term.messages[0] = { ...term.messages[0], answer: "先に書く [1]。dp[2] と番号 [9] は残る [2][3]。", citations: [1, 2, 3].map(citation) };
  assert.equal(explanationOf(term), "先に書く。dp[2] と番号 [9] は残る。");
  assert.equal(explanationOf(sticky(2, 10)), "", "none without an answer");
});

test("of a passage in a block 300,000 times, it is the one that reads as where it was selected, found in time", () => {
  const n = 150_000;
  const text = `${"a. ".repeat(n)}b a. ${"a. ".repeat(n)}`;
  const start = performance.now();
  assert.deepEqual(findPassage([text], 1, "a", [], { prefix: "b", suffix: null }), [
    [0, 3 * n + 2],
    [0, 3 * n + 3],
  ]);
  // About 0.3 s; reading the whole text at each place took seconds.
  assert.ok(performance.now() - start < 5_000);
});
