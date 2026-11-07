import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArticleRow } from "../bindings";
import { type LocalOp, newOpId, settled, tokenInFragment, withOps } from "./client.ts";
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

const op = (id: string, kind: LocalOp["op"], at = 0, sent = true): LocalOp => ({ id, op: kind, at, sent });

test("a row shows this phone's operations in the order they were done", () => {
  const a = row(1, "A");
  const ops = [
    op("1", { kind: "set_read", article_id: 1, read: true }),
    op("2", { kind: "set_favorite", article_id: 1, favorite: true }),
    op("3", { kind: "set_read", article_id: 1, read: false }),
    op("4", { kind: "set_read", article_id: 2, read: true }),
    op("5", { kind: "save_url", url: "https://example.com/" }),
  ];
  assert.equal(withOps(a, ops.slice(0, 1)).read_status, "read");
  assert.equal(withOps(a, ops).read_status, "unread");
  assert.equal(withOps(a, ops).favorite, true);
  assert.equal(withOps(a, []), a, "nothing to do leaves the same object");
});

test("an operation leaves the phone once a list shows it, or long after the server took it", () => {
  const month = 30 * 24 * 60 * 60 * 1000;
  const shown = op("shown", { kind: "set_read", article_id: 1, read: true });
  const waiting = op("waiting", { kind: "set_read", article_id: 1, read: true }, 1000);
  const old = op("old", { kind: "set_read", article_id: 1, read: true }, 0);
  const unsent = op("unsent", { kind: "set_read", article_id: 1, read: true }, 0, false);
  assert.deepEqual(
    settled([shown, waiting, old, unsent], ["shown"], month + 500).map((o) => o.id),
    ["waiting", "unsent"],
  );
  assert.deepEqual(
    settled([unsent], [], 12 * month).map((o) => o.id),
    ["unsent"],
    "what was never sent stays: nobody else has it",
  );
});

test("an operation's id is what the server takes, without a secure context", () => {
  assert.match(newOpId(), /^[0-9a-f]{32}$/);
  assert.notEqual(newOpId(), newOpId());
});
