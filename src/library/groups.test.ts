import { test } from "node:test";
import assert from "node:assert/strict";
import { groupArticles } from "./groups.ts";
import { translatorFor } from "../i18n/index.ts";

const [ja, en] = [translatorFor("ja"), translatorFor("en")];

const a = (id: number, genre: string | null, feed_id: number | null) =>
  ({ id, genre, feed_id, feed_title: feed_id ? `Feed ${feed_id}` : null });
const articles = [a(1, "Linux", 2), a(2, null, 2), a(3, "Database", null), a(4, "Linux", 1), a(5, "Database", 2)];

test("genre mode: by name, unclassified last, order kept within", () => {
  const g = groupArticles(articles, "genre", ja);
  assert.deepEqual(g.map((x) => [x.label, x.articles.map((y) => y.id)]), [
    ["Database", [3, 5]], ["Linux", [1, 4]], ["未分類", [2]],
  ]);
});

test("feed mode: manual first, then feeds, each split by genre", () => {
  const g = groupArticles(articles, "feed", ja);
  assert.deepEqual(g.map((x) => x.label), ["手動追加", "Feed 1", "Feed 2"]);
  assert.deepEqual(g[2].children!.map((x) => [x.label, x.articles.map((y) => y.id)]), [
    ["Database", [5]], ["Linux", [1]], ["未分類", [2]],
  ]);
  assert.deepEqual(groupArticles(articles, "feed", en).map((x) => x.label), ["Added by hand", "Feed 1", "Feed 2"]);
});

test("feed mode follows the user's feed order; a feed not in it goes last", () => {
  const more = [...articles, a(6, null, 3)];
  assert.deepEqual(groupArticles(more, "feed", ja, [2, 1]).map((x) => x.label), ["手動追加", "Feed 2", "Feed 1", "Feed 3"]);
});
