import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArticleRow } from "./api.ts";
import { translatorFor } from "./i18n/index.ts";
import { NO_FACETS, NO_KEPT, countBy, facetBase, inScope, keep, listed, matches, relaxations, toFilter, toggle, valueLabel, viewKey, type Facets } from "./library.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const row = (id: number, p: Partial<ArticleRow> = {}): ArticleRow => ({
  id, original_url: `https://x.dev/${id}`, canonical_url: null, domain: "x.dev", title: `T${id}`, author: null, site_name: null,
  published_at: null, language: null, saved_at: "2026-10-16T00:00:00.000Z", fetch_status: "ok", extraction_status: "ok",
  last_error: null, read_status: "unread", favorite: false, tags: [], genre: null, genre_manual: false, difficulty: null,
  difficulty_manual: false, feed_id: null, feed_title: null, thin: false, relevance: null, relevance_reason: null, relevance_stale: false, ...p,
});
const all = [
  row(1, { genre: "Database", tags: ["postgres", "mvcc"], feed_id: 7, feed_title: "Planet PostgreSQL", difficulty: 4 }),
  row(2, { genre: "Database", tags: ["postgres"], read_status: "read", favorite: true, saved_at: "2026-09-01T00:00:00.000Z" }),
  row(3, { genre: "Linux", tags: ["ebpf"], feed_id: 7, feed_title: "Planet PostgreSQL", thin: true }),
  row(4, { tags: ["mvcc"], extraction_status: "failed", difficulty: 1 }),
];
const ids = (rows: ArticleRow[]) => rows.map((a) => a.id);
const f = (p: Partial<Facets>): Facets => ({ ...NO_FACETS, ...p });

const [ja, en] = [translatorFor("ja"), translatorFor("en")];

test("scopes: recent is the last 7 days; genre/feed null are 未分類/手動追加", () => {
  assert.deepEqual(ids(all.filter((a) => inScope(a, { kind: "recent" }, NOW))), [1, 3, 4]);
  assert.deepEqual(ids(all.filter((a) => inScope(a, { kind: "genre", name: null }, NOW))), [4]);
  assert.deepEqual(ids(all.filter((a) => inScope(a, { kind: "feed", id: null }, NOW))), [2, 4]);
  assert.deepEqual(ids(all.filter((a) => inScope(a, { kind: "favorites" }, NOW))), [2]);
});

test("importance: 重要 keeps scores at or above its minimum, the facet has 未判定, and both reach the backend as is", () => {
  const rated = [row(1, { relevance: 5 }), row(2, { relevance: 4, relevance_stale: true }), row(3, { relevance: 3 }), row(4)];
  assert.deepEqual(ids(rated.filter((a) => inScope(a, { kind: "important", min: 4 }, NOW))), [1, 2], "stale scores still count");
  assert.deepEqual(ids(rated.filter((a) => inScope(a, { kind: "important", min: 5 }, NOW))), [1]);
  assert.deepEqual(ids(rated.filter((a) => matches(a, f({ relevance: [3, null] })))), [3, 4]);
  assert.deepEqual(toFilter({ kind: "important", min: 4 }), { kind: "important", min: 4 });
  assert.equal(valueLabel("relevance", 5, rated, ja), "必読");
  assert.equal(valueLabel("relevance", null, rated, en), "Not rated");
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
  const r = relaxations(all, { kind: "unread" }, f({ genres: ["Database"], tags: ["ebpf"] }), NOW, ja);
  assert.deepEqual(r.map((x) => [x.label, x.count]), [
    ["ジャンル Database を外す", 1], ["タグ ebpf を外す", 1], ["未読 → すべての記事", 0],
  ]);
  assert.deepEqual(relaxations(all, { kind: "unread" }, f({ genres: ["Database"] }), NOW, en).map((x) => x.label), ["Remove Genre: Database", "Unread → All articles"]);
  assert.deepEqual(r[1].facets, f({ genres: ["Database"] }));
  assert.deepEqual(r[2].scope, { kind: "all" });
});

test("labels and backend filters", () => {
  assert.equal(valueLabel("feeds", 7, all, ja), "Planet PostgreSQL");
  assert.equal(valueLabel("feeds", null, all, ja), "手動追加");
  assert.equal(valueLabel("difficulty", 4, all, ja), "上級");
  assert.equal(valueLabel("difficulty", null, all, en), "Not rated");
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
