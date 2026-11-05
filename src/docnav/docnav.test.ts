import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, {
  document: window.document,
  getComputedStyle: window.getComputedStyle.bind(window),
  Node: window.Node,
  NodeFilter: window.NodeFilter,
});

const { docText, indexOfPoint, matchesIn, pickMatch, rangeAt, textNodes } = await import("./text.ts");
const { hintLabels, spread } = await import("./hints.ts");

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

test("spread keeps at most the cap, from all over the list", () => {
  const items = Array.from({ length: 1000 }, (_, i) => i);
  const kept = spread(items, 196);
  assert.equal(kept.length, 196);
  assert.equal(kept[0], 0);
  assert.ok(kept.at(-1)! > 990);
  assert.deepEqual(spread([1, 2, 3], 196), [1, 2, 3]);
});

test("the document's text leaves out what a reader cannot see or select", () => {
  document.body.innerHTML = `
    <div id="d">
      <p>seen</p>
      <script>never()</script>
      <p style="display:none">gone <b>too</b></p>
      <p style="visibility:hidden">hidden</p>
      <p style="user-select:none">unselectable</p>
      <div data-lattice-ui="1">our own</div>
      <p>last</p>
    </div>`;
  assert.deepEqual(
    textNodes(document.getElementById("d")!).map((n) => n.data),
    ["seen", "last"],
  );
});

test("a match runs across spans and over line ends, and comes back as a Range on the right characters", () => {
  // As pdf.js lays out a text layer: a word broken over two spans, a line end, a phrase over two lines.
  document.body.innerHTML = `<div id="d"><span>Atten</span><span>tion is</span><br><span>all you need</span></div>`;
  const doc = docText(document.getElementById("d")!);
  assert.equal(doc.text, "Attentionisallyouneed");

  const word = matchesIn(doc.text, "attention");
  assert.deepEqual(word, { starts: [0], length: 9 });
  assert.equal(rangeAt(doc, 0, word.length).toString(), "Attention");

  const phrase = matchesIn(doc.text, "is all");
  assert.deepEqual(phrase.starts, [9]);
  const r = rangeAt(doc, 9, phrase.length);
  assert.equal(r.startContainer, doc.nodes[1]);
  assert.equal(r.endContainer, doc.nodes[2]);
  assert.equal(r.endOffset, 3);
});

test("a query without a capital ignores case; with one it minds case", () => {
  const text = "ReactreactREACT";
  assert.deepEqual(matchesIn(text, "react").starts, [0, 5, 10]);
  assert.deepEqual(matchesIn(text, "React").starts, [0]);
  assert.deepEqual(matchesIn(text, "   ").starts, []);
  assert.deepEqual(matchesIn(text, "").starts, []);
  assert.deepEqual(matchesIn("İstanbul", "istanbul").starts, [], "a character whose lower case is longer stays as it is");
  assert.deepEqual(matchesIn("İstanbul", "stanbul").starts, [1], "and the offsets after it still line up");
});

test("matches are picked from the origin, wrapping round both ways", () => {
  const starts = [10, 20, 30];
  assert.equal(pickMatch(starts, 15, 1), 1);
  assert.equal(pickMatch(starts, 20, 1), 1, "one that starts right there counts going forward");
  assert.equal(pickMatch(starts, 31, 1), 0, "past the last: back to the first");
  assert.equal(pickMatch(starts, 20, -1), 0, "going back: strictly before");
  assert.equal(pickMatch(starts, 5, -1), 2, "before the first: round to the last");
  assert.equal(pickMatch([], 5, 1), -1);
  assert.equal(pickMatch([], 5, -1), -1);
});

test("a point in the document maps to its place in the text, whitespace left out", () => {
  document.body.innerHTML = `<div id="d"><p>a b</p><p>cd</p></div>`;
  const doc = docText(document.getElementById("d")!);
  assert.equal(indexOfPoint(doc, doc.nodes[0], 0), 0);
  assert.equal(indexOfPoint(doc, doc.nodes[0], 1), 1, "the space belongs to no character: the next one stands for it");
  assert.equal(indexOfPoint(doc, doc.nodes[1], 1), 3);
  assert.equal(indexOfPoint(doc, document.body, 0), null);
});
