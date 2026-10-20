import { test, expect, list } from "./harness.ts";

async function openShortcuts(page: import("@playwright/test").Page) {
  await page.locator(".nav").getByRole("button", { name: "設定" }).click();
  await page.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: "ショートカット" }).click();
  await expect(page.locator(".stg main h1")).toHaveText("ショートカット");
}

const row = (page: import("@playwright/test").Page, label: string) =>
  page.locator(".stg .set").filter({ has: page.locator(".h").getByText(label, { exact: true }) });

test("a recorded key runs the action, survives a reload, and can be removed", async ({ app }) => {
  await openShortcuts(app);
  const next = row(app, "次の項目へ");
  await next.getByRole("button", { name: "+ キーを追加" }).click();
  await expect(next.getByRole("button", { name: /キーを押してください/ })).toBeVisible();
  await app.keyboard.press("n");
  await expect(next.locator(".kbd.key")).toHaveText(["j×", "↓×", "n×"]);

  await app.keyboard.press("Escape");
  await expect(list(app)).toBeVisible();
  await app.keyboard.press("n");
  await expect(list(app).locator(".row.cur")).toHaveCount(1);

  await app.reload();
  await expect(list(app).locator(".row").first()).toBeVisible();
  await app.keyboard.press("n");
  await expect(list(app).locator(".row.cur")).toHaveCount(1);

  await openShortcuts(app);
  await row(app, "次の項目へ").getByRole("button", { name: "次の項目へから n を外す" }).click();
  await expect(row(app, "次の項目へ").locator(".kbd.key")).toHaveText(["j×", "↓×"]);
  await expect(row(app, "次の項目へ").getByRole("button", { name: "既定に戻す" })).toBeDisabled();
});

test("a key bound to two actions is flagged, and Esc cancels recording", async ({ app }) => {
  await openShortcuts(app);
  const fav = row(app, "お気に入り");
  await fav.getByRole("button", { name: "+ キーを追加" }).click();
  await app.keyboard.press("Escape");
  await expect(fav.getByRole("button", { name: "+ キーを追加" })).toBeVisible();
  await expect(fav.locator(".kbd.key")).toHaveText(["s×"]);

  await fav.getByRole("button", { name: "+ キーを追加" }).click();
  await app.keyboard.press("j");
  await expect(fav.getByRole("note")).toHaveText("j は「次の項目へ」にも割り当てられています");
  await app.getByRole("button", { name: "すべて既定に戻す" }).click();
  await expect(fav.locator(".kbd.key")).toHaveText(["s×"]);
});
