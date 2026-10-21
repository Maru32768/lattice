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
    a.favorite ? "お気に入りを解除" : "お気に入り", a.read_status === "read" ? "未読に戻す" : "既読にする", "グループに追加…",
    "新しいタブで開く", "別ウィンドウで開く", "Page で開く", "URL をコピー", "Index から削除…",
  ]);
  await m.getByRole("menuitem", { name: /お気に入り/ }).click();
  await expect(m).toBeHidden();
  expect(await callsOf(app, "set_favorite")).toEqual([{ id: a.id, favorite: !a.favorite }]);

  await row(app, b.title!).click({ button: "right" });
  await menu(app).getByRole("menuitem", { name: "新しいタブで開く" }).click();
  await expect(app.locator(".dpane").first().getByRole("tab")).toHaveCount(1);

  await row(app, a.title!).click({ button: "right" });
  await menu(app).getByRole("menuitem", { name: "Index から削除…" }).click();
  await expect(app.getByRole("alertdialog")).toBeVisible();
  await app.getByRole("alertdialog").getByRole("button", { name: "キャンセル" }).click();
  expect(await callsOf(app, "delete_article")).toEqual([]);
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
  await expect(m).toContainText("2 件");
  await expect(m.getByRole("menuitem")).toHaveCount(3);
  await m.getByRole("menuitem", { name: "グループに追加…" }).click();
  await expect(app.getByRole("dialog")).toBeVisible();
  await app.keyboard.press("Escape");

  await row(app, a.title!).click({ button: "right" });
  const read = [a, b].every((x) => x.read_status === "read");
  await menu(app).getByRole("menuitem", { name: read ? "未読に戻す" : "既読にする" }).click();
  expect(await callsOf(app, "set_read")).toEqual(expect.arrayContaining([{ id: a.id, read: !read }, { id: b.id, read: !read }]));
});

test("right-click on a tab: the article's menu; an unsaved page's tab offers what applies to its URL", async ({ app }) => {
  const [a] = shown;
  await row(app, a.title!).click();
  const tab = app.locator(".dpane").first().getByRole("tab").first();
  await tab.click({ button: "right" });
  await expect(menu(app).getByRole("menuitem", { name: "Index から削除…" })).toBeVisible();
  await menu(app).getByRole("menuitem", { name: "新しいタブで開く" }).click();
  await expect(app.locator(".dpane").first().getByRole("tab")).toHaveCount(2);

  await app.evaluate(() => window.__e2e.emit("main-request", { kind: "open", docs: [{ kind: "page", url: "https://example.com/unsaved" }] }));
  const page = app.locator(".dpane").first().getByRole("tab").last();
  await page.click({ button: "right" });
  await expect(menu(app).getByRole("menuitem")).toHaveText(["新しいタブで開く", "別ウィンドウで開く", "URL をコピー"]);
});
