// The context menu of an article: list rows (one, or the picked ones) and document tabs.
import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const shown = ARTICLES.filter((a) => a.title && a.fetch_status === "ok");
const row = (page: Page, title: string) => list(page).locator(".row", { hasText: title });
const menu = (page: Page) => page.getByRole("menu", { name: "記事のメニュー" });

test("right-click on a row: favorite, read state, a new tab, and delete with confirmation", async ({ app }) => {
  const [a, b] = shown;
  await row(app, a.title!).click({ button: "right" });
  const m = menu(app);
  await expect(m.getByRole("menuitem")).toHaveText([
    a.favorite ? "お気に入りを解除" : "お気に入り",
    a.read_status === "read" ? "未読に戻す" : "既読にする",
    "グループに追加…",
    "タグを編集…",
    "タイトルを変更…",
    "重要度",
    "難易度",
    "ジャンル",
    "新しいタブで開く",
    "別ウィンドウで開く",
    "Pageで開く",
    "URLをコピー",
    "ライブラリから削除…",
  ]);
  await m.getByRole("menuitem", { name: /お気に入り/ }).click();
  await expect(m).toBeHidden();
  expect(await callsOf(app, "set_favorite")).toEqual([{ id: a.id, favorite: !a.favorite }]);

  await row(app, b.title!).click({ button: "right" });
  await menu(app).getByRole("menuitem", { name: "新しいタブで開く" }).click();
  await expect(app.locator(".dpane").first().getByRole("tab")).toHaveCount(1);

  await row(app, a.title!).click({ button: "right" });
  await menu(app).getByRole("menuitem", { name: "ライブラリから削除…" }).click();
  await expect(app.getByRole("alertdialog")).toBeVisible();
  await app.getByRole("alertdialog").getByRole("button", { name: "キャンセル" }).click();
  expect(await callsOf(app, "delete_article")).toEqual([]);
});

test("right-click on a row sets the importance, difficulty and genre from submenus, and edits tags", async ({ app }) => {
  const a = shown.find((x) => x.genre !== "フロントエンド")!;
  const open = async () => {
    await row(app, a.title!).click({ button: "right" });
    return menu(app);
  };
  let m = await open();
  await m.getByRole("menuitem", { name: "重要度" }).hover();
  await app.getByRole("menu", { name: "重要度" }).getByRole("menuitemradio", { name: /^5 / }).click();
  await expect(m).toBeHidden();
  expect((await callsOf(app, "set_relevance")).at(-1)).toEqual({ id: a.id, score: 5 });
  await expect(row(app, a.title!).locator(".imp")).toHaveText("重要5");

  m = await open();
  await m.getByRole("menuitem", { name: "難易度" }).click();
  await app.getByRole("menu", { name: "難易度" }).getByRole("menuitemradio", { name: /^2 / }).click();
  expect((await callsOf(app, "set_difficulty")).at(-1)).toEqual({ id: a.id, level: 2 });

  m = await open();
  await m.getByRole("menuitem", { name: "ジャンル" }).hover();
  await app.getByRole("menu", { name: "ジャンル" }).getByRole("menuitemradio", { name: "フロントエンド" }).click();
  expect((await callsOf(app, "set_genre")).at(-1)).toEqual({ id: a.id, name: "フロントエンド" });

  m = await open();
  await m.getByRole("menuitem", { name: "タグを編集…" }).click();
  const picker = app.getByRole("dialog", { name: "タグ" });
  await picker.getByPlaceholder("タグを検索・追加").fill("from-menu");
  await app.keyboard.press("Enter");
  await expect.poll(async () => (await callsOf(app, "add_tag")).at(-1)).toEqual({ id: a.id, name: "from-menu" });
});

test("タイトルを変更… gives an article a title of its own, and 元に戻す brings back the one Lattice gave it", async ({ app }) => {
  const [a] = shown;
  const open = async (title: string) => {
    await row(app, title).click({ button: "right" });
    await menu(app).getByRole("menuitem", { name: "タイトルを変更…" }).click();
    return app.getByRole("dialog", { name: "記事のタイトル" });
  };
  let box = await open(a.title!);
  const input = box.getByRole("textbox", { name: "記事のタイトル" });
  await expect(input).toHaveValue(a.title!);
  await expect(box.getByRole("button", { name: "元に戻す" })).toHaveCount(0);
  await input.fill("第2部");
  await input.press("Enter");
  await expect(box).toBeHidden();
  expect(await callsOf(app, "set_article_title")).toEqual([{ id: a.id, title: "第2部" }]);

  box = await open("第2部");
  await expect(box.getByText(`元のタイトル: ${a.title}`)).toBeVisible();
  await box.getByRole("button", { name: "元に戻す" }).click();
  await expect(row(app, a.title!)).toBeVisible();
  expect((await callsOf(app, "set_article_title")).at(-1)).toEqual({ id: a.id, title: "" });
});

test("an unchanged title saves nothing, Enter while composing does not save, and 保存 saves", async ({ app }) => {
  const [a] = shown;
  const open = async () => {
    await row(app, a.title!).click({ button: "right" });
    await menu(app).getByRole("menuitem", { name: "タイトルを変更…" }).click();
    return app.getByRole("dialog", { name: "記事のタイトル" });
  };
  let box = await open();
  await box.getByRole("textbox", { name: "記事のタイトル" }).press("Enter");
  await expect(box).toBeHidden();
  box = await open();
  const input = box.getByRole("textbox", { name: "記事のタイトル" });
  await input.fill("第2部");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(box).toBeVisible();
  expect(await callsOf(app, "set_article_title")).toEqual([]);
  await box.getByRole("button", { name: "保存" }).click();
  await expect(box).toBeHidden();
  expect(await callsOf(app, "set_article_title")).toEqual([{ id: a.id, title: "第2部" }]);
});

test("the menu key and Shift+F10 open the cursor row's menu; Esc returns to the row", async ({ app }) => {
  await row(app, shown[0].title!).focus();
  await app.keyboard.press("j");
  const cur = list(app).locator(".row.cur");
  await expect(cur).toBeFocused();
  await app.keyboard.press("Shift+F10");
  await expect(menu(app)).toBeVisible();
  await expect(menu(app).getByRole("menuitem").first()).toBeFocused();
  await app.keyboard.press("Escape");
  await expect(menu(app)).toBeHidden();
  await expect(cur).toBeFocused();
  await app.keyboard.press("ContextMenu");
  await expect(menu(app)).toBeVisible();
});

test("with rows picked, the menu applies the bulk actions to all of them", async ({ app }) => {
  const [a, b] = shown;
  await list(app).getByRole("button", { name: "選択" }).click();
  await row(app, a.title!).click();
  await row(app, b.title!).click();
  await row(app, b.title!).click({ button: "right" });
  const m = menu(app);
  await expect(m).toContainText("2件");
  await expect(m.getByRole("menuitem")).toHaveCount(7);
  await m.getByRole("menuitem", { name: "グループに追加…" }).click();
  await expect(app.getByRole("dialog")).toBeVisible();
  await app.keyboard.press("Escape");

  await row(app, a.title!).click({ button: "right" });
  const read = [a, b].every((x) => x.read_status === "read");
  await menu(app)
    .getByRole("menuitem", { name: read ? "未読に戻す" : "既読にする" })
    .click();
  expect(await callsOf(app, "set_read")).toEqual(
    expect.arrayContaining([
      { id: a.id, read: !read },
      { id: b.id, read: !read },
    ]),
  );
});

test("right-click on a tab: the article's menu; an unsaved page's tab offers what applies to its URL", async ({ app }) => {
  const [a] = shown;
  await row(app, a.title!).click();
  const tab = app.locator(".dpane").first().getByRole("tab").first();
  await tab.click({ button: "right" });
  await expect(menu(app).getByRole("menuitem", { name: "ライブラリから削除…" })).toBeVisible();
  await menu(app).getByRole("menuitem", { name: "新しいタブで開く" }).click();
  await expect(app.locator(".dpane").first().getByRole("tab")).toHaveCount(2);

  await app.evaluate(() => window.__e2e.emit("main-request", { kind: "open", docs: [{ kind: "page", url: "https://example.com/unsaved" }] }));
  const page = app.locator(".dpane").first().getByRole("tab").last();
  await page.click({ button: "right" });
  await expect(menu(app).getByRole("menuitem")).toHaveText(["新しいタブで開く", "別ウィンドウで開く", "URLをコピー"]);
});
