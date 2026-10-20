import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArticleRow } from "./api.ts";
import { translatorFor } from "./i18n/index.ts";
import { NO_FACETS, NO_KEPT, countBy, facetBase, inScope, keep, listed, matches, relaxations, scopeLabel, toFilter, toggle, valueLabel, viewKey, type Facets } from "./library.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const row = (id: number, p: Partial<ArticleRow> = {}): ArticleRow => ({
  id, original_url: `https://x.dev/${id}`, canonical_url: null, domain: "x.dev", title: `T${id}`, author: null, site_name: null,
  published_at: null, language: null, saved_at: "2026-10-16T00:00:00.000Z", fetch_status: "ok", extraction_status: "ok",
  last_error: null, read_status: "unread", favorite: false, tags: [], groups: [], genre: null, genre_manual: false, difficulty: null,
  difficulty_manual: false, feed_id: null, feed_title: null, thin: false, ...p,
});
const all = [
  row(1, { genre: "Database", tags: ["postgres", "mvcc"], feed_id: 7, feed_title: "Planet PostgreSQL", difficulty: 4, groups: [1, 2] }),
  row(2, { genre: "Database", tags: ["postgres"], read_status: "read", favorite: true, saved_at: "2026-09-01T00:00:00.000Z", groups: [2] }),
  row(3, { genre: "Linux", tags: ["ebpf"], feed_id: 7, feed_title: "Planet PostgreSQL", thin: true }),
  row(4, { tags: ["mvcc"], extraction_status: "failed", difficulty: 1 }),
];
const ids = (rows: ArticleRow[]) => rows.map((a) => a.id);
const f = (p: Partial<Facets>): Facets => ({ ...NO_FACETS, ...p });

const [ja, en] = [translatorFor("ja"), translatorFor("en")];
const groups = [{ id: 1, name: "卒論", created_at: "", count: 1 }, { id: 2, name: "Paper", created_at: "", count: 2 }, { id: 3, name: "Empty", created_at: "", count: 0 }];

test("scopes: recent is the last 7 days; genre/feed null are 未分類/手動追加", () => {
  assert.deepEqual(ids(all.filter((a) => inScope(a, { kind: "recent" }, NOW))), [1, 3, 4]);
  assert.deepEqual(ids(all.filter((a) => inScope(a, { kind: "genre", name: null }, NOW))), [4]);
  assert.deepEqual(ids(all.filter((a) => inScope(a, { kind: "feed", id: null }, NOW))), [2, 4]);
  assert.deepEqual(ids(all.filter((a) => inScope(a, { kind: "favorites" }, NOW))), [2]);
  assert.deepEqual(ids(all.filter((a) => inScope(a, { kind: "group", id: 2 }, NOW))), [1, 2]);
  assert.deepEqual(ids(all.filter((a) => inScope(a, { kind: "group", id: 3 }, NOW))), []);
});

test("groups: a scope by id and a facet dimension (OR within, AND with the others), labelled by name", () => {
  assert.deepEqual(ids(all.filter((a) => matches(a, f({ groups: [1, 3] })))), [1]);
  assert.deepEqual(ids(all.filter((a) => matches(a, f({ groups: [2], state: ["read"] })))), [2]);
  assert.deepEqual([...countBy(all, "groups")], [[1, 1], [2, 2]]);
  assert.equal(scopeLabel({ kind: "group", id: 1 }, all, groups, ja), "卒論");
  assert.equal(scopeLabel({ kind: "group", id: 3 }, all, groups, en), "Empty", "an empty group still has its name");
  assert.equal(valueLabel("groups", 2, all, groups, en), "Paper");
  assert.deepEqual(toFilter({ kind: "group", id: 2 }), { kind: "group", id: 2 });
  const r = relaxations(all, groups, { kind: "group", id: 1 }, f({ state: ["read"] }), NOW, ja);
  assert.deepEqual(r.map((x) => [x.label, x.count]), [["状態 既読 を外す", 1], ["卒論 → すべての記事", 1]]);
});

test("facets: AND across dimensions, OR within, tags by tagMode", () => {
  assert.deepEqual(ids(all.filter((a) => matches(a, f({ tags: ["postgres", "mvcc"] })))), [1]);
  assert.deepEqual(ids(all.filter((a) => matches(a, f({ tags: ["postgres", "mvcc"], tagMode: "any" })))), [1, 2, 4]);
  assert.deepEqual(ids(all.filter((a) => matches(a, f({ genres: ["Linux", null] })))), [3, 4]);
  assert.deepEqual(ids(all.filter((a) => matches(a, f({ genres: ["Database"], state: ["read"] })))), [2]);
  assert.deepEqual(ids(all.filter((a) => matches(a, f({ state: ["issue"] })))), [3, 4]);
  assert.deepEqual(ids(all.filter((a) => matches(a, f({ difficulty: [null] })))), [2, 3]);
  assert.deepEqual(toggle(toggle(NO_FACETS, "feeds", 7), "feeds", 7).feeds, []);
});

test("popover counts: own dimension removed, except tags in all mode", () => {
  const genre = facetBase(all, f({ genres: ["Database"] }), "genres");
  assert.deepEqual([...countBy(genre, "genres")], [["Database", 2], ["Linux", 1], [null, 1]]);
  const tags = countBy(facetBase(all, f({ tags: ["postgres"] }), "tags"), "tags");
  assert.deepEqual([...tags], [["postgres", 2], ["mvcc", 1]]);
  const any = countBy(facetBase(all, f({ tags: ["postgres"], tagMode: "any" }), "tags"), "tags");
  assert.equal(any.get("ebpf"), 1);
});

test("relaxations: one per active facet, plus the scope unless all", () => {
  const r = relaxations(all, groups, { kind: "unread" }, f({ genres: ["Database"], tags: ["ebpf"] }), NOW, ja);
  assert.deepEqual(r.map((x) => [x.label, x.count]), [
    ["ジャンル Database を外す", 1], ["タグ ebpf を外す", 1], ["未読 → すべての記事", 0],
  ]);
  assert.deepEqual(relaxations(all, groups, { kind: "unread" }, f({ genres: ["Database"] }), NOW, en).map((x) => x.label), ["Remove Genre: Database", "Unread → All articles"]);
  assert.deepEqual(r[1].facets, f({ genres: ["Database"] }));
  assert.deepEqual(r[2].scope, { kind: "all" });
});

test("labels and backend filters", () => {
  assert.equal(valueLabel("feeds", 7, all, groups, ja), "Planet PostgreSQL");
  assert.equal(valueLabel("feeds", null, all, groups, ja), "手動追加");
  assert.equal(valueLabel("difficulty", 4, all, groups, ja), "上級");
  assert.equal(valueLabel("difficulty", null, all, groups, en), "Not rated");
  assert.deepEqual(toFilter({ kind: "recent" }), { kind: "all" });
  assert.deepEqual(toFilter({ kind: "genre", name: null }), { kind: "genre", name: null });
});

test("kept: an article read while listed stays in that view only", () => {
  const unread = { kind: "unread" } as const;
  const state = f({ state: ["unread"] });
  const read1 = all.map((a) => (a.id === 1 ? { ...a, read_status: "read" } : a));
  assert.deepEqual(ids(listed(read1, unread, NO_FACETS, NOW, NO_KEPT).shown), [3, 4]);
  const k = keep(NO_KEPT, viewKey(unread, NO_FACETS), 1);
  assert.deepEqual(ids(listed(read1, unread, NO_FACETS, NOW, k).shown), [1, 3, 4]);
  assert.deepEqual(ids(listed(read1, unread, NO_FACETS, NOW, k).scoped), [1, 3, 4]);
  assert.deepEqual(ids(listed(read1, unread, f({ genres: ["Linux"] }), NOW, k).shown), [3], "another facet drops it");
  assert.deepEqual(ids(listed(read1, { kind: "all" }, state, NOW, k).shown), [3, 4], "another scope drops it");
  const k2 = keep(NO_KEPT, viewKey({ kind: "all" }, state), 1);
  assert.deepEqual(ids(listed(read1, { kind: "all" }, state, NOW, k2).shown), [1, 3, 4], "状態=未読 keeps it too");
  assert.deepEqual([...keep(k, viewKey(unread, NO_FACETS), 3).ids], [1, 3]);
  assert.deepEqual([...keep(k, viewKey(unread, state), 3).ids], [3], "keeping in a new view starts over");
});
