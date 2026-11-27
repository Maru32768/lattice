import { test } from "node:test";
import assert from "node:assert/strict";
import { articleRef } from "./articleRef.ts";

test("articleRef: the article, one block, and a run of blocks", () => {
  assert.equal(articleRef(12), "lattice:article/12");
  assert.equal(articleRef(12, [345, 345]), "lattice:article/12#b345");
  assert.equal(articleRef(12, [345, 347]), "lattice:article/12#b345-b347");
});
