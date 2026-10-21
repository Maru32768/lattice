import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeedRow } from "./api.ts";
import { feedUrls, folderTree, moved } from "./feedFolders.ts";

const feed = (id: number, folder_id: number | null, article_count: number) => ({ id, folder_id, article_count }) as FeedRow;

test("folders hold their feeds with summed counts; the rest stay loose", () => {
  const feeds = [feed(1, 7, 10), feed(2, null, 4), feed(3, 7, 5), feed(4, 99, 1)];
  const folders = [{ id: 8, name: "Empty", feeds: 0 }, { id: 7, name: "TechFeed", feeds: 2 }];
  const tree = folderTree(feeds, folders, new Map<number | null, number>([[1, 3], [3, 2], [2, 1], [null, 9]]));
  assert.deepEqual(tree.folders.map((n) => [n.folder.name, n.feeds.map((f) => f.id), n.unread, n.total]), [
    ["Empty", [], 0, 0], ["TechFeed", [1, 3], 5, 15],
  ], "in the user's order");
  assert.deepEqual(tree.loose.map((f) => f.id), [2, 4], "a folder not loaded yet leaves its feeds loose");
});

test("moving a folder swaps it with its neighbour, never past the ends", () => {
  assert.deepEqual(moved([1, 2, 3], 3, -1), [1, 3, 2]);
  assert.deepEqual(moved([1, 2, 3], 1, -1), [1, 2, 3]);
  assert.deepEqual(moved([1, 2, 3], 3, 1), [1, 2, 3]);
});

test("pasted feed URLs: one per line, blanks and repeats dropped", () => {
  assert.deepEqual(feedUrls(" https://a.dev/feed \r\n\nhttps://b.dev/rss\nhttps://a.dev/feed\n"), ["https://a.dev/feed", "https://b.dev/rss"]);
});
