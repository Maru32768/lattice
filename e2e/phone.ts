import { expect, type Page } from "@playwright/test";

/** Picks what the phone's list shows (未読, すべての記事, …) in its filter sheet, and closes the sheet. */
export async function showScope(page: Page, name: string) {
  await page.getByRole("button", { name: "絞り込み", exact: true }).click();
  await page.getByRole("dialog").getByRole("region", { name: "表示" }).getByRole("button", { name, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();
}

/** Picks an item of the ⋯ menu in the bar. */
export async function pickInMenu(page: Page, name: string) {
  await page.getByRole("button", { name: "メニュー" }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

/** Expects the ⋯ menu in the bar to offer an item, and closes the menu again. */
export async function expectInMenu(page: Page, name: string, message?: string) {
  await page.getByRole("button", { name: "メニュー" }).click();
  await expect(page.getByRole("menuitem", { name, exact: true }), message).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
}
