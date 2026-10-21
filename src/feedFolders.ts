// Feed folders (H25) in the sidebar: each folder with its feeds, then the feeds in none.
import type { FeedRow, FolderRow } from "./api.ts";

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
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const out = [...ids];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** The feed URLs in pasted text: one per line, blank lines and repeats skipped. */
export const feedUrls = (text: string) => [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
