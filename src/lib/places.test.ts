import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { blockOf, isReadingPlace, needle, placeIn, placeStore, type ReadingPlace } from "./places.ts";

const stored = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  },
});
beforeEach(() => stored.clear());

const isNum = (v: unknown): v is number => typeof v === "number";

test("a place store keeps the most recent places, forgets on null, and reads what another window wrote", () => {
  const s = placeStore("k", 2, isNum);
  s.set("a", 1);
  s.set("b", 2);
  s.set("a", 3);
  s.set("c", 4);
  assert.equal(s.get("b"), undefined, "the oldest went past the cap");
  assert.deepEqual([s.get("a"), s.get("c")], [3, 4]);
  s.set("c", null);
  assert.equal(s.get("c"), undefined);
  stored.set("k", JSON.stringify([["a", 9]]));
  assert.equal(s.get("a"), 9, "not a copy of its own");
  s.clear();
  assert.equal(stored.has("k"), false);
});

test("a place store skips what an older version or a broken write left", () => {
  const s = placeStore("k", 5, isNum);
  stored.set("k", "{not json");
  assert.equal(s.get("a"), undefined);
  stored.set("k", JSON.stringify([["a", "text"], ["b", 2], "junk", [3, 3]]));
  assert.deepEqual([s.get("a"), s.get("b")], [undefined, 2]);
  s.set("c", 3);
  assert.equal(
    stored.get("k"),
    JSON.stringify([
      ["b", 2],
      ["c", 3],
    ]),
    "the rest is dropped on the next write",
  );
});

const place = (p: Partial<ReadingPlace>): ReadingPlace => ({ text: "", at: 0, t: 0, ...p });

test("a place finds its block by id while it has the same text, else by the text", () => {
  const blocks = [
    { id: 1, text: "Intro  to\nthings" },
    { id: 2, text: "Second paragraph" },
    { id: 3, text: "The second paragraph again" },
  ];
  assert.equal(needle(blocks[0].text), "Intro to things");
  assert.equal(blockOf(blocks, place({ block: 2, text: "Second paragraph" }))?.id, 2);
  assert.equal(blockOf(blocks, place({ block: 7, text: "Second paragraph" }))?.id, 2, "imported again: other ids");
  assert.equal(blockOf(blocks, place({ block: 1, text: "Second paragraph" }))?.id, 2, "an id of another article's block");
  assert.equal(blockOf(blocks, place({ text: "second paragraph again" }))?.id, 3, "a page's block may be part of one");
  assert.equal(blockOf(blocks, place({ text: "nowhere" })), undefined);
  assert.equal(blockOf(blocks, place({ text: "Second" })), undefined, "too short to tell which block holds it (a table cell's text)");
  assert.equal(needle("x".repeat(100)).length, 80);
});

test("a block's start keeps whole characters, and a place with half of one is not used", () => {
  const rocket = String.fromCodePoint(0x1f680);
  const cut = needle(`${"x".repeat(79)}${rocket} and more`);
  assert.equal(cut, `${"x".repeat(79)}${rocket}`, "80 characters, the emoji whole");
  // What a cut by UTF-16 units left: a lone surrogate, which the IPC's JSON refuses.
  assert.equal(isReadingPlace({ text: `${"x".repeat(79)}${rocket.slice(0, 1)}`, at: 0, t: 0 }), false);
  assert.equal(isReadingPlace({ text: cut, at: 0, t: 0, block: 3 }), true);
});

/** A block element whose box spans `top` to `bottom` on screen. */
const box = (id: string, top: number, bottom: number) =>
  ({ id, getBoundingClientRect: () => ({ top, bottom, height: bottom - top }) }) as unknown as HTMLElement;

test("the place in a view is the first block with text reaching below its top edge", () => {
  const text = new Map([
    ["b-1", "One"],
    ["b-2", ""],
    ["b-3", "Three"],
  ]);
  const blockAt = (el: HTMLElement) => ({ id: Number(el.id.slice(2)), text: text.get(el.id)! });
  const els = [box("b-1", 0, 100), box("b-2", 100, 300), box("b-3", 300, 400)];
  assert.deepEqual({ ...placeIn(els, 50, blockAt), t: 0 }, { block: 1, text: "One", at: 0.5, t: 0 });
  assert.deepEqual({ ...placeIn(els, 150, blockAt), t: 0 }, { block: 3, text: "Three", at: -1.5, t: 0 }, "past a picture, to the text below it");
  assert.equal(placeIn(els, -10, blockAt), null, "above the first block: the article's header");
  assert.equal(placeIn(els, 450, blockAt), null);
  assert.equal(placeIn([], 0, blockAt), null);
});
