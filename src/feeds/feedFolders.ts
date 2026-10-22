// Feed folders (H25) in the sidebar: each folder with its feeds, then the feeds in none.
import { arrayMove } from "@dnd-kit/sortable";
import type { FeedRow, FolderRow } from "../api.ts";

export interface FolderNode {
  folder: FolderRow;
  feeds: FeedRow[];
  unread: number;
  total: number;
}

/** Folders in the user's order, each with its feeds (in the order given) and their summed counts; `loose`: feeds without a folder. */
export function folderTree(feeds: FeedRow[], folders: FolderRow[], unread: ReadonlyMap<number | null, number>): { folders: FolderNode[]; loose: FeedRow[] } {
  const nodes = folders.map((folder): FolderNode => {
    const mine = feeds.filter((f) => f.folder_id === folder.id);
    return { folder, feeds: mine, unread: mine.reduce((n, f) => n + (unread.get(f.id) ?? 0), 0), total: mine.reduce((n, f) => n + f.article_count, 0) };
  });
  const known = new Set(folders.map((f) => f.id));
  return { folders: nodes, loose: feeds.filter((f) => f.folder_id == null || !known.has(f.folder_id)) };
}

const COLLAPSED_KEY = "lattice.feedFolders.collapsed";

/** Folders collapsed in the sidebar, per device. */
export function loadCollapsed(): Set<number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(ids: ReadonlySet<number>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage off: the state lasts until the window closes.
  }
}

/** `ids` with `id` moved one place up (-1) or down (+1); unchanged at either end. */
export function moved(ids: number[], id: number, d: -1 | 1): number[] {
  const i = ids.indexOf(id);
  const j = i + d;
  if (i < 0 || j < 0 || j >= ids.length) {
    return ids;
  }
  return ids.toSpliced(i, 1).toSpliced(j, 0, id);
}

/** One folder's feeds in order (`folder` null: the feeds in none), as `reorder_feeds` takes them (H26). */
export interface FeedOrder {
  folder: number | null;
  ids: number[];
}

/** Every feed group in display order: the folders', then the feeds in none. */
export const feedGroups = ({ folders, loose }: ReturnType<typeof folderTree>): FeedOrder[] => [
  ...folders.map((n) => ({ folder: n.folder.id, ids: n.feeds.map((f) => f.id) })),
  { folder: null, ids: loose.map((f) => f.id) },
];

function placed(o: FeedOrder, feed: number, at: number): FeedOrder {
  const ids = o.ids.filter((id) => id !== feed);
  ids.splice(at, 0, feed);
  return { folder: o.folder, ids };
}

/** Alt+↑ / ↓ on a feed: one place in its folder, and past either end into the next group (last there going up, first going down); null at the very ends. */
export function feedStep(groups: FeedOrder[], feed: number, d: -1 | 1): FeedOrder | null {
  const g = groups.findIndex((o) => o.ids.includes(feed));
  const group = groups[g];
  if (!group) {
    return null;
  }
  const i = group.ids.indexOf(feed) + d;
  if (i >= 0 && i < group.ids.length) {
    return placed(group, feed, i);
  }
  const next = groups[g + d];
  return next ? placed(next, feed, d < 0 ? next.ids.length : 0) : null;
}

/** A row of the sidebar's feed tree as dragged: a folder, a feed, or the drop target after the feeds in none. */
export type NavRow = { kind: "folder"; id: number } | { kind: "feed"; id: number; folder: number | null } | { kind: "loose" };

/**
 * A feed dragged from row `from` onto row `to` of the shown rows: the group it lands in and that
 * group's new order, or null when nothing changes. Onto a feed it takes that feed's slot; onto a
 * folder (or the drop target after the feeds in none) it goes last there. Feeds not shown (a
 * collapsed folder's, the ones past 「すべてのフィード」) keep their place after.
 */
export function feedDrop(rows: NavRow[], groups: FeedOrder[], from: number, to: number): FeedOrder | null {
  const [row, over] = [rows[from], rows[to]];
  if (row?.kind !== "feed" || !over || from === to) {
    return null;
  }
  const folder = over.kind === "folder" ? over.id : over.kind === "loose" ? null : over.folder;
  const group = groups.find((o) => o.folder === folder) ?? { folder, ids: [] };
  const at =
    over.kind === "feed"
      ? arrayMove(rows, from, to)
          .slice(0, to)
          .filter((r) => r.kind === "feed" && r.folder === folder).length
      : group.ids.length;
  const out = placed(group, row.id, at);
  return row.folder === folder && out.ids.every((id, i) => id === group.ids[i]) ? null : out;
}

/** The folder order after a folder is dragged from row `from` to row `to`, or null when it stays. */
export function folderDrop(rows: NavRow[], from: number, to: number): number[] | null {
  if (rows[from]?.kind !== "folder" || from === to) {
    return null;
  }
  const ids = (xs: NavRow[]) => xs.flatMap((r) => (r.kind === "folder" ? [r.id] : []));
  const before = ids(rows);
  const after = ids(arrayMove(rows, from, to));
  return after.every((id, i) => id === before[i]) ? null : after;
}

/** `feeds` with `ids` moved into their folder first, as `reorder_feeds` stores them: shown before the backend answers. */
export function placeFeeds(feeds: FeedRow[], { folder, ids }: FeedOrder): FeedRow[] {
  const moving = ids.flatMap((id) => feeds.filter((f) => f.id === id).map((f) => ({ ...f, folder_id: folder })));
  const rest = feeds.filter((f) => !ids.includes(f.id));
  const at = rest.findIndex((f) => f.folder_id === folder);
  rest.splice(at < 0 ? rest.length : at, 0, ...moving);
  return rest;
}

/** The feed URLs in pasted text: one per line, blank lines and repeats skipped. */
export const feedUrls = (text: string) => [
  ...new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  ),
];
