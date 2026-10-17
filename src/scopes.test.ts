import { test } from "node:test";
import assert from "node:assert/strict";
import { filterGroups, parseFilterKey } from "./scopes.ts";

test("filter groups: empty genres dropped, 未分類/手動追加 always offered, keys round-trip", () => {
  const feed = { id: 7, url: "https://a.dev/feed", title: null, site_url: null, last_fetched_at: null, last_error: null, article_count: 2 };
  const g = filterGroups([{ name: "Linux", count: 3 }, { name: "Web", count: 0 }], [feed], []);
  assert.deepEqual(g.map((x) => [x.label, x.options.map((o) => o.label)]), [
    ["ジャンル", ["Linux（3件）", "未分類"]],
    ["フィード", ["手動追加", "https://a.dev/feed（2件）"]],
  ]);
  assert.deepEqual(g.flatMap((x) => x.options.map((o) => parseFilterKey(o.key))), [
    { kind: "genre", name: "Linux" }, { kind: "genre", name: null }, { kind: "feed", id: null }, { kind: "feed", id: 7 },
  ]);
});
