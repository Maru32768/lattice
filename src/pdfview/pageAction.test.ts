import { test } from "node:test";
import assert from "node:assert/strict";
import { pageAction } from "./pageAction.ts";

test("a page with nothing to translate offers nothing", () => {
  assert.equal(pageAction([]), "none");
  assert.equal(pageAction(["skip", "skip"]), "none");
});

test("a page being translated is busy, whatever else is on it", () => {
  assert.equal(pageAction(["done", "translating", "failed"]), "busy");
  assert.equal(pageAction(["translating", "skip"]), "busy");
});

test("a page with all its translation done offers to redo it", () => {
  assert.equal(pageAction(["done", "done"]), "redo");
  assert.equal(pageAction(["done", "skip"]), "redo");
});

test("anything else still to translate offers to translate", () => {
  for (const state of ["idle", "pending", "failed", undefined]) {
    assert.equal(pageAction(["done", state]), "translate", String(state));
    assert.equal(pageAction([state, "skip"]), "translate", String(state));
  }
});
