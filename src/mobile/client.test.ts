import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ArticleRow } from "../bindings";
import { type LocalOp, fragmentOf, inboxWaits, newOpId, resultOf, settled, settledByPc, withOps } from "./client.ts";
import { savableUrl } from "./urls.ts";
import { FIRST_VIEW, type ListScope, type ListView, isOldList, options, visibleArticles } from "./list.ts";
import { NO_FACETS, NO_KEPT, keep, viewKey, type Facets } from "../library/library.ts";
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
  ({
    id,
    title,
    original_url: `https://example.com/${id}`,
    domain: "example.com",
    read_status: "unread",
    favorite: false,
    tags: [],
    groups: [],
    genre: null,
    feed_id: null,
    difficulty: null,
    relevance: null,
    saved_at: "2026-11-01T00:00:00Z",
    ...more,
  }) as ArticleRow;

test("a view lists by scope and by title or site, without regard to case", () => {
  const articles = [
    row(1, "Rust Notes"),
    row(2, "Go Notes", { read_status: "read" }),
    row(3, "Zig", { read_status: "read", favorite: true }),
    row(4, null, { domain: "other.org" }),
  ];
  const ids = (kind: ListScope["kind"], query = "") => visibleArticles(articles, { ...FIRST_VIEW, scope: { kind }, query }).rows.map((a) => a.id);
  assert.deepEqual(ids("unread"), [1, 4]);
  assert.deepEqual(ids("all"), [1, 2, 3, 4]);
  assert.deepEqual(ids("favorites"), [3]);
  assert.deepEqual(ids("all", " NOTES "), [1, 2]);
  assert.deepEqual(ids("all", "other.org"), [4]);
  assert.deepEqual(ids("all", "example.com/3"), [], "a titled article is not found by its address");
  assert.deepEqual(ids("all", "example.com/4"), [4], "an untitled one shows its address, so it is");
  const named = [row(5, "Post", { feed_title: "Rust Blog" }), row(6, "Post", { site_name: "はてなブログ" })];
  const find = (q: string) => visibleArticles(named, { ...FIRST_VIEW, scope: { kind: "all" }, query: q }).rows.map((a) => a.id);
  assert.deepEqual(find("rust blog"), [5], "the site as the row names it");
  assert.deepEqual(find("はてな"), [6]);
});

test("the filter narrows as the PC's does, and counts what each choice would leave", () => {
  const articles = [
    row(1, "A", { genre: "DB", tags: ["sql", "mvcc"] }),
    row(2, "B", { genre: "DB", tags: ["sql"], read_status: "read" }),
    row(3, "C", { genre: "Web", tags: ["css"], difficulty: 2 }),
  ];
  const view = (facets: Partial<Facets>, kept = NO_KEPT): ListView => ({ ...FIRST_VIEW, scope: { kind: "all" }, facets: { ...NO_FACETS, ...facets }, kept });
  const ids = (v: ListView) => visibleArticles(articles, v).rows.map((a) => a.id);
  assert.deepEqual(ids(view({ genres: ["DB"] })), [1, 2]);
  assert.deepEqual(ids(view({ genres: ["DB"], tags: ["sql", "mvcc"] })), [1], "tags: all of them");
  assert.deepEqual(ids(view({ tags: ["mvcc", "css"], tagMode: "any" })), [1, 3]);
  assert.deepEqual(ids(view({ difficulty: [null] })), [1, 2], "未判定 is a value of its own");
  const genres = options("genres", visibleArticles(articles, view({ genres: ["Web"] })).base, articles, view({ genres: ["Web"] }).facets);
  assert.deepEqual(
    genres,
    [
      { v: "DB", count: 2 },
      { v: "Web", count: 1 },
    ],
    "a dimension's own choice does not narrow its counts",
  );
  const opened = { ...FIRST_VIEW, kept: keep(NO_KEPT, viewKey(FIRST_VIEW.scope, FIRST_VIEW.facets), 1) };
  const read = articles.map((a) => (a.id === 1 ? { ...a, read_status: "read" as const } : a));
  assert.deepEqual(
    visibleArticles(read, opened).rows.map((a) => a.id),
    [1, 3],
    "an article read from 未読 stays in it",
  );
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
  assert.deepEqual(resultOf(200, { status: "applied" }), { status: "done", queued: false });
  assert.deepEqual(resultOf(202, { status: "queued" }), { status: "done", queued: true });
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

test("while one waits in the inbox, the next must follow it there", () => {
  const read = { kind: "set_read", article_id: 1, read: true } as const;
  const direct = op("direct", read);
  const queued = { ...op("queued", read), queued: true };
  assert.equal(inboxWaits([direct], new Set()), false);
  assert.equal(inboxWaits([direct, queued], new Set()), true);
  assert.equal(inboxWaits([direct, queued], new Set(["queued"])), false, "the PC has it: nothing to overtake");
});

test("the page and the server agree on the documents' format", () => {
  const core = readFileSync(new URL("../../crates/lattice-core/src/mobile.rs", import.meta.url), "utf8");
  const client = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
  assert.equal(/pub const FORMAT: u32 = (\d+);/.exec(core)?.[1], /const FORMAT = (\d+);/.exec(client)?.[1]);
});

test("the PC's list settles only what the snapshot, made since, shows too", () => {
  const read = { kind: "set_read", article_id: 1, read: true } as const;
  const minute = 60 * 1000;
  const at = 1_000 * minute;
  const local = [op("shown", read, at), op("not shown", read, at)];
  const ids = (snapshotAt: number | null) => settledByPc(local, ["shown"], snapshotAt).map((o) => o.id);
  assert.deepEqual(ids(null), ["shown", "not shown"], "no snapshot at all");
  assert.deepEqual(ids((at - minute) / 1000), ["shown", "not shown"], "made before the operation");
  assert.deepEqual(ids((at + 3 * minute) / 1000), ["shown", "not shown"], "within the clocks' difference");
  assert.deepEqual(ids((at + 10 * minute) / 1000), ["not shown"]);
  const madeOffline = [{ ...op("shown", read, at), sentAt: at + 60 * minute }];
  assert.deepEqual(
    settledByPc(madeOffline, ["shown"], (at + 30 * minute) / 1000).map((o) => o.id),
    ["shown"],
    "made offline, sent after that snapshot: it is not in it",
  );
});
