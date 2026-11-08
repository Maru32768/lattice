import type { Page } from "@playwright/test";

/** Picks what the phone's list shows (未読, すべての記事, …) in its filter sheet, and closes the sheet. */
export async function showScope(page: Page, name: string) {
  await page.getByRole("button", { name: "絞り込み", exact: true }).click();
  await page.getByRole("dialog").getByRole("region", { name: "表示" }).getByRole("button", { name, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();
}
