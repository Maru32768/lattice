import { test } from "node:test";
import assert from "node:assert/strict";
import type { VocabEntry } from "./api.ts";
import { MAX_SENTENCE, captureIn, findWord, isWord, markWords, sentenceAt, shownEntries, wordMarks } from "./vocab.ts";

test("isWord: short English selections on one line", () => {
  assert.equal(isWord(" write skew "), true);
  assert.equal(isWord("分離"), false, "no Latin letter");
  assert.equal(isWord("a".repeat(65)), false);
  assert.equal(isWord("two\nlines"), false);
  assert.equal(isWord("   "), false);
});

test("sentenceAt: the sentence around the word, across closing quotes and line breaks", () => {
  const text = "First one. It said \"ran fast.\" Then it ran again! Last?";
  const at = text.indexOf("ran again");
  assert.equal(sentenceAt(text, at, at + 3), "Then it ran again!");
  assert.equal(sentenceAt(text, text.indexOf("ran fast"), text.indexOf("ran fast") + 3), "It said \"ran fast.\"");
  assert.equal(sentenceAt("Heading\nBody  with   word here", 15, 19), "Body with word here");
  assert.equal(sentenceAt("v1.2 is out", 0, 4), "v1.2 is out", "a dot inside a token is no end");
  const long = `${"x ".repeat(400)}word ${"y ".repeat(400)}`;
  const s = sentenceAt(long, 800, 804);
  assert.ok(s.length <= MAX_SENTENCE && s.includes("word"), s);
});

test("captureIn picks the occurrence the selection is at", () => {
  const text = "Retry the run. The second run fails.";
  assert.deepEqual(captureIn(text, "run", 30), { surface: "run", sentence: "The second run fails." });
  assert.deepEqual(captureIn(text, "run", 0), { surface: "run", sentence: "Retry the run." });
  assert.equal(captureIn(text, "walk", 0), null);
});

test("findWord finds the form used, as a whole word, case-insensitively", () => {
  assert.deepEqual(findWord("She ran the tests and Ran them again.", "ran"), [[4, 7], [22, 25]]);
  assert.deepEqual(findWord("Rerun and run.", "run"), [[10, 13]], "not inside rerun");
  assert.deepEqual(findWord("write  skew happens", "write skew"), [[0, 11]], "any spaces between words");
  assert.deepEqual(findWord("x", ""), []);
});

const entry = (id: number, headword: string, meaning: string, surfaces: string[], extra: Partial<VocabEntry> = {}): VocabEntry => ({
  id, headword, meaning, pos: "", definition: "", ipa: "", example: "", state: "ready", suspended: false, created_at: "", due_at: null,
  contexts: surfaces.map((surface) => ({ surface, sentence: surface, article_id: null, block_id: null, url: null, title: null })),
  ...extra,
});

test("wordMarks marks every saved form, longest first, with its meaning", () => {
  const m = wordMarks([
    entry(1, "run", "走る", ["ran"]),
    entry(2, "write skew", "書き込みスキュー", []),
    entry(3, "write", "書く", []),
    entry(4, "pending", "", [], { state: "pending" }),
  ]);
  assert.deepEqual(markWords("Write skew ran; rerun to write.", m), [
    { v: "Write skew", meaning: "書き込みスキュー" },
    { v: " " },
    { v: "ran", meaning: "走る" },
    { v: "; rerun to " },
    { v: "write", meaning: "書く" },
    { v: "." },
  ]);
  assert.deepEqual(markWords("pending", m), [{ v: "pending" }], "no meaning yet");
  assert.equal(wordMarks([]), null);
  assert.deepEqual(markWords("text", null), [{ v: "text" }]);
});

test("shownEntries searches every form and sorts by added or due", () => {
  const es = [entry(1, "run", "走る", ["ran"], { due_at: 50 }), entry(2, "skew", "歪み", [], { due_at: null }), entry(3, "flaky", "不安定", [], { due_at: 10 })];
  assert.deepEqual(shownEntries(es, "", "added").map((e) => e.id), [3, 2, 1]);
  assert.deepEqual(shownEntries(es, "", "due").map((e) => e.id), [3, 1, 2]);
  assert.deepEqual(shownEntries(es, " RAN ", "added").map((e) => e.id), [1]);
  assert.deepEqual(shownEntries(es, "歪", "added").map((e) => e.id), [2]);
});
