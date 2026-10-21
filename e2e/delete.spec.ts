import { test, expect, list, listCount, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";

test("deleting an article asks first; Esc keeps it, 削除 removes it", async ({ app }) => {
  const a = ARTICLES[1];
  const all = ARTICLES.length;
  await list(app).locator(".row", { hasText: a.title! }).click();
  await expect(app.locator(".art-title")).toHaveText(a.title!);

  const more = app.getByRole("button", { name: /^その他/ });
  const dialog = app.getByRole("alertdialog", { name: "記事を削除しますか？" });
  await more.click();
  await app.getByRole("menuitem", { name: "Index から削除…" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
  await app.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(app.locator(".art-title")).toHaveText(a.title!);
  expect(await callsOf(app, "delete_article")).toEqual([]);

  await more.click();
  await app.getByRole("menuitem", { name: "Index から削除…" }).click();
  await dialog.getByRole("button", { name: "削除", exact: true }).click();
  await expect.poll(() => callsOf(app, "delete_article")).toEqual([{ id: a.id }]);
  await expect(app.getByText("記事を選んでください")).toBeVisible();
  await expect(listCount(app)).toHaveText(`${all - 1} / ${all - 1}`);
  await expect(list(app).locator(".row", { hasText: a.title! })).toHaveCount(0);
});
