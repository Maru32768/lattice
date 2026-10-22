// Run with `npm test` (Node strips the types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoTranslates, needsTranslation, nothingToTranslate, splitBackticks, translatedBlockIds, translationProgress } from "./mixed.ts";

const blocks = Array.from({ length: 10 }, (_, i) => ({ id: i, translation: i === 9 ? null : `t${i}` }));

test("modes", () => {
  assert.equal(translatedBlockIds(blocks, "original", 70).size, 0);
  assert.equal(translatedBlockIds(blocks, "translated", 0).size, 9);
});

test("mixed ratio is exact by count and evenly spread", () => {
  const ten = blocks.map((b) => ({ ...b, translation: "t" }));
  for (const p of [0, 10, 30, 50, 70, 100]) {
    assert.equal(translatedBlockIds(ten, "mixed", p).size, p / 10);
  }
  assert.deepEqual([...translatedBlockIds(ten, "mixed", 30)], [3, 6, 9]);
  assert.equal(translatedBlockIds(blocks, "mixed", 100).has(9), false, "untranslated blocks never flip");
});

test("splitBackticks", () => {
  assert.deepEqual(splitBackticks("ログ（`WAL`）は"), [
    { code: false, v: "ログ（" },
    { code: true, v: "WAL" },
    { code: false, v: "）は" },
  ]);
});

test("picking 混在 or 訳文 starts a translation only when prose is untranslated and no job is on it", () => {
  const fresh = [
    { kind: "heading", translation: null },
    { kind: "paragraph", translation: null },
    { kind: "code", translation: null },
  ];
  const done = fresh.map((b) => ({ ...b, translation: b.kind === "code" ? null : "訳" }));
  assert.equal(autoTranslates("translated", fresh, undefined), true);
  assert.equal(autoTranslates("mixed", fresh, undefined), true);
  assert.equal(autoTranslates("original", fresh, undefined), false, "原文 needs no translation");
  assert.equal(autoTranslates("translated", done, undefined), false, "code blocks are never translated");
  assert.equal(autoTranslates("translated", fresh, { status: "pending" }), false, "queued, or waiting to retry");
  assert.equal(autoTranslates("translated", fresh, { status: "running" }), false);
  assert.equal(autoTranslates("translated", fresh, { status: "succeeded" }), false, "what is left is already in the target language");
  assert.equal(autoTranslates("translated", fresh, { status: "failed" }), true, "gave up earlier: picking again retries");
  assert.equal(autoTranslates("translated", [], undefined), false, "nothing extracted");
});

test("the Reader counts only blocks the job would translate", () => {
  const b = (kind: string, text: string, translation: string | null = null) => ({ kind, text, translation });
  assert.equal(needsTranslation(b("heading", "GitHub Actionsによる自動化"), "en"), true, "Japanese with English identifiers");
  assert.equal(needsTranslation(b("paragraph", "npm install lattice"), "en"), false, "already English: the job skips it");
  assert.equal(needsTranslation(b("paragraph", "スナップショット分離", "Snapshot isolation"), "en"), false, "translated");
  assert.equal(needsTranslation(b("code", "SELECT 1;"), "ja"), false, "code is never translated");
});

test("the list and the Reader count the same blocks left to translate", () => {
  const b = (kind: string, text: string, translation: string | null = null) => ({ kind, text, translation });
  const blocks = [
    b("heading", "MVCC", "MVCC"),
    b("paragraph", "Readers never block writers."),
    b("paragraph", "多版本并发控制让读写互不阻塞。"),
    b("paragraph", "すでに日本語の段落"),
    b("code", "SELECT 1;"),
  ];
  assert.deepEqual(translationProgress(blocks, "ja"), { done: 1, total: 3 }, "Chinese is left to translate; Japanese and code are not");
  assert.deepEqual(translationProgress([b("code", "RFC 8446 ...")], "ja"), { done: 0, total: 0 });
});

test("an article with nothing to translate says why", () => {
  const b = (kind: string, text: string, translation: string | null = null) => ({ kind, text, translation });
  assert.equal(nothingToTranslate([b("code", "Network Working Group   RFC 8446")], "ja"), "reader.noProse", "only <pre>");
  assert.equal(nothingToTranslate([b("paragraph", "npm install lattice")], "en"), "reader.alreadyInTarget");
  assert.equal(nothingToTranslate([b("paragraph", "Readers never block writers.")], "ja"), null, "something to translate");
  assert.equal(nothingToTranslate([b("paragraph", "MVCC", "MVCC")], "ja"), null, "already translated");
  assert.equal(nothingToTranslate([], "ja"), null, "not extracted yet");
});
