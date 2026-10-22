import { test } from "node:test";
import assert from "node:assert/strict";
import { OPEN_ALL, mergeDocs, openDocs, openKey, scopeOf, splitCitations } from "./chat.ts";

test("only validated citation numbers become chips", () => {
  assert.deepEqual(splitCitations("WAL は先に書く[1]。詳細 [2][99]。", new Set([1, 2])), ["WAL は先に書く", { n: 1 }, "。詳細 ", { n: 2 }, "[99]", "。"]);
  assert.deepEqual(splitCitations("配列 a[0] はそのまま", new Set([1])), ["配列 a", "[0]", " はそのまま"]);
});

test("the open articles: saved ones once each, in tab order; unsaved pages and unknown articles left out", () => {
  const titles = new Map([
    [1, "WAL"],
    [2, "MVCC"],
    [3, "Epoll"],
  ]);
  const docs = openDocs(
    [
      { kind: "reader", articleId: 2 },
      { kind: "page", saved: null },
      { kind: "page", saved: 1 },
      { kind: "reader", articleId: 2 },
      { kind: "reader", articleId: 9 },
    ],
    (id) => titles.get(id) ?? null,
  );
  assert.deepEqual(docs, [
    { id: 2, title: "MVCC" },
    { id: 1, title: "WAL" },
  ]);
  assert.deepEqual(
    mergeDocs([
      docs,
      [
        { id: 3, title: "Epoll" },
        { id: 1, title: "WAL" },
      ],
    ]).map((d) => d.id),
    [2, 1, 3],
  );

  assert.deepEqual(scopeOf(OPEN_ALL, null, docs), { kind: "articles", ids: [2, 1] });
  assert.equal(scopeOf(OPEN_ALL, null, []), null, "nothing open: nothing to send");
  assert.deepEqual(scopeOf(openKey(1), null, docs), { kind: "article", id: 1 });
  assert.deepEqual(scopeOf("article", { id: 5 }, docs), { kind: "article", id: 5 });
  assert.equal(scopeOf("article", null, docs), null);
  assert.deepEqual(scopeOf("all", null, []), { kind: "filter", filter: { kind: "all" } });
  assert.deepEqual(scopeOf(JSON.stringify({ kind: "tag", name: "db" }), null, []), { kind: "filter", filter: { kind: "tag", name: "db" } });
});
