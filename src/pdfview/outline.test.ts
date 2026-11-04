import { test } from "node:test";
import assert from "node:assert/strict";
import { bookmarkTree, headingTree, topOf, webLink } from "./outline.ts";

test("bookmarks keep their hierarchy, and one with no place stays for its children", () => {
  const tree = bookmarkTree([
    { title: " 2  Hardware\n", dest: null, items: [{ title: "2.1 RAM", dest: "sec.2.1", items: [] }] },
    { title: "3 Caches", dest: [{ num: 1, gen: 0 }, { name: "Fit" }], items: [] },
  ]);
  assert.equal(tree[0].title, "2 Hardware");
  assert.equal(tree[0].target, null);
  assert.deepEqual(tree[0].items[0].target, { dest: "sec.2.1" });
  assert.equal(tree.length, 2);
});

test("headings nest by level and body text is left out", () => {
  const region = (text: string, level: number | null, y0 = 10) => ({ text, page: 0, y0, level });
  const tree = headingTree([
    region("Abstract", 2),
    region("body", null),
    region("3 Caches", 2, 50),
    region("3.1 Big picture", 3),
    region("3.1.1 Detail", 4),
    region("3.2 Level", 3),
    region("4 Virtual", 2),
  ]);
  assert.deepEqual(
    tree.map((e) => e.title),
    ["Abstract", "3 Caches", "4 Virtual"],
  );
  assert.deepEqual(tree[1].target, { page: 0, y: 50 });
  assert.deepEqual(
    tree[1].items.map((e) => e.title),
    ["3.1 Big picture", "3.2 Level"],
  );
  assert.equal(tree[1].items[0].items[0].title, "3.1.1 Detail");
});

test("a heading deeper than the first one still finds a place", () => {
  assert.deepEqual(
    headingTree([
      { text: "2.1 First", page: 0, y0: 0, level: 3 },
      { text: "3 Second", page: 1, y0: 0, level: 2 },
    ]).map((e) => e.title),
    ["2.1 First", "3 Second"],
  );
});

test("the height of a destination, by its kind", () => {
  assert.equal(topOf([0, { name: "XYZ" }, 72, 700, null]), 700);
  assert.equal(topOf([0, { name: "FitH" }, 500]), 500);
  assert.equal(topOf([0, { name: "FitR" }, 10, 20, 30, 40]), 40);
  assert.equal(topOf([0, { name: "Fit" }]), null);
  assert.equal(topOf([0, { name: "XYZ" }, 72, null, null]), null, "XYZ may leave the height as it is");
  assert.equal(topOf([0]), null);
});

test("a PDF's links reach only the web", () => {
  assert.equal(webLink("https://example.com/a"), "https://example.com/a");
  assert.equal(webLink("javascript:alert(1)"), null);
  assert.equal(webLink("file:///C:/secret"), null);
  assert.equal(webLink("not a url"), null);
});
