import { test } from "node:test";
import assert from "node:assert/strict";
import { excerpt, highlight, terms } from "./search.ts";

test("highlight is case-insensitive and regex-safe", () => {
  assert.deepEqual(highlight("Use EPOLLET (edge)", terms("epollet (edge")), [
    { mark: false, v: "Use " }, { mark: true, v: "EPOLLET" }, { mark: false, v: " " }, { mark: true, v: "(edge" }, { mark: false, v: ")" },
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
