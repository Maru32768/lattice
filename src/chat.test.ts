import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCitations } from "./chat.ts";

test("only validated citation numbers become chips", () => {
  assert.deepEqual(splitCitations("WAL は先に書く[1]。詳細 [2][99]。", new Set([1, 2])), [
    "WAL は先に書く", { n: 1 }, "。詳細 ", { n: 2 }, "[99]", "。",
  ]);
  assert.deepEqual(splitCitations("配列 a[0] はそのまま", new Set([1])), ["配列 a", "[0]", " はそのまま"]);
});
