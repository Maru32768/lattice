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
  assert.ok(e.startsWith("…") && e.endsWith("…") && e.includes("WAL"), e);
  assert.equal(excerpt("short", ["wal"]), "short");
  assert.ok(excerpt("z".repeat(300), ["none"], 100).startsWith("zzz"));
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
