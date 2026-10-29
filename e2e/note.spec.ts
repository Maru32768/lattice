import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES, SNAPSHOT_ID } from "./fixtures.ts";

async function open(page: import("@playwright/test").Page, id: number) {
  const title = ARTICLES.find((a) => a.id === id)!.title!;
  await list(page).locator(".row", { hasText: title }).click();
  await expect(page.locator(".art-title")).toHaveText(title);
}

test("メモ: written beside the Reader, saved as you type, back when the article opens again", async ({ app }) => {
  await open(app, SNAPSHOT_ID);
  const button = app.getByRole("button", { name: "メモ", exact: true });
  await button.click();
  const panel = app.getByRole("complementary", { name: "メモ" });
  await panel.getByRole("textbox", { name: "メモ" }).fill("2PL と比べる");
  await expect(panel.getByRole("status")).toHaveText("保存しました");
  expect((await callsOf(app, "set_article_note")).at(-1)).toEqual({ id: SNAPSHOT_ID, body: "2PL と比べる" });

  // One panel at a time: the quiz takes the memo's place.
  await app.getByRole("button", { name: "理解度チェック", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(app.getByRole("complementary", { name: "理解度チェック" })).toBeVisible();
  await expect(button, "the toolbar marks an article with a memo").toHaveClass(/\bon\b/);

  await open(app, 2);
  await expect(app.getByRole("button", { name: "メモ", exact: true })).not.toHaveClass(/\bon\b/);
  await open(app, SNAPSHOT_ID);
  await button.click();
  await expect(panel.getByRole("textbox", { name: "メモ" })).toHaveValue("2PL と比べる");
});

test("ジャンル: a genre added ahead of any article is listed for classification", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "ジャンルを管理" }).click();
  const name = app.getByRole("textbox", { name: "追加するジャンルの名前" });
  await name.fill("Compilers");
  await app.getByRole("button", { name: "追加", exact: true }).click();
  await expect(app.getByRole("status")).toHaveText("「Compilers」を追加しました");
  await expect(app.getByRole("combobox", { name: "Compilers の新しい名前" })).toHaveValue("Compilers");
  await name.fill("compilers");
  await expect(app.getByText("「Compilers」はすでにあります")).toBeVisible();
  await expect(app.getByRole("button", { name: "追加", exact: true })).toBeDisabled();
});
