import { test } from "node:test";
import assert from "node:assert/strict";
import { filterGroups, parseFilterKey } from "./scopes.ts";
import { translatorFor } from "./i18n/index.ts";

test("filter groups: empty genres dropped, 未分類/手動追加 always offered, keys round-trip", () => {
  const feed = { id: 7, url: "https://a.dev/feed", title: null, custom_title: null, has_icon: false, site_url: null, last_fetched_at: null, last_error: null, article_count: 2 };
  const g = filterGroups([], [{ name: "Linux", count: 3 }, { name: "Web", count: 0 }], [feed], [], translatorFor("ja"));
  assert.deepEqual(g.map((x) => [x.label, x.options.map((o) => o.label)]), [
    ["ジャンル", ["Linux（3件）", "未分類"]],
    ["ソース", ["手動追加", "https://a.dev/feed（2件）"]],
  ]);
  const paper = { id: 4, name: "Paper", created_at: "", count: 0 };
  const en = filterGroups([paper], [{ name: "Linux", count: 3 }], [], [{ name: "rust", count: 1 }], translatorFor("en"));
  assert.deepEqual(en.map((x) => [x.label, x.options.map((o) => o.label)]), [
    ["Collection", ["Paper (0)"]], ["Genre", ["Linux (3)", "Unclassified"]], ["Source", ["Added by hand"]], ["Tag", ["#rust (1)"]],
  ]);
  assert.deepEqual(parseFilterKey(en[0].options[0].key), { kind: "group", id: 4 });
  assert.deepEqual(g.flatMap((x) => x.options.map((o) => parseFilterKey(o.key))), [
    { kind: "genre", name: "Linux" }, { kind: "genre", name: null }, { kind: "feed", id: null }, { kind: "feed", id: 7 },
  ]);
});

test("feed folders are offered as scopes beside their feeds", () => {
  const g = filterGroups([], [], [], [], translatorFor("en"), [{ id: 3, name: "TechFeed", feeds: 2 }]);
  assert.deepEqual(g.find((x) => x.label === "Source")!.options.map((o) => [o.label, parseFilterKey(o.key)]), [
    ["Added by hand", { kind: "feed", id: null }], ["Folder: TechFeed", { kind: "folder", id: 3 }],
  ]);
});
