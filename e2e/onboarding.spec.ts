import { test, expect, callsOf, list } from "./harness.ts";
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
  await expect(firstRun).toContainText("記事の保存・閲覧・全文検索は、AIを設定せずに使えます。");
  await expect(firstRun).toContainText("Claude CLIをインストールしてログイン");
  await expect(firstRun).toContainText("自動分類を含むAI機能は、記事の本文を設定したAIプロバイダに送信します。");
  await firstRun.getByRole("button", { name: "URLを貼る" }).click();
  await expect(app.getByRole("dialog", { name: "コマンドパレット" })).toBeVisible();
  await app.keyboard.press("Escape");
  await firstRun.getByRole("button", { name: "AIプロバイダの設定", exact: true }).click();
  await expect(app.locator(".stg main h1")).toHaveText("AIプロバイダ");
});

test("a library read overtaken by a later one does not show the first run over the library", async ({ shell }) => {
  await shell.addInitScript(() => {
    window.__e2eHold = ["list_articles"];
  });
  await shell.goto("/");
  const reads = async () => (await callsOf(shell, "list_articles")).length;
  await expect.poll(reads, { timeout: 30_000 }).toBeGreaterThan(0);
  const first = await reads();
  await shell.evaluate(() => window.__e2e.emit("article-changed", 1));
  await expect.poll(reads).toBeGreaterThan(first);
  await shell.evaluate((n) => window.__e2e.release("list_articles", n), first);
  await shell.waitForTimeout(300);
  const firstRun = shell.getByRole("region", { name: "最初の記事を入れる" });
  await expect(firstRun, "the overtaken read's articles are dropped, and the later read is still out").toBeHidden();
  await shell.evaluate(() => window.__e2e.release("list_articles"));
  await expect(list(shell).locator(".row").first()).toBeVisible();
  await expect(firstRun).toBeHidden();
});
