import { test } from "node:test";
import assert from "node:assert/strict";
import { OPEN_ALL, mergeDocs, openDocs, openKey, scopeOf, scopeSections, splitCitations } from "./chat.ts";
import { translatorFor } from "../i18n/index.ts";
import type { FilterGroup } from "../library/scopes.ts";

test("only validated citation numbers become chips", () => {
  assert.deepEqual(splitCitations("WAL は先に書く[1]。詳細 [2][99]。", new Set([1, 2])), ["WAL は先に書く", { n: 1 }, "。詳細 ", { n: 2 }, "[99]", "。"]);
  assert.deepEqual(splitCitations("配列 a[0] はそのまま", new Set([1])), ["配列 a", "[0]", " はそのまま"]);
  // Right after a word it may be an index in code: text, unless the source is cited nowhere else.
  assert.deepEqual(splitCitations("argv[1] を m[2][3] に書く [1][3]。MVCC[2]で読む [2]。", new Set([1, 2, 3])), [
    "argv",
    "[1]",
    " を m",
    "[2]",
    "[3]",
    " に書く ",
    { n: 1 },
    { n: 3 },
    "。MVCC",
    "[2]",
    "で読む ",
    { n: 2 },
    "。",
  ]);
  assert.deepEqual(splitCitations("MVCC[1]で読む", new Set([1])), ["MVCC", { n: 1 }, "で読む"]);
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

test("the scope options: この記事, all open, 全記事 and the list's scope first, then each open article, then the filters", () => {
  const t = translatorFor("ja");
  const groups: FilterGroup[] = [{ label: "タグ", options: [{ key: JSON.stringify({ kind: "tag", name: "db" }), label: "#db(2件)" }] }];
  const group = JSON.stringify({ kind: "group", id: 3 });
  assert.deepEqual(
    scopeSections(
      t,
      { title: "WAL" },
      [
        { id: 2, title: "MVCC" },
        { id: 1, title: "WAL" },
      ],
      { key: group, label: "DB" },
      groups,
    ),
    [
      {
        label: "",
        options: [
          { key: "article", label: "この記事(WAL)", disabled: false },
          { key: OPEN_ALL, label: "開いている記事すべて(2件)", disabled: false },
          { key: "all", label: "全記事" },
          { key: group, label: "このグループ: DB" },
        ],
      },
      {
        label: "開いている記事",
        options: [
          { key: openKey(2), label: "MVCC" },
          { key: openKey(1), label: "WAL" },
        ],
      },
      ...groups,
    ],
  );

  const [first, ...rest] = scopeSections(t, null, [], { key: JSON.stringify({ kind: "unread" }), label: "未読" }, []);
  assert.deepEqual(first.options, [
    { key: "article", label: "この記事(記事を開いていません)", disabled: true },
    { key: OPEN_ALL, label: "開いている記事すべて(0件)", disabled: true },
    { key: "all", label: "全記事" },
    { key: JSON.stringify({ kind: "unread" }), label: "現在の一覧: 未読" },
  ]);
  assert.deepEqual(rest, [], "nothing open: no section for the open articles");
});
