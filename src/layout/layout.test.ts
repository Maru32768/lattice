import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_SIZE, activate, activeTab, allTabs, close, closePane, closeWhere, cycle, docOf, dropOn, focus, focusedPane, move, navigated, open, pageByKey, panes, parse, resize, serialize, single, split,
  tabById, type Layout,
} from "./layout.ts";

const reader = (articleId: number) => ({ kind: "reader" as const, articleId });
const page = (url: string) => ({ kind: "page" as const, url });
/** Article ids (or URLs) of the panes' tabs, with the active one starred, in reading order. */
const picture = (l: Layout) =>
  panes(l.root).map((p) => p.tabs.map((t) => `${t.kind === "reader" ? t.articleId : t.url}${t.id === p.active ? "*" : ""}`).join(" "));

test("open: fills the empty pane, then replaces the active tab; a new tab goes right after it", () => {
  let l = open(single(), reader(1));
  assert.deepEqual(picture(l), ["1*"]);
  l = open(l, reader(2));
  assert.deepEqual(picture(l), ["2*"], "the active tab is replaced, not added");
  assert.equal(panes(l.root)[0].tabs[0].id, 2, "the tab keeps its id across the replacement");
  l = open(l, reader(3), "new");
  l = activate(l, 2);
  l = open(l, reader(4), "new");
  assert.deepEqual(picture(l), ["2 4* 3"]);
  const same = open(l, reader(4));
  assert.equal(same, l, "already showing it: unchanged");
  l = open(l, reader(5), "new", undefined, 0);
  assert.deepEqual(picture(l), ["5* 2 4 3"], "a tab dropped from another window takes its slot");
  l = open(l, reader(6), "new", undefined, 99);
  assert.deepEqual(picture(l), ["5 2 4 3 6*"], "a slot past the end appends");
});

test("open: a page in its own tab keeps the webview (same id) and bumps seq; the same URL is a no-op", () => {
  let l = open(single(), page("https://a.example/"));
  const t = activeTab(focusedPane(l))!;
  assert.equal(t.kind, "page");
  assert.equal(t.kind === "page" && t.seq, 1);
  l = open(l, { ...page("https://b.example/"), title: "B", saved: 7 });
  const t2 = activeTab(focusedPane(l))!;
  assert.equal(t2.id, t.id);
  assert.deepEqual(t2.kind === "page" && [t2.seq, t2.title, t2.saved, t2.loading], [2, "B", 7, true]);
  assert.equal(open(l, { ...page("https://b.example/x"), saved: 7 }), l, "redirected: the saved article is the one already shown");
  assert.notEqual(open(l, { ...page("https://b.example/"), focus: "jump" }), l, "a jump inside the page navigates again");
});

test("close: the neighbour becomes active; the last tab removes the pane, except the root", () => {
  let l = open(open(open(single(), reader(1)), reader(2), "new"), reader(3), "new");
  l = activate(l, 3);
  l = close(l, 3);
  assert.deepEqual(picture(l), ["1 3*"], "closing the active tab shows the one after it");
  l = close(l, 4);
  assert.deepEqual(picture(l), ["1*"], "... or the one before");
  l = close(l, 2);
  assert.deepEqual(picture(l), [""], "the root pane stays, empty");
  assert.equal(focusedPane(l).id, 1);
});

test("split and merge: the new pane is empty and focused; same-direction splits become siblings", () => {
  let l = open(single(), reader(1));
  l = split(l, 1, "row");
  const [a, b] = panes(l.root);
  assert.deepEqual(picture(l), ["1*", ""]);
  assert.equal(l.focused, b.id);
  l = open(l, reader(2));
  assert.deepEqual(picture(l), ["1*", "2*"]);
  l = split(l, a.id, "row");
  assert.equal(l.root.kind === "split" && l.root.children.length, 3, "a sibling, not a nested split");
  assert.deepEqual(l.root.kind === "split" && l.root.sizes, [0.25, 0.25, 0.5]);
  l = split(l, b.id, "column");
  const nested = l.root.kind === "split" && l.root.children[2];
  assert.equal(nested && nested.kind === "split" && nested.dir, "column", "a different direction nests");
  assert.equal(panes(l.root).length, 4);

  l = closePane(l, l.focused);
  assert.equal(panes(l.root).length, 3);
  assert.equal(l.root.kind === "split" && l.root.children[2].kind, "pane", "a split left with one child collapses into it");
  assert.equal(l.focused, b.id, "focus moves to the pane that took the place");
  l = closePane(l, a.id);
  l = closePane(l, panes(l.root).find((p) => !p.tabs.length)!.id);
  assert.equal(l.root.kind, "pane");
  assert.deepEqual(picture(l), ["2*"]);
  assert.equal(closePane(l, l.focused), l, "the only pane stays");
  assert.equal(closePane(l, 99), l);
});

test("close of the last tab in a split pane merges the pane away and refocuses", () => {
  let l = open(single(), reader(1));
  l = split(l, 1, "column");
  l = open(l, reader(2));
  l = close(l, tabById(l, 5)!.tab.id);
  assert.equal(l.root.kind, "pane");
  assert.deepEqual(picture(l), ["1*"]);
  assert.equal(l.focused, 1);
});

test("move: within a pane reorders around the gap; across panes shows it there and drops an emptied pane", () => {
  let l = open(open(open(single(), reader(1)), reader(2), "new"), reader(3), "new");
  l = move(l, 3, 1, 3);
  assert.deepEqual(picture(l), ["1 3 2*"]);
  l = move(l, 3, 1, 0);
  assert.deepEqual(picture(l), ["2* 1 3"]);
  l = split(l, 1, "row");
  const right = l.focused;
  l = move(l, 2, right, 0);
  assert.deepEqual(picture(l), ["2* 3", "1*"]);
  assert.equal(l.focused, right);
  l = move(l, 4, right, 1);
  l = move(l, 3, right, 0);
  assert.deepEqual(picture(l), ["2* 1 3"], "the emptied left pane is gone");
  assert.equal(l.root.kind, "pane");
});

test("dropOn: a body's center takes the tab at the end, an edge splits that pane on its side and puts the tab there", () => {
  let l = open(open(open(single(), reader(1)), reader(2), "new"), reader(3), "new");
  const id = (a: number) => allTabs(l).find((t) => t.kind === "reader" && t.articleId === a)!.id;
  const first = panes(l.root)[0].id;
  assert.equal(dropOn(l, id(3), first, "center"), l, "its own pane's center: nothing");
  l = dropOn(l, id(3), first, "right");
  assert.deepEqual(picture(l), ["1* 2", "3*"]);
  assert.equal(l.root.kind === "split" && l.root.dir, "row");
  l = dropOn(l, id(1), l.focused, "center");
  assert.deepEqual(picture(l), ["2*", "3 1*"]);
  l = dropOn(l, id(2), l.focused, "top");
  assert.deepEqual(picture(l), ["2*", "3 1*"], "the emptied pane is gone, the new one above");
  assert.equal(l.root.kind === "split" && l.root.dir, "column");
  l = dropOn(l, id(3), panes(l.root)[1].id, "left");
  assert.deepEqual(picture(l), ["2*", "3*", "1*"]);
  const bottom = l.root.kind === "split" && l.root.children[1];
  assert.equal(bottom && bottom.kind === "split" && bottom.dir, "row", "split off on the left, in its own row");
  assert.equal(focusedPane(l).tabs[0].id, id(3));
  assert.equal(dropOn(l, 99, first, "left"), l, "an unknown tab");

  let m = open(open(open(single(), reader(1)), reader(2), "new"), reader(3), "new");
  m = dropOn(m, 4, 1, "right");
  m = dropOn(m, 3, m.focused, "left");
  assert.deepEqual(picture(m), ["1*", "2*", "3*"]);
  assert.deepEqual(m.root.kind === "split" && m.root.sizes, [0.5, 0.25, 0.25], "split off on the left of a pane in a row: a sibling before it");
});

test("cycle wraps; focus ignores unknown panes", () => {
  let l = open(open(open(single(), reader(1)), reader(2), "new"), reader(3), "new");
  l = cycle(l, 1);
  assert.deepEqual(picture(l), ["1* 2 3"]);
  l = cycle(l, -1);
  assert.deepEqual(picture(l), ["1 2 3*"]);
  assert.equal(focus(l, 42), l);
  assert.equal(cycle(open(single(), reader(1)), 1).focused, 1);
});

test("resize sets a child's fraction, its neighbour takes the rest, and both stop at MIN_SIZE", () => {
  let l = split(open(single(), reader(1)), 1, "row");
  const id = l.root.kind === "split" ? l.root.id : -1;
  const pct = () => l.root.kind === "split" && l.root.sizes.map((s) => Math.round(s * 100));
  l = resize(l, id, 0, 0.7);
  assert.deepEqual(pct(), [70, 30]);
  l = resize(l, id, 0, 1);
  const [lo, hi] = [Math.round(MIN_SIZE * 100), Math.round(100 - MIN_SIZE * 100)];
  assert.deepEqual(pct(), [hi, lo]);
  l = resize(l, id, 0, -5);
  assert.deepEqual(pct(), [lo, hi]);
  assert.deepEqual(resize(l, id, 5, 0.5), l, "no such child");
});

test("navigated keeps the title on the same URL and clears it on another; a Reader tab ignores page events", () => {
  let l = open(single(), { ...page("https://a.example/"), title: "A" });
  l = navigated(l, 2, { url: "https://a.example/", loading: false, canGoBack: false, canGoForward: false });
  assert.equal(activeTab(focusedPane(l))!.kind === "page" && (activeTab(focusedPane(l)) as { title: string }).title, "A");
  l = navigated(l, 2, { url: "https://a.example/next", loading: true, canGoBack: true, canGoForward: false });
  const t = activeTab(focusedPane(l))!;
  assert.deepEqual(t.kind === "page" && [t.title, t.url, t.loading, t.canGoBack], ["", "https://a.example/next", true, true]);
  const r = open(single(), reader(1));
  assert.equal(navigated(r, 2, { url: "x", loading: false, canGoBack: false, canGoForward: false }), r);
});

test("closeWhere drops every tab of a deleted article", () => {
  let l = open(open(single(), reader(1)), reader(2), "new");
  l = split(l, 1, "row");
  l = open(l, reader(1));
  l = closeWhere(l, (t) => t.kind === "reader" && t.articleId === 1);
  assert.deepEqual(picture(l), ["2*"]);
});

test("serialize round-trips the tree, drops runtime page state, and rejects other shapes", () => {
  let l = open(open(single(), reader(1)), { ...page("https://a.example/"), title: "A", saved: 7 }, "new");
  l = split(l, 1, "column");
  l = open(l, reader(3));
  l = navigated(l, 3, { url: "https://a.example/", loading: true, canGoBack: true, canGoForward: true });
  const back = parse(serialize(l))!;
  assert.deepEqual(picture(back), picture(l));
  assert.equal(back.focused, l.focused);
  assert.equal(back.next, l.next);
  const p = tabById(back, 3)!.tab;
  assert.deepEqual(p.kind === "page" && [p.title, p.seq, p.loading, p.saved, p.canGoBack], ["A", 0, false, null, undefined]);
  const before = tabById(l, 3)!.tab;
  assert.equal(p.kind === "page" && before.kind === "page" && p.key, before.kind === "page" && before.key, "the webview key survives a restart");
  const legacy = parse(JSON.stringify({ root: { kind: "pane", id: 1, tabs: [{ kind: "page", id: 2, url: "https://x.example/", title: "" }], active: 2 }, focused: 1 }))!;
  assert.match(pageByKey(legacy, allTabs(legacy).map((t) => (t.kind === "page" ? t.key : ""))[0])!.key, /^[0-9a-z]{6,}$/, "a layout saved before keys gets a fresh one");
  assert.equal(parse("nonsense"), null);
  assert.equal(parse(JSON.stringify({ root: { kind: "pane", id: 1, tabs: [{ kind: "video", id: 2 }] }, focused: 1 })), null);
  const fixed = parse(JSON.stringify({ root: { kind: "pane", id: 1, tabs: [{ kind: "reader", id: 2, articleId: 5 }], active: 99 }, focused: 42 }))!;
  assert.equal(fixed.focused, 1, "an unknown focused pane falls back to the first");
  assert.equal(panes(fixed.root)[0].active, 2, "an unknown active tab falls back to the first");
});

test("a page keeps its webview key when replaced in place, and docOf carries it to another pane or window", () => {
  let l = open(single(), page("https://a.example/"));
  const a = activeTab(focusedPane(l))!;
  l = open(l, page("https://b.example/"));
  const b = activeTab(focusedPane(l))!;
  assert.equal(b.kind === "page" && b.key, a.kind === "page" && a.key, "same tab, same webview");
  l = open(l, page("https://c.example/"), "new");
  const c = activeTab(focusedPane(l))!;
  assert.notEqual(c.kind === "page" && c.key, a.kind === "page" && a.key, "a new tab gets its own webview");
  const moved = open(single(), docOf(c), "new");
  const m = activeTab(focusedPane(moved))!;
  assert.equal(m.kind === "page" && m.key, c.kind === "page" && c.key, "the doc of a page names its webview");
  assert.equal(pageByKey(moved, (c as { key: string }).key)?.id, m.id);
  assert.deepEqual(docOf(tabById(open(single(), reader(4)), 2)!.tab), { kind: "reader", articleId: 4 });
});
