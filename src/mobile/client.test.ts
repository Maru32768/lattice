import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArticleRow } from "../bindings";
import { tokenInFragment } from "./client.ts";
import { visibleArticles } from "./list.ts";
import { articleInHash } from "./route.ts";

test("the token comes from the QR code's fragment only", () => {
  assert.equal(tokenInFragment("#t=abc"), "abc");
  assert.equal(tokenInFragment("#t="), null);
  assert.equal(tokenInFragment(""), null);
  assert.equal(tokenInFragment("#/a/12"), null);
});

test("an article's address is the article's id and nothing else", () => {
  assert.equal(articleInHash("#/a/12"), 12);
  for (const hash of ["", "#/", "#/a/", "#/a/12/x", "#/a/x", "#t=abc"]) {
    assert.equal(articleInHash(hash), null, hash);
  }
});

const row = (id: number, title: string | null, more: Partial<ArticleRow> = {}) =>
  ({ id, title, original_url: `https://example.com/${id}`, domain: "example.com", read_status: "unread", favorite: false, ...more }) as ArticleRow;

test("a view lists by state and by title or site, without regard to case", () => {
  const articles = [
    row(1, "Rust Notes"),
    row(2, "Go Notes", { read_status: "read" }),
    row(3, "Zig", { read_status: "read", favorite: true }),
    row(4, null, { domain: "other.org" }),
  ];
  const ids = (filter: "unread" | "all" | "favorites", query = "") => visibleArticles(articles, { filter, query }).map((a) => a.id);
  assert.deepEqual(ids("unread"), [1, 4]);
  assert.deepEqual(ids("all"), [1, 2, 3, 4]);
  assert.deepEqual(ids("favorites"), [3]);
  assert.deepEqual(ids("all", " NOTES "), [1, 2]);
  assert.deepEqual(ids("all", "other.org"), [4]);
  assert.deepEqual(ids("all", "example.com/3"), [], "a titled article is not found by its address");
  assert.deepEqual(ids("all", "example.com/4"), [4], "an untitled one shows its address, so it is");
});
