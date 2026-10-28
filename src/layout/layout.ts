// The document area as a tree: split nodes (direction, children, size fractions) over panes, each
// with an ordered tab list and an active tab. One pane is focused: that is where documents open.
// Every operation is a pure function (Layout, …) => Layout.
import type { Focus } from "../reader/Reader";

export type Id = number;
export type Dir = "row" | "column";
/** Where a tab dropped on a pane's body goes: into the pane, or into a new pane split off on that side. */
export type Zone = "center" | "left" | "right" | "top" | "bottom";

export interface ReaderTab {
  kind: "reader";
  id: Id;
  articleId: number;
  focus?: Focus;
}

export interface PageTab {
  kind: "page";
  id: Id;
  /** Names the tab's native webview (`browser-<key>`); unlike `id`, unique across windows and kept when the tab moves to another. */
  key: string;
  /** Where the page is now: follows the page's own navigations. */
  url: string;
  title: string;
  /** Explicit navigations: bumped so the webview moves even to the URL it already shows. */
  seq: number;
  /** Text of a block to scroll to after load (search-result jumps). */
  focus?: string;
  /** A new tab (the + button): its URL bar starts in edit, the URL selected, so a pasted one replaces it. */
  edit?: boolean;
  loading: boolean;
  /** Unknown (undefined) leaves the toolbar button enabled. */
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** The library article of this URL, when it is in the Index. */
  saved: number | null;
  /** The page overlay's translation while it runs: blocks done of those sent so far. */
  translating?: { done: number; total: number };
}

export type Tab = ReaderTab | PageTab;

/** What to open: a Reader of an article, or a Page of a URL (`key`: the webview of a tab moved from another window). */
export type Doc =
  | { kind: "reader"; articleId: number; focus?: Omit<Focus, "seq"> }
  | { kind: "page"; url: string; focus?: string; title?: string; saved?: number | null; key?: string; edit?: boolean };

/** A fresh webview key: time plus a random tail, in the characters a webview label allows. */
export const newKey = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** The tab as a `Doc` to open elsewhere (another pane or window); a page keeps its webview. */
export const docOf = (t: Tab): Doc =>
  t.kind === "reader" ? { kind: "reader", articleId: t.articleId } : { kind: "page", url: t.url, title: t.title, saved: t.saved, key: t.key };

export interface Pane {
  kind: "pane";
  id: Id;
  tabs: Tab[];
  active: Id | null;
}

export interface Split {
  kind: "split";
  id: Id;
  dir: Dir;
  children: Node[];
  /** Fractions of the split's length, one per child, summing to 1. */
  sizes: number[];
}

export type Node = Pane | Split;

export interface Layout {
  root: Node;
  focused: Id;
  /** Next pane or tab id. */
  next: Id;
}

/** A child of a split is never thinner than this fraction of it. */
export const MIN_SIZE = 0.15;

export const single = (): Layout => ({ root: { kind: "pane", id: 1, tabs: [], active: null }, focused: 1, next: 2 });

// ---- queries ------------------------------------------------------------------------------------

/** The panes, in reading order (left to right, top to bottom). */
export function panes(n: Node): Pane[] {
  return n.kind === "pane" ? [n] : n.children.flatMap(panes);
}

/** The first pane in reading order. */
function firstPane(n: Node): Pane {
  for (let at: Node = n; ;) {
    if (at.kind === "pane") {
      return at;
    }
    const [child] = at.children;
    // `without` collapses a split left with fewer than two children, and parsing refuses one.
    if (!child) {
      throw new Error(`split ${at.id} has no children`);
    }
    at = child;
  }
}

export const paneById = (l: Layout, id: Id) => panes(l.root).find((p) => p.id === id);
export const focusedPane = (l: Layout) => paneById(l, l.focused) ?? firstPane(l.root);
export const activeTab = (p: Pane | undefined) => p?.tabs.find((t) => t.id === p.active);
/** The pane holding tab `id`, and the tab. */
export function tabById(l: Layout, id: Id): { pane: Pane; tab: Tab } | undefined {
  for (const pane of panes(l.root)) {
    const tab = pane.tabs.find((t) => t.id === id);
    if (tab) {
      return { pane, tab };
    }
  }
  return undefined;
}
export const allTabs = (l: Layout) => panes(l.root).flatMap((p) => p.tabs);
/** The page tab whose webview is `key` (how the backend's events name a tab). */
export const pageByKey = (l: Layout, key: string) => allTabs(l).find((t): t is PageTab => t.kind === "page" && t.key === key);

// ---- tree edits ---------------------------------------------------------------------------------

function mapPanes(n: Node, f: (p: Pane) => Pane): Node {
  return n.kind === "pane" ? f(n) : { ...n, children: n.children.map((c) => mapPanes(c, f)) };
}

const replacePane = (l: Layout, p: Pane): Layout => ({ ...l, root: mapPanes(l.root, (x) => (x.id === p.id ? p : x)) });

/** Without pane `id`; a split left with one child becomes that child. The root pane only empties. */
function without(n: Node, id: Id): Node | null {
  if (n.kind === "pane") {
    return n.id === id ? null : n;
  }
  const kept = n.children.map((c, i) => [without(c, id), n.sizes[i]] as const).filter((x): x is [Node, number] => x[0] != null);
  if (kept.length === n.children.length) {
    return kept.every(([c], i) => c === n.children[i]) ? n : { ...n, children: kept.map(([c]) => c) };
  }
  const [first, second] = kept;
  if (first && !second) {
    return first[0];
  }
  const total = kept.reduce((s, [, w]) => s + w, 0);
  return { ...n, children: kept.map(([c]) => c), sizes: kept.map(([, w]) => w / total) };
}

function removePane(l: Layout, id: Id): Layout {
  const before = panes(l.root);
  const i = before.findIndex((p) => p.id === id);
  const root = without(l.root, id) ?? { kind: "pane" as const, id, tabs: [], active: null };
  const after = panes(root);
  const focused = l.focused === id ? (after[Math.min(i, after.length - 1)] ?? firstPane(root)).id : l.focused;
  return { ...l, root, focused };
}

// ---- operations ---------------------------------------------------------------------------------

export const focus = (l: Layout, pane: Id): Layout => (paneById(l, pane) && l.focused !== pane ? { ...l, focused: pane } : l);

function tabFor(doc: Doc, id: Id, prev?: Tab): Tab {
  if (doc.kind === "reader") {
    const seq = (prev?.kind === "reader" ? (prev.focus?.seq ?? 0) : 0) + 1;
    return { kind: "reader", id, articleId: doc.articleId, focus: doc.focus && { ...doc.focus, seq } };
  }
  const seq = (prev?.kind === "page" ? prev.seq : 0) + 1;
  // A page replacing a page keeps the webview; one arriving from another window brings its own.
  const key = prev?.kind === "page" ? prev.key : (doc.key ?? newKey());
  return { kind: "page", id, key, url: doc.url, title: doc.title ?? "", seq, focus: doc.focus, edit: doc.edit, loading: true, saved: doc.saved ?? null };
}

/** True when `t` already shows `doc` and nothing asks to jump inside it. */
function shows(t: Tab, doc: Doc): boolean {
  if (doc.focus) {
    return false;
  }
  if (t.kind === "reader") {
    return doc.kind === "reader" && t.articleId === doc.articleId;
  }
  // Also after a redirect, by the saved article the page turned out to be.
  return doc.kind === "page" && (t.url === doc.url || (doc.saved != null && t.saved === doc.saved));
}

/**
 * Opens `doc` in the focused pane: in its active tab (or a new one when `where` is "new" or the
 * pane is empty). In another pane when `pane` is given. A new tab goes right after the active one,
 * or at `index` (a tab dropped from another window).
 */
export function open(l: Layout, doc: Doc, where: "active" | "new" = "active", pane = l.focused, index?: number): Layout {
  const p = paneById(l, pane) ?? focusedPane(l);
  const cur = activeTab(p);
  if (cur && where === "active") {
    if (shows(cur, doc)) {
      return focus(l, p.id);
    }
    const tab = tabFor(doc, cur.id, cur);
    return focus(replacePane(l, { ...p, tabs: p.tabs.map((t) => (t.id === cur.id ? tab : t)) }), p.id);
  }
  const tab = tabFor(doc, l.next);
  const at = index ?? (cur ? p.tabs.indexOf(cur) + 1 : p.tabs.length);
  return focus({ ...replacePane(l, { ...p, tabs: p.tabs.toSpliced(at, 0, tab), active: tab.id }), next: l.next + 1 }, p.id);
}

export function activate(l: Layout, tab: Id): Layout {
  const hit = tabById(l, tab);
  if (!hit) {
    return l;
  }
  return focus(replacePane(l, { ...hit.pane, active: tab }), hit.pane.id);
}

/** The focused pane's active tab moves `d` along the strip, wrapping. */
export function cycle(l: Layout, d: 1 | -1): Layout {
  const p = focusedPane(l);
  const n = p.tabs.length;
  if (n < 2) {
    return l;
  }
  const i = p.tabs.findIndex((t) => t.id === p.active);
  const next = p.tabs[(i + d + n) % n];
  return next ? activate(l, next.id) : l;
}

export function close(l: Layout, tab: Id): Layout {
  const hit = tabById(l, tab);
  if (!hit) {
    return l;
  }
  const { pane } = hit;
  const i = pane.tabs.findIndex((t) => t.id === tab);
  const tabs = pane.tabs.toSpliced(i, 1);
  if (tabs.length === 0) {
    return removePane(l, pane.id);
  }
  const active = pane.active === tab ? ((tabs[i] ?? tabs[i - 1])?.id ?? null) : pane.active;
  return replacePane(l, { ...pane, tabs, active });
}

/** Closes every tab `pred` accepts (an article that was deleted, …). */
export function closeWhere(l: Layout, pred: (t: Tab) => boolean): Layout {
  return allTabs(l)
    .filter(pred)
    .reduce((acc, t) => close(acc, t.id), l);
}

/** Moves a tab to position `index` of pane `to` (its own pane included) and shows it there. */
export function move(l: Layout, tab: Id, to: Id, index: number): Layout {
  const hit = tabById(l, tab);
  const target = paneById(l, to);
  if (!hit || !target) {
    return l;
  }
  const from = hit.pane;
  if (from.id === to) {
    const i = from.tabs.indexOf(hit.tab);
    const at = index > i ? index - 1 : index;
    return activate(replacePane(l, { ...from, tabs: from.tabs.toSpliced(i, 1).toSpliced(at, 0, hit.tab) }), tab);
  }
  let out = replacePane(l, { ...target, tabs: target.tabs.toSpliced(index, 0, hit.tab), active: tab });
  const rest = from.tabs.filter((t) => t.id !== tab);
  const [first] = rest;
  out = first ? replacePane(out, { ...from, tabs: rest, active: from.active === tab ? first.id : from.active }) : removePane(out, from.id);
  return focus(out, to);
}

/** Splits pane `id` along `dir`; the new, empty pane takes half (after it, or `before`) and the focus. */
export function split(l: Layout, id: Id, dir: Dir, before = false): Layout {
  const fresh: Pane = { kind: "pane", id: l.next, tabs: [], active: null };
  const rec = (n: Node): Node => {
    if (n.kind === "pane") {
      return n.id !== id ? n : { kind: "split", id: l.next + 1, dir, children: before ? [fresh, n] : [n, fresh], sizes: [0.5, 0.5] };
    }
    const i = n.children.findIndex((c) => c.kind === "pane" && c.id === id);
    // Same direction as the parent: a sibling, not a nested split.
    if (i >= 0 && n.dir === dir) {
      const half = (n.sizes[i] ?? 1 / n.children.length) / 2;
      return { ...n, children: n.children.toSpliced(before ? i : i + 1, 0, fresh), sizes: n.sizes.toSpliced(i, 1, half, half) };
    }
    return { ...n, children: n.children.map(rec) };
  };
  if (!paneById(l, id)) {
    return l;
  }
  return { root: rec(l.root), focused: fresh.id, next: l.next + 2 };
}

/** Tab `tab` dropped on pane `pane`'s body: its center moves the tab to the end of that pane (its own pane: nothing), an edge into a new pane split off on that side. */
export function dropOn(l: Layout, tab: Id, pane: Id, zone: Zone): Layout {
  const target = paneById(l, pane);
  if (!target || !tabById(l, tab)) {
    return l;
  }
  if (zone === "center") {
    return target.tabs.some((t) => t.id === tab) ? l : move(l, tab, pane, target.tabs.length);
  }
  const s = split(l, pane, zone === "left" || zone === "right" ? "row" : "column", zone === "left" || zone === "top");
  return move(s, tab, s.focused, 0);
}

/** The only pane stays: closing it would close every tab, which Ctrl+W does one at a time. */
export const closePane = (l: Layout, id: Id): Layout => (paneById(l, id) && l.root.kind === "split" ? removePane(l, id) : l);

/** Sets child `i` of a split to `size` (a fraction of the split); child `i + 1` takes the difference, both within MIN_SIZE. */
export function resize(l: Layout, splitId: Id, i: number, size: number): Layout {
  const rec = (n: Node): Node => {
    if (n.kind === "pane") {
      return n;
    }
    if (n.id !== splitId) {
      return { ...n, children: n.children.map(rec) };
    }
    const [a, b] = [n.sizes[i], n.sizes[i + 1]];
    if (a == null || b == null) {
      return n;
    }
    const next = Math.max(MIN_SIZE, Math.min(a + b - MIN_SIZE, size));
    return { ...n, sizes: n.sizes.toSpliced(i, 2, next, a + b - next) };
  };
  return { ...l, root: rec(l.root) };
}

/** Changes a page tab (a navigation, a title, the Index state); nothing when the tab is gone or a Reader now. */
export function update(l: Layout, tab: Id, patch: Partial<Omit<PageTab, "kind" | "id">>): Layout {
  const hit = tabById(l, tab);
  if (hit?.tab.kind !== "page") {
    return l;
  }
  return replacePane(l, { ...hit.pane, tabs: hit.pane.tabs.map((t) => (t.id === tab && t.kind === "page" ? { ...t, ...patch } : t)) });
}

/** The page reported where it is: a new URL drops the old title until the page sets its own. */
export function navigated(l: Layout, tab: Id, e: { url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }): Layout {
  const t = tabById(l, tab)?.tab;
  if (t?.kind !== "page") {
    return l;
  }
  return update(l, tab, { ...e, title: t.url === e.url ? t.title : "", translating: t.url === e.url ? t.translating : undefined });
}

// ---- persistence --------------------------------------------------------------------------------

/** The main window's layout; a pop-out's lives under its own key (`windows.ts`). */
export const LAYOUT_KEY = "lattice.layout";

type Stored = { root: unknown; focused: unknown };

function strip(n: Node): unknown {
  if (n.kind === "split") {
    return { kind: "split", id: n.id, dir: n.dir, children: n.children.map(strip), sizes: n.sizes };
  }
  return {
    kind: "pane",
    id: n.id,
    active: n.active,
    tabs: n.tabs.map((t) =>
      t.kind === "reader" ? { kind: "reader", id: t.id, articleId: t.articleId } : { kind: "page", id: t.id, key: t.key, url: t.url, title: t.title },
    ),
  };
}

export const serialize = (l: Layout): string => JSON.stringify({ root: strip(l.root), focused: l.focused } satisfies Stored);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** `ids` collects every id seen, for the counter. Null when the shape is not one this version wrote. */
function parseNode(v: unknown, ids: number[]): Node | null {
  if (typeof v !== "object" || v === null) {
    return null;
  }
  const o = v as Record<string, unknown>;
  if (!isNum(o.id)) {
    return null;
  }
  ids.push(o.id);
  if (o.kind === "split") {
    if (!Array.isArray(o.children) || !Array.isArray(o.sizes) || o.children.length < 2 || o.sizes.length !== o.children.length) {
      return null;
    }
    const sizes = o.sizes.filter(isNum);
    if ((o.dir !== "row" && o.dir !== "column") || sizes.length !== o.children.length) {
      return null;
    }
    const children = o.children.map((c) => parseNode(c, ids)).filter((c) => c != null);
    if (children.length !== o.children.length) {
      return null;
    }
    const total = sizes.reduce((s, x) => s + x, 0);
    return { kind: "split", id: o.id, dir: o.dir, children, sizes: sizes.map((x) => x / total) };
  }
  if (o.kind !== "pane" || !Array.isArray(o.tabs)) {
    return null;
  }
  const tabs: Tab[] = [];
  for (const t of o.tabs as Record<string, unknown>[]) {
    if (!isNum(t?.id)) {
      return null;
    }
    ids.push(t.id);
    if (t.kind === "reader" && isNum(t.articleId)) {
      tabs.push({ kind: "reader", id: t.id, articleId: t.articleId });
    }
    // Layouts written before G52 have no key: the tab gets a fresh webview, as a restored tab does anyway.
    else if (t.kind === "page" && isStr(t.url)) {
      tabs.push({
        kind: "page",
        id: t.id,
        key: isStr(t.key) ? t.key : newKey(),
        url: t.url,
        title: isStr(t.title) ? t.title : "",
        seq: 0,
        loading: false,
        saved: null,
      });
    } else {
      return null;
    }
  }
  const active = isNum(o.active) && tabs.some((t) => t.id === o.active) ? o.active : (tabs[0]?.id ?? null);
  return { kind: "pane", id: o.id, tabs, active };
}

export function parse(json: string): Layout | null {
  try {
    const s = JSON.parse(json) as Stored;
    const ids: number[] = [];
    const root = parseNode(s.root, ids);
    if (!root) {
      return null;
    }
    const all = panes(root);
    const f = s.focused;
    const focused = isNum(f) && all.some((p) => p.id === f) ? f : firstPane(root).id;
    return { root, focused, next: Math.max(0, ...ids) + 1 };
  } catch {
    return null;
  }
}

export function load(key = LAYOUT_KEY): Layout {
  try {
    return parse(localStorage.getItem(key) ?? "") ?? single();
  } catch {
    return single();
  }
}

/** What each key last held: transient page state (loading, translating progress) changes the layout, not what is saved. */
const written = new Map<string, string>();

export function save(l: Layout, key = LAYOUT_KEY) {
  const s = serialize(l);
  if (written.get(key) === s) {
    return;
  }
  written.set(key, s);
  try {
    localStorage.setItem(key, s);
  } catch {
    // Blocked storage: the layout lasts for this session only.
  }
}
