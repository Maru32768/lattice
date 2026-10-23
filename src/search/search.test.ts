import { test } from "node:test";
import assert from "node:assert/strict";
import { excerpt, filterHits, groupHits, highlight, terms } from "./search.ts";

test("highlight is case-insensitive and regex-safe", () => {
  assert.deepEqual(highlight("Use EPOLLET (edge)", terms("epollet (edge")), [
    { mark: false, v: "Use " },
    { mark: true, v: "EPOLLET" },
    { mark: false, v: " " },
    { mark: true, v: "(edge" },
    { mark: false, v: ")" },
  ]);
  assert.deepEqual(highlight("abc", []), [{ mark: false, v: "abc" }]);
});

test("excerpt centers on the first hit", () => {
  const text = "x".repeat(500) + "WAL" + "y".repeat(500);
  const e = excerpt(text, ["wal"], 90);
  assert.equal(e, "…" + "x".repeat(30) + "WAL" + "y".repeat(57) + "…");
  assert.equal(e.length, 92, "90 characters plus the two omission marks");
  assert.equal(excerpt(text + "LATE", ["late", "wal"], 90), e, "the first occurrence wins, not the first query term");
  assert.equal(excerpt("WAL" + "y".repeat(100), ["wal"], 12), "WAL" + "y".repeat(9) + "…");
  assert.equal(excerpt("x".repeat(100) + "WAL", ["wal"], 12), "…" + "x".repeat(9) + "WAL");
  assert.equal(excerpt("short", ["wal"]), "short");
  assert.equal(excerpt("z".repeat(300), ["none"], 100), "z".repeat(100) + "…");
});

test("hits: method filters by match source, scope by article; grouped by article in rank order", () => {
  const h = (block_id: number, article_id: number, source: "lexical" | "semantic" | "both") => ({ block_id, article_id, source });
  const hits = [h(1, 10, "both"), h(2, 20, "semantic"), h(3, 10, "lexical"), h(4, 30, "lexical")];
  const ids = new Set([10, 20]);
  assert.deepEqual(
    filterHits(hits, "hybrid", ids).map((x) => x.block_id),
    [1, 2, 3],
  );
  assert.deepEqual(
    filterHits(hits, "lexical", ids).map((x) => x.block_id),
    [1, 3],
  );
  assert.deepEqual(
    filterHits(hits, "semantic", ids).map((x) => x.block_id),
    [1, 2],
  );
  assert.deepEqual(
    groupHits(hits).map((g) => [g.article_id, g.hits.map((x) => x.block_id)]),
    [
      [10, [1, 3]],
      [20, [2]],
      [30, [4]],
    ],
  );
});
