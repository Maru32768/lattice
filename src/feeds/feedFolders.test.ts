import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeedRow } from "../api.ts";
import { feedDrop, feedGroups, feedStep, feedUrls, folderDrop, folderTree, moved, placeFeeds, type FeedOrder, type NavRow } from "./feedFolders.ts";

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

// Folder 7 holds feeds 1 and 3, folder 8 is collapsed with feed 5; 2, 4 and 6 are in none.
const groups: FeedOrder[] = [{ folder: 7, ids: [1, 3] }, { folder: 8, ids: [5] }, { folder: null, ids: [2, 4, 6] }];
const rows: NavRow[] = [
  { kind: "folder", id: 7 }, { kind: "feed", id: 1, folder: 7 }, { kind: "feed", id: 3, folder: 7 },
  { kind: "folder", id: 8 },
  { kind: "feed", id: 2, folder: null }, { kind: "feed", id: 4, folder: null },
];

test("feed groups: the folders' feeds in order, then the feeds in none", () => {
  const tree = folderTree([feed(1, 7, 0), feed(2, null, 0), feed(3, 7, 0)], [{ id: 7, name: "T", feeds: 2 }], new Map());
  assert.deepEqual(feedGroups(tree), [{ folder: 7, ids: [1, 3] }, { folder: null, ids: [2] }]);
});

test("Alt+arrows step a feed one place, across into the neighbouring folder at either end", () => {
  assert.deepEqual(feedStep(groups, 3, -1), { folder: 7, ids: [3, 1] });
  assert.deepEqual(feedStep(groups, 1, 1), { folder: 7, ids: [3, 1] });
  assert.deepEqual(feedStep(groups, 3, 1), { folder: 8, ids: [3, 5] }, "first in the next folder");
  assert.deepEqual(feedStep(groups, 2, -1), { folder: 8, ids: [5, 2] }, "last in the previous folder");
  assert.equal(feedStep(groups, 1, -1), null);
  assert.equal(feedStep(groups, 6, 1), null);
  assert.equal(feedStep(groups, 99, 1), null);
});

test("dropping a feed: onto a feed it takes that slot, onto a folder it goes last there", () => {
  assert.deepEqual(feedDrop(rows, groups, 2, 1), { folder: 7, ids: [3, 1] }, "reordered in its folder");
  assert.deepEqual(feedDrop(rows, groups, 5, 1), { folder: 7, ids: [4, 1, 3] }, "moving up onto a folder's first feed: first there");
  assert.deepEqual(feedDrop(rows, groups, 1, 4), { folder: null, ids: [2, 1, 4, 6] }, "moving down onto a feed in none: after it");
  assert.deepEqual(feedDrop(rows, groups, 1, 5), { folder: null, ids: [2, 4, 1, 6] }, "the hidden feeds in none keep their place after");
  assert.deepEqual(feedDrop(rows, groups, 5, 3), { folder: 8, ids: [5, 4] }, "onto a collapsed folder: last in it");
  assert.deepEqual(feedDrop(rows, groups, 4, 0), { folder: 7, ids: [1, 3, 2] }, "onto an open folder: last in it");
  assert.equal(feedDrop(rows, groups, 2, 0), null, "already last in that folder");
  assert.deepEqual(feedDrop([...rows.slice(0, 4), { kind: "loose" }], [...groups.slice(0, 2), { folder: null, ids: [] }], 1, 4), { folder: null, ids: [1] }, "onto the drop target when no feed is in none");
  assert.equal(feedDrop(rows, groups, 1, 1), null);
  assert.equal(feedDrop(rows, groups, 0, 2), null, "a folder is not a feed");
});

test("dropping a folder reorders the folders; its feeds follow it", () => {
  assert.deepEqual(folderDrop(rows, 3, 0), [8, 7]);
  assert.deepEqual(folderDrop(rows, 0, 5), [8, 7], "dropped among the feeds in none: after the last folder");
  assert.equal(folderDrop(rows, 0, 2), null, "still the first folder");
  assert.equal(folderDrop(rows, 1, 0), null);
});

test("placing feeds shows a move before the backend answers", () => {
  const feeds = [feed(1, 7, 0), feed(3, 7, 0), feed(2, null, 0), feed(4, null, 0)];
  const ids = (fs: { id: number; folder_id: number | null }[]) => fs.map((f) => [f.id, f.folder_id]);
  assert.deepEqual(ids(placeFeeds(feeds, { folder: 7, ids: [3, 4] })), [[3, 7], [4, 7], [1, 7], [2, null]]);
  assert.deepEqual(ids(placeFeeds(feeds, { folder: 9, ids: [1] })), [[3, 7], [2, null], [4, null], [1, 9]], "a folder with no feeds yet");
});
