// In-app back / forward (H4): mouse side buttons, Alt+← / Alt+→ and the title bar's buttons.
import { test, expect, list, navItem } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const titled = ARTICLES.filter((a) => a.title && a.fetch_status === "ok");
/** XButton1 (3) is back, XButton2 (4) forward; WebView2 reports them as mouseup with these buttons. */
const side = (page: Page, button: 3 | 4) =>
  page.evaluate((b) => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { button: b, bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("mouseup", { button: b, bubbles: true }));
  }, button);
const back = (page: Page) => page.getByRole("banner").getByRole("button", { name: "戻る" });
const forward = (page: Page) => page.getByRole("banner").getByRole("button", { name: "進む" });
const listTitle = (page: Page) => list(page).locator(".list-title h1");

test("screens and scopes: the side buttons, Alt+arrows and the title bar go back and forward", async ({ app }) => {
  await expect(back(app)).toBeDisabled();
  await navItem(app, "お気に入り").click();
  await expect(listTitle(app)).toHaveText("お気に入り");
  await navItem(app, "処理状況").click();
  await expect(app.getByRole("heading", { name: "処理状況" })).toBeVisible();

  await side(app, 3);
  await expect(listTitle(app)).toHaveText("お気に入り");
  await app.keyboard.press("Alt+ArrowLeft");
  await expect(listTitle(app)).toHaveText("すべての記事");
  await expect(back(app)).toBeDisabled();
  await side(app, 4);
  await expect(listTitle(app)).toHaveText("お気に入り");
  await forward(app).click();
  await expect(app.getByRole("heading", { name: "処理状況" })).toBeVisible();
  await expect(forward(app)).toBeDisabled();

  // A new place after going back drops what was ahead.
  await back(app).click();
  await navItem(app, "未読").click();
  await expect(forward(app)).toBeDisabled();
});

test("settings sections are places of their own", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  const section = (title: string) => nav.locator(".ni").filter({ has: app.locator(".label").getByText(title, { exact: true }) });
  await section("翻訳").click();
  await section("画像").click();
  const heading = app.locator(".stg main h1");
  await expect(heading).toHaveText("画像");
  await back(app).click();
  await expect(heading).toHaveText("翻訳");
  await back(app).click();
  await back(app).click();
  await expect(nav).toBeHidden();
  await expect(listTitle(app)).toBeVisible();
});

test("articles opened in the focused tab come back in order; a tab switch is undone by switching back", async ({ app }) => {
  const [a, b] = titled;
  const title = app.locator(".art-title");
  await list(app).locator(".row", { hasText: a.title! }).click();
  await list(app).locator(".row", { hasText: b.title! }).click();
  await expect(title).toHaveText(b.title!);
  await app.keyboard.press("Alt+ArrowLeft");
  await expect(title).toHaveText(a.title!);
  await app.keyboard.press("Alt+ArrowRight");
  await expect(title).toHaveText(b.title!);

  await list(app)
    .locator(".row", { hasText: a.title! })
    .click({ modifiers: ["Control"] });
  const tabs = app.locator(".dpane").first().getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await back(app).click();
  await expect(tabs, "back to the first tab, not a reload of it").toHaveCount(2);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(title).toHaveText(b.title!);
});
