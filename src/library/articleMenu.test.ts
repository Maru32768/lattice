import { test } from "node:test";
import assert from "node:assert/strict";
import { articleMenu, type ArticleActions } from "./articleMenu.ts";
import type { ArticleRow } from "../api.ts";
import type { MenuItem } from "../ui/Popover.tsx";
import type { T } from "../i18n/index.ts";

const t = ((k: string) => k) as unknown as T;
const noop = () => {};
const actions: ArticleActions = {
  favorite: noop,
  read: noop,
  group: noop,
  tags: noop,
  relevance: noop,
  difficulty: noop,
  genre: noop,
  genres: ["Database", "Web"],
  openNew: noop,
  popOut: noop,
  page: noop,
  copyUrl: noop,
  remove: noop,
};
const row = (id: number, extra: Partial<ArticleRow> = {}) =>
  ({ id, favorite: false, read_status: "unread", original_url: `https://example.com/${id}`, ...extra }) as ArticleRow;
const labels = (items: (MenuItem | string)[]) => items.map((i) => (typeof i === "string" ? i : i.label));

test("one article gets every action; picked ones only those that apply to all at once", () => {
  assert.deepEqual(labels(articleMenu([row(1)], actions, t)), [
    "articleMenu.favorite",
    "reader.markRead",
    "articleMenu.addToGroup",
    "articleMenu.editTags",
    "-",
    "common.relevance",
    "common.difficulty",
    "common.genre",
    "-",
    "articleMenu.openNewTab",
    "tabStrip.popOut",
    "articleMenu.openPage",
    "articleMenu.copyUrl",
    "-",
    "browserView.remove",
  ]);
  assert.deepEqual(labels(articleMenu([row(1), row(2, { favorite: true })], actions, t)), [
    "articleMenu.picked",
    "articleMenu.favorite",
    "reader.markRead",
    "articleMenu.addToGroup",
    "articleMenu.editTags",
    "-",
    "common.relevance",
    "common.difficulty",
    "common.genre",
  ]);
});

test("importance, difficulty and genre are submenus whose choice is checked only when every article has it", () => {
  const sub = (items: (MenuItem | string)[], label: string) => (items.find((i) => typeof i !== "string" && i.label === label) as MenuItem).items!;
  const checked = (items: (MenuItem | string)[]) => items.filter((i): i is MenuItem => typeof i !== "string" && !!i.checked).map((i) => i.label);
  const a = row(1, { relevance: 5, relevance_manual: true, relevance_ai: 2, difficulty: 3, genre: "Web" });
  const b = row(2, { relevance: 5, relevance_manual: true, relevance_ai: 4, difficulty: 3, genre: "Database" });
  const menu = articleMenu([a, b], actions, t);
  assert.deepEqual(checked(sub(menu, "common.relevance")), ["5 library.relevance5"]);
  assert.deepEqual(checked(sub(menu, "common.difficulty")), ["3 library.difficulty3"]);
  assert.deepEqual(checked(sub(menu, "common.genre")), [], "mixed genres: none checked");
  assert.deepEqual(labels(sub(menu, "common.genre")), ["common.unclassified", "-", "Database", "Web"]);

  let got: [number[], number | null] | null = null;
  const pick = articleMenu([a, b], { ...actions, relevance: (ids, score) => (got = [ids, score]) }, t);
  (sub(pick, "common.relevance")[0] as MenuItem).onSelect();
  assert.deepEqual(got, [[1, 2], null], "the first choice leaves the importance to AI again");
});

test("favorite and read flip only when every article already has them", () => {
  const items = articleMenu([row(1, { favorite: true, read_status: "read" }), row(2, { favorite: true, read_status: "read" })], actions, t);
  assert.deepEqual(labels(items).slice(1, 3), ["articleMenu.unfavorite", "reader.markUnread"]);
  let got: [number[], boolean] | null = null;
  articleMenu([row(1, { favorite: true }), row(2)], { ...actions, favorite: (ids, on) => (got = [ids, on]) }, t)
    .filter((i): i is MenuItem => typeof i !== "string")[0]
    .onSelect();
  assert.deepEqual(got, [[1, 2], true]);
});

test("an imported PDF opens its original in Page, with no URL to copy", () => {
  const items = articleMenu([row(3, { original_url: "local:pdf/abc", pdf: true })], actions, t).filter((i): i is MenuItem => typeof i !== "string");
  assert.deepEqual(
    items.filter((i) => i.disabled).map((i) => i.label),
    ["articleMenu.copyUrl"],
  );
});

test("an imported file has no page and no URL to copy; a pop-out has no new window to offer", () => {
  const local = articleMenu([row(3, { original_url: "local:md/abc" })], { ...actions, popOut: undefined }, t).filter(
    (i): i is MenuItem => typeof i !== "string",
  );
  assert.deepEqual(
    local.filter((i) => i.disabled).map((i) => i.label),
    ["articleMenu.openPage", "articleMenu.copyUrl"],
  );
  assert.equal(
    local.some((i) => i.label === "tabStrip.popOut"),
    false,
  );
});
