import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTICLES } from "./fixtures.ts";
import { handlers } from "./mock.ts";

test("search restricts explicit article IDs before the page limit, including an empty set", () => {
  const selected = ARTICLES.find((a) => a.tags.includes("crdt"))!;
  const all = handlers.search_blocks({ query: "a", filter: null });
  assert.equal(all.hits.length, 30);
  assert.ok(all.hits.every((hit) => hit.article_id !== selected.id));
  const restricted = handlers.search_blocks({ query: "a", filter: null, articles: [selected.id] });
  assert.ok(restricted.hits.length > 0);
  assert.ok(restricted.hits.every((hit) => hit.article_id === selected.id));
  assert.deepEqual(handlers.search_blocks({ query: "a", filter: null, articles: [] }).hits, []);
});
