import { test } from "node:test";
import assert from "node:assert/strict";
import type { VocabEntry } from "../api.ts";
import { MAX_SENTENCE, captureIn, findWord, isWord, markWords, sentenceAt, shownEntries, wordIn, wordMarks } from "./vocab.ts";

test("isWord: short English selections on one line", () => {
  assert.equal(isWord(" write skew "), true);
  assert.equal(isWord("分離"), false, "no Latin letter");
  assert.equal(isWord("a".repeat(65)), false);
  assert.equal(isWord("two\nlines"), false);
  assert.equal(isWord("   "), false);
});

test("sentenceAt: the sentence around the word, across closing quotes and line breaks", () => {
  const text = 'First one. It said "ran fast." Then it ran again! Last?';
  const at = text.indexOf("ran again");
  assert.equal(sentenceAt(text, at, at + 3), "Then it ran again!");
  assert.equal(sentenceAt(text, text.indexOf("ran fast"), text.indexOf("ran fast") + 3), 'It said "ran fast."');
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
  assert.deepEqual(findWord("She ran the tests and Ran them again.", "ran"), [
    [4, 7],
    [22, 25],
  ]);
  assert.deepEqual(findWord("Rerun and run.", "run"), [[10, 13]], "not inside rerun");
  assert.deepEqual(findWord("write  skew happens", "write skew"), [[0, 11]], "any spaces between words");
  assert.deepEqual(findWord("x", ""), []);
});

const entry = (id: number, headword: string, meaning: string, surfaces: string[], extra: Partial<VocabEntry> = {}): VocabEntry => ({
  id,
  headword,
  meaning,
  pos: "",
  definition: "",
  ipa: "",
  example: "",
  state: "ready",
  suspended: false,
  created_at: "",
  due_at: null,
  contexts: surfaces.map((surface) => ({ surface, sentence: surface, article_id: null, block_id: null, url: null, title: null, explanation: null })),
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
  const es = [
    entry(1, "run", "走る", ["ran"], { due_at: 50 }),
    entry(2, "skew", "歪み", [], { due_at: null }),
    entry(3, "flaky", "不安定", [], { due_at: 10 }),
  ];
  assert.deepEqual(
    shownEntries(es, "", "added").map((e) => e.id),
    [3, 2, 1],
  );
  assert.deepEqual(
    shownEntries(es, "", "due").map((e) => e.id),
    [3, 1, 2],
  );
  assert.deepEqual(
    shownEntries(es, " RAN ", "added").map((e) => e.id),
    [1],
  );
  assert.deepEqual(
    shownEntries(es, "歪", "added").map((e) => e.id),
    [2],
  );
});

test("wordIn: a whole word in its sentence, first where it has its own case", () => {
  const text = "See the catalog. The Log grows. The log is append-only.";
  assert.deepEqual(wordIn(text, "log"), { surface: "log", sentence: "The log is append-only." }, "not inside catalog, and its own case first");
  assert.deepEqual(wordIn(text, "LOG"), { surface: "Log", sentence: "The Log grows." }, "else the first, as it is written there");
  assert.deepEqual(wordIn("write\n  skew happens.", "write skew"), { surface: "write skew", sentence: "write skew happens." });
  assert.equal(wordIn(text, "cat"), null);
});

test("wordIn: of a word twice, the place that reads as where its sticky was selected, else as with no context", () => {
  const text = "The log is append-only. Readers tail the log as it grows.";
  const later = { prefix: "append-only. Readers tail the", suffix: " as it grows." };
  assert.deepEqual(wordIn(text, "log", later), { surface: "log", sentence: "Readers tail the log as it grows." });
  assert.deepEqual(
    wordIn(text, "log", { prefix: "Readers\n tail the", suffix: "as it\tgrows." }),
    { surface: "log", sentence: "Readers tail the log as it grows." },
    "whitespace apart",
  );
  assert.deepEqual(
    wordIn("𝑓 is a b. 𝑔 is a b.", "a", { prefix: "𝑔 is", suffix: null }),
    { surface: "a", sentence: "𝑔 is a b." },
    "after characters of two code units",
  );
  assert.deepEqual(
    wordIn(text, "log", { prefix: "Writers tail the", suffix: " as it grows." }),
    { surface: "log", sentence: "Readers tail the log as it grows." },
    "the place where one side still reads so",
  );
  assert.deepEqual(
    wordIn("Readers tail the log. Writers append to the log.", "log", { prefix: "Writers append to the", suffix: "." }),
    { surface: "log", sentence: "Writers append to the log." },
    "where only the side before tells them apart",
  );
  assert.deepEqual(
    wordIn(text, "log", { prefix: "Writers tail the", suffix: " when it shrinks." }),
    { surface: "log", sentence: "The log is append-only." },
    "none reads so",
  );
  assert.deepEqual(wordIn(text, "log", { prefix: null, suffix: null }), { surface: "log", sentence: "The log is append-only." });
  assert.deepEqual(
    wordIn("The Log grows. Readers tail the log.", "Log", { prefix: "Readers tail the", suffix: "." }),
    { surface: "log", sentence: "Readers tail the log." },
    "before its own case",
  );
});

test("wordIn and sentenceAt: a Japanese sentence ends at its own stop, with no space after it", () => {
  assert.deepEqual(wordIn("WALを先に書く。次にfsyncを呼ぶ。", "fsync"), { surface: "fsync", sentence: "次にfsyncを呼ぶ。" });
  const text = "「速い！」MVCCは古い版を残す。それで読む側が待たない？";
  assert.equal(sentenceAt(text, text.indexOf("MVCC"), text.indexOf("MVCC") + 4), "MVCCは古い版を残す。", "after a closing bracket too");
  assert.equal(sentenceAt(text, 0, 3), "「速い！」");
  const at = (t: string, word: string) => sentenceAt(t, t.indexOf(word), t.indexOf(word) + word.length);
  assert.equal(at("なぜ速い？WALを先に書くから。", "WAL"), "WALを先に書くから。", "after a question");
  assert.equal(at("本当に速い？！WALを先に書く。", "WAL"), "WALを先に書く。", "after stops one after another");
  assert.equal(at("本当に速い？！WALを先に書く。", "本当"), "本当に速い？！");
  for (const t of [
    "（先に書く。）次にfsyncを呼ぶ。",
    "【先に書く。】次にfsyncを呼ぶ。",
    "〔先に書く。〕次にfsyncを呼ぶ。",
    "《先に書く。》次にfsyncを呼ぶ。",
    "〈先に書く。〉次にfsyncを呼ぶ。",
    "［先に書く。］次にfsyncを呼ぶ。",
  ]) {
    assert.equal(at(t, "fsync"), "次にfsyncを呼ぶ。", `after ${t.slice(0, 7)}`);
  }
});

test("wordIn: Japanese, written with no spaces, ends no word", () => {
  assert.deepEqual(wordIn("PostgreSQLはこれをMVCCで実装している。", "mvcc"), { surface: "MVCC", sentence: "PostgreSQLはこれをMVCCで実装している。" });
  assert.deepEqual(wordIn("分離でもwrite\nskewは起こる。", "write skew"), { surface: "write skew", sentence: "分離でもwrite skewは起こる。" });
  assert.deepEqual(wordIn("MVCC方式で実装する。", "MVCC"), { surface: "MVCC", sentence: "MVCC方式で実装する。" }, "kanji as kana");
  assert.equal(wordIn("MVCCsの実装", "MVCC"), null);
});

test("wordIn: of a word in a block 300,000 times, it is the place its sticky was selected, found in time", () => {
  const text = `${"a. ".repeat(150_000)}b a. ${"a. ".repeat(150_000)}`;
  assert.equal(wordIn(text, "a", { prefix: "b ", suffix: null })?.sentence, "b a.");
});
