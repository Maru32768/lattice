import { test, expect } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";

test("the empty library explains AI defaults and data sharing, and opens provider settings", async ({ app }) => {
  await app.evaluate(
    async (ids) => {
      for (const id of ids) {
        await window.__e2e.deleteArticle(id);
      }
      await window.__e2e.emit("article-changed", 0);
    },
    ARTICLES.map((article) => article.id),
  );
  const firstRun = app.getByRole("region", { name: "最初の記事を入れる" });
  await expect(firstRun).toBeVisible();
  await expect(firstRun).toContainText("記事の保存・閲覧・全文検索は、AI を設定せずに使えます。");
  await expect(firstRun).toContainText("Claude CLI をインストールしてログイン");
  await expect(firstRun).toContainText("自動分類を含む AI 機能は、記事の本文を設定した AI プロバイダに送信します。");
  await firstRun.getByRole("button", { name: "URL を貼る" }).click();
  await expect(app.getByRole("dialog", { name: "コマンドパレット" })).toBeVisible();
  await app.keyboard.press("Escape");
  await firstRun.getByRole("button", { name: "AI プロバイダの設定", exact: true }).click();
  await expect(app.locator(".stg main h1")).toHaveText("AI プロバイダ");
});
