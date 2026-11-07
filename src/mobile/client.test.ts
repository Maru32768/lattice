import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ArticleRow } from "../bindings";
import { type LocalOp, fragmentOf, newOpId, resultOf, settled, withOps } from "./client.ts";
import { savableUrl } from "./urls.ts";
import { isOldList, visibleArticles } from "./list.ts";
import { articleInHash } from "./route.ts";

test("the token and the library come from the QR code's fragment only", () => {
  assert.deepEqual(fragmentOf("#t=abc&l=lib"), { token: "abc", library: "lib" });
  assert.deepEqual(fragmentOf("#t=abc"), { token: "abc", library: null });
  assert.equal(fragmentOf("#t="), null);
  assert.equal(fragmentOf(""), null);
  assert.equal(fragmentOf("#/a/12"), null);
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

test("an operation leaves the phone once a list shows it, or when it has waited too long", () => {
  const day = 24 * 60 * 60 * 1000;
  const ids = (local: LocalOp[], applied: string[], now: number) => settled(local, applied, now).map((o) => o.id);
  const read = { kind: "set_read", article_id: 1, read: true } as const;
  const [shown, waiting, unsent] = [op("shown", read), op("waiting", read, 1000), op("unsent", read, 1000, false)];
  assert.deepEqual(ids([shown, waiting, unsent], ["shown"], 2000), ["waiting", "unsent"]);
  assert.deepEqual(ids([waiting, unsent], [], 59 * day), ["waiting", "unsent"]);
  assert.deepEqual(ids([waiting, unsent], [], 61 * day), [], "sent later, one could undo what changed on the PC since it applied");
});

test("the phone gives up on an operation before the PC forgets it applied it", () => {
  const core = readFileSync(new URL("../../crates/lattice-core/src/mobile.rs", import.meta.url), "utf8");
  const client = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
  const pc = /KEEP_APPLIED_SECS: i64 = (\d+) \* 24/.exec(core);
  const phone = /KEEP_OPS_MS = (\d+) \* 24/.exec(client);
  assert.ok(pc && phone);
  assert.ok(Number(phone[1]) < Number(pc[1]));
});

test("only Lattice's own answer settles an operation", () => {
  const coded = '{"code":"mobile.badUrl","params":{}}';
  assert.deepEqual(resultOf(200, { status: "applied" }), { status: "done" });
  assert.deepEqual(resultOf(202, { status: "queued" }), { status: "done" });
  assert.deepEqual(resultOf(422, { error: coded }), { status: "rejected", error: coded });
  assert.deepEqual(resultOf(400, { error: coded }), { status: "rejected", error: coded });
  const waits: [number, unknown, string][] = [
    [200, null, "a captive portal's page"],
    [200, { status: "other" }, "not ours"],
    [403, { error: '{"code":"mobile.readOnly","params":{}}' }, "may be restarted with writes on"],
    [403, null, "a proxy's refusal"],
    [401, { error: "unauthorized" }, "the token may be replaced"],
    [413, null, "a proxy's limit"],
    [400, null, "a proxy's error page"],
    [422, { error: "plain text" }, "not in Lattice's form"],
    [500, { error: "internal error" }, "may pass"],
    [502, null, "the tunnel's PC is off"],
  ];
  for (const [status, body, why] of waits) {
    assert.deepEqual(resultOf(status, body), { status: "wait" }, why);
  }
});

test("an address must be one the PC can fetch, before it leaves the box", () => {
  for (const good of ["https://example.com/a", "http://example.com"]) {
    assert.ok(savableUrl(good), good);
  }
  for (const bad of ["example.com/a", "ftp://example.com", "javascript:alert(1)", "https://a b", "https://", `https://${"x".repeat(2048)}`]) {
    assert.ok(!savableUrl(bad), bad);
  }
});

test("an operation's id is what the server takes, without a secure context", () => {
  assert.match(newOpId(), /^[0-9a-f]{32}$/);
  assert.notEqual(newOpId(), newOpId());
});

test("a list says how old it is only when that matters", () => {
  assert.equal(isOldList(1000, 1_100_000), false);
  assert.equal(isOldList(1000, 1_121_000), true);
});

test("the page and the server agree on the documents' format", () => {
  const core = readFileSync(new URL("../../crates/lattice-core/src/mobile.rs", import.meta.url), "utf8");
  const client = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
  assert.equal(/pub const FORMAT: u32 = (\d+);/.exec(core)?.[1], /const FORMAT = (\d+);/.exec(client)?.[1]);
});
