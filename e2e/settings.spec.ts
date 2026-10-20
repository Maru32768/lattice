import { test, expect, navItem } from "./harness.ts";

const SECTIONS = [
  "AI プロバイダ", "翻訳", "要約・対話", "自動分類", "重要度", "ジャンル", "取り込み・JS 描画", "取り込みフィルタ", "画像", "復習", "ショートカット", "ブラウザ", "タスクバー",
  "バックアップ", "クラウドバックアップ（R2）", "エクスポート", "ログ・保存場所",
];

test("every settings section renders, and Esc goes back to the library", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  const heading = app.locator(".stg main h1");
  const section = (title: string) => nav.locator(".ni").filter({ has: app.locator(".label").getByText(title, { exact: true }) });
  for (const title of SECTIONS) {
    await section(title).click();
    await expect(heading).toHaveText(title);
  }
  await section("ログ・保存場所").click();
  await expect(app.locator(".stg main")).toContainText("lattice.db");
  await section("AI プロバイダ").click();
  await expect(section("AI プロバイダ")).toContainText("2 段");

  await app.keyboard.press("Escape");
  await expect(nav).toBeHidden();
  await expect(navItem(app, "すべての記事")).toBeVisible();
});
