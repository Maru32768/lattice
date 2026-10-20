import { test, expect, navItem, list, listCount, callsOf } from "./harness.ts";
import type { Page } from "@playwright/test";
import { ARTICLES, GROUPS } from "./fixtures.ts";

const all = ARTICLES.length;
const [mvcc, rust, empty] = GROUPS;
const members = (id: number) => ARTICLES.filter((a) => a.groups.includes(id));
const nav = (app: Page) => app.locator(".nav");
const picker = (app: Page) => app.getByRole("dialog", { name: "グループ" });

test("a sidebar group is a scope; groups are created, renamed and deleted there (articles stay)", async ({ app }) => {
  await expect(navItem(app, mvcc.name).locator(".n")).toHaveText(String(members(mvcc.id).length));
  await navItem(app, mvcc.name).click();
  await expect(list(app).locator("h1")).toHaveText(mvcc.name);
  await expect(listCount(app)).toHaveText(`${members(mvcc.id).length} / ${members(mvcc.id).length}`);

  await nav(app).getByRole("button", { name: "＋ 新規" }).click();
  const name = nav(app).getByLabel("グループ名");
  await name.fill("論文");
  await name.press("Enter");
  await expect(list(app).locator("h1")).toHaveText("論文");
  await expect(listCount(app)).toHaveText("0 / 0");

  await nav(app).getByRole("button", { name: "論文 の操作" }).click();
  await app.getByRole("menuitem", { name: "名前を変更" }).click();
  await name.fill(rust.name);
  await name.press("Enter");
  await expect(app.getByRole("alert")).toContainText(`グループ「${rust.name}」はすでにあります`);
  await nav(app).getByRole("button", { name: "論文 の操作" }).click();
  await app.getByRole("menuitem", { name: "名前を変更" }).click();
  await name.fill("論文 2026");
  await name.press("Enter");
  await expect(list(app).locator("h1")).toHaveText("論文 2026");

  await navItem(app, mvcc.name).click();
  await nav(app).getByRole("button", { name: `${mvcc.name} の操作` }).click();
  await app.getByRole("menuitem", { name: "削除" }).click();
  const dialog = app.getByRole("alertdialog", { name: `グループ「${mvcc.name}」を削除しますか？` });
  await dialog.getByRole("button", { name: "削除", exact: true }).click();
  await expect(navItem(app, mvcc.name)).toHaveCount(0);
  await expect(list(app).locator("h1")).toHaveText("すべての記事");
  await expect(listCount(app)).toHaveText(`${all} / ${all}`);
});

test("the Reader's group chips: pick a group, create one, remove one", async ({ app }) => {
  const a = members(mvcc.id)[0];
  await list(app).locator(".row", { hasText: a.title! }).click();
  const chips = app.locator(".art-chips");
  await expect(chips.locator(".chip", { hasText: mvcc.name })).toBeVisible();

  await chips.getByRole("button", { name: "＋ グループ" }).click();
  await picker(app).getByRole("button", { name: new RegExp(rust.name) }).click();
  await expect(chips.locator(".chip", { hasText: rust.name })).toBeVisible();
  await expect(navItem(app, rust.name).locator(".n")).toHaveText(String(members(rust.id).length + 1));

  await picker(app).getByRole("textbox").fill("卒論");
  await app.keyboard.press("Enter");
  await expect(chips.locator(".chip", { hasText: "卒論" })).toBeVisible();
  await expect(navItem(app, "卒論").locator(".n")).toHaveText("1");
  await app.keyboard.press("Escape");
  await expect(picker(app)).toBeHidden();

  await chips.getByRole("button", { name: `グループ「${mvcc.name}」から外す` }).click();
  await expect(chips.locator(".chip", { hasText: mvcc.name })).toHaveCount(0);
  await expect.poll(() => callsOf(app, "group_remove")).toEqual([{ id: mvcc.id, articles: [a.id] }]);
});

test("list rows picked with 選択 and Shift+click go into a group together", async ({ app }) => {
  const rows = list(app).locator(".row");
  const ids = await rows.evaluateAll((els) => els.slice(0, 4).map((e) => Number((e as HTMLElement).dataset.id)));
  await list(app).getByRole("button", { name: "選択", exact: true }).click();
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ["Shift"] });
  await rows.nth(1).click();
  await expect(list(app).getByRole("toolbar")).toContainText("2 件を選択");
  await expect(app.locator(".art-title")).toHaveCount(0);

  await list(app).getByRole("button", { name: "グループに追加" }).click();
  await picker(app).getByRole("button", { name: new RegExp(empty.name) }).click();
  await expect.poll(() => callsOf(app, "group_add")).toEqual([{ id: empty.id, articles: [ids[0], ids[2]] }]);
  await expect(navItem(app, empty.name).locator(".n")).toHaveText("2");

  await list(app).getByRole("button", { name: "選択を終了" }).click();
  await rows.nth(3).click({ modifiers: ["Shift"] });
  await expect(list(app).getByRole("toolbar")).toContainText("1 件を選択");
});

test("a group is a facet, a search scope and a chat scope (このグループ)", async ({ app }) => {
  await list(app).getByRole("button", { name: "グループ", exact: true }).click();
  await app.getByRole("dialog", { name: "グループで絞り込む" }).getByRole("button", { name: new RegExp(rust.name) }).click();
  await expect(listCount(app)).toHaveText(`${members(rust.id).length} / ${all}`);
  await app.keyboard.press("Escape");

  await navItem(app, mvcc.name).click();
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const scope = app.getByLabel("質問の範囲");
  const key = JSON.stringify({ kind: "group", id: mvcc.id });
  await expect(scope.locator("option", { hasText: `このグループ: ${mvcc.name}` })).toHaveAttribute("value", key);
  await expect(scope.locator(`optgroup[label="グループ"] option`)).toHaveText(GROUPS.map((g) => `${g.name}（${members(g.id).length}件）`));
  await scope.selectOption({ label: `このグループ: ${mvcc.name}` });
  await app.getByLabel("質問", { exact: true }).fill("MVCC とは？");
  await app.getByRole("button", { name: "送信" }).click();
  await expect.poll(async () => (await callsOf(app, "chat_ask")).map((c) => (c as { scope: unknown }).scope))
    .toEqual([{ kind: "filter", filter: { kind: "group", id: mvcc.id } }]);

  await app.keyboard.press("Control+k");
  await app.keyboard.type("?vacuum");
  await app.keyboard.press("Enter");
  await expect.poll(async () => (await callsOf(app, "search_blocks")).at(-1)).toEqual({ query: "vacuum", filter: { kind: "group", id: mvcc.id } });
});

test("imports land in the chosen groups; the list's group is chosen first", async ({ app }) => {
  await navItem(app, rust.name).click();
  await app.keyboard.press("Control+k");
  await app.keyboard.type(">一括");
  await app.keyboard.press("Enter");
  const field = app.locator(".import-groups");
  await expect(field.getByRole("button")).toHaveText(rust.name);
  await field.getByRole("button").click();
  await picker(app).getByRole("button", { name: new RegExp(rust.name) }).click();
  await picker(app).getByRole("button", { name: new RegExp(empty.name) }).click();
  await app.keyboard.press("Escape");
  await expect(field.getByRole("button")).toHaveText(empty.name);

  const existing = ARTICLES[0].original_url;
  await app.getByRole("textbox", { name: "インポートするテキスト" }).fill(`${existing}\nhttps://example.com/new-post`);
  await app.getByRole("button", { name: "インポート", exact: true }).click();
  await expect(app.getByRole("status")).toContainText("2 件中 1 件");
  const [call] = await callsOf(app, "group_add") as { id: number; articles: number[] }[];
  expect(call.id).toBe(empty.id);
  expect(call.articles[0]).toBe(ARTICLES[0].id);
  expect(call.articles).toHaveLength(2);
  await expect(navItem(app, empty.name).locator(".n")).toHaveText("2");
});

test("the palette opens a group, adds the open article to one, and saves a URL into the list's group", async ({ app }) => {
  await app.keyboard.press("Control+k");
  await app.keyboard.type("グループ rust");
  await app.getByRole("option", { name: `グループ: ${rust.name}` }).click();
  await expect(list(app).locator("h1")).toHaveText(rust.name);

  await list(app).locator(".row").first().click();
  await app.keyboard.press("Control+k");
  await app.keyboard.type("この記事をグループに追加");
  await app.getByRole("option", { name: "この記事をグループに追加…" }).click();
  await expect(picker(app)).toBeVisible();
  await app.keyboard.press("Escape");

  await app.keyboard.press("Control+k");
  await app.keyboard.type("https://example.com/into-group");
  await app.getByRole("option", { name: `Index に追加してグループ「${rust.name}」に入れる` }).click();
  await expect.poll(() => callsOf(app, "group_add")).toHaveLength(1);
  const [call] = await callsOf(app, "group_add") as { id: number; articles: number[] }[];
  expect(call.id).toBe(rust.id);
  await expect(navItem(app, rust.name).locator(".n")).toHaveText(String(members(rust.id).length + 1));
});

test("the JSON export can be limited to a group", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("エクスポート", { exact: true }).click();
  await app.getByLabel("エクスポートする範囲").selectOption({ label: `グループ: ${mvcc.name}` });
  await app.locator(".set", { has: app.getByLabel("エクスポートする範囲") }).getByRole("button", { name: "エクスポート", exact: true }).click();
  await expect.poll(() => callsOf(app, "export_json")).toEqual([{ group: mvcc.id }]);
});
